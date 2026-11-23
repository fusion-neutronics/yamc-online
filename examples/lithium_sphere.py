# Lithium sphere: 14 MeV neutrons into a sphere of, scoring tritium production.

import yamc

# The neutron cross-section library, fetched on demand
yamc.neutron_cross_section_data = "endf-b8.1"

lithium = yamc.Material(
  composition={"Li": 1.0},
  density=0.56,
  name="TBR-tally"
)

sphere = yamc.Sphere(radius=100.0, boundary="vacuum")
cell = yamc.Cell(region=sphere.below, material=lithium)
geometry = yamc.Geometry(cells=[cell])

source = yamc.NeutronSource(
  energy=14.06e6,
  position=(0.0, 0.0, 0.0)
)

# H3-production covers all reactions with tritium products (e.g MT 205 and 105)
tally1 = yamc.Tally(cells=cell, scores=['H3-production'], name="tritium production")

model = yamc.Model(
  geometry=geometry,
  tallies=[tally1],
  source=source
)

# simulation has no set total_particles or time so will stop when converged and statistical tests all pass
results = model.simulate_transport()

result = results[tally1]
print(f"Tritium production: {result.mean} +/- {result.standard_deviation} per source neutron")

# show() renders anything with a rich display into the Plots tab.
show(result)
model.plot()
