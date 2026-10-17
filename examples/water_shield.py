# Shielding slab: a 14 MeV beam onto 60 cm of water, with the neutron flux
# scored in ten 6 cm layers to show the attenuation. Water is H1 and O16,
# about 3.6 MB of nuclear data.
import yamc

yamc.cross_section_data = "endf-b8.1"

water = yamc.Material(composition={"H1": 2.0, "O16": 1.0}, density=1.0, temperature=294, name="water")

thickness = 60.0
layers = 10
# Planes normal to x at every layer boundary; the outer box is the vacuum edge.
planes = [yamc.Plane(axis="x", offset=thickness * i / layers) for i in range(layers + 1)]
planes[0].boundary = "vacuum"
planes[-1].boundary = "vacuum"
side_lo = [yamc.Plane(axis=a, offset=-50.0, boundary="vacuum") for a in ("y", "z")]
side_hi = [yamc.Plane(axis=a, offset=50.0, boundary="vacuum") for a in ("y", "z")]
sides = side_lo[0].above & side_hi[0].below & side_lo[1].above & side_hi[1].below

cells = [
    yamc.Cell(region=planes[i].above & planes[i + 1].below & sides, material=water, name=f"layer {i}")
    for i in range(layers)
]
geometry = yamc.Geometry(cells=cells)

# A pencil beam entering the front face, pointing into the slab.
source = yamc.NeutronSource(
    energy=14.06e6,
    position=(1e-6, 0.0, 0.0),
    direction=yamc.sources.Monodirectional((1.0, 0.0, 0.0)),
)

flux = yamc.Tally(cells=cells, scores=["flux"], name="flux per layer")
model = yamc.Model(geometry=geometry, tallies=[flux], source=source)
results = model.simulate_transport(total_particles=20_000, seed=1)

result = results[flux]
print("depth (cm)   flux (cm / source neutron)")
for i, (mean, std) in enumerate(zip(result.mean, result.standard_deviation)):
    depth = thickness * (i + 0.5) / layers
    print(f"{depth:9.1f}    {mean:.4e} +/- {std:.1e}")
print(f"Front to back attenuation: {result.mean[0] / result.mean[-1]:.1f}x")

model.plot(basis="xy")
