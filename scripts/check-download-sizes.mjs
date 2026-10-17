// Check the download size each example's opening comment quotes against what
// the example fetches when it runs first, on a page holding nothing.
//
//   node scripts/check-download-sizes.mjs [--live]
//
// The quoted figures drifted once already: written before the data moved to
// the release layout, they said 7 to 8 MB for examples that fetch about 4 MB,
// and 145 MB for a tokamak that fetches 44 MB. Nothing compared them with a
// run, so nothing noticed.
//
// A size is the nuclear data the example's own nuclides, elements and
// transmutation chain take, in the page's MB (2^20 bytes, as its status bar and
// Data tab show them). It leaves out the library's index (`latest.json` and the
// release manifest), which the first run of a session fetches whatever the
// example. Each figure must be within 10% of the run's.
//
// Against the fixtures by default (serve.mjs, as verify.mjs runs), which skips
// the tokamak, since they carry no lead or iron. `--live` reads the published
// data origin and checks the tokamak too. Needs `node build.mjs` first, and for
// the fixtures what scripts/fetch-fixtures.mjs lists.

import { chromium } from "playwright";

import { serve } from "../serve.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const TOLERANCE = 0.1;
const RUN_TIMEOUT = 300_000;
const MB = 1048576;

/// The size an example's opening comment quotes, in MB, or null if it quotes
/// none: "about 4.3 MB" or "about half a megabyte".
function quotedSize(code) {
  const header = code.split("\n").filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s?/, "")).join(" ");
  const m = header.match(/about (half a megabyte|(\d+(?:\.\d+)?) MB)/);
  if (!m) return null;
  return m[2] ? Number(m[2]) : 0.5;
}

const server = await serve({ port: 0 });
const base = `http://127.0.0.1:${server.address().port}/`;
const url = `${base}${live ? "" : "?data=/fixtures/"}#code=`;
const browser = await chromium.launch();
let failed = false;
try {
  const ready = (page) => page.waitForFunction(() => window.yamcOnline && window.yamcOnline.state === "ready", null, { timeout: RUN_TIMEOUT });
  const first = await browser.newPage();
  await first.goto(url);
  await ready(first);
  const examples = await first.evaluate(() => {
    const select = document.getElementById("example");
    return [...select.options].map((o) => {
      select.value = o.value;
      select.dispatchEvent(new Event("change"));
      return [o.text, window.yamcOnline.code()];
    });
  });
  await first.close();

  for (const [title, code] of examples) {
    const quoted = quotedSize(code);
    if (quoted === null) {
      console.log(`--    ${title}: quotes no size`);
      continue;
    }
    if (title === "Tokamak" && !live) {
      console.log(`--    ${title}: not in the fixtures (run with --live)`);
      continue;
    }
    // A context of its own, so nothing is held from the example before.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    await ready(page);
    await page.evaluate((c) => { window.yamcOnline.setCode(c); window.yamcOnline.run(); }, code);
    await page.waitForFunction(() => window.yamcOnline.state !== "running", null, { timeout: RUN_TIMEOUT });
    await ready(page);
    const status = await page.textContent("#status");
    const rows = await page.evaluate(() => window.yamcOnline.fetched);
    await context.close();
    const bytes = rows.filter((r) => r.kind !== "release").reduce((s, r) => s + r.bytes, 0);
    const measured = bytes / MB;
    const ok = status.startsWith("Finished") && Math.abs(measured - quoted) <= TOLERANCE * measured;
    failed ||= !ok;
    const what = `${title}: quotes ${quoted} MB, fetched ${measured.toFixed(2)} MB`;
    console.log(ok ? `ok    ${what}` : `FAIL  ${what}${status.startsWith("Finished") ? "" : ` (${status})`}`);
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.error(`\nAn example's comment is more than ${TOLERANCE * 100}% from what it fetches. Correct the comment, with the README if it repeats it.`);
  process.exitCode = 1;
}
