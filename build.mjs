// Produce dist/: the page, its worker, and everything they load from beside
// them. Pyodide comes from the jsDelivr CDN and yamc-core from PyPI, at the
// versions vendor/PYODIDE_VERSION and vendor/YAMC_CORE_VERSION pin.
//
//   node build.mjs [--wheel path/to/yamc_core-...-pyemscripten_..._wasm32.whl]
//
// `--wheel` copies a local Pyodide wheel of yamc-core into dist/ and installs
// that instead of the PyPI release: for trying an unreleased core, and for
// checking the page offline. A published page is built without it.
//
// Nothing here needs npm: the CodeMirror bundle is committed under vendor/.
// The examples are read from examples/*.py, so each one is also a script that
// runs as-is under `pip install yamc`.

import { readFile, writeFile, mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = new URL("./src/", import.meta.url);
const VENDOR = new URL("./vendor/", import.meta.url);
const EXAMPLES = new URL("./examples/", import.meta.url);
const DIST = new URL("./dist/", import.meta.url);

// The order of the examples menu. The first is what a new visitor sees.
const EXAMPLE_ORDER = [
  "li6_sphere", "water_shield", "mesh_tally", "gamma_shield", "neutrons_and_photons", "weight_windows", "tokamak",
  "lithium_activation", "activated_sphere",
];

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const text = async (url) => (await readFile(url, "utf8")).trim();

/// The title is the first comment line up to its colon: "# Li-6 sphere: ..."
function exampleTitle(name, code) {
  const m = code.match(/^#\s*([^:\n]+):/);
  if (!m) throw new Error(`examples/${name}.py must open with "# Title: description"`);
  return m[1].trim();
}

async function main() {
  const args = process.argv.slice(2);
  const wheelArg = args.indexOf("--wheel");
  const localWheel = wheelArg >= 0 ? resolve(args[wheelArg + 1] || "") : null;
  if (localWheel && !/^yamc_core-.+-pyemscripten_\d+_\d+_wasm32\.whl$/.test(basename(localWheel))) {
    throw new Error(`--wheel wants a Pyodide wheel of yamc-core (yamc_core-*-pyemscripten_*_wasm32.whl), not ${localWheel}`);
  }
  const wheel = localWheel && basename(localWheel);
  const pyodideVersion = await text(new URL("PYODIDE_VERSION", VENDOR));
  const yamcCoreVersion = await text(new URL("YAMC_CORE_VERSION", VENDOR));

  const names = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".py")).map((f) => f.slice(0, -3));
  const unlisted = names.filter((n) => !EXAMPLE_ORDER.includes(n));
  if (unlisted.length) throw new Error(`examples not in EXAMPLE_ORDER: ${unlisted.join(", ")}`);
  const examples = [];
  for (const name of EXAMPLE_ORDER) {
    const code = `${await text(new URL(`${name}.py`, EXAMPLES))}\n`;
    examples.push({ name, title: exampleTitle(name, code), code });
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  for (const f of ["index.html", "app.js", "worker.js", "fetcher.js"]) await copyFile(new URL(f, SRC), new URL(f, DIST));
  for (const f of ["codemirror.js", "coi-serviceworker.min.js"]) await copyFile(new URL(f, VENDOR), new URL(f, DIST));
  if (wheel) await copyFile(pathToFileURL(localWheel), new URL(wheel, DIST));
  // GitHub Pages runs Jekyll otherwise, which would drop nothing here today
  // but has opinions about underscored names.
  await writeFile(new URL(".nojekyll", DIST), "");

  const config =
    "// Written by build.mjs. Edit vendor/ and examples/, not this file.\n" +
    `export const PYODIDE_VERSION = ${JSON.stringify(pyodideVersion)};\n` +
    `export const YAMC_CORE_VERSION = ${JSON.stringify(yamcCoreVersion)};\n` +
    "// A wheel beside the page to install instead of the PyPI release, or null.\n" +
    `export const WHEEL = ${JSON.stringify(wheel)};\n` +
    `export const EXAMPLES = ${JSON.stringify(examples, null, 2)};\n`;
  await writeFile(new URL("config.js", DIST), config);

  const sizes = await Promise.all(
    ["index.html", "app.js", "worker.js", "config.js", "codemirror.js", ...(wheel ? [wheel] : [])].map(async (f) => [f, (await readFile(new URL(f, DIST))).length]),
  );
  console.log(sizes.map(([f, n]) => `dist/${f.padEnd(28)} ${mb(n)}`).join("\n"));
  const core = wheel ? `yamc-core from ${wheel} (not PyPI)` : `yamc-core ${yamcCoreVersion} from PyPI`;
  console.log(`Pyodide ${pyodideVersion} from the CDN, ${core}, ${examples.length} examples`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
