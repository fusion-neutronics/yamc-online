# Activated sphere: 14 MeV neutrons into a sphere of lithium hydride, with the
# transport's own reaction rates driving the transmutation. The transport runs
# once, its rates are scaled by the source rate through a year of operation,
# and the activity is followed as the sphere cools. Lithium hydride keeps the
# transmutation chain among H, He and Li: about 14 MB of nuclear data.
import math

import yamc

yamc.cross_section_data = "endf-b8.1"

# transmutable=True picks the materials to deplete; volume converts atom
# densities into the activity of the whole sphere.
radius = 20.0
lithium_hydride = yamc.Material(
    composition={"Li6": 0.0759, "Li7": 0.9241, "H1": 1.0},
    density=0.78,
    temperature=294,
    volume=4 / 3 * math.pi * radius**3,
    transmutable=True,
    name="lithium hydride",
)

sphere = yamc.Sphere(radius=radius, boundary="vacuum")
cell = yamc.Cell(region=sphere.below, material=lithium_hydride, name="sphere")
geometry = yamc.Geometry(cells=[cell])
source = yamc.NeutronSource(energy=14.06e6, position=(0.0, 0.0, 0.0))
model = yamc.Model(geometry=geometry, tallies=[], source=source)

# Here a pulse's rate is the source strength in neutrons per second.
schedule = yamc.PulseSchedule([
    yamc.Pulse(rate=1e17, duration=(1, "a")),
    yamc.Cooldown(duration=(1, "h")),
    yamc.Cooldown(duration=(10, "a")),
])
results = model.simulate_transmutation(method="independent", schedule=schedule, total_particles=10_000, seed=1)

material_id = results.material_ids[0]
tritium = results.get_nuclide_evolution(material_id, "H3")
grams = tritium[1] * 1e24 * lithium_hydride.volume / 6.02214076e23 * 3.016
print(f"Tritium bred in a year: {grams:.2f} g")

print("\nAfter                     Activity (Bq)   Decay heat (W)")
labels = ["1 year of operation", "1 hour of cooling", "10 years more"]
for label, material in zip(labels, results.step_materials(material_id)):
    print(f"{label:24s} {material.activity():14.4e} {material.decay_heat():14.4e}")
