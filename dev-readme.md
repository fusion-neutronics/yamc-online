# Developing yamc-online

## Layout

| | |
| --- | --- |
| `src/index.html`, `src/app.js` | The page: editor, tabs, worker lifecycle. |
| `src/worker.js` | Pyodide, the yamc wheel, the nuclear-data fetcher, running scripts. |
| `examples/*.py` | The examples menu. Each opens with `# Title: description`. |
| `vendor/` | The yamc wheel, `CORE_COMMIT`, `PYODIDE_VERSION`, the CodeMirror bundle, coi-serviceworker. Committed. |
| `build.mjs` | Copies `src/` and `vendor/` into `dist/` and writes `dist/config.js`. |
| `serve.mjs` | Static server for `dist/`, with core's fixtures under `/fixtures/`. |
| `verify.mjs` | Playwright checks against `dist/`. |

## Building and running

```bash
node build.mjs
node serve.mjs            # http://localhost:8000/
```

`http://localhost:8000/?data=/fixtures/` reads nuclear data from core's test
fixtures (`../core/crates/yamc/tests`, or `YAMC_FIXTURES`) instead of the
published origin.

The page needs serving over HTTP; `file://` cannot start a module worker.

## Checking it

```bash
npm ci
node build.mjs
node verify.mjs           # against core's fixtures, offline except for Pyodide
node verify.mjs --live    # plus one run against yamc-data.xsplot.com
```

It runs the examples and checks the printed tally values against the native
wheel's to the printed digit, the plot frames and the geometry viewer, that a
rerun fetches nothing, tracebacks, the mesh-geometry error, a Rust panic, Stop
(both the interrupt and the restart), share links, and that nothing but Pyodide
is fetched from another origin. CI runs the same against the published Li6, H1
and O16 objects, fetched by `scripts/fetch-fixtures.mjs`.

## How it works

**The worker.** Python runs in a module worker (`src/worker.js`). Pyodide 314
refuses to start in a classic worker. Transport is one synchronous call into
wasm, so in the worker it blocks nothing the user can see.

**Nuclear data.** The wheel's downloader is the same Rust as native yamc,
deciding what to fetch per nuclide, but an Emscripten build has no sockets, so
it calls back into the page for each GET (`yamc._core._set_data_fetcher`). The
worker answers with a synchronous `XMLHttpRequest`, which browsers still allow
in a worker. Files land in Emscripten's in-memory filesystem under
`~/.cache/yamc`, so reruns read them instead of fetching again; **Clear held
data** in the Data tab frees them.

Transport currently fetches each nuclide's `reactions.arrow` and `energy.arrow`
whole, every published temperature, even though it only loads the material's
temperature. For heavy nuclides that is most of the download (PbLi: 312 MB of
the 447 MB for its 22 nuclides is reactions at six temperatures). Fetching only
the needed temperature's byte ranges is a change in core's downloader; the
activation path already ranges by MT from the same `version.json` index.

**Stop.** With cross-origin isolation the page shares an interrupt buffer with
Pyodide, and Stop raises `KeyboardInterrupt` in the script. Transport is in Rust
and never looks at it, so if the run has not ended 1.5 s after Stop, the page
terminates the worker and starts a fresh one. GitHub Pages cannot send the
COOP/COEP headers isolation needs, so `coi-serviceworker` adds them and reloads
the page once; without it, Stop always restarts.

**Plots.** The script is compiled with each top-level expression statement
wrapped in a call that shows its value if it has `_repr_html_`, so a
`model.plot()` line draws wherever it stands; the last expression's value is
shown, or printed if it has no rich display. `show(obj)` posts
`obj._repr_html_()` to the page, which puts it in
an `<iframe sandbox="allow-scripts">`: the viewers' scripts run, but in an
opaque origin with no access to the page. The frame reports its content height
so short tables do not sit in a tall box.

**Panics.** A Rust panic reaches Python as `pyo3_runtime.PanicException`, as it
does natively, and the session carries on. If Pyodide itself dies (out of
memory, say) the page starts a new worker.

## Refreshing the wheel

The wheel is a Pyodide build of core's `yamc-core` package. Until core attaches
one to its releases, it is built with
[pyodide-build](https://pyodide.org/en/stable/development/building-packages-from-source.html)
from a core checkout carrying the Emscripten support (the data-fetcher hook, and
reqwest kept off emscripten):

```bash
python3.14 -m venv .pyb && .pyb/bin/pip install pyodide-build
.pyb/bin/pyodide xbuildenv install 314.0.7
cd ../core/packages/yamc-core
MATURIN_PEP517_ARGS=--no-default-features ../../../yamc-online/.pyb/bin/pyodide build -o ../../../yamc-online/vendor
cd ../../../yamc-online
rm vendor/<the old wheel>.whl
git -C ../core rev-parse HEAD > vendor/CORE_COMMIT
```

`--no-default-features` drops mesh geometry, CAD, GPU and the TLS stack, none of
which build or work in Pyodide. The wheel's platform tag
(`pyemscripten_2026_0`) has to match the Pyodide ABI, so `vendor/PYODIDE_VERSION`
moves with it: a Pyodide upgrade is a wheel rebuild.

`vendor/codemirror.js` is rebuilt with `node scripts/vendor-codemirror.mjs`
after bumping a CodeMirror package.
