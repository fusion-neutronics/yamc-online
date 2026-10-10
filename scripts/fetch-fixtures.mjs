// Download the nuclear data verify.mjs runs against, into the layout core's
// fixtures use (`<dir>/<Nuclide>.arrow/<section>`).
//
//   node scripts/fetch-fixtures.mjs [dir]      (default: .fixtures)
//
// For CI, which has no core checkout. Locally, core's own fixtures already
// cover these (python3 scripts/fetch_test_fixtures.py in core), and serve.mjs
// reads them by default. These are the published objects, byte for byte, so
// the two are interchangeable.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ORIGIN = "https://yamc-data.xsplot.com/endf-b8.1/neutron";
// What verify.mjs's examples use: the Li-6 sphere, the water slab and the
// mesh tally.
const NUCLIDES = ["Li6", "H1", "O16"];
const SECTIONS = [
  "version.json", "nuclide.arrow", "energy.arrow", "reactions.arrow", "products.arrow",
  "distributions.arrow", "urr.arrow", "total_nu.arrow", "fission_photon.arrow",
];

const dir = process.argv[2] || ".fixtures";
let total = 0;
for (const nuclide of NUCLIDES) {
  const target = join(dir, `${nuclide}.arrow`);
  await mkdir(target, { recursive: true });
  for (const section of SECTIONS) {
    const res = await fetch(`${ORIGIN}/${nuclide}.arrow/${section}`);
    if (res.status === 404) continue; // an optional section this nuclide does not publish
    if (!res.ok) throw new Error(`${nuclide}/${section}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    await writeFile(join(target, section), body);
    total += body.length;
  }
}
console.log(`${NUCLIDES.join(", ")} into ${dir}: ${(total / 1048576).toFixed(1)} MB`);
