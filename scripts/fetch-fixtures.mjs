// Download the nuclear data verify.mjs runs against, into the layout core's
// fixtures use (`<dir>/<Name>.arrow/<section>`, neutron nuclides and photon
// elements side by side), with the transmutation chain's subsections under
// `<dir>/transmutation/<subsection>.arrow/<section>`.
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
// (H1, O16, Li6, and H and O photon data), and the two lithium transmutation
// examples (Li7, and the H2, H3 and He3 their chain reaches, and the chain
// itself). The tokamak is listed, not run.
export const NEUTRON = ["Li6", "H1", "O16", "Li7", "H2", "H3", "He3"];
export const PHOTON = ["H", "O"];
export const TRANSMUTATION = ["decay", "reactions", "fission_yields", "branching"];
const SECTIONS = {
  neutron: [
    "version.json", "nuclide.arrow", "energy.arrow", "reactions.arrow", "products.arrow",
    "distributions.arrow", "urr.arrow", "total_nu.arrow", "fission_photon.arrow",
  ],
  photon: ["version.json", "element.arrow", "subshells.arrow", "compton.arrow", "bremsstrahlung.arrow"],
  // Keyed by subsection; every file a subsection can publish, optional ones
  // included.
  decay: ["nuclides.arrow", "decay_modes.arrow", "sources.arrow", "provenance.json"],
  reactions: ["reactions.arrow", "provenance.json"],
  fission_yields: ["fission_yields.arrow", "aliases.arrow", "evaluated_yields.arrow", "provenance.json"],
  branching: ["branching.arrow", "branching_covariance.arrow", "provenance.json"],
};

// verify.mjs imports the lists above; only a direct run downloads.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || ".fixtures";
  let total = 0;
  const wanted = [
    ...NEUTRON.map((name) => ["neutron", name, name, SECTIONS.neutron]),
    ...PHOTON.map((name) => ["photon", name, name, SECTIONS.photon]),
    ...TRANSMUTATION.map((sub) => ["transmutation", sub, join("transmutation", sub), SECTIONS[sub]]),
  ];
  for (const [kind, name, local, sections] of wanted) {
    const target = join(dir, `${local}.arrow`);
    await mkdir(target, { recursive: true });
    for (const section of sections) {
      const res = await fetch(`${ORIGIN}/${kind}/${name}.arrow/${section}`);
      if (res.status === 404) continue; // an optional section this one does not publish
      if (!res.ok) throw new Error(`${kind}/${name}/${section}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      await writeFile(join(target, section), body);
      total += body.length;
    }
  }
  console.log(`${NEUTRON.join(", ")}, ${PHOTON.join(", ")} photon data and the transmutation chain into ${dir}: ${(total / 1048576).toFixed(1)} MB`);
}
