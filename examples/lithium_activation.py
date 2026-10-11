# Lithium activation: a litre of lithium irradiated for 30 days in a given
# neutron flux, then left to cool. No transport: the flux spectrum is supplied,
# collapsed with each nuclide's cross sections, and the inventory is solved
# through every step. Prints the tritium and helium made and the activity as
# it cools. Lithium's transmutation chain stays among H, He and Li, so this
# fetches about 14 MB, most of it the decay data.
import yamc

yamc.cross_section_data = "endf-b8.1"

lithium = yamc.Material(
    composition={"Li6": 0.0759, "Li7": 0.9241}, density=0.534, temperature=294, volume=1000.0, name="lithium",
)

# The spectrum as a histogram: a 14 MeV peak over a slowed-down tail, as in a
# fusion blanket. Edges in eV, and the share of the flux in each bin.
edges = [1e-5, 0.625, 1e3, 1e5, 1e6, 1e7, 13.5e6, 14.5e6]
shares = [0.05, 0.10, 0.15, 0.20, 0.15, 0.05, 0.30]
spectrum = yamc.NeutronSource(energy=yamc.sources.Histogram(edges, shares))

# A pulse's rate is the total flux, in neutrons per cm^2 per second. A
# cooldown is decay alone.
schedule = yamc.PulseSchedule([
    yamc.Pulse(rate=1e14, duration=(30, "d"), source=spectrum),
    yamc.Cooldown(duration=(1, "min")),
    yamc.Cooldown(duration=(1, "d")),
    yamc.Cooldown(duration=(1, "a")),
])
results = lithium.transmute(schedule=schedule)

material_id = lithium.id or 0
gas = results.get_gas_production(material_id)
print(f"Tritium made: {gas['H3'][1]:.1f} appm, helium-4: {gas['He4'][1]:.1f} appm")

print("\nAfter                    Activity (Bq)   Largest part")
labels = ["30 days of irradiation", "1 minute of cooling", "1 day more", "1 year more"]
for label, material in zip(labels, results.step_materials(material_id)):
    by_nuclide = material.activity(by_nuclide=True)
    top = max(by_nuclide, key=by_nuclide.get)
    print(f"{label:24s} {material.activity():12.4e}    {top} {by_nuclide[top] / material.activity():.1%}")
