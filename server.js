'use strict';
/**
 * FROSTLINE server
 *  - serves the game (public/) and three.js (from node_modules) over HTTP
 *  - runs the multiplayer game rooms over WebSocket (/ws?room=<id>)
 *
 * Model: clients simulate their own movement and aim; the server owns health,
 * kills, deaths, scores, respawns, match flow and validates hit claims
 * (fire-rate, team, alive state, range). Good for friends; not cheat-proof.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');
const { TacticalBot, SquadCoordinator } = require('./ai.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

// ---------- game tuning ----------
const MAX_PLAYERS = 12;
const envInt = (k, d) => (Number.isFinite(parseInt(process.env[k], 10)) ? parseInt(process.env[k], 10) : d);
const SCORE_LIMIT = envInt('SCORE_LIMIT', 40);   // team kills needed to win
const RESPAWN_MS = envInt('RESPAWN_MS', 4000);
const PROTECT_MS = envInt('PROTECT_MS', 2500);
const OVER_MS = envInt('OVER_MS', 12000);        // how long the results screen shows
const REGEN_DELAY_MS = 5000;
const REGEN_PER_SEC = 24;
const DMG_BODY = 22;
const DMG_HEAD = 55;
const MAX_HIT_RANGE = 260;
const TICK_MS = 50; // 20 Hz
const TANK_HP = 600;
const TANK_RELOAD_MS = envInt('TANK_RELOAD_MS', 2400);
const TANK_RESPAWN_MS = envInt('TANK_RESPAWN_MS', 45000);
const SHELL_SPEED = 150, SHELL_G = 6, SPLASH_R = 7;
const WAVE_BREAK_MS = envInt('WAVE_BREAK_MS', 8000);
const BOT_REMOVE_MS = 3500;
const MAX_BOTS_CAP = 60;

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.glb', '.svg']);
const gzCache = new Map();

function safeJoin(base, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { return null; }
  if (decoded.includes('\0')) return null;
  const full = path.normalize(path.join(base, decoded));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function sendFile(req, res, file, cacheControl) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'ETag': etag,
      'Cache-Control': cacheControl,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const wantsGzip = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!wantsGzip) {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    const cached = gzCache.get(file);
    const reply = (buf) => {
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    if (cached && cached.etag === etag) return reply(cached.buf);
    fs.readFile(file, (e2, data) => {
      if (e2) { res.writeHead(500); return res.end('Read error'); }
      zlib.gzip(data, { level: 9 }, (e3, buf) => {
        if (e3) { res.writeHead(500); return res.end('Compress error'); }
        gzCache.set(file, { etag, buf });
        reply(buf);
      });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (p === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    let players = 0;
    for (const r of rooms.values()) players += r.players.size;
    return res.end(JSON.stringify({ rooms: rooms.size, players }));
  }
  if (p.startsWith('/vendor/three/')) {
    const rel = p.slice('/vendor/three/'.length);
    if (!(rel.startsWith('build/') || rel.startsWith('examples/jsm/'))) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const file = safeJoin(THREE_DIR, rel);
    if (!file) { res.writeHead(400); return res.end('Bad path'); }
    return sendFile(req, res, file, 'public, max-age=86400');
  }
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) { res.writeHead(400); return res.end('Bad path'); }
  const longCache = rel.startsWith('assets/');
  return sendFile(req, res, file, longCache ? 'public, max-age=86400' : 'no-cache');
});

// ---------- rooms & players ----------
const rooms = new Map();

const TANK_SPAWNS = {
  tdm: [[-30, 56, 0], [30, 56, 0], [-30, -56, Math.PI], [30, -56, Math.PI]],
  horde: [[-30, 56, 0], [30, 56, 0], [0, 100, 0]],
};

// ---------- static world for server-side bot AI (built from the shared layout) ----------
let W = null; // { G, boxes, solid, cover, half, shared }
(async () => {
  try {
    const base = pathToFileURL(path.join(PUBLIC_DIR, 'js') + path.sep);
    const shared = await import(new URL('shared.js', base).href);
    const lay = await import(new URL('layout.js', base).href);
    const G = shared.CFG.groundY;
    const L = lay.generateLayout();
    const boxes = [];
    for (const c of L.colliders) boxes.push({ minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ, minY: G + c.minY, maxY: G + c.maxY, kind: c.k, name: c.name });
    for (const r of lay.EXISTING) boxes.push({ minX: r[0], maxX: r[1], minZ: r[2], maxZ: r[3], minY: G, maxY: G + 4, kind: 'solid', name: 'existing' });
    const treeAt = (x, z) => boxes.push({ minX: x - 1.0, maxX: x + 1.0, minZ: z - 1.0, maxZ: z + 1.0, minY: G, maxY: G + 14, kind: 'tree', name: 'tree' });
    for (const t of L.trees) treeAt(t.x, t.z);
    for (const t of lay.EXISTING_TREES) treeAt(t[0], t[1]);
    const rect = (b) => ({ x: b.minX, y: b.minZ, w: b.maxX - b.minX, h: b.maxZ - b.minZ });
    const solid = [], cover = [];
    for (const b of boxes) {
      if (b.minY > G + 1) continue;
      const h = b.maxY - G;
      if (h >= 1.6) solid.push(rect(b));
      if (h >= 0.85) cover.push(rect(b));
    }
    W = { G, boxes, solid, cover, half: shared.CFG.bounds - 6, shared };
    console.log('bot world:', boxes.length, 'colliders,', solid.length, 'LOS blockers');
  } catch (e) { console.error('bot world failed to load:', e); }
})();

class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode === 'horde' ? 'horde' : 'tdm';
    this.players = new Map();
    this.scores = [0, 0];
    this.over = false;
    this.overAt = 0;
    this.nextId = 1;
    this.wave = { n: 0, phase: 'idle', toSpawn: 0, nextAt: 0, spawnAt: 0, lastSent: 0, sig: '' };
    this.squad = new SquadCoordinator();
    this.aiAcc = 0;
    this.shells = [];
    this.tanks = TANK_SPAWNS[this.mode].map((s, i) => ({
      id: i + 1, x: s[0], z: s[1], yaw: s[2], ty: s[2], tp: 0, hp: TANK_HP, alive: true, driver: 0, team: -1,
      spawn: s, respawnAt: 0, nextFire: 0, speed: 0, lastTs: 0,
    }));
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p !== except) rawSend(p, s);
    }
  }
  teamCount(t) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t && !p.bot) n++;
    return n;
  }
  humans() {
    const a = [];
    for (const p of this.players.values()) if (!p.bot) a.push(p);
    return a;
  }
}

function rawSend(p, s) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(s);
}
function send(p, obj) {
  if (p.ws) rawSend(p, JSON.stringify(obj));
}

function cleanName(n) {
  n = String(n == null ? '' : n).replace(/[^\w \-.!?*#@$&()+=:'"À-ɏ]/g, '').trim().slice(0, 16);
  return n || 'Player';
}
function cleanRoom(r) {
  r = String(r || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  return r || 'main';
}
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function publicInfo(p) {
  return {
    id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, alive: p.alive, bot: p.bot ? 1 : 0,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, m: p.m,
  };
}
const tankInfo = (t) => ({ id: t.id, x: r2(t.x), z: r2(t.z), yaw: r3(t.yaw), ty: r3(t.ty), tp: r3(t.tp), hp: Math.ceil(t.hp), alive: t.alive, driver: t.driver, team: t.team });
const waveInfo = (room, now) => {
  const w = room.wave;
  let alive = 0;
  for (const p of room.players.values()) if (p.bot && p.alive) alive++;
  return { t: 'wave', n: w.n, left: w.toSpawn + alive, phase: w.phase, next: w.phase === 'break' ? Math.max(0, w.nextAt - now) : 0 };
};

function handleJoin(room, p, msg) {
  p.name = cleanName(msg.name);
  if (room.mode === 'horde') p.team = 0;
  else {
    const a = room.teamCount(0), b = room.teamCount(1);
    p.team = a < b ? 0 : b < a ? 1 : (Math.random() < 0.5 ? 0 : 1);
  }
  p.joined = true;
  p.alive = false;
  p.respawnAt = 0;
  room.players.set(p.id, p);
  send(p, {
    t: 'welcome', id: p.id, team: p.team, name: p.name, limit: SCORE_LIMIT, mode: room.mode,
    respawnMs: RESPAWN_MS, over: room.over, scores: room.scores,
    players: [...room.players.values()].filter((o) => o !== p).map(publicInfo),
    tanks: room.tanks.map(tankInfo), wave: room.mode === 'horde' ? waveInfo(room, Date.now()) : null,
  });
  room.broadcast({ t: 'join', p: publicInfo(p) }, p);
}

function leaveTank(room, p, exitPos) {
  const t = room.tanks.find((x) => x.driver === p.id);
  if (!t) { p.vehicle = 0; return; }
  t.driver = 0; t.team = -1; t.speed = 0; p.vehicle = 0;
  let x = t.x + Math.cos(t.yaw) * 3.6, z = t.z - Math.sin(t.yaw) * 3.6;
  if (W && W.shared.blockedAt(x, z, W.boxes, 0.5)) { x = t.x - Math.cos(t.yaw) * 3.6; z = t.z + Math.sin(t.yaw) * 3.6; }
  if (exitPos !== false) { p.x = x; p.z = z; p.y = W ? W.G : 30; }
  room.broadcast({ t: 'tank', op: 'exit', id: t.id, pid: p.id, x: r2(x), y: r2(p.y), z: r2(z) });
}

function applyDamage(room, shooter, target, dmg, head, now) {
  if (!target.alive) return;
  target.hp -= dmg;
  target.lastDamage = now;
  if (target.hp > 0) {
    send(target, { t: 'hurt', hp: Math.ceil(target.hp), from: shooter.id });
    send(shooter, { t: 'hitc', head, kill: false });
    return;
  }
  target.hp = 0;
  target.alive = false;
  target.deaths++;
  target.respawnAt = now + RESPAWN_MS;
  if (target.vehicle) leaveTank(room, target, false);
  const self = shooter === target;
  if (!self) { shooter.kills++; room.scores[shooter.team]++; }
  if (target.bot) { target.removeAt = now + BOT_REMOVE_MS; target.respawnAt = Infinity; }
  room.broadcast({
    t: 'kill', killer: shooter.id, victim: target.id, head,
    scores: room.scores, kk: shooter.kills, vd: target.deaths, respawnMs: RESPAWN_MS,
  });
  if (!self) send(shooter, { t: 'hitc', head, kill: true });
  if (room.mode === 'tdm' && !self && room.scores[shooter.team] >= SCORE_LIMIT && !room.over) {
    room.over = true;
    room.overAt = now;
    room.broadcast({
      t: 'over', winner: shooter.team, scores: room.scores,
      players: [...room.players.values()].filter((p) => !p.bot).map((p) => ({ id: p.id, k: p.kills, d: p.deaths })),
    });
  }
}

function damageTank(room, shooter, t, dmg, now) {
  if (!t.alive) return;
  t.hp -= dmg;
  if (shooter && !shooter.bot) send(shooter, { t: 'hitc', head: false, kill: t.hp <= 0, tank: true });
  if (t.hp > 0) return;
  t.hp = 0; t.alive = false; t.respawnAt = now + TANK_RESPAWN_MS; t.speed = 0;
  const driver = t.driver ? room.players.get(t.driver) : null;
  room.broadcast({ t: 'tank', op: 'dead', id: t.id, x: r2(t.x), z: r2(t.z) });
  room.broadcast({ t: 'boom', x: r2(t.x), y: (W ? W.G : 30) + 1.5, z: r2(t.z), r: 9, big: 1 });
  if (driver) {
    const killer = shooter || driver;
    if (driver.alive) applyDamage(room, killer, driver, 9999, false, now);
  }
  t.driver = 0; t.team = -1;
}

function explode(room, x, y, z, shooter, directTank, now) {
  room.broadcast({ t: 'boom', x: r2(x), y: r2(y), z: r2(z), r: SPLASH_R });
  for (const p of [...room.players.values()]) {
    if (!p.alive || p.vehicle) continue;
    const d = Math.hypot(p.x - x, (p.y + 0.9) - y, p.z - z);
    if (d > SPLASH_R) continue;
    if (p.team === shooter.team && p !== shooter) continue;
    if (now < p.protectUntil) continue;
    let dmg = 170 * (1 - d / SPLASH_R);
    if (p === shooter) dmg *= 0.5;
    if (dmg >= 1) applyDamage(room, shooter, p, dmg, false, now);
  }
  for (const t of room.tanks) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - x, (W ? W.G : 30) + 1.2 - y, t.z - z);
    if (t === directTank) damageTank(room, shooter, t, 250, now);
    else if (d < SPLASH_R && (t.team === -1 || t.team !== shooter.team)) damageTank(room, shooter, t, 130 * (1 - d / SPLASH_R), now);
  }
}

function stepShells(room, dt, now) {
  if (!room.shells.length) return;
  const G = W ? W.G : 30;
  const keep = [];
  for (const s of room.shells) {
    const shooter = room.players.get(s.by);
    s.age += dt;
    let hit = null, tankHit = null;
    const n = 4, h = dt / n;
    for (let i = 0; i < n && !hit; i++) {
      s.vy -= SHELL_G * h;
      const px = s.x, py = s.y, pz = s.z;
      s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
      if (s.y <= G) { hit = [s.x, G, s.z]; break; }
      if (W) {
        for (const b of W.boxes) {
          if (s.x > b.minX && s.x < b.maxX && s.z > b.minZ && s.z < b.maxZ && s.y > b.minY && s.y < b.maxY && b.kind !== 'tree') { hit = [px, py, pz]; break; }
        }
        if (hit) break;
      }
      for (const t of room.tanks) {
        if (!t.alive || (t.id === s.tank && s.age < 0.35)) continue;
        if (Math.hypot(s.x - t.x, s.z - t.z) < 2.6 && s.y > G && s.y < G + 3) { hit = [s.x, s.y, s.z]; tankHit = t; break; }
      }
      if (hit) break;
      for (const p of room.players.values()) {
        if (!p.alive || p.vehicle || p.id === s.by) continue;
        if (Math.hypot(s.x - p.x, s.y - (p.y + 0.9), s.z - p.z) < 0.9) { hit = [s.x, s.y, s.z]; break; }
      }
    }
    if (hit) { if (shooter) explode(room, hit[0], hit[1], hit[2], shooter, tankHit, now); }
    else if (s.age < 6 && Math.abs(s.x) < 400 && Math.abs(s.z) < 400) keep.push(s);
  }
  room.shells = keep;
}

function handleMessage(room, p, msg, now) {
  switch (msg.t) {
    case 'ping':
      send(p, { t: 'pong', ts: msg.ts });
      break;

    case 's': { // movement state
      if (!p.alive || p.vehicle) break;
      const x = num(msg.x, -400, 400), y = num(msg.y, -50, 200), z = num(msg.z, -400, 400);
      const yaw = num(msg.yaw, -100, 100), pitch = num(msg.pitch, -2, 2), m = num(msg.m, 0, 255);
      if (x === null || y === null || z === null || yaw === null || pitch === null || m === null) break;
      p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = pitch; p.m = m | 0;
      break;
    }

    case 'shoot': { // cosmetic broadcast: tracer + sound for others
      if (!p.alive || room.over || p.vehicle) break;
      if (now - p.lastShootMsg < 45) break;
      p.lastShootMsg = now;
      const o = msg.o, d = msg.d;
      if (!Array.isArray(o) || !Array.isArray(d) || o.length !== 3 || d.length !== 3) break;
      if (![...o, ...d].every((v) => typeof v === 'number' && Number.isFinite(v))) break;
      room.broadcast({ t: 'shoot', id: p.id, o: o.map(r2), d: d.map(r3) }, p);
      break;
    }

    case 'hit': {
      const rej = (why) => send(p, { t: 'rej', why });
      if (room.over) return rej('match over');
      if (!p.alive) return rej('you are not spawned');
      if (p.vehicle) return rej('in a tank');
      const target = room.players.get(msg.id | 0);
      if (!target || target === p) return rej('no such target');
      if (!target.alive) return rej('target not alive');
      if (target.team === p.team) return rej('teammate');
      if (now < target.protectUntil) return rej('target spawn-protected');
      // token bucket: ~12 hits/s, burst 3 (rifle fires ~11/s)
      p.tokens = Math.min(3, p.tokens + ((now - p.tokenT) / 1000) * 12);
      p.tokenT = now;
      if (p.tokens < 1) return rej('too fast');
      const dx = target.x - p.x, dy = target.y - p.y, dz = target.z - p.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > MAX_HIT_RANGE) return rej('out of range');
      p.tokens -= 1;
      const head = !!msg.head;
      applyDamage(room, p, target, head ? DMG_HEAD : DMG_BODY, head, now);
      break;
    }

    case 'thit': { // rifle round hit a tank
      const rej = (why) => send(p, { t: 'rej', why });
      if (!p.alive || p.vehicle) return rej('cannot shoot tanks now');
      const t = room.tanks.find((x) => x.id === (msg.id | 0));
      if (!t || !t.alive) return rej('tank not alive');
      if (t.team === p.team) return rej('friendly tank');
      p.tokens = Math.min(3, p.tokens + ((now - p.tokenT) / 1000) * 12);
      p.tokenT = now;
      if (p.tokens < 1) return rej('too fast');
      if (Math.hypot(t.x - p.x, t.z - p.z) > 200) return rej('out of range');
      p.tokens -= 1;
      damageTank(room, p, t, 7, now);
      break;
    }

    case 'tenter': {
      if (!p.alive || p.vehicle || room.over) break;
      const t = room.tanks.find((x) => x.id === (msg.id | 0));
      if (!t || !t.alive || t.driver) break;
      if (Math.hypot(t.x - p.x, t.z - p.z) > 6.5) break;
      t.driver = p.id; t.team = p.team; p.vehicle = t.id; t.lastTs = now; t.speed = 0;
      room.broadcast({ t: 'tank', op: 'enter', id: t.id, pid: p.id, team: p.team });
      break;
    }
    case 'texit': {
      if (p.vehicle) leaveTank(room, p);
      break;
    }
    case 'ts': { // tank drive state from the driver
      const t = room.tanks.find((x) => x.driver === p.id);
      if (!t || !t.alive) break;
      const x = num(msg.x, -400, 400), z = num(msg.z, -400, 400), yaw = num(msg.yaw, -100, 100);
      const ty = num(msg.ty, -100, 100), tp = num(msg.tp, -1, 1);
      if (x === null || z === null || yaw === null || ty === null || tp === null) break;
      const dt = Math.max(0.02, (now - t.lastTs) / 1000);
      const dist = Math.hypot(x - t.x, z - t.z);
      if (dist > 22 * dt + 2) break; // too fast: ignore
      t.speed = dist / dt;
      t.lastTs = now;
      t.x = x; t.z = z; t.yaw = yaw; t.ty = ty; t.tp = tp;
      p.x = x; p.z = z; p.y = W ? W.G : 30;
      break;
    }
    case 'tfire': {
      const t = room.tanks.find((x) => x.driver === p.id);
      if (!t || !t.alive || room.over || now < t.nextFire) break;
      t.nextFire = now + TANK_RELOAD_MS;
      const cp = Math.cos(t.tp);
      const dx = -Math.sin(t.ty) * cp, dy = Math.sin(t.tp), dz = -Math.cos(t.ty) * cp;
      const G = W ? W.G : 30;
      const o = [t.x + dx * 4.2, G + 2.3 + dy * 4.2, t.z + dz * 4.2];
      room.shells.push({ by: p.id, tank: t.id, x: o[0], y: o[1], z: o[2], vx: dx * SHELL_SPEED, vy: dy * SHELL_SPEED, vz: dz * SHELL_SPEED, age: 0 });
      room.broadcast({ t: 'shell', tid: t.id, by: p.id, o: o.map(r2), v: [dx * SHELL_SPEED, dy * SHELL_SPEED, dz * SHELL_SPEED].map(r2) });
      break;
    }

    case 'spawn': {
      if (p.alive || room.over) break;
      if (now < p.respawnAt - 250) break;
      const x = num(msg.x, -400, 400), y = num(msg.y, -50, 200), z = num(msg.z, -400, 400), yaw = num(msg.yaw, -100, 100);
      if (x === null || y === null || z === null || yaw === null) break;
      p.alive = true; p.hp = 100; p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = 0; p.m = 0; p.vehicle = 0;
      p.protectUntil = now + PROTECT_MS;
      p.lastDamage = 0;
      p.lastHpSent = 100;
      room.broadcast({ t: 'spawned', id: p.id, x: r2(x), y: r2(y), z: r2(z), yaw: r3(yaw), hp: 100 });
      break;
    }
    default:
      break;
  }
}

// ---------- horde: bots + waves ----------
function spawnBot(room, now) {
  if (!W) return false;
  const humans = room.humans().filter((h) => h.alive);
  const ref = humans.length ? humans[(Math.random() * humans.length) | 0] : null;
  for (let i = 0; i < 30; i++) {
    let x, z;
    if (ref && i < 22) {
      const a = Math.random() * Math.PI * 2, r = 55 + Math.random() * 45;
      x = ref.x + Math.cos(a) * r; z = ref.z + Math.sin(a) * r;
    } else { x = (Math.random() * 2 - 1) * W.half; z = (Math.random() * 2 - 1) * W.half; }
    if (Math.abs(x) > W.half || Math.abs(z) > W.half) continue;
    if (W.shared.blockedAt(x, z, W.boxes, 1.4)) continue;
    if (humans.some((h) => Math.hypot(h.x - x, h.z - z) < 45)) continue;
    const n = room.wave.n;
    const id = room.nextId++;
    const ai = new TacticalBot({
      id, x, z, squad: room.squad, hp: Math.min(140, 55 + 6 * n),
      speed: 3.8 + Math.min(1.6, n * 0.1) + Math.random() * 0.6,
      accuracy: Math.min(0.88, 0.5 + n * 0.02 + Math.random() * 0.15),
      reaction: Math.max(0.2, 0.62 - n * 0.02 + Math.random() * 0.15),
      aggression: Math.min(0.95, 0.5 + n * 0.02 + Math.random() * 0.2),
    });
    const p = {
      id, ws: null, bot: true, ai, name: 'BOT-' + String(id).padStart(2, '0'), team: 1, joined: true,
      kills: 0, deaths: 0, alive: true, hp: ai.hp, x, y: W.G, z, yaw: 0, pitch: 0, m: 0,
      respawnAt: Infinity, protectUntil: 0, lastDamage: 0, vehicle: 0, removeAt: 0, lastShot: 0,
    };
    room.players.set(id, p);
    room.broadcast({ t: 'join', p: publicInfo(p) });
    room.broadcast({ t: 'spawned', id, x: r2(x), y: W.G, z: r2(z), yaw: 0, hp: Math.ceil(p.hp) });
    return true;
  }
  return false;
}

function hordeTick(room, dt, now) {
  const w = room.wave;
  const humans = room.humans();
  if (!humans.length) {
    if (w.n || room.players.size) {
      for (const p of [...room.players.values()]) if (p.bot) room.players.delete(p.id);
      room.wave = { n: 0, phase: 'idle', toSpawn: 0, nextAt: 0, spawnAt: 0, lastSent: 0, sig: '' };
      room.scores = [0, 0];
    }
    return;
  }
  let aliveBots = 0;
  for (const p of [...room.players.values()]) {
    if (!p.bot) continue;
    if (!p.alive) {
      if (now >= p.removeAt) { room.players.delete(p.id); room.broadcast({ t: 'leave', id: p.id }); }
      continue;
    }
    aliveBots++;
  }
  if (!humans.some((h) => h.alive || h.respawnAt) && w.phase !== 'idle') { /* everyone dead: keep going, they respawn */ }
  if (w.phase === 'idle') {
    if (!w.nextAt) w.nextAt = now + 4000;
    if (now >= w.nextAt && W) { w.n = 1; w.toSpawn = Math.min(MAX_BOTS_CAP, 6 + 3 * w.n); w.phase = 'active'; w.spawnAt = now; }
  } else if (w.phase === 'active') {
    const conc = Math.min(18, 8 + w.n);
    if (w.toSpawn > 0 && aliveBots < conc && now >= w.spawnAt) {
      if (spawnBot(room, now)) { w.toSpawn--; aliveBots++; }
      w.spawnAt = now + 600;
    }
    if (w.toSpawn <= 0 && aliveBots === 0) { w.phase = 'break'; w.nextAt = now + WAVE_BREAK_MS; }
  } else if (w.phase === 'break') {
    if (now >= w.nextAt) { w.n++; w.toSpawn = Math.min(MAX_BOTS_CAP, 6 + 3 * w.n); w.phase = 'active'; w.spawnAt = now; }
  }
  const info = waveInfo(room, now);
  const sig = info.n + ':' + info.left + ':' + info.phase;
  if (sig !== w.sig || now - w.lastSent > 1000) { w.sig = sig; w.lastSent = now; room.broadcast(info); }
}

function botAI(room, dt, now) {
  if (!W) return;
  const bots = [];
  for (const p of room.players.values()) if (p.bot && p.alive) bots.push(p);
  if (!bots.length) return;
  // enemies the horde can see: people on foot and driven tanks
  const enemies = [];
  for (const h of room.players.values()) {
    if (h.bot || !h.alive || h.vehicle) continue;
    enemies.push({ x: h.x, y: h.z, vx: h.vx || 0, vy: h.vz || 0, aim: h.yaw, hp: h.hp, ref: h, kind: 'p' });
  }
  for (const t of room.tanks) {
    if (!t.alive || !t.driver) continue;
    enemies.push({ x: t.x, y: t.z, vx: 0, vy: 0, aim: t.ty, hp: t.hp, ref: t, kind: 't' });
  }
  const ais = bots.map((b) => b.ai);
  room.squad.update(dt, ais, W);
  const world = { enemies, allies: ais, los: W.solid, solid: W.solid, cover: W.cover, half: W.half, stimulus: null };
  for (const b of bots) {
    const ai = b.ai;
    ai.hp = b.hp;
    // bots can always "hear" the nearest player (they are hunting)
    let best = null, bd = Infinity;
    for (const e of enemies) { const d = Math.hypot(e.x - ai.x, e.y - ai.y); if (d < bd) { bd = d; best = e; } }
    world.stimulus = best ? { x: best.x, y: best.y, vx: 0, vy: 0 } : null;
    const res = ai.update(dt, world);
    // move with the shared collision code
    const pos = { x: ai.x + ai.vx * dt, y: W.G, z: ai.y + ai.vy * dt };
    W.shared.movePlayer(pos, W.boxes, 0, 0);
    ai.x = pos.x; ai.y = pos.z;
    b.vx = ai.vx; b.vz = ai.vy;
    b.x = ai.x; b.z = ai.y; b.y = W.G;
    b.yaw = Math.atan2(-Math.cos(ai.aim), -Math.sin(ai.aim));
    const spd = Math.hypot(ai.vx, ai.vy);
    let m = 0;
    if (spd > 3.9) m |= 2;
    if (ai.hiding) m |= 1;
    if (ai.reload > 0) m |= 8;
    if (now - b.lastShot < 160) m |= 16;
    b.m = m;
    if (res.fire && ai.fireCd <= 0 && res.target) {
      ai.fireCd = 0.2 + Math.random() * 0.15;
      ai.ammo--;
      b.lastShot = now;
      const tg = res.target;
      const d = Math.hypot(tg.x - ai.x, tg.y - ai.y);
      const wv = Math.min(14, 7 + 0.35 * room.wave.n);
      const chance = Math.max(0.06, (1 - d / 75)) * (0.35 + ai.traits.accuracy * 0.6);
      const ok = Math.random() < chance;
      const ty = tg.kind === 'p' ? tg.ref.y + 1.3 : W.G + 1.5;
      const dx = tg.x - ai.x, dy = ty - (W.G + 1.5), dz = tg.y - ai.y, l = Math.hypot(dx, dy, dz) || 1;
      const sp = ok ? 0.004 : 0.05;
      const dir = [dx / l + (Math.random() - 0.5) * sp, dy / l + (Math.random() - 0.5) * sp, dz / l + (Math.random() - 0.5) * sp];
      room.broadcast({ t: 'shoot', id: b.id, o: [r2(ai.x), r2(W.G + 1.5), r2(ai.y)], d: dir.map(r3) });
      if (ok) {
        if (tg.kind === 'p') { if (tg.ref.alive && now >= tg.ref.protectUntil && !tg.ref.vehicle) applyDamage(room, b, tg.ref, wv, false, now); }
        else damageTank(room, b, tg.ref, 4, now);
      }
    }
  }
}

function tankTick(room, dt, now) {
  for (const t of room.tanks) {
    if (!t.alive) {
      if (!t.driver && now >= t.respawnAt) {
        t.alive = true; t.hp = TANK_HP; t.x = t.spawn[0]; t.z = t.spawn[1]; t.yaw = t.ty = t.spawn[2]; t.tp = 0; t.driver = 0; t.team = -1;
        room.broadcast({ t: 'tank', op: 'spawn', id: t.id, x: t.x, z: t.z, yaw: t.yaw });
      }
      continue;
    }
    if (!t.driver || t.speed < 4) continue;
    const driver = room.players.get(t.driver);
    if (!driver) continue;
    for (const p of [...room.players.values()]) { // roadkill
      if (!p.alive || p.vehicle || p.team === t.team) continue;
      if (Math.hypot(p.x - t.x, p.z - t.z) < 2.6 && Math.abs(p.y - (W ? W.G : 30)) < 2) applyDamage(room, driver, p, 200, false, now);
    }
  }
}

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
  if (url.pathname !== '/ws') return socket.destroy();
  const roomId = cleanRoom(url.searchParams.get('room'));
  const mode = url.searchParams.get('mode') === 'horde' ? 'horde' : 'tdm';
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, roomId, mode));
});

wss.on('connection', (ws, roomId, mode) => {
  let room = rooms.get(roomId);
  if (!room) { room = new Room(roomId, mode); rooms.set(roomId, room); }

  if (room.humans().length >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ t: 'full' }));
    ws.close();
    if (room.players.size === 0) rooms.delete(roomId);
    return;
  }

  const now0 = Date.now();
  const p = {
    id: room.nextId++, ws, name: 'Player', team: 0, joined: false,
    kills: 0, deaths: 0, alive: false, hp: 100, vehicle: 0, vx: 0, vz: 0,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, m: 0,
    respawnAt: 0, protectUntil: 0, lastDamage: 0, lastHpSent: 100,
    tokens: 3, tokenT: now0, lastShootMsg: 0,
    isAlive: true, msgCount: 0, msgWindow: now0,
  };
  ws.on('pong', () => { p.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgCount = 0; }
    if (++p.msgCount > 300) return ws.terminate(); // flooding
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.joined) {
      if (msg.t === 'join') handleJoin(room, p, msg);
      return;
    }
    handleMessage(room, p, msg, now);
  });

  ws.on('close', () => {
    if (p.joined) {
      if (p.vehicle) leaveTank(room, p, false);
      room.players.delete(p.id);
      room.broadcast({ t: 'leave', id: p.id });
    }
    if (room.humans().length === 0) rooms.delete(room.id);
  });
  ws.on('error', () => {});
});

// ---------- game loop ----------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  for (const room of rooms.values()) {
    if (room.mode === 'horde') {
      hordeTick(room, dt, now);
      room.aiAcc += dt;
      if (room.aiAcc >= 0.1) { botAI(room, room.aiAcc, now); room.aiAcc = 0; }
    }
    stepShells(room, dt, now);
    tankTick(room, dt, now);
    if (room.over && now - room.overAt > OVER_MS) {
      room.over = false;
      room.scores = [0, 0];
      for (const p of room.players.values()) {
        p.kills = 0; p.deaths = 0; p.alive = false; p.hp = 100; p.respawnAt = 0;
      }
      room.broadcast({ t: 'reset' });
    }

    const snap = [];
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      if (p.vehicle) continue;
      if (p.bot) { /* bots do not regen */ snap.push([p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch), p.m]); continue; }
      snap.push([p.id, r2(p.x), r2(p.y), r2(p.z), r3(p.yaw), r3(p.pitch), p.m]);
      if (p.hp < 100 && now - p.lastDamage > REGEN_DELAY_MS) {
        p.hp = Math.min(100, p.hp + REGEN_PER_SEC * dt);
        const shown = Math.floor(p.hp);
        if (shown !== p.lastHpSent) {
          p.lastHpSent = shown;
          send(p, { t: 'hp', hp: shown });
        }
      }
    }
    const v = [];
    for (const t of room.tanks) if (t.alive) v.push([t.id, r2(t.x), r2(t.z), r3(t.yaw), r3(t.ty), r3(t.tp), Math.ceil(t.hp)]);
    if ((snap.length && room.players.size > 1) || (v.length && room.players.size)) room.broadcast({ t: 'snap', p: snap, v });
  }
}, TICK_MS);

// keep connections alive through Render's proxy and drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAliveFlag === false) { ws.terminate(); continue; }
    ws.isAliveFlag = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000);
wss.on('connection', (ws) => { ws.isAliveFlag = true; ws.on('pong', () => { ws.isAliveFlag = true; }); });

server.listen(PORT, () => {
  console.log(`FROSTLINE listening on :${PORT}`);
});

module.exports = { server };
