// Download the nuclear data verify.mjs runs against, into the layout core's
// fixtures use (`<dir>/<Name>.arrow/<section>`, neutron nuclides and photon
// elements side by side).
//
//   node scripts/fetch-fixtures.mjs [dir]      (default: .fixtures)
//
// For CI, which has no core checkout, and locally for the photon data core's
// fixtures lack (H and O): serve.mjs reads core's fixtures first and
// .fixtures/ second. These are the published objects, byte for byte, so the
// two are interchangeable.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://yamc-data.xsplot.com/endf-b8.1";
// What verify.mjs's examples use: the Li-6 sphere (Li6), the water slab, the
// mesh tally, the gamma shield, the weight windows and the coupled example
// (H1, O16, Li6, and H and O photon data). The tokamak is listed, not run.
export const NEUTRON = ["Li6", "H1", "O16"];
export const PHOTON = ["H", "O"];
const SECTIONS = {
  neutron: [
    "version.json", "nuclide.arrow", "energy.arrow", "reactions.arrow", "products.arrow",
    "distributions.arrow", "urr.arrow", "total_nu.arrow", "fission_photon.arrow",
  ],
  photon: ["version.json", "element.arrow", "subshells.arrow", "compton.arrow", "bremsstrahlung.arrow"],
};

// verify.mjs imports the lists above; only a direct run downloads.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || ".fixtures";
  let total = 0;
  for (const [kind, names] of [["neutron", NEUTRON], ["photon", PHOTON]]) {
    for (const name of names) {
      const target = join(dir, `${name}.arrow`);
      await mkdir(target, { recursive: true });
      for (const section of SECTIONS[kind]) {
        const res = await fetch(`${ORIGIN}/${kind}/${name}.arrow/${section}`);
        if (res.status === 404) continue; // an optional section this one does not publish
        if (!res.ok) throw new Error(`${kind}/${name}/${section}: HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        await writeFile(join(target, section), body);
        total += body.length;
      }
    }
  }
  console.log(`${NEUTRON.join(", ")} and ${PHOTON.join(", ")} photon data into ${dir}: ${(total / 1048576).toFixed(1)} MB`);
}
