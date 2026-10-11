# yamc-online

Write [yamc](https://github.com/fusion-neutronics/yamc) Python in the browser and
run the neutron transport there. The API is the one `pip install yamc` gives
you, so a script that runs here runs locally, and **Download .py** saves it.

Nothing is installed and nothing is uploaded. Python and yamc run in your
browser through [Pyodide](https://pyodide.org), and the only data fetched is the
nuclear data for the nuclides your materials name, the first time a run needs
them.

## Using it

- **Run** (or Ctrl+Enter) runs the script in a fresh namespace, like
  `python model.py`.
- **Output** shows what the script prints, including the transport's own
  progress and tally summary.
- **Plots** shows anything passed to `show()`, and every line of the script
  that is just an object with a rich display, as a notebook cell does: a
  `model.plot()` line draws the geometry wherever it stands. Geometry plots,
  mesh tally plots, `TallyResult` and `SimulationResults` all work.
- **Data** lists the nuclear data fetched so far, per nuclide, and how much
  memory the session is using.
- **Share** copies a link with the script compressed into it. The code travels
  in the link itself; no server stores it.
- **Stop** interrupts Python. A transport run cannot be interrupted midway, so
  during one Stop restarts Python instead, and the nuclear data is fetched again
  on the next run.

The examples menu opens on a Li-6 sphere, and also has a water shielding slab,
a mesh tally, a gamma shield (a photon source), coupled neutron and photon
transport, weight windows for deep penetration, and a tokamak with a PbLi
breeder blanket (about 145 MB of nuclear data on its first run). They are also
in [examples/](examples/) as plain scripts.

## What the browser cannot do

- **One thread.** Pyodide has no threads, so transport runs on one core, about
  2.5 times slower than one native thread. The examples are sized to take
  seconds.
- **CSG geometry only.** Mesh geometry (`yamc.MeshGeometry`) says so with an
  error; it needs `pip install yamc`.
- **About 2 GB of memory for Python.** Roughly 100 nuclides of typical fusion
  materials fit.
- **Nuclear data is downloaded per nuclide.** Light nuclides are a megabyte or
  two; heavy ones such as lead, iron or tungsten are 15 to 50 MB each. The Data
  tab shows what was fetched.

## Development

See [dev-readme.md](dev-readme.md) for building, testing, and refreshing the
vendored yamc wheel.
