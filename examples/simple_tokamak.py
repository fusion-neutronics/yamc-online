# Simple tokamak: two spheres and a z-cylinder make a plasma, a lithium blanket
# around it and an iron centre column through the middle. A ring of 14 MeV
# neutrons in the plasma, clear of the column, scoring the tritium bred in the
# blanket.
import math

import yamc

# The nuclear data library, fetched on demand from yamc-data.xsplot.com.
yamc.cross_section_data = "endf-b8.1"

lithium = yamc.Material(composition={"Li6": 1.0}, density=0.46, temperature=294, name="Li6 blanket")
# Fe56 alone rather than natural iron, which is 92% Fe56 and four isotopes'
# worth of nuclear data to download.
iron = yamc.Material(composition={"Fe56": 1.0}, density=7.87, temperature=294, name="iron")

centre_column = yamc.Cylinder(axis="z", radius=40.0)
first_wall = yamc.Sphere(radius=150.0)
blanket_back = yamc.Sphere(radius=250.0, boundary="vacuum")

column = yamc.Cell(region=centre_column.below & blanket_back.below, material=iron, name="centre column")
plasma = yamc.Cell(region=centre_column.above & first_wall.below, name="plasma")
blanket = yamc.Cell(
    region=centre_column.above & first_wall.above & blanket_back.below, material=lithium, name="blanket"
)
geometry = yamc.Geometry(cells=[column, plasma, blanket])

# A thin ring of D-T neutrons in the midplane, at a radius of 95 cm: outside
# the 40 cm column and inside the 150 cm first wall, so every neutron starts in
# the plasma.
ring = yamc.sources.CylindricalRing(
    radius=yamc.sources.Discrete([95.0], [1.0]),
    phi=yamc.sources.Uniform(0.0, 2 * math.pi),
    z=yamc.sources.Discrete([0.0], [1.0]),
)
source = yamc.NeutronSource(energy=14.06e6, position=ring)

# MT 105 is (n,t): one tritium atom per reaction.
tritium = yamc.Tally(cells=blanket, scores=[105], name="tritium production")

model = yamc.Model(geometry=geometry, tallies=[tritium], source=source)
results = model.simulate_transport(total_particles=10_000, seed=1)

result = results[tritium]
print(f"Tritium bred per source neutron: {result.mean[0]:.4e} +/- {result.standard_deviation[0]:.1e}")

# show() renders anything with a rich display into the Plots tab.
show(result)
# A vertical slice, through the column, shows the tokamak's profile.
model.plot(basis="xz")
