# FROSTLINE — arctic team deathmatch

Browser FPS built around your `map.glb`. Two teams (FROST vs EMBER), first team to 40 kills wins, 12 players per room.
Three.js client + a small Node WebSocket server. Everything in the map (buildings, pines, containers, sandbags, the
Roblox character as the player model, the winter assault rifle as the weapon) comes from the one GLB.

## Controls
| | |
|---|---|
| WASD | move |
| Shift | sprint |
| C | crouch |
| Space | jump (you can hop onto sandbags) |
| Mouse / LMB / RMB | look / fire / aim down sights |
| R | reload |
| M | full map |
| Q / E | lean left / right (peek around cover) |
| C while sprinting | slide |
| Tab | scoreboard |

## Run it on your computer
```bash
npm install
npm start
# open http://localhost:3000 in TWO SEPARATE WINDOWS placed side by side
# (a background browser tab pauses itself, so a second tab is a poor test)
```

## Put it online with GitHub + Render
1. Create a new GitHub repository and push this folder to it (`node_modules` is already git-ignored).
   ```bash
   git init && git add . && git commit -m "FROSTLINE"
   git branch -M main
   git remote add origin https://github.com/<you>/frostline.git
   git push -u origin main
   ```
2. On [render.com](https://render.com): **New → Web Service → connect the repo.**
   `render.yaml` is included, so the settings fill themselves in. If you enter them by hand:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: **Free**
3. Wait for the deploy. Render gives you a URL like `https://frostline.onrender.com`.
4. Open it, enter a name, click **Copy invite link**, and send the link to your friends. Everyone with the same
   `?room=name` plays in the same match.

Notes for Render's free plan: the server sleeps after ~15 minutes with nobody connected, and the first visit after
that takes up to a minute to wake it. Keep one tab open while you play. Free instances are shared CPU, so expect
about 60 ms extra latency unless you pick a region near you.

## The village (Part 1)
The map is now 280 m x 280 m: the original compound in the middle, ring streets with houses (the barracks model), a container
yard in the south-east, sandbag checkpoints and jersey barriers at the road mouths, watchtowers, lamps, crates and drums, and a
forest belt around the edge. FROST deploys from the south, EMBER from the north. Layout is generated from a fixed seed in
`public/js/layout.js`, so everyone gets the same map. See `ROADMAP.md` for the plan against the GDD.
Menu -> Graphics (Low/Medium/High) controls view distance, shadows and resolution. Use Low on weak laptops.

## Bot Horde mode and tanks (Part 1.5)
- Menu -> Mode -> **Bot Horde**: everyone is on one team and fights endless waves of bots (wave n = 6+3n bots, tougher each wave).
  Share the link with `&mode=horde` (Copy invite link does this for you). The mode is set by the first player to create the room.
- Bot AI is a port of your tactical shooter AI module (`ai.js`): patrol / stalk-flank / ambush / overwatch / take-cover states,
  vision cone + line of sight, memory, reaction time, cover scoring, squad blackboard with 3-way pinch. It runs on the server.
- **Tanks** (both modes): walk up and press **F** to drive. WASD drives, mouse aims the turret, LMB fires the cannon (2.4 s reload),
  F exits. Shells have splash damage, tanks can be destroyed (rifles do little, cannons and bots chip away), crush people, wreck
  and respawn after 45 s.
- Extra env vars: `TANK_RELOAD_MS`, `TANK_RESPAWN_MS`, `WAVE_BREAK_MS`.

## Tuning
- Server settings can be changed with environment variables in the Render dashboard:
  `SCORE_LIMIT` (40), `RESPAWN_MS` (4000), `PROTECT_MS` (2500), `OVER_MS` (12000).
- Damage, fire rate, speeds, magazine size: `public/js/shared.js` (client) and the top of `server.js` (damage).
- Lighting can be tweaked live with URL parameters: `?exp=0.8` (exposure), `?env=0.9` (sky reflections),
  `?fog=0.0085` (fog density). Add `?debug` for an FPS / position / object-bounds overlay.
- If other players appear to face backwards, add `?flip`, and if that is the fix, change the `+ (Q.has('flip') ...)`
  term in `prepareAvatarTemplate()` in `public/js/game.js`.

## How it works
- The client simulates its own movement and aim. The server owns health, kills, deaths, score, respawns and the match
  flow, and checks every hit claim (fire rate, team, alive, range). That is fine for friends but not cheat-proof.
- Other players are shown 110 ms in the past and interpolated, and hits are tested against what the shooter saw.
- All audio is synthesised in the browser (gunshots with valley echo, snow footsteps, wind), so there are no sound files.
- Collisions are simple boxes around each building, container, sandbag line and pine cluster, built from the GLB at load.
  Bullets hit the real building geometry; trees do not stop bullets.

## Files
```
server.js            HTTP + WebSocket server, game rules, horde waves, tanks
ai.js                bot AI (FSM + squad coordinator)
public/index.html    page, HUD markup
public/style.css     HUD styling
public/js/game.js    renderer, map loading, player, weapons, netcode, HUD
public/js/shared.js  collision / ray math shared logic
public/js/audio.js   synthesised sound
public/js/net.js     WebSocket wrapper
public/assets/map.glb  your map
```
