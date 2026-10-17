// End-to-end check: run the examples in a real browser and look at what comes
// back.
//
// The page is served from dist/ with core's nuclear-data fixtures beside it
// (see serve.mjs), and opened with `?data=/fixtures/`, so the worker's own
// fetch path is exercised against real data without the network. Pyodide
// comes from the CDN and yamc-core from PyPI, as in production, unless the
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

const PYODIDE_CDN = "https://cdn.jsdelivr.net";
// Where yamc-core comes from when the page installs the PyPI release: the
// JSON API naming the wheel, and the host serving it.
const PYPI = ["https://pypi.org/", "https://files.pythonhosted.org/"];
const RUN_TIMEOUT = 180_000;

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(`${msg}${detail ? `: ${detail}` : ""}`));

const args = process.argv.slice(2);

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
  if (WHEEL) ok(`installed yamc-core from ${WHEEL}, not PyPI`);
  else check(booted.includes(`yamc ${YAMC_CORE_VERSION} `), `installed yamc-core ${YAMC_CORE_VERSION} from PyPI`, booted);
  check(await app(() => self.crossOriginIsolated), "cross-origin isolated, so Stop can interrupt");

  const titles = await app(() => [...document.getElementById("example").options].map((o) => o.text));
  check(titles.join("|") === "Li-6 sphere|Shielding slab|Mesh tally|Gamma shielding|Neutrons and photons|Weight windows|Tokamak|Lithium activation|Activated sphere", "examples menu", titles.join(", "));

  // -- The default example, with one click ----------------------------------
  // What a first visitor gets: the editor holds the Li-6 sphere, and Run.
  check((await app(() => window.yamcOnline.code())).startsWith("# Li-6 sphere:"), "the editor opens on the Li-6 sphere");
  await page.click("#run");
  await page.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
  let out = await output();
  // The native wheel gives this to the digit: the same Rust, the same seed.
  check(out.includes("Tritium production: 3.3274e-02 +/- 8.3e-04 per source neutron"), "Li-6 tritium production matches native", out);
  check((await app(() => window.yamcOnline.plots)) === 2, "Li-6 drew the tally and the geometry");
  check((await page.locator("#plots iframe").count()) === 2, "two sandboxed plot frames");
  check((await page.getAttribute("#plots iframe", "sandbox")) === "allow-scripts", "plot frames are sandboxed");
  check(await page.isVisible('[data-panel="plots"]'), "a successful run lands on the Plots tab");
  // The geometry viewer draws into a canvas from its own script.
  const viewer = page.frameLocator("#plots figure:nth-of-type(2) iframe");
  await viewer.locator("canvas").first().waitFor({ timeout: 30_000 });
  ok("geometry viewer drew a canvas");
  const progressLines = out.split("\n").filter((l) => l.startsWith("Progress:")).length;
  check(progressLines === 1, "progress lines collapse into one", `${progressLines} lines`);
  checkDownloadCounter(out, "Li-6", "nuclides");
  const li6Run = await app(() => window.yamcOnline.runFetch);
  check(li6Run.batched > 1 && li6Run.batched <= li6Run.requests, "the downloads went out as a batch", JSON.stringify(li6Run));
  check(dataPeak > 1, "data requests were in flight together", `peak ${dataPeak}`);

  // Besides the release index (latest.json and the manifest).
  const nuclearData = async () => (await app(() => window.yamcOnline.fetched)).filter((f) => f.kind !== "release");
  let fetched = await nuclearData();
  check(fetched.length === 1 && fetched[0].name === "Li6", "fetched Li6 and nothing else", JSON.stringify(fetched));
  const li6Bytes = fetched[0].bytes;

  // -- Reruns read the held data --------------------------------------------
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
  fetched = await nuclearData();
  check(fetched[0].bytes === li6Bytes, "a rerun fetches nothing", `${fetched[0].bytes} vs ${li6Bytes}`);

  // -- Data tab -------------------------------------------------------------
  await page.click('[data-tab="data"]');
  const dataText = await page.textContent("#data");
  check(dataText.includes("Li6") && dataText.includes("Python heap"), "Data tab lists the nuclide and the heap");

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
  check(out.includes("     3.0    1.1927e+01 +/- 9.7e-02"), "slab: flux in the first layer matches native", out);
  check(out.includes("Front to back attenuation: 13.5x"), "slab: attenuation matches native");
  out = await runCode(examples["Mesh tally"]);
  check(out.includes("3600 mesh voxels, peak flux 3.876e-01"), "mesh tally matches native", out);
  check((await app(() => window.yamcOnline.plots)) === 1, "mesh tally drew its map");

  // -- Photons ---------------------------------------------------------------
  // Values taken from the page with the wheel in vendor/, against the fixtures.
  out = await runCode(examples["Gamma shielding"]);
  check(out.includes("      3.0    1.1139e+01 +/- 6.6e-02      4.9633e+00     2.24"), "gamma shield: flux in the first layer", out);
  check(out.includes("     57.0    2.1110e+00 +/- 4.0e-02      1.6434e-01    12.85"), "gamma shield: flux in the last layer");
  check((await app(() => window.yamcOnline.plots)) === 2, "gamma shield drew the tally and the geometry");
  fetched = await app(() => window.yamcOnline.fetched);
  const photonData = fetched.filter((f) => f.kind === "photon").map((f) => f.name).sort().join(",");
  check(photonData === "H,O", "gamma shield fetched photon data for H and O", photonData);
  checkDownloadCounter(out, "gamma shield", "elements");

  out = await runCode(examples["Neutrons and photons"]);
  check(out.includes("Photon heating:  3.077 MeV per source neutron"), "coupled: photon heating", out);
  check(out.includes("Captures on H1: 0.7613 per source neutron"), "coupled: hydrogen captures");
  check((await app(() => window.yamcOnline.plots)) === 1, "coupled drew the photon flux map");

  out = await runCode(examples["Weight windows"]);
  check(out.includes("      295    0.000e+00 +/-   0%    9.477e-06 +/-  41%"), "weight windows: only the windows reach the back", out);
  check(out.includes("Layers with a score: analog 27 of 30, weight windows 30 of 30"), "weight windows: layers reached");
  check((await app(() => window.yamcOnline.plots)) === 2, "weight windows drew both flux maps");

  // -- Transmutation ---------------------------------------------------------
  // Values from the native wheel, which gives the same to the printed digit.
  const before = new Set((await app(() => window.yamcOnline.fetched)).map((f) => `${f.kind}/${f.name}`));
  out = await runCode(examples["Lithium activation"]);
  check(out.includes("Tritium made: 392.0 appm, helium-4: 399.9 appm"), "lithium activation: gas production", out);
  check(out.includes("30 days of irradiation     5.1970e+13    H3 62.3%"), "lithium activation: activity at shutdown");
  check(out.includes("1 year more                3.0607e+13    H3 100.0%"), "lithium activation: activity after a year");
  // What this run fetched: the earlier examples already hold Li6 and H1.
  fetched = (await app(() => window.yamcOnline.fetched)).filter((f) => !before.has(`${f.kind}/${f.name}`));
  const chain = fetched.filter((f) => f.kind === "transmutation").map((f) => f.name).sort().join(",");
  check(chain === "decay,fission_yields,reactions", "lithium activation fetched the transmutation chain", chain);
  const reached = fetched.filter((f) => f.kind === "neutron").map((f) => f.name).sort().join(",");
  check(reached === "H2,H3,He3,Li7", "lithium's chain reaches only H, He and Li", reached);

  out = await runCode(examples["Activated sphere"]);
  check(out.includes("Tritium bred in a year: 6.83 g"), "activated sphere: tritium bred", out);
  check(out.includes("1 year of operation          3.1120e+15     2.0615e+02"), "activated sphere: activity and decay heat at shutdown");
  check(out.includes("10 years more                1.3842e+15     1.2619e+00"), "activated sphere: activity and decay heat after cooling");

  // -- A rich line anywhere in the script is drawn ---------------------------
  // `model.plot()` above `show(result)` is drawn where it stands, before the
  // result, as a notebook cell would, and not only as the script's last line.
  const reordered = examples["Li-6 sphere"].replace("show(result)\nmodel.plot()", "model.plot()\nshow(result)\nx = 1");
  check(reordered !== examples["Li-6 sphere"], "the reordered script differs");
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
  await app((c) => window.yamcOnline.setCode(c), examples["Li-6 sphere"].replace("10_000", "50_000_000"));
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => document.getElementById("output").textContent.includes("Progress:"), null, { timeout: RUN_TIMEOUT });
  await page.click("#stop");
  await waitReady();
  out = await output();
  check(out.includes("Stopped. Python was restarted."), "Stop during transport restarts Python", out.slice(-300));

  // -- No library is an ordinary error --------------------------------------
  // With no cross_section_data the load stops with a message naming the
  // setting, as an exception `except Exception` catches. Before yamc-core
  // 0.16.0 this was a Rust panic.
  out = await runCode(
    "import yamc\nyamc.cross_section_data = None\n" +
    "m = yamc.Material(composition={'Li6': 1.0}, density=0.46)\n" +
    "c = yamc.Cell(region=yamc.Sphere(radius=1, boundary='vacuum').below, material=m)\n" +
    "yamc.Model(geometry=yamc.Geometry([c]), tallies=[], source=yamc.NeutronSource(energy=1e6))" +
    ".simulate_transport(total_particles=10)\n",
  );
  check(out.includes("no neutron cross-section library is configured") && !out.includes("PanicException"),
    "no cross_section_data is an ordinary error naming the setting", out);

  // -- A Rust panic is a Python exception ----------------------------------
  // A zero direction vector panics in the Rust constructor rather than
  // raising ValueError. pyo3 turns the panic into PanicException, and the
  // interpreter carries on. If core comes to raise ValueError here, this
  // needs another input that panics.
  out = await runCode("import yamc\nyamc.sources.Monodirectional((0.0, 0.0, 0.0))\n");
  check(out.includes("PanicException") && !out.includes("Restarting Python"), "a Rust panic is a Python exception, not a crash", out);
  out = await runCode(examples["Li-6 sphere"]);
  check(out.includes("Tritium production: 3.3274e-02"), "Python runs the example again after a panic");

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
    check((await opened()).startsWith("# Li-6 sphere:"), "a draft that is an unedited example is not restored");
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
    await live.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, examples["Li-6 sphere"]);
    await live.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
    const liveOut = await live.textContent("#output");
    check(liveOut.includes("Tritium production: 3.3274e-02"), "live: the published data gives the same answer", liveOut);
    // And the published photon data, through the gamma shield.
    await live.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, examples["Gamma shielding"]);
    await live.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
    const livePhoton = await live.textContent("#output");
    check(livePhoton.includes("      3.0    1.1139e+01 +/- 6.6e-02"), "live: the published photon data gives the same answer", livePhoton);
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
