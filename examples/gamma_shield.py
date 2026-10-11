# Gamma shielding: a pencil beam of Co-60 gammas (1.17 and 1.33 MeV) onto
# 60 cm of water, with the photon flux scored in ten 6 cm layers and set
# against the narrow-beam answer, the photons that never scatter. H1, O16 and
# H and O photon data: about 8 MB.
import math

import yamc

yamc.cross_section_data = "endf-b8.1"

water = yamc.Material(composition={"H1": 2.0, "O16": 1.0}, density=1.0, temperature=294, name="water")
# Photon transport reads per-element photon data; this fetches it for H and O.
water.read_nuclear_data("endf-b8.1")

thickness = 60.0
layers = 10
planes = [yamc.Plane(axis="x", offset=thickness * i / layers) for i in range(layers + 1)]
planes[0].boundary = "vacuum"
planes[-1].boundary = "vacuum"
side_lo = [yamc.Plane(axis=a, offset=-100.0, boundary="vacuum") for a in ("y", "z")]
side_hi = [yamc.Plane(axis=a, offset=100.0, boundary="vacuum") for a in ("y", "z")]
sides = side_lo[0].above & side_hi[0].below & side_lo[1].above & side_hi[1].below

cells = [
    yamc.Cell(region=planes[i].above & planes[i + 1].below & sides, material=water, name=f"layer {i}")
    for i in range(layers)
]
geometry = yamc.Geometry(cells=cells)

# Co-60 emits both lines in every decay, so they are equally likely.
lines = [1.173e6, 1.332e6]
source = yamc.PhotonSource(
    energy=yamc.sources.Discrete(lines, [1.0, 1.0]),
    position=(1e-6, 0.0, 0.0),
    direction=yamc.sources.Monodirectional((1.0, 0.0, 0.0)),
)

flux = yamc.Tally(cells=cells, particle="photon", scores=["flux"], name="photon flux per layer")
model = yamc.Model(geometry=geometry, tallies=[flux], source=source)
results = model.simulate_transport(total_particles=20_000, seed=1)


def mu(energy):
    """Attenuation coefficient of water (1/cm) from NIST's XCOM tables."""
    hydrogen = yamc.data.mass_attenuation_coefficient("H").interpolate(energy)
    oxygen = yamc.data.mass_attenuation_coefficient("O").interpolate(energy)
    return 1.0 * (0.1119 * hydrogen + 0.8881 * oxygen)


# The unscattered beam's track length in a layer at this depth. Transport also
# counts the photons scattered into the layer, so it sits above this by the
# buildup factor, which grows with depth.
def uncollided(depth):
    return sum(thickness / layers * math.exp(-mu(e) * depth) for e in lines) / len(lines)


result = results[flux]
print("depth (cm)   flux (cm / source photon)   uncollided   buildup")
for i, (mean, std) in enumerate(zip(result.mean, result.standard_deviation)):
    depth = thickness * (i + 0.5) / layers
    print(f"{depth:9.1f}    {mean:.4e} +/- {std:.1e}      {uncollided(depth):.4e}   {mean / uncollided(depth):6.2f}")

show(result)
model.plot(basis="xy")
