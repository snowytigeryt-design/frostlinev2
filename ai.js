'use strict';
/**
 * Bot AI for FROSTLINE horde mode.
 * Port of the user's "Tactical Shooter Bot AI" sandbox module (2D FSM bot + squad blackboard)
 * onto the ground plane (x, z) in metres:
 *   - FSM: PATROL_SWEEP / STALK_FLANK / HIDING_AMBUSH / OVERWATCH_PIN / TAKE_COVER / RETREAT_HEAL
 *   - perception: vision range + FOV cone + line-of-sight, memory of last-known position, reaction time
 *   - traits (aggression, accuracy, reactionTime) and a genome (cover preference, flank aggression,
 *     trigger discipline, squad cohesion), cover scoring, obstacle feelers, ally separation
 *   - SquadCoordinator: shared blackboard, 3-way pinch roles (OVERWATCH / FLANK_LEFT / AMBUSH_TRAP)
 * Aim angle convention here: atan2(dz, dx). Obstacles are {x, y, w, h} rects where y is world z.
 */

const TAU = Math.PI * 2;
const norm = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
const rotTo = (c, t, step) => { const d = norm(t - c); return Math.abs(d) <= step ? t : c + Math.sign(d) * step; };

function segRect(x1, y1, x2, y2, r) {
  // quick reject on bounding box
  if (Math.max(x1, x2) < r.x || Math.min(x1, x2) > r.x + r.w || Math.max(y1, y2) < r.y || Math.min(y1, y2) > r.y + r.h) return false;
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const ch = [[-dx, x1 - r.x], [dx, r.x + r.w - x1], [-dy, y1 - r.y], [dy, r.y + r.h - y1]];
  for (let i = 0; i < 4; i++) {
    const p = ch[i][0], q = ch[i][1];
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t0 <= t1;
}
function los(x1, y1, x2, y2, obs) {
  for (let i = 0; i < obs.length; i++) if (segRect(x1, y1, x2, y2, obs[i])) return false;
  return true;
}
function inObs(px, py, obs, pad) {
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (px >= o.x - pad && px <= o.x + o.w + pad && py >= o.y - pad && py <= o.y + o.h + pad) return true;
  }
  return false;
}

class SquadCoordinator {
  constructor() {
    this.lastKnownPos = null; this.intel = 0;
    this.phase = 'RECON'; this.ambushTriggered = false; this.ambushTimer = 0;
    this.roleWaypoints = new Map();
  }
  reportContact(enemy, visual) {
    this.lastKnownPos = { x: enemy.x, y: enemy.y, vx: enemy.vx || 0, vy: enemy.vy || 0, aim: enemy.aim || 0 };
    this.intel = visual ? 1 : Math.max(this.intel, 0.75);
  }
  update(dt, bots, world) {
    const alive = bots.filter((b) => b.hp > 0);
    if (!alive.some((b) => b.target)) {
      this.intel = Math.max(0, this.intel - dt * 0.14);
      if (this.intel <= 0.05) { this.lastKnownPos = null; this.phase = 'RECON'; this.ambushTriggered = false; }
    }
    const roles = ['OVERWATCH', 'FLANK_LEFT', 'AMBUSH_TRAP'];
    alive.forEach((b, i) => { b.squadRole = roles[i % 3]; });
    if (!this.lastKnownPos) return;
    // geometry around last known pos
    let cx = 0, cy = 0;
    for (const b of alive) { cx += b.x; cy += b.y; }
    cx /= Math.max(1, alive.length); cy /= Math.max(1, alive.length);
    const base = Math.atan2(this.lastKnownPos.y - cy, this.lastKnownPos.x - cx);
    this.roleWaypoints.set('OVERWATCH', this._spot(base + Math.PI, 38, world, false));
    this.roleWaypoints.set('FLANK_LEFT', this._spot(base + Math.PI - 1.75, 28, world, true));
    this.roleWaypoints.set('AMBUSH_TRAP', this._spot(base + Math.PI + 1.95, 26, world, true));

    if (this.phase === 'SETTING_TRAP' && !this.ambushTriggered) {
      let ready = 0, walkedIn = false;
      for (const b of alive) {
        const wp = this.roleWaypoints.get(b.squadRole);
        if (wp && Math.hypot(b.x - wp.x, b.y - wp.y) < 6) ready++;
        if (b.squadRole === 'AMBUSH_TRAP' && b.target && Math.hypot(b.target.x - b.x, b.target.y - b.y) < 30) walkedIn = true;
      }
      if (ready >= Math.min(2, alive.length) || walkedIn) { this.ambushTriggered = true; this.phase = 'SPRING_AMBUSH'; this.ambushTimer = 5.5; }
    } else if (this.phase === 'SPRING_AMBUSH') {
      this.ambushTimer -= dt;
      if (this.ambushTimer <= 0) { this.ambushTriggered = false; this.phase = 'SETTING_TRAP'; }
    } else this.phase = 'SETTING_TRAP';
  }
  _spot(angle, radius, world, avoidFov) {
    const th = this.lastKnownPos;
    const ax = th.x + Math.cos(angle) * radius, ay = th.y + Math.sin(angle) * radius;
    let best = { x: ax, y: ay }, bs = -Infinity;
    // only consider obstacles near the anchor (keeps this cheap on a big map)
    for (const o of world.cover) {
      const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
      if (Math.abs(ocx - ax) > 45 || Math.abs(ocy - ay) > 45) continue;
      const dx = ocx - th.x, dy = ocy - th.y, len = Math.hypot(dx, dy) || 1;
      const off = Math.max(o.w, o.h) * 0.6 + 1.2;
      const px = ocx + (dx / len) * off, py = ocy + (dy / len) * off;
      if (inObs(px, py, world.cover, 0.6)) continue;
      let pen = 0;
      if (avoidFov) {
        const d = Math.abs(norm(Math.atan2(py - th.y, px - th.x) - th.aim));
        if (d < 0.75) pen = 240;
      }
      const sc = 220 - Math.hypot(px - ax, py - ay) * 6 - Math.abs(Math.hypot(px - th.x, py - th.y) - radius) * 3 - pen;
      if (sc > bs) { bs = sc; best = { x: px, y: py }; }
    }
    return best;
  }
}

class TacticalBot {
  constructor(c) {
    this.id = c.id; this.team = 1; this.squad = c.squad; this.squadRole = 'SOLO';
    this.x = c.x; this.y = c.z; // y == world z
    this.vx = 0; this.vy = 0; this.radius = 0.38;
    this.aim = Math.random() * TAU;
    this.hp = c.hp; this.maxHp = c.hp;
    this.ammo = 30; this.maxAmmo = 30; this.maxSpeed = c.speed || 4.2;
    this.traits = { aggression: c.aggression ?? 0.6, accuracy: c.accuracy ?? 0.6, reactionTime: c.reaction ?? 0.45 };
    this.vision = c.vision || 75; this.fov = Math.PI * 0.72;
    const r = Math.random;
    this.genome = { coverPreference: 0.3 + r() * 0.4, flankAggression: 0.4 + r() * 0.5, triggerDiscipline: r(), squadCohesion: 0.3 + r() * 0.5 };
    this.state = 'PATROL_SWEEP'; this.stateTimer = 0;
    this.target = null; this.lastKnown = null; this.memory = 0; this.reactionTimer = 0;
    this.sweep = r() * TAU; this.pause = 0; this.wp = null; this.cover = null; this.reload = 0;
    this.holdingFire = false; this.hiding = false;
    this.fireCd = 0;
  }

  update(dt, world) {
    this.stateTimer += dt; this.sweep += dt * 1.4; this.holdingFire = false; this.hiding = false;
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.reload > 0) { this.reload -= dt; if (this.reload <= 0) this.ammo = this.maxAmmo; }
    else if (this.ammo <= 0) this.reload = 1.8;

    // perception
    const seen = this._perceive(world);
    const th = seen.length ? seen.reduce((b, c) => (Math.hypot(c.x - this.x, c.y - this.y) < Math.hypot(b.x - this.x, b.y - this.y) ? c : b)) : null;
    if (th) {
      this.target = th;
      this.lastKnown = { x: th.x, y: th.y, vx: th.vx || 0, vy: th.vy || 0, aim: th.aim || 0 };
      this.memory = 6; this.reactionTimer += dt;
      if (this.squad) this.squad.reportContact(th, true);
    } else {
      this.target = null; this.reactionTimer = Math.max(0, this.reactionTimer - dt * 1.5);
      if (this.memory > 0) { this.memory -= dt; if (this.memory <= 0) this.lastKnown = null; }
    }
    if (this.squad && this.squad.lastKnownPos && !this.target) { this.lastKnown = { ...this.squad.lastKnownPos }; this.memory = 4; }
    if (!this.target && world.stimulus) { // horde bots are drawn toward the nearest player
      this.lastKnown = { x: world.stimulus.x, y: world.stimulus.y, vx: 0, vy: 0 }; this.memory = 4.5;
      if (this.squad) this.squad.reportContact(world.stimulus, false);
    }

    this._transitions(world);

    let dv = { x: 0, y: 0 }, scale = 1;
    switch (this.state) {
      case 'RETREAT_HEAL': case 'TAKE_COVER': dv = this._takeCover(dt, world); scale = 1.15; break;
      case 'HIDING_AMBUSH': this.hiding = true; scale = 0; break;
      case 'STALK_FLANK': dv = this._stalk(dt, world); scale = 0.85 + this.genome.flankAggression * 0.35 + this.traits.aggression * 0.2; break;
      case 'OVERWATCH_PIN': dv = this._overwatch(dt, world); scale = 0.7; break;
      default: dv = this._patrol(dt, world); scale = 0.8;
    }
    const av = this._avoid(world), sp = this._separate(world.allies);
    const coh = 1.5 - this.genome.squadCohesion * 0.8;
    dv.x += av.x * 1.4 + sp.x * coh; dv.y += av.y * 1.4 + sp.y * coh;
    const s = Math.hypot(dv.x, dv.y);
    if (s > 0.001 && scale > 0) {
      const cap = this.maxSpeed * scale, c = Math.min(s, cap);
      this.vx = (dv.x / s) * c; this.vy = (dv.y / s) * c;
    } else {
      this.vx *= 0.7; this.vy *= 0.7;
      if (Math.hypot(this.vx, this.vy) < 0.15) { this.vx = 0; this.vy = 0; }
    }

    // aiming / trigger
    let fire = false, desired = this.aim;
    if (this.target) {
      const raw = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      desired = raw + (Math.random() - 0.5) * (1 - this.traits.accuracy) * 0.16;
      const isAmbush = this.squad && (this.squadRole === 'AMBUSH_TRAP' || this.squadRole === 'FLANK_LEFT');
      const trapNotSprung = this.squad && this.squad.phase === 'SETTING_TRAP' && !this.squad.ambushTriggered;
      const d = Math.hypot(this.target.x - this.x, this.target.y - this.y);
      if (isAmbush && trapNotSprung && d > 24 - this.genome.triggerDiscipline * 12 && this.hp > this.maxHp * 0.65) this.holdingFire = true;
      if (!this.holdingFire && this.reactionTimer >= this.traits.reactionTime && this.ammo > 0 && this.reload <= 0 && Math.abs(norm(raw - this.aim)) < 0.16) fire = true;
    } else if (this.lastKnown) {
      desired = Math.atan2(this.lastKnown.y - this.y, this.lastKnown.x - this.x) + Math.sin(this.sweep) * 0.22;
    } else if (Math.hypot(this.vx, this.vy) > 0.5) {
      desired = Math.atan2(this.vy, this.vx) + Math.sin(this.sweep) * 0.38;
    }
    this.aim = rotTo(this.aim, desired, dt * 6.5);
    return { fire, target: this.target };
  }

  _perceive(world) {
    const out = [];
    for (const e of world.enemies) {
      if (e.hp <= 0) continue;
      const dx = e.x - this.x, dy = e.y - this.y, d = Math.hypot(dx, dy);
      if (d > this.vision) continue;
      if (!(Math.abs(norm(Math.atan2(dy, dx) - this.aim)) <= this.fov * 0.5 || d < 14)) continue;
      if (los(this.x, this.y, e.x, e.y, world.los)) out.push(e);
    }
    return out;
  }

  _transitions(world) {
    const hpr = this.hp / this.maxHp;
    if ((this.reload > 0 || hpr < 0.3) && (this.target || this.lastKnown)) return this._to('TAKE_COVER');
    if (this.squad && this.squad.lastKnownPos) {
      const wp = this.squad.roleWaypoints.get(this.squadRole);
      if (this.squadRole === 'OVERWATCH' && this.traits.aggression < 0.75) return this._to('OVERWATCH_PIN');
      if (this.squadRole === 'FLANK_LEFT' || this.squadRole === 'AMBUSH_TRAP') {
        const d = wp ? Math.hypot(wp.x - this.x, wp.y - this.y) : 999;
        return this._to(d < 5 && !this.squad.ambushTriggered ? 'HIDING_AMBUSH' : 'STALK_FLANK');
      }
    }
    if (this.target) {
      if (world.enemies.length > 1 && this.stateTimer > 2.2 && Math.random() < 0.02 * (1 - this.traits.aggression)) return this._to('TAKE_COVER');
      return this._to('OVERWATCH_PIN');
    }
    if (this.lastKnown) return this._to('STALK_FLANK');
    this._to('PATROL_SWEEP');
  }
  _to(s) { if (this.state !== s) { this.state = s; this.stateTimer = 0; if (s === 'TAKE_COVER') this.cover = null; } }

  _patrol(dt, world) {
    if (this.pause > 0) { this.pause -= dt; return { x: 0, y: 0 }; }
    if (Math.random() < dt * 0.15) { this.pause = 0.6 + Math.random() * 0.8; return { x: 0, y: 0 }; }
    if (!this.wp || Math.hypot(this.wp.x - this.x, this.wp.y - this.y) < 4 || this.stateTimer > 8) {
      this.wp = this._randPoint(world); this.stateTimer = 0;
    }
    return this._seek(this.wp.x, this.wp.y);
  }
  _overwatch(dt, world) {
    const wp = this.squad && this.squad.roleWaypoints.get('OVERWATCH');
    if (wp) return Math.hypot(wp.x - this.x, wp.y - this.y) > 4 ? this._seek(wp.x, wp.y) : { x: 0, y: 0 };
    if (!this.target) return this._patrol(dt, world);
    const dx = this.target.x - this.x, dy = this.target.y - this.y, d = Math.hypot(dx, dy) || 1;
    if (d < 16) return { x: -(dx / d) * this.maxSpeed, y: -(dy / d) * this.maxSpeed };
    // aggressive bots keep closing in; patient ones hold the angle
    if (d > 28 && this.traits.aggression > 0.4) return { x: (dx / d) * this.maxSpeed * 0.8, y: (dy / d) * this.maxSpeed * 0.8 };
    return { x: 0, y: 0 };
  }
  _stalk(dt, world) {
    const wp = this.squad && this.squad.roleWaypoints.get(this.squadRole);
    if (wp) return this._seek(wp.x, wp.y);
    if (this.lastKnown) return this._seek(this.lastKnown.x, this.lastKnown.y);
    return this._patrol(dt, world);
  }
  _takeCover(dt, world) {
    const th = this.target || this.lastKnown;
    if (!th) return this._patrol(dt, world);
    if (!this.cover || this.stateTimer % 1.4 < dt) this.cover = this._bestCover(th, world);
    if (this.cover) {
      return Math.hypot(this.cover.x - this.x, this.cover.y - this.y) < 1.2 ? { x: 0, y: 0 } : this._seek(this.cover.x, this.cover.y);
    }
    const ax = this.x - th.x, ay = this.y - th.y, l = Math.hypot(ax, ay) || 1;
    return { x: (ax / l) * this.maxSpeed, y: (ay / l) * this.maxSpeed };
  }
  _bestCover(th, world) {
    let best = null, bs = -Infinity;
    const occW = 100 + this.genome.coverPreference * 200;
    for (const o of world.cover) {
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      if (Math.abs(cx - this.x) > 30 || Math.abs(cy - this.y) > 30) continue;
      const dx = cx - th.x, dy = cy - th.y, len = Math.hypot(dx, dy) || 1;
      const off = Math.max(o.w, o.h) * 0.6 + this.radius + 0.9;
      const px = cx + (dx / len) * off, py = cy + (dy / len) * off;
      if (inObs(px, py, world.cover, this.radius)) continue;
      const occ = !los(th.x, th.y, px, py, world.los);
      const sc = (occ ? occW : -150) + Math.hypot(px - th.x, py - th.y) * 0.35 - Math.hypot(px - this.x, py - this.y) * 0.65;
      if (sc > bs) { bs = sc; best = { x: px, y: py }; }
    }
    return best;
  }
  _avoid(world) {
    let sx = 0, sy = 0;
    const ang0 = Math.hypot(this.vx, this.vy) > 0.4 ? Math.atan2(this.vy, this.vx) : this.aim;
    for (const o of [-0.85, -0.4, 0, 0.4, 0.85]) {
      const a = ang0 + o, fx = this.x + Math.cos(a) * 4.2, fy = this.y + Math.sin(a) * 4.2;
      if (!los(this.x, this.y, fx, fy, world.solid)) { sx -= Math.cos(a) * this.maxSpeed; sy -= Math.sin(a) * this.maxSpeed; }
    }
    return { x: sx, y: sy };
  }
  _separate(allies) {
    let sx = 0, sy = 0; const want = 2.4;
    for (const a of allies) {
      if (a === this || a.hp <= 0) continue;
      const dx = this.x - a.x, dy = this.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < want) { const k = (want - d) / want; sx += (dx / d) * this.maxSpeed * k; sy += (dy / d) * this.maxSpeed * k; }
    }
    return { x: sx, y: sy };
  }
  _randPoint(world) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU, r = 15 + Math.random() * 35;
      const px = Math.max(-world.half, Math.min(world.half, this.x + Math.cos(a) * r));
      const py = Math.max(-world.half, Math.min(world.half, this.y + Math.sin(a) * r));
      if (!inObs(px, py, world.solid, 1.2)) return { x: px, y: py };
    }
    return { x: 0, y: 0 };
  }
  _seek(tx, ty) {
    const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy) || 1;
    return { x: (dx / d) * this.maxSpeed, y: (dy / d) * this.maxSpeed };
  }
}

module.exports = { TacticalBot, SquadCoordinator, los, inObs };
