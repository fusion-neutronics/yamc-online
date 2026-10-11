// Python and yamc, off the main thread.
//
// A module worker, loaded from its own file next to the page: Pyodide refuses
// to start in a classic one. Pyodide is imported from the CDN, and yamc-core
// is installed with micropip from its Pyodide wheel on PyPI (or from a local
// wheel beside the page, for a build made with `--wheel`).
// Transport is one synchronous call into wasm that returns when it is done, so
// on the main thread it would freeze the page for the whole run; here it only
// blocks this thread, and the page stays responsive and can terminate it.
//
// Protocol, page to worker: `{ type: "init", ... }`, `{ type: "run", code }`,
// `{ type: "clearData" }`. Worker to page: `status`, `ready`, `stdout`,
// `stderr`, `plot`, `fetch`, `done`, `cleared` and `fatal` messages. stdout,
// plots and fetches are posted while a run is still going, so the page shows
// them live rather than at the end. The `fetch` messages of a batch come from
// the helper in fetcher.js instead, on the port the page hands over in `init`.

// The origin the wheel has compiled in. Every nuclear-data URL starts with it.
const PUBLISHED_ORIGIN = "https://yamc-data.xsplot.com/";

let pyodide = null;
// Where data requests actually go. The published origin unless the page was
// opened with `?data=`, which verify.mjs uses to serve core's fixtures.
let dataOrigin = PUBLISHED_ORIGIN;

const post = (msg) => self.postMessage(msg);

async function getJson(url, missing = null) {
  const r = await fetch(url);
  if (r.status === 404 && missing) throw new Error(missing);
  if (!r.ok) throw new Error(`could not fetch ${url}: HTTP ${r.status}`);
  return r.json();
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/// The yamc-core wheel to install, as `{ name, bytes }`: the local wheel the
/// page was built with, or else the PyPI release's wheel for this Pyodide.
///
/// Fetched while Pyodide starts, which is why this does not leave it to
/// micropip: micropip only exists once Pyodide has started, and would then
/// ask PyPI's index and download the wheel one after the other. PyPI names
/// each file with its sha256, which the bytes are checked against. The wheel's
/// platform tag (PEP 783) has to be the one this Pyodide's lock file names, so
/// a release built for another Pyodide fails here, saying so.
async function fetchWheel({ pyodideBase, pyodideVersion, yamcCore, wheelUrl }) {
  let file;
  if (wheelUrl) {
    file = { url: wheelUrl, filename: decodeURIComponent(new URL(wheelUrl).pathname.split("/").pop()) };
  } else {
    const [lock, release] = await Promise.all([
      getJson(`${pyodideBase}pyodide-lock.json`),
      getJson(`https://pypi.org/pypi/yamc-core/${yamcCore}/json`, `yamc-core ${yamcCore} is not on PyPI`),
    ]);
    const platform = `pyemscripten_${lock.info.abi_version}_${lock.info.arch}`;
    file = release.urls.find((f) => f.filename.endsWith(`-${platform}.whl`));
    if (!file) {
      throw new Error(`yamc-core ${yamcCore} on PyPI has no wheel for Pyodide ${pyodideVersion} (${platform})`);
    }
  }
  const r = await fetch(file.url);
  if (!r.ok) throw new Error(`could not fetch ${file.url}: HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  const expected = file.digests && file.digests.sha256;
  if (expected && hex(await crypto.subtle.digest("SHA-256", bytes)) !== expected) {
    throw new Error(`${file.filename} from PyPI does not match its sha256`);
  }
  return { name: file.filename, bytes: new Uint8Array(bytes) };
}

// The helper worker that fetches a batch of requests concurrently (see
// fetcher.js), and whether this worker can block on it: Atomics.wait on
// shared memory needs the page to be cross-origin isolated.
let helper = null;
const canBatch = self.crossOriginIsolated && typeof SharedArrayBuffer === "function";
// The most one batch's bodies may take, all told. A body that does not fit is
// fetched again on its own. Reserved, not allocated: the buffer grows as the
// bodies arrive.
const BATCH_BYTES = 1 << 30;

const dataUrl = (url) => (url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url);

/// One blocking GET, as a synchronous XMLHttpRequest.
///
/// `range` is the `Range` header value to send, or null for the whole object.
/// Answers `[status, body]`. A synchronous XMLHttpRequest is what makes this
/// possible at all: the Rust downloader is blocking, and a worker is the one
/// place a browser still allows a synchronous request with an ArrayBuffer
/// response. A network failure (offline, or a CORS refusal) is status 0,
/// which the downloader retries and then reports with the URL.
function fetchSync(url, range) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", dataUrl(url), false);
  xhr.responseType = "arraybuffer";
  if (range != null) xhr.setRequestHeader("Range", range);
  const started = performance.now();
  let status = 0;
  try {
    xhr.send();
    status = xhr.status;
  } catch {
    status = 0;
  }
  // Only a success carries a body worth handing over: an error page is not
  // nuclear data, and the downloader only reads the status of a 404.
  const ok = status >= 200 && status < 300;
  const body = ok ? new Uint8Array(xhr.response) : new Uint8Array(0);
  post({ type: "fetch", url, range, status, bytes: body.length, ms: performance.now() - started });
  return [status, body];
}

/// Every GET of a batch, concurrently, blocking until all are answered.
///
/// The helper worker fetches them with async fetch() and writes each body into
/// a growable SharedArrayBuffer, and this worker sleeps in Atomics.wait until
/// the count of answers reaches the batch size. Answers `[status, body]` per
/// request, in order.
function fetchBatch(requests) {
  const n = requests.length;
  const ctl = new Int32Array(new SharedArrayBuffer(4 * (1 + 3 * n)));
  const arena = new SharedArrayBuffer(0, { maxByteLength: BATCH_BYTES });
  helper.postMessage({ requests, ctl, arena, dataOrigin });
  for (let done = Atomics.load(ctl, 0); done < n; done = Atomics.load(ctl, 0)) {
    Atomics.wait(ctl, 0, done);
  }
  return requests.map((_, i) => {
    const [status, offset, length] = [ctl[1 + 3 * i], ctl[2 + 3 * i], ctl[3 + 3 * i]];
    return [status, new Uint8Array(arena, offset, length)];
  });
}

/// The wheel's data fetcher: a list of `[url, range]` requests in, one
/// `[status, body]` per request out. A batch goes to the helper; a single
/// request, or any request on a page that is not cross-origin isolated, is a
/// synchronous XMLHttpRequest, which costs no shared memory and no hop.
function fetchMany(pyRequests) {
  const requests = pyRequests.toJs().map(([url, range]) => [url, range ?? null]);
  if (requests.length > 1 && canBatch && helper) return fetchBatch(requests);
  return requests.map(([url, range]) => fetchSync(url, range));
}
self.yamcFetch = fetchMany;
self.yamcShow = (html, title) => post({ type: "plot", html, title });

// Installed once at boot. `show` is in builtins so a user script and anything
// it imports can call it without an import, as in a notebook.
const PRELUDE = `
import ast, builtins, os, shutil, sys, traceback

import js
import yamc
from yamc import _core


def _fetch(requests):
    return [(int(status), body.to_bytes()) for status, body in js.yamcFetch(requests)]


_core._set_data_fetcher(_fetch)


def show(obj, title=None):
    """Draw an object in the Plots tab.

    Anything with a rich HTML display works: geometry and tally plots from
    \`.plot()\`, a \`TallyResult\`, \`SimulationResults\`, a \`Material\`. A
    line of a script that is just such an object, such as \`model.plot()\`, is
    shown the same way wherever it stands, so it needs no call to this.

    Args:
        obj: The object to draw. Must have a \`_repr_html_\` method.
        title: Caption above the plot. Defaults to the object's type name.
    """
    render = getattr(obj, "_repr_html_", None)
    if render is None:
        raise TypeError(f"show() needs an object with a rich display, not {type(obj).__name__}")
    js.yamcShow(render(), title or type(obj).__name__)


builtins.show = show

# The browser wheel is built without mesh geometry, so these names are absent
# from it. A stand-in that says why reads better than an AttributeError. Only
# installed for a name the wheel lacks, so a wheel that has it is untouched.
_MESH_ONLY = [
    "MeshGeometry", "FaceOutput", "SceneFaceOutput", "cad_mesh_labels", "cad_mesh_to_arrow",
    "mesh_face", "mesh_faces", "mesh_faces_scene_resolved", "mesh_to_arrow", "mesh_volume_rs",
    "weld_mesh",
]


def _browser_unavailable(name):
    def unavailable(*args, **kwargs):
        raise NotImplementedError(
            f"yamc.{name} is not available in the browser, which runs CSG geometry only. "
            "Mesh geometry needs yamc installed locally: pip install yamc"
        )
    unavailable.__name__ = name
    return unavailable


for _name in _MESH_ONLY:
    if not hasattr(yamc, _name):
        setattr(yamc, _name, _browser_unavailable(_name))

_SCRIPT = "model.py"


def _print_exception(error):
    # Drop the frames above the user's script: they are this prelude and
    # Pyodide's own machinery, which say nothing about the script.
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != _SCRIPT:
        tb = tb.tb_next
    lines = traceback.format_exception(type(error), error, tb)
    sys.stderr.write("".join(lines))


def _show_rich(value):
    # What a top-level expression before the last is wrapped in: drawn if it
    # has a rich display, and otherwise left alone, as a script would.
    if hasattr(value, "_repr_html_"):
        show(value)


def _compile(source):
    """Compile a script so every top-level expression with a rich display is
    drawn, and the last expression's value comes back.

    A script with \`model.plot()\` partway down then draws it where it stands,
    as a notebook cell would, rather than only when it is the last line. Every
    node keeps its line number, so tracebacks point at the script as written.
    """
    tree = ast.parse(source, filename=_SCRIPT)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    for i, node in enumerate(tree.body):
        if isinstance(node, ast.Expr):
            call = ast.Call(ast.Name("_show_rich", ast.Load()), [node.value], [])
            tree.body[i] = ast.copy_location(ast.Expr(ast.copy_location(call, node.value)), node)
    ast.fix_missing_locations(tree)
    body = compile(tree, _SCRIPT, "exec")
    return body, None if last is None else compile(last, _SCRIPT, "eval")


def _run(source):
    """Run a script in a fresh namespace, as \`python model.py\` would.

    Synchronously, not with eval_code_async: under the async runner a blocking
    call such as time.sleep can suspend to the event loop, and an interrupt
    then lands in the loop's machinery rather than in the script.
    """
    namespace = {"__name__": "__main__", "__file__": _SCRIPT, "show": show, "_show_rich": _show_rich}
    try:
        body, last = _compile(source)
        exec(body, namespace)
        value = None if last is None else eval(last, namespace)
    except BaseException as error:  # noqa: BLE001  (KeyboardInterrupt too)
        _print_exception(error)
        return False
    if value is not None:
        if hasattr(value, "_repr_html_"):
            show(value)
        else:
            print(repr(value))
    return True


def _cache_root():
    return os.path.expanduser("~/.cache/yamc")


def _held_bytes():
    total = 0
    for root, _dirs, files in os.walk(_cache_root()):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    return total


def _clear_data():
    shutil.rmtree(_cache_root(), ignore_errors=True)
`;

/// Bytes the page is holding for Python: the wasm heap, and the downloaded
/// nuclear data in Emscripten's in-memory filesystem, which lives outside it.
function memory() {
  return {
    heap: pyodide._module.HEAP8.length,
    held: pyodide.globals.get("_held_bytes")(),
  };
}

const handlers = {
  async init({ pyodideBase, pyodideVersion, yamcCore, wheelUrl, data, interruptBuffer, fetchPort }) {
    if (data) dataOrigin = data.endsWith("/") ? data : `${data}/`;
    if (canBatch) {
      helper = new Worker(new URL("fetcher.js", import.meta.url));
      // The helper reports each request to the page directly: this worker is
      // asleep in Atomics.wait while it works, and could not pass them on.
      helper.postMessage({ port: fetchPort }, [fetchPort]);
    }
    // The wheel downloads while Pyodide does, rather than after it: the two
    // are the bulk of the start-up time and neither needs the other.
    const wheel = fetchWheel({ pyodideBase, pyodideVersion, yamcCore, wheelUrl });
    wheel.catch(() => {}); // Reported where it is awaited, not as unhandled.
    post({ type: "status", text: "Loading Python" });
    const { loadPyodide } = await import(`${pyodideBase}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL: pyodideBase, packages: ["micropip"] });
    pyodide.setStdout({ batched: (text) => post({ type: "stdout", text }) });
    pyodide.setStderr({ batched: (text) => post({ type: "stderr", text }) });
    if (interruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
    post({ type: "status", text: "Installing yamc" });
    // micropip installs from the bytes already fetched: it checks the wheel's
    // tags against this Pyodide and puts it in site-packages. yamc-core has no
    // dependencies, so it asks nothing of the network.
    const { name, bytes } = await wheel;
    pyodide.FS.writeFile(`/tmp/${name}`, bytes);
    await pyodide.pyimport("micropip").install(`emfs:/tmp/${name}`);
    await pyodide.runPythonAsync(PRELUDE);
    post({
      type: "ready",
      yamc: pyodide.runPython("yamc.__version__"),
      python: pyodide.runPython("sys.version.split()[0]"),
      pyodide: pyodide.version,
      dataOrigin,
      memory: memory(),
    });
  },

  async run({ code }) {
    const started = performance.now();
    const ok = pyodide.globals.get("_run")(code);
    post({ type: "done", ok, seconds: (performance.now() - started) / 1000, memory: memory() });
  },

  clearData() {
    pyodide.globals.get("_clear_data")();
    post({ type: "cleared", memory: memory() });
  },
};

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    await handlers[msg.type](msg);
  } catch (e) {
    // Anything reaching here was not caught by the Python wrapper, which
    // catches every Python exception. So it is Pyodide itself failing: a Rust
    // panic aborts the wasm instance, and after that the interpreter is gone.
    // The page starts a new worker.
    post({ type: "fatal", message: String((e && e.message) || e) });
  }
};
