// End-to-end check: run the examples in a real browser and look at what comes
// back.
//
// The page is served from dist/ with core's nuclear-data fixtures beside it
// (see serve.mjs), and opened with `?data=/fixtures/`, so the worker's own
// fetch path is exercised against real data without the network. Pyodide
// comes from the CDN and yamc from PyPI, as in production, unless the
// page was built with `node build.mjs --wheel <path>`: then the wheel is
// installed from beside the page, and PyPI is not asked at all.
//
//   node verify.mjs [--headed] [--live]
//
// `--live` runs the default example and the gamma shield once more against
// the published data origin, which is the only part that needs yamc-data.xsplot.com.
//
// Needs `node build.mjs` first, and the nuclear data scripts/fetch-fixtures.mjs
// lists, from core's fixtures or from `node scripts/fetch-fixtures.mjs`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import { serve, fixtureDir, FIXTURES, FETCHED_FIXTURES } from "./serve.mjs";
import { WHEEL, YAMC_CORE_VERSION } from "./dist/config.js";
import { NEUTRON, PHOTON, TRANSMUTATION } from "./scripts/fetch-fixtures.mjs";
import { CREDITS, citations, citeListHtml, dataSet, doiUrl } from "./src/citations.js";

const PYODIDE_CDN = "https://cdn.jsdelivr.net";
// Where yamc comes from when the page installs the PyPI release: the
// JSON API naming the wheel, and the host serving it.
const PYPI = ["https://pypi.org/", "https://files.pythonhosted.org/"];
const RUN_TIMEOUT = 180_000;

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(`${msg}${detail ? `: ${detail}` : ""}`));

const args = process.argv.slice(2);

// -- What to cite, without a browser ------------------------------------------
// The references are core's (credits.rs), so this checks their shape and the
// page's use of them, not their text.
check(Object.keys(CREDITS).join(",") === "endf-b8.1,jeff-4.0,jendl-5.0,tendl-2025,tendl-2017,fendl-3.2d,irdff-ii,ukdd-2012,ukdd-2020,ukfy-4.2",
  "a credit for every hosted library keyword", Object.keys(CREDITS).join(","));
for (const [id, c] of Object.entries(CREDITS)) {
  const bad = c.references.filter((r) => (r.doi ? !/^10\.\d+\/\S+$/.test(r.doi) : !r.text.includes("processed for FISPACT-II by UKAEA")));
  check(c.references.length > 0 && bad.length === 0, `${id}: every reference has a DOI, or is UKAEA's worded attribution`);
}
check(["neutron/Fe56", "photon/Fe", "thermal/c_H_in_H2O", "transmutation/reactions", "transmutation/branching",
  "transmutation/decay", "transmutation/fission_yields"].map((p) => dataSet(...p.split("/"))).join(",")
  === "neutron,photon,thermal,neutron,neutron,decay,fission_yields", "each fetched file's data set");
const jeffRead = citations(new Map([["jeff-4.0", new Set(["neutron", "decay"])]]));
check(jeffRead[0].references.map((r) => r.doi).join(",") === "10.82555/e9ajn-a3p20,10.82555/tw0c6-t1386",
  "JEFF-4.0 is cited by the data sets read", jeffRead[0].references.map((r) => r.doi).join(","));
check(citations(new Map([["not-a-library", new Set(["neutron"])]])).length === 0, "an unknown library is left out");
const citeHtml = citeListHtml(new Map([["tendl-2017", new Set(["neutron"])], ["ukdd-2012", new Set(["decay"])]]));
check(citeHtml.includes(`href="${doiUrl("10.1016/j.nds.2012.11.002")}"`) && citeHtml.includes("&quot;Modern Nuclear Data Evaluation"),
  "the citation list links each DOI and escapes its text");
check(/<li>decay_2012 data processed for FISPACT-II by UKAEA[^<]*<\/li>/.test(citeHtml), "and a reference with no DOI is text, with no link");

// The neutron, photon and transmutation-chain data scripts/fetch-fixtures.mjs
// lists. The tokamak is listed in the menu but not run: lead is too much data
// for a check.
const fixtureFiles = [
  ...[...NEUTRON, ...PHOTON].map((name) => [`${name}.arrow`, "version.json"]),
  ...TRANSMUTATION.map((sub) => [join("transmutation", `${sub}.arrow`), sub === "decay" ? "nuclides.arrow" : `${sub}.arrow`]),
];
for (const [dir, file] of fixtureFiles) {
  if (!existsSync(join(fixtureDir(dir), dir, file))) {
    console.error(`no ${dir} fixture under ${FIXTURES} or ${FETCHED_FIXTURES}; run node scripts/fetch-fixtures.mjs, or set YAMC_FIXTURES`);
    process.exit(1);
  }
}

const server = await serve({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: !args.includes("--headed") });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// Every request the page, its worker and its frames make. The page promises to
// fetch nothing but Pyodide from anywhere but its own origin.
const offOrigin = new Set();
context.on("request", (r) => {
  const url = r.url();
  if (url.startsWith(base) || url.startsWith(`${PYODIDE_CDN}/`) || url.startsWith("data:") || url.startsWith("blob:")) return;
  if (!WHEEL && PYPI.some((p) => url.startsWith(p))) return;
  if (url === "about:srcdoc") return;
  offOrigin.add(url);
});

// Nuclear-data requests in flight, from the page, its worker and the worker's
// fetch helper: a batch has several at once.
let dataInFlight = 0;
let dataPeak = 0;
const isData = (r) => r.url().startsWith(`${base}fixtures/`);
context.on("request", (r) => { if (isData(r)) dataPeak = Math.max(dataPeak, ++dataInFlight); });
context.on("requestfinished", (r) => { if (isData(r)) dataInFlight--; });
context.on("requestfailed", (r) => { if (isData(r)) dataInFlight--; });

/// The download counter's lines in `out`: one, reading "Downloaded M of M",
/// is what a run that fetched anything should leave.
// The examples run until every scored bin passes the statistical checks, and
// where that stops depends on wall time (the figure-of-merit checks), so
// values are checked against the native answer within its error.
const CONVERGED = "Every scored bin passed the standard statistical checks";
function near(out, re, expected, tolerance, label) {
  const m = out.match(re);
  const got = m ? parseFloat(m[1]) : NaN;
  check(Math.abs(got - expected) <= tolerance, label, m ? m[0] : out.slice(-300));
}

function checkDownloadCounter(out, label, what) {
  const lines = out.split("\n").filter((l) => l.startsWith("Downloaded "));
  const m = lines.length === 1 && lines[0].match(/^Downloaded (\d+) of (\d+) (.+)$/);
  check(m && m[1] === m[2] && m[3] === what, `${label}: the download counter reaches M of M ${what}, on one line`, lines.join(" | "));
}

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const app = (fn, arg) => page.evaluate(fn, arg);
const output = () => page.textContent("#output");
const status = () => page.textContent("#status");

async function waitReady() {
  await page.waitForFunction(() => window.yamcOnline && window.yamcOnline.state === "ready", null, { timeout: RUN_TIMEOUT });
}

/// Put `code` in the editor, run it, and wait for the run to end.
async function runCode(code) {
  await app((c) => window.yamcOnline.setCode(c), code);
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => window.yamcOnline.state !== "running", null, { timeout: RUN_TIMEOUT });
  await waitReady();
  return output();
}

try {
  // -- Boot -----------------------------------------------------------------
  await page.goto(`${base}?data=/fixtures/`);
  await waitReady();
  const booted = await status();
  ok(`booted: ${booted}`);
  if (WHEEL) ok(`installed yamc from ${WHEEL}, not PyPI`);
  else check(booted.includes(`yamc ${YAMC_CORE_VERSION} `), `installed yamc ${YAMC_CORE_VERSION} from PyPI`, booted);
  check(await app(() => self.crossOriginIsolated), "cross-origin isolated, so Stop can interrupt");

  const titles = await app(() => [...document.getElementById("example").options].map((o) => o.text));
  check(titles.join("|") === "Lithium sphere|Shielding slab|Mesh tally|Gamma shielding|Neutrons and photons|Weight windows|Tokamak|Lithium activation|Activated sphere", "examples menu", titles.join(", "));

  // -- The default example, with one click ----------------------------------
  // What a first visitor gets: the editor holds the lithium sphere, and Run.
  check((await app(() => window.yamcOnline.code())).startsWith("# Lithium sphere:"), "the editor opens on the lithium sphere");
  await page.click("#run");
  await page.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
  let out = await output();
  // The example sets no stop condition, so it runs until its tally passes the
  // statistical checks. Where it stops depends on wall time (the figure-of-
  // merit checks), so the value is not pinned to the digit as a fixed
  // particle count would be.
  check(out.includes(CONVERGED), "the lithium sphere runs until its statistical checks pass", out);
  near(out, /Tritium production: ([0-9.e+-]+)/, 1.260, 0.02, "lithium: tritium production matches native");
  // The transport's verdict on the tally's statistical checks, which the
  // TallyResult in the Plots tab shows too.
  const lithiumVerdict = out.split("\n").find((l) => l.trimStart().startsWith("tritium production:")) ?? "";
  check(lithiumVerdict.includes("checks=PASSED"), "lithium: the tally passes its statistical checks", lithiumVerdict);
  check((await app(() => window.yamcOnline.plots)) === 2, "lithium drew the tally and the geometry");
  check((await page.locator("#plots iframe").count()) === 2, "two sandboxed plot frames");
  check((await page.getAttribute("#plots iframe", "sandbox")) === "allow-scripts", "plot frames are sandboxed");
  check(await page.isVisible('[data-panel="plots"]'), "a successful run lands on the Plots tab");
  // The geometry viewer draws into a canvas from its own script.
  const viewer = page.frameLocator("#plots figure:nth-of-type(2) iframe");
  await viewer.locator("canvas").first().waitFor({ timeout: 30_000 });
  ok("geometry viewer drew a canvas");
  const progressLines = out.split("\n").filter((l) => l.startsWith("Progress:")).length;
  check(progressLines === 1, "progress lines collapse into one", `${progressLines} lines`);
  checkDownloadCounter(out, "lithium", "nuclides");
  const lithiumRun = await app(() => window.yamcOnline.runFetch);
  check(lithiumRun.batched > 1 && lithiumRun.batched <= lithiumRun.requests, "the downloads went out as a batch", JSON.stringify(lithiumRun));
  check(dataPeak > 1, "data requests were in flight together", `peak ${dataPeak}`);

  // Besides the release index (latest.json and the manifest).
  const nuclearData = async () => (await app(() => window.yamcOnline.fetched)).filter((f) => f.kind !== "release");
  let fetched = await nuclearData();
  const names = fetched.map((f) => f.name).sort().join(",");
  check(names === "Li6,Li7", "fetched Li6 and Li7 and nothing else", JSON.stringify(fetched));
  const bytesOf = (f) => f.map((x) => x.bytes).reduce((a, b) => a + b, 0);
  const lithiumBytes = bytesOf(fetched);

  // -- Reruns read the held data --------------------------------------------
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
  fetched = await nuclearData();
  check(bytesOf(fetched) === lithiumBytes, "a rerun fetches nothing", `${bytesOf(fetched)} vs ${lithiumBytes}`);

  // -- Data tab -------------------------------------------------------------
  await page.click('[data-tab="data"]');
  const dataText = await page.textContent("#data");
  check(dataText.includes("Li6") && dataText.includes("Python heap"), "Data tab lists the nuclide and the heap");
  // The fixtures are ENDF/B-VIII.1's, so that is the one library to cite.
  const cited = await page.$$eval("#data .cite-entry", (els) => els.map((el) => el.dataset.library));
  check(cited.join(",") === "endf-b8.1", "Data tab cites the library the run read", cited.join(","));
  check(await page.$$eval('#data .cite-entry a[href^="https://doi.org/"]', (els) => els.length) === 2,
    "with ENDF/B-VIII.1's paper and data DOIs as links");

  // -- The other small examples ---------------------------------------------
  const examples = await app(() => {
    const select = document.getElementById("example");
    const out = {};
    for (const o of select.options) {
      select.value = o.value;
      select.dispatchEvent(new Event("change"));
      out[o.text] = window.yamcOnline.code();
    }
    return out;
  });
  out = await runCode(examples["Shielding slab"]);
  check(out.includes(CONVERGED), "slab: runs until its statistical checks pass", out);
  near(out, /^ +3\.0 +([0-9.e+-]+)/m, 11.93, 0.3, "slab: flux in the first layer matches native");
  near(out, /Front to back attenuation: ([0-9.]+)x/, 13.7, 0.8, "slab: attenuation matches native");

  // -- Another page reads what the browser kept --------------------------------
  // The release files and byte ranges a run fetches are kept in Cache Storage,
  // so a reload (here a second page of the same browser) reads them instead of
  // asking the network, and a run that reads a library's current release drops
  // its other releases. The slab is the first example to ask for ranges (of H1
  // and O16), as well as whole files.
  const keptKeys = (p) => p.evaluate(async () => (await (await caches.open("yamc-online-data")).keys()).map((r) => r.url));
  // Kept after each answer is handed over, so not necessarily by the run's end.
  const until = async (test) => {
    for (let t = 0; t < 100 && !(await test()); t++) await new Promise((r) => setTimeout(r, 100));
  };
  await until(async () => (await keptKeys(page)).length > 0);
  const kept = await keptKeys(page);
  const ranges = kept.filter((u) => /\?bytes=\d+-\d+$/.test(u)).length;
  check(ranges > 0 && ranges < kept.length && kept.every((u) => /\/fixtures\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/?]+(\?bytes=\d+-\d+)?$/.test(u)),
    "the release files and ranges fetched are kept in Cache Storage, one entry each", `${kept.length} entries, ${ranges} of them ranges`);
  const stale = kept[0].replace(/(\/fixtures\/[^/]+\/)[^/]+\//, "$1an-older-release/");
  await page.evaluate(async (k) => (await caches.open("yamc-online-data")).put(k, new Response("x")), stale);
  const reload = await context.newPage();
  reload.on("pageerror", (e) => pageErrors.push(e.message));
  // Every data request but the release index, latest.json and the manifest.
  let asked = 0;
  reload.context().on("request", (r) => { if (isData(r) && !/(latest|manifest)\.json(\?|$)/.test(r.url())) asked++; });
  await reload.goto(`${base}?data=/fixtures/`);
  await reload.waitForFunction(() => window.yamcOnline && window.yamcOnline.state === "ready", null, { timeout: RUN_TIMEOUT });
  asked = 0;
  await reload.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, examples["Shielding slab"]);
  await reload.waitForFunction(() => window.yamcOnline.state !== "running", null, { timeout: RUN_TIMEOUT });
  await reload.waitForFunction(() => window.yamcOnline.state === "ready", null, { timeout: RUN_TIMEOUT });
  near(await reload.textContent("#output"), /^ +3\.0 +([0-9.e+-]+)/m, 11.93, 0.3, "after a reload, the kept data gives the same answer");
  const again = await reload.evaluate(() => window.yamcOnline.runFetch);
  check(again.cached > 0 && asked === 0, "after a reload, no data request but the release index goes to the network", `${asked} requests, ${again.cached} bytes from the browser`);
  const reloadStatus = await reload.textContent("#status");
  check(reloadStatus.includes("more already downloaded"), "the status says how much was already downloaded", reloadStatus);
  await until(async () => !(await keptKeys(reload)).includes(stale));
  const keptAfter = await keptKeys(reload);
  check(!keptAfter.includes(stale) && keptAfter.length === kept.length, "a run drops the library's other releases and keeps the current one", `${keptAfter.length} of ${kept.length} entries`);
  await reload.close();
  out = await runCode(examples["Mesh tally"]);
  check(out.includes("3600 mesh voxels, peak flux 3.876e-01"), "mesh tally matches native", out);
  check((await app(() => window.yamcOnline.plots)) === 1, "mesh tally drew its map");

  // -- Photons ---------------------------------------------------------------
  // Values taken from the page with the wheel in vendor/, against the fixtures.
  out = await runCode(examples["Gamma shielding"]);
  check(out.includes(CONVERGED), "gamma shield: runs until its statistical checks pass", out);
  near(out, /^ +3\.0 +([0-9.e+-]+)/m, 11.05, 0.3, "gamma shield: flux in the first layer");
  near(out, /^ +57\.0 +([0-9.e+-]+)/m, 2.16, 0.15, "gamma shield: flux in the last layer");
  check((await app(() => window.yamcOnline.plots)) === 2, "gamma shield drew the tally and the geometry");
  fetched = await app(() => window.yamcOnline.fetched);
  const photonData = fetched.filter((f) => f.kind === "photon").map((f) => f.name).sort().join(",");
  check(photonData === "H,O", "gamma shield fetched photon data for H and O", photonData);
  checkDownloadCounter(out, "gamma shield", "elements");

  out = await runCode(examples["Neutrons and photons"]);
  check(out.includes("Photon heating:  3.046 MeV per source neutron"), "coupled: photon heating", out);
  check(out.includes("Captures on H1: 0.7613 per source neutron"), "coupled: hydrogen captures");
  check((await app(() => window.yamcOnline.plots)) === 1, "coupled drew the photon flux map");

  // The windowed column is the page's: the analog column matches the native
  // wheel to the digit, but the generated windows do not, so the windowed
  // flux differs in its later digits (native yamc-core 0.24.0 gives 9.199e-06
  // at 295 cm, as 0.17.0 gave 9.207e-06 against the page's 9.477e-06). yamc
  // 0.28.0 sets the windows' density reduction itself, and gives 8.133e-06
  // +/- 31% where 0.27.0 gave 9.469e-06 +/- 41%.
  out = await runCode(examples["Weight windows"]);
  check(out.includes("      295    0.000e+00 +/-   0%    8.133e-06 +/-  31%"), "weight windows: only the windows reach the back", out);
  check(out.includes("Layers with a score: analog 27 of 30, weight windows 30 of 30"), "weight windows: layers reached");
  check((await app(() => window.yamcOnline.plots)) === 2, "weight windows drew both flux maps");

  // -- Transmutation ---------------------------------------------------------
  // Values from the native wheel, which gives the same to the printed digit.
  const before = new Set((await app(() => window.yamcOnline.fetched)).map((f) => `${f.kind}/${f.name}`));
  out = await runCode(examples["Lithium activation"]);
  check(out.includes("Tritium made: 392.0 appm, helium-4: 399.9 appm"), "lithium activation: gas production", out);
  check(out.includes("30 days of irradiation     5.1970e+13    H3 62.3%"), "lithium activation: activity at shutdown");
  check(out.includes("1 year more                3.0607e+13    H3 100.0%"), "lithium activation: activity after a year");
  // What this run fetched: the earlier examples already hold Li6, Li7 and H1.
  fetched = (await app(() => window.yamcOnline.fetched)).filter((f) => !before.has(`${f.kind}/${f.name}`));
  const chain = fetched.filter((f) => f.kind === "transmutation").map((f) => f.name).sort().join(",");
  check(chain === "decay,fission_yields,reactions", "lithium activation fetched the transmutation chain", chain);
  const reached = fetched.filter((f) => f.kind === "neutron").map((f) => f.name).sort().join(",");
  check(reached === "H2,H3,He3", "lithium's chain reaches only H, He and Li", reached);

  out = await runCode(examples["Activated sphere"]);
  check(out.includes("Tritium bred in a year: 6.83 g"), "activated sphere: tritium bred", out);
  check(out.includes("1 year of operation          3.1120e+15     2.0615e+02"), "activated sphere: activity and decay heat at shutdown");
  check(out.includes("10 years more                1.3842e+15     1.2619e+00"), "activated sphere: activity and decay heat after cooling");

  // -- A rich line anywhere in the script is drawn ---------------------------
  // `model.plot()` above `show(result)` is drawn where it stands, before the
  // result, as a notebook cell would, and not only as the script's last line.
  const reordered = examples["Lithium sphere"].replace("show(result)\nmodel.plot()", "model.plot()\nshow(result)\nx = 1");
  check(reordered !== examples["Lithium sphere"], "the reordered script differs");
  await runCode(reordered);
  const captions = await app(() => [...document.querySelectorAll("#plots figcaption span")].map((s) => s.textContent));
  check(captions.length === 2 && captions[0] !== "TallyResult" && captions[1] === "TallyResult",
    "a model.plot() line partway down is drawn, in order", captions.join(", "));

  // -- Errors ---------------------------------------------------------------
  out = await runCode("import yamc\n\nx = 1\nyamc.Sphere(radius=-1.0).nonexistent\n");
  check(/File "model\.py", line 4/.test(out), "a traceback points at the script's line", out);
  check(!out.includes("_pyodide") && !out.includes("eval_code"), "the traceback hides Pyodide's frames");
  check((await status()).startsWith("Failed"), "status says Failed");
  check(await page.isVisible('[data-panel="output"]'), "a failed run lands on the Output tab");

  out = await runCode("import yamc\nyamc.MeshGeometry('blanket.vtk')\n");
  check(out.includes("CSG geometry only"), "mesh geometry says the browser is CSG only", out);

  out = await runCode("def f(:\n  pass\n");
  check(out.includes("SyntaxError"), "a syntax error is reported", out);

  // -- Stop -----------------------------------------------------------------
  await app((c) => window.yamcOnline.setCode(c), "import time\nwhile True:\n    time.sleep(0.01)\n");
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => window.yamcOnline.state === "running");
  await page.waitForTimeout(500);
  await page.click("#stop");
  await waitReady();
  out = await output();
  check(out.includes("KeyboardInterrupt"), "Stop interrupts Python", out);
  fetched = await app(() => window.yamcOnline.fetched);
  check(fetched.length > 0, "an interrupt keeps the held data (no restart)");

  // Transport is one call into Rust, which never looks at the interrupt, so
  // Stop falls back to restarting Python once the grace period is up.
  await app((c) => window.yamcOnline.setCode(c), examples["Lithium sphere"].replace("simulate_transport()", "simulate_transport(total_particles=50_000_000)"));
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => document.getElementById("output").textContent.includes("Progress:"), null, { timeout: RUN_TIMEOUT });
  await page.click("#stop");
  await waitReady();
  out = await output();
  check(out.includes("Stopped. Python was restarted."), "Stop during transport restarts Python", out.slice(-300));

  // -- No library is an ordinary error --------------------------------------
  // With no neutron_cross_section_data the load stops with a message naming
  // the setting, as an exception `except Exception` catches. Before yamc-core
  // 0.16.0 this was a Rust panic.
  out = await runCode(
    "import yamc\nyamc.neutron_cross_section_data = None\n" +
    "m = yamc.Material(composition={'Li6': 1.0}, density=0.46)\n" +
    "c = yamc.Cell(region=yamc.Sphere(radius=1, boundary='vacuum').below, material=m)\n" +
    "yamc.Model(geometry=yamc.Geometry([c]), tallies=[], source=yamc.NeutronSource(energy=1e6))" +
    ".simulate_transport(total_particles=10)\n",
  );
  check(out.includes("no neutron cross-section library is configured") && !out.includes("PanicException"),
    "no neutron_cross_section_data is an ordinary error naming the setting", out);

  // -- A Rust panic is a Python exception ----------------------------------
  // The lithium sphere with its source outside the geometry: every history is
  // lost, and transport stops with a Rust panic ("Maximum lost particles
  // exceeded"). pyo3 turns the panic into PanicException, and the
  // interpreter carries on. Until core#396 a zero direction vector was the
  // trigger; it raises ValueError since. If core comes to raise an ordinary
  // exception here too, this needs another input that panics.
  //
  // 100 histories, not the example's run to convergence. The first panic
  // comes once 11 are lost either way, but more follow before the run stops,
  // each with its lost-particle diagnostics: at 10 000 that was 145 panics and
  // over a minute here, at 100 it is 7 and under a second.
  const lost = examples["Lithium sphere"]
    .replace("position=(0.0, 0.0, 0.0)", "position=(100.0, 0.0, 0.0)")
    .replace("simulate_transport()", "simulate_transport(total_particles=100)");
  check(lost.includes("position=(100.0, 0.0, 0.0)") && lost.includes("total_particles=100)"),
    "the script moves the source out of the sphere and runs 100 histories");
  out = await runCode(lost);
  check(out.includes("PanicException") && !out.includes("Restarting Python"), "a Rust panic is a Python exception, not a crash", out);
  out = await runCode(examples["Lithium sphere"]);
  // The example runs until its statistical checks pass, and the stop point
  // depends on wall time (the figure-of-merit checks), so no exact value.
  check(out.includes(CONVERGED) && out.includes("Tritium production: "),
    "Python runs the example to convergence again after a panic", out.slice(-300));

  // -- Completion list is readable in the dark palette ---------------------
  {
    const dark = await browser.newContext({ colorScheme: "dark", viewport: { width: 1400, height: 900 } });
    const dp = await dark.newPage();
    await dp.goto(`${base}#code=`);
    await dp.waitForFunction(() => window.yamcOnline);
    await dp.evaluate(() => window.yamcOnline.setCode(""));
    await dp.click("#editor .cm-content");
    await dp.keyboard.type("imp");
    const tooltip = dp.locator(".cm-tooltip-autocomplete").first();
    await tooltip.waitFor({ timeout: 10_000 });
    const colours = await tooltip.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor];
    });
    // Luminance of an rgb() string, 0 (black) to 1 (white).
    const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    check(Math.abs(lum(colours[0]) - lum(colours[1])) > 0.5, "the completion list is readable in dark mode", colours.join(" on "));
    await dark.close();
  }

  // -- Drafts ---------------------------------------------------------------
  // Edited code is kept for the next visit; an unedited example is not, so a
  // stale copy of one never hides the example as updated.
  {
    const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const dp = await fresh.newPage();
    const draft = () => dp.evaluate(() => localStorage.getItem("yamc-online:draft"));
    const opened = () => dp.evaluate(() => window.yamcOnline.code());
    await dp.goto(base);
    await dp.waitForFunction(() => window.yamcOnline);
    await dp.evaluate((c) => localStorage.setItem("yamc-online:draft", c), examples["Gamma shielding"]);
    await dp.reload();
    await dp.waitForFunction(() => window.yamcOnline);
    check((await opened()).startsWith("# Lithium sphere:"), "a draft that is an unedited example is not restored");
    const edited = `${examples["Gamma shielding"]}print("edited")\n`;
    await dp.evaluate((c) => window.yamcOnline.setCode(c), edited);
    await dp.waitForFunction(() => localStorage.getItem("yamc-online:draft") !== null && localStorage.getItem("yamc-online:draft").endsWith('print("edited")\n'));
    await dp.reload();
    await dp.waitForFunction(() => window.yamcOnline);
    check((await opened()) === edited, "an edited draft is restored");
    await dp.evaluate(() => {
      // Accept the "Replace the code?" prompt, as a user would.
      window.confirm = () => true;
      const select = document.getElementById("example");
      select.value = "1";
      select.dispatchEvent(new Event("change"));
    });
    await dp.waitForFunction(() => localStorage.getItem("yamc-online:draft") === null);
    check((await draft()) === null, "choosing an example leaves no draft");
    await fresh.close();
  }

  // -- Share link -----------------------------------------------------------
  const shared = "import yamc\nprint('shared ✓', 2 + 2)\n";
  await app((c) => window.yamcOnline.setCode(c), shared);
  await page.click("#share");
  await page.waitForFunction(() => location.hash.startsWith("#code="));
  const link = page.url();
  check(link.includes("#code="), "Share puts the code in the hash");
  const second = await context.newPage();
  await second.goto(link);
  await second.waitForFunction(() => window.yamcOnline);
  check((await second.evaluate(() => window.yamcOnline.code())) === shared, "a shared link opens the same code");
  await second.close();

  // -- Live origin ----------------------------------------------------------
  if (args.includes("--live")) {
    const live = await context.newPage();
    await live.goto(`${base}#code=`);
    await live.waitForFunction(() => window.yamcOnline && window.yamcOnline.state === "ready", null, { timeout: RUN_TIMEOUT });
    await live.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, examples["Lithium sphere"]);
    await live.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
    const liveOut = await live.textContent("#output");
    near(liveOut, /Tritium production: ([0-9.e+-]+)/, 1.260, 0.02, "live: the published data gives the same answer");
    // And the published photon data, through the gamma shield.
    await live.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, examples["Gamma shielding"]);
    await live.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
    const livePhoton = await live.textContent("#output");
    near(livePhoton, /^ +3\.0 +([0-9.e+-]+)/m, 11.05, 0.3, "live: the published photon data gives the same answer");
    await live.close();
  }

  // -- What the page asked for ----------------------------------------------
  const allowed = args.includes("--live") ? [...offOrigin].filter((u) => !u.startsWith("https://yamc-data.xsplot.com/")) : [...offOrigin];
  const except = WHEEL ? "the Pyodide CDN" : "the Pyodide CDN and PyPI";
  check(allowed.length === 0, `no requests off-origin except ${except}`, allowed.slice(0, 5).join(", "));
  check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join("; "));

  await page.screenshot({ path: "verify.png" });
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
