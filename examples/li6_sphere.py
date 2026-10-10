# Li-6 sphere: 14 MeV neutrons into a sphere of Li-6, scoring tritium production.
# The smallest model that does something useful: one nuclide (about 1 MB of
# nuclear data), a second or two to run.
import yamc

# The nuclear data library, fetched on demand from yamc-data.xsplot.com.
yamc.cross_section_data = "endf-b8.1"

lithium = yamc.Material(composition={"Li6": 1.0}, density=0.46, temperature=294, name="Li6")

sphere = yamc.Sphere(radius=10.0, boundary="vacuum")
cell = yamc.Cell(region=sphere.below, material=lithium, name="li6 sphere")
geometry = yamc.Geometry(cells=[cell])

source = yamc.NeutronSource(energy=14.06e6, position=(0.0, 0.0, 0.0))

# MT 105 is (n,t): one tritium atom per reaction.
tritium = yamc.Tally(cells=cell, scores=[105], name="tritium production")

model = yamc.Model(geometry=geometry, tallies=[tritium], source=source)
results = model.simulate_transport(total_particles=10_000, seed=1)

result = results[tritium]
print(f"Tritium production: {result.mean[0]:.4e} +/- {result.standard_deviation[0]:.1e} per source neutron")

# show() renders anything with a rich display into the Plots tab.
show(result)
model.plot()
