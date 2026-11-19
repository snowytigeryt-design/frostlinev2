// Pure game math (no three.js) so it can be unit-tested in Node.

export const CFG = {
  groundY: 30,          // the map's ground plane sits at y = 30
  bounds: 140,          // playable half-size (metres) — a forest belt rings the edge
  radius: 0.38,         // player body radius
  height: 1.8,          // standing height
  heightCrouch: 1.4,
  eye: 1.65,
  eyeCrouch: 1.2,
  gravity: 20,
  jump: 6.7,
  walk: 5.0,
  sprint: 7.8,
  crouch: 2.6,
  step: 0.45,           // auto step-up height
  hitRadius: 0.42,      // body hitbox radius (a little generous)
  headRadius: 0.25,
  leanDist: 0.38,       // how far Q/E leans the head sideways

  mag: 30,
  fireInterval: 60 / 700,
  reloadTime: 2.1,
  range: 300,
  respawnMs: 4000,
};

export const TEAMS = [
  { name: 'FROST', color: '#4aa8ff', tint: 0x3d8bff },
  { name: 'EMBER', color: '#ff7b3a', tint: 0xff6a2a },
];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Push a standing circle (p.x, p.z) out of every box it overlaps vertically. */
export function pushOut(p, boxes, r = CFG.radius, h = CFG.height) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (p.y >= b.maxY - CFG.step) continue; // low enough to step/stand on
    if (p.y + h <= b.minY) continue;        // box is above our head
    const cx = clamp(p.x, b.minX, b.maxX);
    const cz = clamp(p.z, b.minZ, b.maxZ);
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      const k = (r - d) / d;
      p.x += dx * k;
      p.z += dz * k;
    } else {
      // centre is inside the box: leave through the nearest face
      const l = p.x - b.minX, rr = b.maxX - p.x, t = p.z - b.minZ, bt = b.maxZ - p.z;
      const m = Math.min(l, rr, t, bt);
      if (m === l) p.x = b.minX - r;
      else if (m === rr) p.x = b.maxX + r;
      else if (m === t) p.z = b.minZ - r;
      else p.z = b.maxZ + r;
    }
  }
  p.x = clamp(p.x, -CFG.bounds, CFG.bounds);
  p.z = clamp(p.z, -CFG.bounds, CFG.bounds);
}

export function movePlayer(p, boxes, dx, dz) {
  p.x += dx; pushOut(p, boxes);
  p.z += dz; pushOut(p, boxes);
}

/** Highest surface under the player that they can step onto. */
export function floorHeight(p, boxes) {
  let h = CFG.groundY;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.maxY > p.y + CFG.step) continue;
    if (p.x < b.minX - 0.05 || p.x > b.maxX + 0.05 || p.z < b.minZ - 0.05 || p.z > b.maxZ + 0.05) continue;
    if (b.maxY > h) h = b.maxY;
  }
  return h;
}

/** True if a point (with margin) lies inside any ground-level obstacle. */
export function blockedAt(x, z, boxes, margin) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.minY > CFG.groundY + 2) continue;
    if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) return true;
  }
  return false;
}

/** Ray vs sphere. o,d,c = {x,y,z}. Returns distance along ray or -1. */
export function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  return -b + s >= 0 ? 0 : -1;
}

/** Ray vs vertical cylinder (side only), spanning y0..y1. */
export function rayCylinderY(o, d, cx, cz, y0, y1, r) {
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = (-b - s) / a;
  if (t < 0) { t = (-b + s) / a; if (t < 0) return -1; }
  const y = o.y + d.y * t;
  if (y < y0 || y > y1) return -1;
  return t;
}

/**
 * Test a ray against a player standing at feet position `f`.
 * `off` = optional {x,z} sideways head offset (leaning).
 * Returns { t, head } or null.
 */
export function rayPlayer(o, d, f, crouched, off) {
  const H = crouched ? CFG.heightCrouch : CFG.height;
  const head = { x: f.x + (off ? off.x : 0), y: f.y + H - 0.2, z: f.z + (off ? off.z : 0) };
  const th = raySphere(o, d, head, CFG.headRadius);
  const tb = rayCylinderY(o, d, f.x, f.z, f.y, f.y + H - 0.36, CFG.hitRadius);
  if (th >= 0 && (tb < 0 || th <= tb + 0.02)) return { t: th, head: true };
  if (tb >= 0) return { t: tb, head: false };
  return null;
}

/** Yaw that makes a player look along horizontal direction (dx, dz). */
export function yawToward(dx, dz) {
  return Math.atan2(-dx, -dz);
}
