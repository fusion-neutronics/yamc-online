// Python and yamc, off the main thread.
//
// A module worker, loaded from its own file next to the page: Pyodide refuses
// to start in a classic one. Pyodide is imported from the CDN, the yamc wheel
// is fetched from beside the page.
// Transport is one synchronous call into wasm that returns when it is done, so
// on the main thread it would freeze the page for the whole run; here it only
// blocks this thread, and the page stays responsive and can terminate it.
//
// Protocol, page to worker: `{ type: "init", ... }`, `{ type: "run", code }`,
// `{ type: "clearData" }`. Worker to page: `status`, `ready`, `stdout`,
// `stderr`, `plot`, `fetch`, `done`, `cleared` and `fatal` messages. stdout,
// plots and fetches are posted while a run is still going, so the page shows
// them live rather than at the end.

// The origin the wheel has compiled in. Every nuclear-data URL starts with it.
const PUBLISHED_ORIGIN = "https://yamc-data.xsplot.com/";

let pyodide = null;
// Where data requests actually go. The published origin unless the page was
// opened with `?data=`, which verify.mjs uses to serve core's fixtures.
let dataOrigin = PUBLISHED_ORIGIN;

const post = (msg) => self.postMessage(msg);

/// One blocking GET, as the wheel's downloader asks for it.
///
/// `offset` and `length` are both null for a whole object, otherwise the byte
/// range to request. Answers `[status, body]`. A synchronous XMLHttpRequest is
/// what makes this possible at all: the Rust downloader is blocking, and a
/// worker is the one place a browser still allows a synchronous request with an
/// ArrayBuffer response.
///
/// A network failure (offline, or a CORS refusal) throws rather than inventing
/// a status. The downloader treats a thrown fetch as a failed attempt and
/// retries, then reports the URL, which is the useful thing to see.
function fetchSync(url, offset, length) {
  const target = url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url;
  const xhr = new XMLHttpRequest();
  xhr.open("GET", target, false);
  xhr.responseType = "arraybuffer";
  if (offset != null) xhr.setRequestHeader("Range", `bytes=${offset}-${offset + length - 1}`);
  const started = performance.now();
  try {
    xhr.send();
  } catch (e) {
    post({ type: "fetch", url, offset, length, status: 0, bytes: 0, ms: performance.now() - started });
    throw new Error(`could not fetch ${target}: ${e.message || e}`);
  }
  const ok = xhr.status >= 200 && xhr.status < 300;
  // Only a success carries a body worth handing over: an error page is not
  // nuclear data, and the downloader only reads the status of a 404.
  const body = ok ? new Uint8Array(xhr.response) : new Uint8Array(0);
  post({ type: "fetch", url, offset, length, status: xhr.status, bytes: body.length, ms: performance.now() - started });
  return [xhr.status, body];
}
self.yamcFetch = fetchSync;
self.yamcShow = (html, title) => post({ type: "plot", html, title });

// Installed once at boot. `show` is in builtins so a user script and anything
// it imports can call it without an import, as in a notebook.
const PRELUDE = `
import ast, builtins, os, shutil, sys, traceback

import js
import yamc
from yamc import _core


def _fetch(url, offset, length):
    status, body = js.yamcFetch(url, offset, length)
    return int(status), body.to_bytes()


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
  async init({ pyodideBase, wheelUrl, data, interruptBuffer }) {
    if (data) dataOrigin = data.endsWith("/") ? data : `${data}/`;
    // The wheel downloads while Pyodide does, rather than after it: the two
    // are the bulk of the start-up time and neither needs the other.
    const wheel = fetch(wheelUrl).then((r) => {
      if (!r.ok) throw new Error(`could not fetch ${wheelUrl}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    wheel.catch(() => {}); // Reported where it is awaited, not as unhandled.
    post({ type: "status", text: "Loading Python" });
    const { loadPyodide } = await import(`${pyodideBase}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL: pyodideBase });
    pyodide.setStdout({ batched: (text) => post({ type: "stdout", text }) });
    pyodide.setStderr({ batched: (text) => post({ type: "stderr", text }) });
    if (interruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
    post({ type: "status", text: "Installing yamc" });
    // Unpacked into site-packages from the bytes already fetched; the
    // extension module is loaded when the prelude imports yamc.
    pyodide.unpackArchive(await wheel, "wheel");
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
