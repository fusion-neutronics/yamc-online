# Tokamak: two spheres and a z-cylinder make an iron centre column, a plasma
# and a lead-lithium breeder blanket. A ring of D-T fusion neutrons in the
# plasma, scoring the tritium breeding ratio (TBR) and the blanket heating.
#
# Lead is heavy on nuclear data: Fe56, the four Pb isotopes and Li6/Li7 are
# about 44 MB to download, so the first run takes a while (half a minute or
# more). Reruns reuse it.
import math

import yamc

# The nuclear data library, fetched on demand from yamc-data.xsplot.com.
yamc.cross_section_data = "endf-b8.1"

# Lead-lithium eutectic with its lithium enriched to 90% Li-6.
enrichment = 0.9
pbli = yamc.Material(
    composition={"Pb": 0.83, "Li6": 0.17 * enrichment, "Li7": 0.17 * (1 - enrichment)},
    density=9.4,
    temperature=600,
    name="PbLi breeder",
)
# Fe56 alone rather than natural iron, which is 92% Fe56 and four isotopes'
# worth of nuclear data to download.
iron = yamc.Material(composition={"Fe56": 1.0}, density=7.87, temperature=294, name="iron")

centre_column = yamc.Cylinder(axis="z", radius=40.0)
first_wall = yamc.Sphere(radius=150.0)
blanket_back = yamc.Sphere(radius=210.0, boundary="vacuum")

column = yamc.Cell(region=centre_column.below & blanket_back.below, material=iron, name="centre column")
plasma = yamc.Cell(region=centre_column.above & first_wall.below, name="plasma")
blanket = yamc.Cell(region=centre_column.above & first_wall.above & blanket_back.below, material=pbli, name="blanket")
geometry = yamc.Geometry(cells=[column, plasma, blanket])

# A thin ring of D-T neutrons in the midplane, at a radius of 95 cm: outside
# the 40 cm column and inside the 150 cm first wall, so every neutron starts in
# the plasma. Their energies follow a 20 keV plasma's fusion spectrum.
ring = yamc.sources.CylindricalRing(
    radius=yamc.sources.Discrete([95.0], [1.0]),
    phi=yamc.sources.Uniform(0.0, 2 * math.pi),
    z=yamc.sources.Discrete([0.0], [1.0]),
)
source = yamc.NeutronSource(energy=yamc.sources.fusion_neutron_spectrum(20000.0), position=ring)

tbr = yamc.Tally(cells=blanket, scores=["H3-production"], nuclides=["Li6", "Li7", "total"], name="TBR")
heating = yamc.Tally(cells=blanket, scores=["heating"], name="blanket heating")

model = yamc.Model(geometry=geometry, tallies=[tbr, heating], source=source)
results = model.simulate_transport(total_particles=5_000, seed=1)

for nuclide, mean, std in zip(["Li6", "Li7", "total"], results[tbr].mean, results[tbr].standard_deviation):
    print(f"TBR from {nuclide:5s}: {mean:.4f} +/- {std:.1e}")
heat = results[heating]
print(f"Blanket heating: {heat.mean[0] / 1e6:.2f} +/- {heat.standard_deviation[0] / 1e6:.2f} MeV per source neutron")

# A vertical slice, through the column, shows the tokamak's profile.
model.plot(basis="xz")
