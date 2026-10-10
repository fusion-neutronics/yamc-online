// End-to-end check: run the examples in a real browser and look at what comes
// back.
//
// The page is served from dist/ with core's nuclear-data fixtures beside it
// (see serve.mjs), and opened with `?data=/fixtures/`, so the worker's own
// fetch path is exercised against real data without the network. Pyodide is
// the one thing fetched from outside, from the CDN, as it is in production.
//
//   node verify.mjs [--headed] [--live]
//
// `--live` runs the default example once more against the published data
// origin, which is the only part that needs yamc-data.xsplot.com.
//
// Needs `node build.mjs` first, and core's fixtures for H1, O16 and Li6:
//   python3 scripts/fetch_test_fixtures.py   (in core)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import { serve, FIXTURES } from "./serve.mjs";

const PYODIDE_CDN = "https://cdn.jsdelivr.net";
const RUN_TIMEOUT = 180_000;

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(`${msg}${detail ? `: ${detail}` : ""}`));

const args = process.argv.slice(2);

for (const nuclide of ["Li6", "H1", "O16"]) {
  if (!existsSync(join(FIXTURES, `${nuclide}.arrow`, "version.json"))) {
    console.error(`no ${nuclide} fixture under ${FIXTURES}; run scripts/fetch_test_fixtures.py in core, or set YAMC_FIXTURES`);
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
  if (url === "about:srcdoc") return;
  offOrigin.add(url);
});

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
  ok(`booted: ${await status()}`);
  check(await app(() => self.crossOriginIsolated), "cross-origin isolated, so Stop can interrupt");

  const titles = await app(() => [...document.getElementById("example").options].map((o) => o.text));
  check(titles.join("|") === "Li-6 sphere|Shielding slab|Mesh tally|PbLi breeder blanket", "examples menu", titles.join(", "));

  // -- The default example, with one click ----------------------------------
  // What a first visitor gets: the editor holds the Li-6 sphere, and Run.
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

  let fetched = await app(() => window.yamcOnline.fetched);
  check(fetched.length === 1 && fetched[0].name === "Li6", "fetched Li6 and nothing else", JSON.stringify(fetched));
  const li6Bytes = fetched[0].bytes;

  // -- Reruns read the held data --------------------------------------------
  await app(() => window.yamcOnline.run());
  await page.waitForFunction(() => window.yamcOnline.state === "ready" && window.yamcOnline.plots > 0, null, { timeout: RUN_TIMEOUT });
  fetched = await app(() => window.yamcOnline.fetched);
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

  // -- A Rust panic is a Python exception ----------------------------------
  // The loader panics on a material with no nuclear data source. pyo3 turns
  // the panic into PanicException, and the interpreter carries on.
  out = await runCode(
    "import yamc\nyamc.cross_section_data = None\n" +
    "m = yamc.Material(composition={'Li6': 1.0}, density=0.46)\n" +
    "c = yamc.Cell(region=yamc.Sphere(radius=1, boundary='vacuum').below, material=m)\n" +
    "yamc.Model(geometry=yamc.Geometry([c]), tallies=[], source=yamc.NeutronSource(energy=1e6))" +
    ".simulate_transport(total_particles=10)\n",
  );
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
    await live.close();
  }

  // -- What the page asked for ----------------------------------------------
  const allowed = args.includes("--live") ? [...offOrigin].filter((u) => !u.startsWith("https://yamc-data.xsplot.com/")) : [...offOrigin];
  check(allowed.length === 0, "no requests off-origin except the Pyodide CDN", allowed.slice(0, 5).join(", "));
  check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join("; "));

  await page.screenshot({ path: "verify.png" });
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
