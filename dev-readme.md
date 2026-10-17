# Developing yamc-online

## Layout

| | |
| --- | --- |
| `src/index.html`, `src/app.js` | The page: editor, tabs, worker lifecycle. |
| `src/worker.js` | Pyodide, the yamc wheel, the nuclear-data fetcher, running scripts. |
| `src/fetcher.js` | The worker's helper that fetches a batch of nuclear-data requests concurrently. |
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
node scripts/fetch-fixtures.mjs   # once: what core's fixtures lack (photon data, H3, He3, the chain)
node verify.mjs           # against the fixtures, offline except for Pyodide
node verify.mjs --live    # plus runs against yamc-data.xsplot.com
node scripts/check-download-sizes.mjs [--live]   # the sizes the examples quote, against a run
```

It runs the examples and checks the printed tally and inventory values against
the native wheel's to the printed digit, the plot frames and the geometry
viewer, that a rerun fetches nothing, that the lithium transmutation chain
reaches only H, He and Li, tracebacks, the mesh-geometry error, a Rust panic,
Stop (both the interrupt and the restart), that only edited code is kept as a
draft, share links, and that nothing but Pyodide is fetched from another
origin. CI runs the same against the published data `scripts/fetch-fixtures.mjs`
lists: Li6, Li7, H1, H2, H3, He3 and O16 neutron data, H and O photon data, and
the endf-b8.1 transmutation chain. The tokamak is listed but not run: its lead
is too much data for a check.

## How it works

**The worker.** Python runs in a module worker (`src/worker.js`). Pyodide 314
refuses to start in a classic worker. Transport is one synchronous call into
wasm, so in the worker it blocks nothing the user can see.

**Nuclear data.** The wheel's downloader is the same Rust as native yamc,
deciding what to fetch per nuclide, but an Emscripten build has no sockets, so
it hands its GETs to the page (`yamc._core._set_data_fetcher`), as a list of
`(url, range)` requests answered with one `(status, body)` each. Files land in
Emscripten's in-memory filesystem under `~/.cache/yamc`, so reruns read them
instead of fetching again; **Clear held data** in the Data tab frees them.

The Python call is synchronous, so the worker cannot await anything during a
run. Before a load of several nuclides the downloader plans every request it
will make and sends them in two batches per 32 nuclides: every `version.json`
and whole section first, then the byte ranges those `version.json` indexes
name. A batch goes to `src/fetcher.js`, a helper worker that has up to 32
requests in flight with ordinary `fetch()` (the origin speaks HTTP/2, so they
share a connection) and writes each body into a growable `SharedArrayBuffer`,
while the Python worker sleeps in `Atomics.wait` until all are answered. The
helper reports each request to the page on a `MessageChannel`, since the worker
cannot pass anything on while it sleeps. A single request, and every request
on a page that is not cross-origin isolated, is a synchronous
`XMLHttpRequest` from the worker, as before.

The downloader prints `Downloaded 4 of 9 nuclides` as it goes. The page keeps
one such line in the Output tab, as it does for transport's `Progress:` lines,
and shows it in the status bar.

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
