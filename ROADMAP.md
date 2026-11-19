# FROSTLINE → Project Vanguard roadmap

Project Vanguard's GDD targets Unreal Engine 5 (C++, Nanite, Lumen, 64 players). FROSTLINE is a browser game
(Three.js + Node), so each GDD system is built as the closest browser equivalent. Parts are built in order:

| Part | GDD sections | Content | Status |
|---|---|---|---|
| 1 | 6.2 | Large village map from the GLB assets, roads, forest belt, cover props, full map (M) | **done** |
| 2 | 2.2, 2.3 | Kinetic inertia + loadout weight, stamina (anaerobic/aerobic), prone + mouse-wheel stance, variable lean, hard mounting, body-cam mode | next |
| 3 | 3.1, 3.2, 7.2 | Physical projectiles: drag, gravity drop, wind, penetration, ricochet; procedural recoil; supersonic crack vs. subsonic thump | |
| 4 | 3.3, 3.4 | Gunsmith (8 attachment points), reload types (tactical / dry / emergency drop), chamber +1, more weapons, scoped PiP optics | |
| 5 | 4.1–4.3, 7.1 | Locational damage multipliers, armor plates, bleeds and fractures, medical items, suppression, diegetic UI (no crosshair/ammo counter) | |
| 6 | 5.1–5.3 | Server-side AI squads: HFSM + behaviour trees, cover rating, flank/suppress, flashbang breaches, radio callouts | |
| 7 | 6.1 | Game modes: Search & Destroy (6v6), Tactical Raid co-op (revives, objectives), Ground War (16v16, wave respawns) | |
| 8 | 6.2, 7.2 | Dynamic weather, destructible cover, interior acoustics, radio squelch, surface footsteps | |
| 9 | 8 | Network hardening for 64 players, lag compensation, performance tuning | |

Known gaps against the GDD: no Nanite/Lumen (so "photoreal" is limited by the GLB's low-poly assets), and the
GLB has only one weapon model and one character, so other weapons and gear will be placeholders.
