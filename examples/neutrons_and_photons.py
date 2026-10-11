# Neutrons and photons: 14 MeV neutrons in a sphere of water, with the gammas
# they produce transported too. Hydrogen captures the slowed-down neutrons and
# emits a 2.2 MeV gamma each time, so part of the heating is carried by
# photons. Scores the heating per particle and maps the photon flux. H1, O16
# and H and O photon data: about 8 MB.
import yamc

yamc.cross_section_data = "endf-b8.1"

water = yamc.Material(composition={"H1": 2.0, "O16": 1.0}, density=1.0, temperature=294, name="water")
# Photon transport reads per-element photon data; this fetches it for H and O.
water.read_nuclear_data("endf-b8.1")

sphere = yamc.Sphere(radius=50.0, boundary="vacuum")
cell = yamc.Cell(region=sphere.below, material=water, name="water")
geometry = yamc.Geometry(cells=[cell])

source = yamc.NeutronSource(energy=14.06e6, position=(0.0, 0.0, 0.0))

neutron_heating = yamc.Tally(cells=cell, particle="neutron", scores=["heating"], name="neutron heating")
photon_heating = yamc.Tally(cells=cell, particle="photon", scores=["heating"], name="photon heating")
# MT 102 is (n,gamma): radiative capture, mostly on hydrogen here.
capture = yamc.Tally(cells=cell, scores=[102], nuclides=["H1", "O16"], name="captures")

mesh = yamc.RegularRectangularMesh(lower_left=(-50, -1, -50), upper_right=(50, 1, 50), shape=(50, 1, 50))
photon_flux = yamc.Tally(mesh=mesh, particle="photon", scores=["flux"], name="photon flux")

# transport_secondary_photons=True follows every gamma the neutrons make.
model = yamc.Model(
    geometry=geometry,
    tallies=[neutron_heating, photon_heating, capture, photon_flux],
    source=source,
    transport_secondary_photons=True,
)
results = model.simulate_transport(total_particles=10_000, seed=1)

n_heat = results[neutron_heating].mean[0] / 1e6
p_heat = results[photon_heating].mean[0] / 1e6
print(f"Neutron heating: {n_heat:.3f} MeV per source neutron")
print(f"Photon heating:  {p_heat:.3f} MeV per source neutron")
print(f"Photon share of the heating: {p_heat / (n_heat + p_heat):.1%}")
for nuclide, mean in zip(["H1", "O16"], results[capture].mean):
    print(f"Captures on {nuclide}: {mean:.4f} per source neutron")

photon_flux.plot(geometry=geometry, basis="xz")
