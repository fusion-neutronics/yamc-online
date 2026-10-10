# PbLi breeder blanket: a 14 MeV point source in a plasma void, surrounded by
# 60 cm of lead-lithium eutectic enriched to 90% Li-6, scoring the tritium
# breeding ratio (TBR) and the heating.
#
# Lead is heavy on nuclear data: the four Pb isotopes and Li6/Li7 are about
# 90 MB to download, so the first run takes a while. Reruns reuse it.
import yamc

yamc.cross_section_data = "endf-b8.1"

enrichment = 0.9
pbli = yamc.Material(
    composition={"Pb": 0.83, "Li6": 0.17 * enrichment, "Li7": 0.17 * (1 - enrichment)},
    density=9.4,
    temperature=600,
    name="PbLi breeder",
)

plasma_edge = yamc.Sphere(radius=150.0)
breeder_back = yamc.Sphere(radius=210.0, boundary="vacuum")
plasma = yamc.Cell(region=plasma_edge.below, name="plasma")
breeder = yamc.Cell(region=plasma_edge.above & breeder_back.below, material=pbli, name="breeder")
geometry = yamc.Geometry(cells=[plasma, breeder])

source = yamc.NeutronSource(
    energy=yamc.sources.fusion_neutron_spectrum(20000.0),
    position=(0.0, 0.0, 0.0),
)

tbr = yamc.Tally(cells=breeder, scores=["H3-production"], nuclides=["Li6", "Li7", "total"], name="TBR")
heating = yamc.Tally(cells=breeder, scores=["heating"], name="breeder heating")

model = yamc.Model(geometry=geometry, tallies=[tbr, heating], source=source)
results = model.simulate_transport(total_particles=5_000, seed=1)

for nuclide, mean, std in zip(["Li6", "Li7", "total"], results[tbr].mean, results[tbr].standard_deviation):
    print(f"TBR from {nuclide:5s}: {mean:.4f} +/- {std:.1e}")
heat = results[heating]
print(f"Breeder heating: {heat.mean[0] / 1e6:.2f} +/- {heat.standard_deviation[0] / 1e6:.2f} MeV per source neutron")

model.plot(basis="xz")
