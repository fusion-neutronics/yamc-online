# Mesh tally: the neutron flux on a 2D grid through a water sphere with a
# Li-6 core, drawn over the geometry. Li6, H1 and O16: about 8 MB of data.
import yamc

yamc.cross_section_data = "endf-b8.1"

lithium = yamc.Material(composition={"Li6": 1.0}, density=0.46, temperature=294, name="Li6")
water = yamc.Material(composition={"H1": 2.0, "O16": 1.0}, density=1.0, temperature=294, name="water")

core = yamc.Sphere(radius=10.0)
outer = yamc.Sphere(radius=40.0, boundary="vacuum")
core_cell = yamc.Cell(region=core.below, material=lithium, name="core")
water_cell = yamc.Cell(region=core.above & outer.below, material=water, name="moderator")
geometry = yamc.Geometry(cells=[core_cell, water_cell])

# Offset from the centre so the map is not symmetric.
source = yamc.NeutronSource(energy=14.06e6, position=(20.0, 0.0, 0.0))

# One cell thick in y: a slice through the middle of the sphere.
mesh = yamc.RegularRectangularMesh(lower_left=(-40, -1, -40), upper_right=(40, 1, 40), shape=(60, 1, 60))
flux_map = yamc.Tally(mesh=mesh, scores=["flux"], name="flux map")

model = yamc.Model(geometry=geometry, tallies=[flux_map], source=source)
results = model.simulate_transport(total_particles=20_000, seed=1)

mean = results[flux_map].mean
print(f"{len(mean)} mesh voxels, peak flux {max(mean):.3e} cm/cm3 per source neutron")

flux_map.plot(geometry=geometry, basis="xz")
