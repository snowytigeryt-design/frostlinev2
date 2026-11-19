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
const { WebSocketServer } = require('ws');

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

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.scores = [0, 0];
    this.over = false;
    this.overAt = 0;
    this.nextId = 1;
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p !== except) rawSend(p, s);
    }
  }
  teamCount(t) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t) n++;
    return n;
  }
}

function rawSend(p, s) {
  if (p.ws.readyState === 1) p.ws.send(s);
}
function send(p, obj) {
  rawSend(p, JSON.stringify(obj));
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
    id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, alive: p.alive,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, m: p.m,
  };
}

function handleJoin(room, p, msg) {
  p.name = cleanName(msg.name);
  const a = room.teamCount(0), b = room.teamCount(1);
  p.team = a < b ? 0 : b < a ? 1 : (Math.random() < 0.5 ? 0 : 1);
  p.joined = true;
  p.alive = false;
  p.respawnAt = 0;
  room.players.set(p.id, p);
  send(p, {
    t: 'welcome', id: p.id, team: p.team, name: p.name, limit: SCORE_LIMIT,
    respawnMs: RESPAWN_MS, over: room.over, scores: room.scores,
    players: [...room.players.values()].filter((o) => o !== p).map(publicInfo),
  });
  room.broadcast({ t: 'join', p: publicInfo(p) }, p);
}

function applyDamage(room, shooter, target, dmg, head, now) {
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
  shooter.kills++;
  room.scores[shooter.team]++;
  room.broadcast({
    t: 'kill', killer: shooter.id, victim: target.id, head,
    scores: room.scores, kk: shooter.kills, vd: target.deaths, respawnMs: RESPAWN_MS,
  });
  send(shooter, { t: 'hitc', head, kill: true });
  if (room.scores[shooter.team] >= SCORE_LIMIT && !room.over) {
    room.over = true;
    room.overAt = now;
    room.broadcast({
      t: 'over', winner: shooter.team, scores: room.scores,
      players: [...room.players.values()].map((p) => ({ id: p.id, k: p.kills, d: p.deaths })),
    });
  }
}

function handleMessage(room, p, msg, now) {
  switch (msg.t) {
    case 'ping':
      send(p, { t: 'pong', ts: msg.ts });
      break;

    case 's': { // movement state
      if (!p.alive) break;
      const x = num(msg.x, -400, 400), y = num(msg.y, -50, 200), z = num(msg.z, -400, 400);
      const yaw = num(msg.yaw, -100, 100), pitch = num(msg.pitch, -2, 2), m = num(msg.m, 0, 255);
      if (x === null || y === null || z === null || yaw === null || pitch === null || m === null) break;
      p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = pitch; p.m = m | 0;
      break;
    }

    case 'shoot': { // cosmetic broadcast: tracer + sound for others
      if (!p.alive || room.over) break;
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

    case 'spawn': {
      if (p.alive || room.over) break;
      if (now < p.respawnAt - 250) break;
      const x = num(msg.x, -400, 400), y = num(msg.y, -50, 200), z = num(msg.z, -400, 400), yaw = num(msg.yaw, -100, 100);
      if (x === null || y === null || z === null || yaw === null) break;
      p.alive = true; p.hp = 100; p.x = x; p.y = y; p.z = z; p.yaw = yaw; p.pitch = 0; p.m = 0;
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

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
  if (url.pathname !== '/ws') return socket.destroy();
  const roomId = cleanRoom(url.searchParams.get('room'));
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, roomId));
});

wss.on('connection', (ws, roomId) => {
  let room = rooms.get(roomId);
  if (!room) { room = new Room(roomId); rooms.set(roomId, room); }

  if (room.players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ t: 'full' }));
    ws.close();
    if (room.players.size === 0) rooms.delete(roomId);
    return;
  }

  const now0 = Date.now();
  const p = {
    id: room.nextId++, ws, name: 'Player', team: 0, joined: false,
    kills: 0, deaths: 0, alive: false, hp: 100,
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
      room.players.delete(p.id);
      room.broadcast({ t: 'leave', id: p.id });
    }
    if (room.players.size === 0) rooms.delete(room.id);
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
    if (snap.length && room.players.size > 1) room.broadcast({ t: 'snap', p: snap });
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
