# Weight windows: Co-60 gammas into 3 m of water, about 17 mean free paths.
# An analog run loses every photon long before the back; weight windows split
# photons as they go deeper and roulette them on the way back, so the same
# number of source photons resolves the flux right through. H1, O16 and H and
# O photon data: about 4.3 MB.
import yamc

yamc.cross_section_data = "endf-b8.1"

water = yamc.Material(composition={"H1": 2.0, "O16": 1.0}, density=1.0, temperature=294, name="water")
# Photon transport reads per-element photon data; this fetches it for H and O.
water.read_nuclear_data("endf-b8.1")

thickness = 300.0
slab = yamc.Plane(axis="x", offset=0.0, boundary="vacuum").above & yamc.Plane(axis="x", offset=thickness, boundary="vacuum").below
for axis in ("y", "z"):
    slab &= yamc.Plane(axis=axis, offset=-100.0, boundary="vacuum").above & yamc.Plane(axis=axis, offset=100.0, boundary="vacuum").below
cell = yamc.Cell(region=slab, material=water, name="water")
geometry = yamc.Geometry(cells=[cell])

# A pencil beam of the two Co-60 lines onto the front face.
source = yamc.PhotonSource(
    energy=yamc.sources.Discrete([1.173e6, 1.332e6], [1.0, 1.0]),
    position=(1e-6, 0.0, 0.0),
    direction=yamc.sources.Monodirectional((1.0, 0.0, 0.0)),
)

# Thirty 10 cm layers through the slab, each one cell across in y and z.
layers = yamc.RegularRectangularMesh(lower_left=(0, -100, -100), upper_right=(thickness, 100, 100), shape=(30, 1, 1))
# A finer map in x and z for the plots.
grid = yamc.RegularRectangularMesh(lower_left=(0, -100, -100), upper_right=(thickness, 100, 100), shape=(60, 1, 40))
analog_flux = yamc.Tally(mesh=layers, particle="photon", scores=["flux"], name="analog")
analog_map = yamc.Tally(mesh=grid, particle="photon", scores=["flux"], name="analog map")
analog = yamc.Model(geometry=geometry, tallies=[analog_flux, analog_map], source=source)

# DeGVR builds the windows from two quick runs at reduced density, where
# photons do reach the back, on the same layers.
generator = yamc.WeightWindowGeneratorDeGVR(mesh=layers, particle="photon")
windows = analog.generate_weight_windows(generator, total_particles=10_000, seed=1)

biased_flux = yamc.Tally(mesh=layers, particle="photon", scores=["flux"], name="weight windows")
biased_map = yamc.Tally(mesh=grid, particle="photon", scores=["flux"], name="weight windows map")
biased = yamc.Model(geometry=geometry, tallies=[biased_flux, biased_map], source=source, variance_reduction=[windows])

analog_result = analog.simulate_transport(total_particles=50_000, seed=1)[analog_flux]
biased_result = biased.simulate_transport(total_particles=50_000, seed=1)[biased_flux]

print("depth (cm)   analog                   weight windows")
for i in range(4, 30, 5):
    a, w = analog_result, biased_result
    print(f"{10 * i + 5:9d}    {a.mean[i]:.3e} +/- {a.relative_error[i]:4.0%}    {w.mean[i]:.3e} +/- {w.relative_error[i]:4.0%}")
reached = lambda r: sum(1 for m in r.mean if m > 0)
print(f"Layers with a score: analog {reached(analog_result)} of 30, weight windows {reached(biased_result)} of 30")

# The analog map goes blank partway in; the weight-windowed one does not.
analog_map.plot(basis="xz", title="analog")
biased_map.plot(basis="xz", title="weight windows")
