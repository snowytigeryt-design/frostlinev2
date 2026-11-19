// Village layout generator — pure data, no three.js, deterministic.
// Every client builds the same map from the same seed, and Node can run it for tests.
//
// Coordinates: x = east, z = south, y = up. Ground is y = 30 (added by the builder),
// so every height here is relative to the ground.
// Quarter turns q (0..3): the house's door faces +z, +x, -z, -x respectively.

export const MAP = {
  half: 126,        // roads and buildings stay inside +-126 m
  bounds: 140,      // players are kept inside +-140 m
  roadW: 9,
  seed: 20251118,
};

// Footprints measured from the GLB (centre offset is centre minus node origin).
export const FOOT = {
  house:     { w: 11.68, d: 6.11, h: 4.02, ox: 0.32, oz: 0.015 },
  container: { w: 6.16,  d: 2.75, h: 2.83, ox: 0.01, oz: 0.005 },
  sandA:     { w: 4.12,  d: 2.30, h: 1.19, ox: 0,    oz: 0 },
  sandB:     { w: 4.02,  d: 0.98, h: 1.19, ox: 0,    oz: 0 },
  tower:     { w: 5.1,   d: 5.1,  h: 15.91, ox: 0,   oz: 0 },
};

// What is already in the GLB (the central compound). rect = [minX,maxX,minZ,maxZ]
export const EXISTING = [
  [-20.52, -8.84, -7.04, -0.93],   // Arctic barracks
  [8.84, 20.52, -18.07, -11.96],   // East barracks
  [5.94, 10.06, -2.15, 0.15],      // East cover
  [-2.55, 2.55, -10.55, -5.45],    // Radar tower
  [6.93, 13.09, 6.63, 9.38],       // Freight container
  [-9.37, -6.62, -18.09, -11.93],  // North cargo
  [0.94, 5.06, -19.15, -16.85],    // North sandbags
  [-6.01, -1.99, 7.51, 8.49],      // Snow sandbag cover
  [0.94, 5.06, 14.85, 17.15],      // South sandbags
  [-21.16, -9.48, 11.93, 18.04],   // West barracks
  [-10.37, -7.62, -2.09, 4.07],    // West cargo
];
export const EXISTING_TREES = [
  [30.3, -15.4], [-9.0, -37.5], [12.4, -35.2], [-25.5, -33.2], [9.5, 34.1],
  [29.6, 13.0], [-17.2, 33.5], [-31.9, 9.5], [-31.6, -19.8],
];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotate a local (x,z) offset by a quarter turn q (same convention as three.js rotation.y). */
export function rotOff(x, z, q) {
  const a = q * Math.PI / 2, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [x * c + z * s, -x * s + z * c];
}

const overlap = (a, b, m) => a.minX - m < b.maxX && a.maxX + m > b.minX && a.minZ - m < b.maxZ && a.maxZ + m > b.minZ;
const circleHitsRect = (x, z, r, b) => {
  const cx = Math.min(Math.max(x, b.minX), b.maxX), cz = Math.min(Math.max(z, b.minZ), b.maxZ);
  return (x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r;
};

export function generateLayout() {
  const R = mulberry32(MAP.seed);
  const rnd = (a, b) => a + R() * (b - a);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const HW = MAP.roadW / 2;

  const items = [];      // things to instantiate
  const colliders = [];  // {minX,maxX,minZ,maxZ,minY,maxY,k,name}
  const blockers = EXISTING.map(([minX, maxX, minZ, maxZ]) => ({ minX, maxX, minZ, maxZ }));
  const treeSpots = EXISTING_TREES.map(([x, z]) => ({ x, z }));

  // ---------- roads ----------
  // centre lines (used to place houses and lamps) …
  const L = MAP.half;
  const lines = [
    { axis: 'h', c: -56, a0: -L, a1: L }, { axis: 'h', c: 56, a0: -L, a1: L },
    { axis: 'h', c: 0, a0: -L, a1: -60.5 }, { axis: 'h', c: 0, a0: 60.5, a1: L },
    { axis: 'v', c: -56, a0: -L, a1: L }, { axis: 'v', c: 56, a0: -L, a1: L },
    { axis: 'v', c: 0, a0: -L, a1: -60.5 }, { axis: 'v', c: 0, a0: 60.5, a1: L },
  ];
  const lineRect = (ln) => (ln.axis === 'h'
    ? { minX: ln.a0, maxX: ln.a1, minZ: ln.c - HW, maxZ: ln.c + HW }
    : { minX: ln.c - HW, maxX: ln.c + HW, minZ: ln.a0, maxZ: ln.a1 });
  const roadAvoid = lines.map(lineRect);
  // … and non-overlapping rectangles for drawing (no z-fighting at junctions)
  const roads = [];
  for (const z of [-56, 56]) roads.push({ minX: -L, maxX: L, minZ: z - HW, maxZ: z + HW });
  for (const sgn of [-1, 1]) roads.push({ minX: sgn > 0 ? 60.5 : -L, maxX: sgn > 0 ? L : -60.5, minZ: -HW, maxZ: HW });
  for (const x of [-56, 56]) {
    roads.push({ minX: x - HW, maxX: x + HW, minZ: -L, maxZ: -60.5 });
    roads.push({ minX: x - HW, maxX: x + HW, minZ: -51.5, maxZ: 51.5 });
    roads.push({ minX: x - HW, maxX: x + HW, minZ: 60.5, maxZ: L });
  }
  roads.push({ minX: -HW, maxX: HW, minZ: -L, maxZ: -60.5 });
  roads.push({ minX: -HW, maxX: HW, minZ: 60.5, maxZ: L });

  // ---------- placement helpers ----------
  const inMap = (r, lim) => r.minX > -lim && r.maxX < lim && r.minZ > -lim && r.maxZ < lim;
  function free(r, o) {
    o = o || {};
    if (!inMap(r, o.lim || MAP.half + 2)) return false;
    for (const b of blockers) if (overlap(r, b, o.m == null ? 1.5 : o.m)) return false;
    if (!o.onRoad) for (const b of roadAvoid) if (overlap(r, b, o.rm == null ? 0.4 : o.rm)) return false;
    for (const t of treeSpots) if (circleHitsRect(t.x, t.z, o.tm == null ? 3.2 : o.tm, r)) return false;
    return true;
  }
  const rectOf = (cx, cz, hx, hz) => ({ minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz });

  function addBuilding(k, cx, cz, q, s, o) {
    const f = FOOT[k];
    const odd = q & 1;
    const hx = (odd ? f.d : f.w) * s / 2, hz = (odd ? f.w : f.d) * s / 2;
    const r = rectOf(cx, cz, hx, hz);
    if (!free(r, o)) return null;
    const [rx, rz] = rotOff(f.ox * s, f.oz * s, q);
    const it = { k, cx, cz, q, s, x: cx - rx, z: cz - rz };
    items.push(it);
    blockers.push(r);
    colliders.push({ ...r, minY: 0, maxY: f.h * s, k: 'solid', name: k });
    return it;
  }

  function addStack(cx, cz, q, base) {         // container, optionally stacked on a container
    const it = addBuilding('container', cx, cz, q, 1, { m: 0.6, rm: 1 });
    if (!it) return null;
    if (base && R() < 0.35) {
      const f = FOOT.container;
      items.push({ ...it, y: f.h });
      const last = colliders[colliders.length - 1];
      colliders.push({ ...last, minY: f.h, maxY: f.h * 2, name: 'container-top' });
    }
    return it;
  }

  // ---------- 1. industrial yard (south-east block): rows of containers ----------
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      if (R() < 0.3) continue;
      const q = (R() < 0.18) ? 1 : 0;
      addStack(74 + col * 8.4 + rnd(-0.3, 0.3), 74 + row * 7.6 + rnd(-0.3, 0.3), q, true);
    }
  }

  // ---------- 2. watchtowers (open lattice) ----------
  for (const [x, z] of [[-100, -100], [100, -100], [-100, 100], [0, 96]]) {
    const r = rectOf(x, z, 2.55, 2.55);
    if (!free(r, { m: 3, rm: 3 })) continue;
    items.push({ k: 'tower', cx: x, cz: z, q: 0, s: 1, x, z });
    blockers.push(r);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      colliders.push({ ...rectOf(x + sx * 2.05, z + sz * 2.05, 0.5, 0.5), minY: 0, maxY: FOOT.tower.h, k: 'solid', name: 'tower-leg' });
    }
  }

  // ---------- 3. checkpoints: sandbags at the arm mouths and ring corners ----------
  const mouths = [[0, -82, 'v'], [0, 82, 'v'], [-82, 0, 'h'], [82, 0, 'h']];
  for (const [mx, mz, ax] of mouths) {
    for (const side of [-1, 1]) {
      const off = 7.5 * side;
      const px = ax === 'v' ? mx + off : mx, pz = ax === 'v' ? mz : mz + off;
      addBuilding(R() < 0.5 ? 'sandA' : 'sandB', px, pz, ax === 'v' ? 1 : 0, 1, { onRoad: true, m: 0.5 });
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBuilding('sandB', sx * 66, sz * 66, R() < 0.5 ? 0 : 1, 1, { m: 1 });
  }

  // ---------- 4. houses along every street ----------
  const houseScales = [1, 1, 1, 0.8, 0.8, 0.62];
  for (const ln of lines) {
    for (const side of [-1, 1]) {
      let cursor = ln.a0 + 5;
      let guard = 0;
      while (cursor < ln.a1 - 10 && guard++ < 60) {
        const s = pick(houseScales);
        const len = FOOT.house.w * s, dep = FOOT.house.d * s;
        if (R() < 0.38) { cursor += rnd(8, 18); continue; }        // gap / empty lot
        const setback = 2 + rnd(0, 2.5);
        const along = cursor + len / 2;
        const perp = ln.c + side * (HW + setback + dep / 2);
        // long axis follows the street; door faces the street
        let cx, cz, q;
        if (ln.axis === 'h') { cx = along; cz = perp; q = side < 0 ? 0 : 2; }
        else { cx = perp; cz = along; q = side < 0 ? 1 : 3; }
        const it = addBuilding('house', cx, cz, q, s, { m: 1.2, rm: 0.4 });
        cursor += it ? len + rnd(2.5, 8) : 4;
      }
    }
  }

  // ---------- 5. back lots: sheds, extra houses, cover ----------
  let tries = 0, placed = 0;
  while (placed < 26 && tries++ < 900) {
    const x = rnd(-120, 120), z = rnd(-120, 120);
    const kind = pick(['house', 'house', 'house', 'container', 'container', 'sandA', 'sandB']);
    const s = kind === 'house' ? pick([0.8, 0.62, 1]) : 1;
    if (addBuilding(kind, x, z, Math.floor(R() * 4), s, { m: 6, rm: 3.5, tm: 4 })) placed++;
  }

  // ---------- 6. small props (crates, drums, jersey barriers, lamps) ----------
  const crates = [], drums = [], barriers = [], lamps = [];
  const nearPoints = items.filter((i) => i.k === 'house' || i.k === 'container');
  for (const it of nearPoints) {
    const n = R() < 0.55 ? 1 + Math.floor(R() * 3) : 0;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const dist = (FOOT[it.k].w * it.s) / 2 + rnd(1.2, 2.6);
      const x = it.cx + Math.cos(a) * dist, z = it.cz + Math.sin(a) * dist * 0.7;
      if (R() < 0.62) {
        const s = rnd(0.9, 1.2), r = rectOf(x, z, s / 2, s / 2);
        if (!free(r, { m: 0.7, rm: 0.6, tm: 1 })) continue;
        blockers.push(r);
        crates.push({ x, z, y: 0, s });
        colliders.push({ ...r, minY: 0, maxY: s, k: 'prop', name: 'crate' });
        if (R() < 0.4) {
          const s2 = s * 0.85;
          const r2 = rectOf(x, z, s2 / 2, s2 / 2);
          crates.push({ x, z, y: s, s: s2 });
          colliders.push({ ...r2, minY: s, maxY: s + s2, k: 'prop', name: 'crate' });
        }
      } else {
        const r = rectOf(x, z, 0.3, 0.3);
        if (!free(r, { m: 0.6, rm: 0.6, tm: 1 })) continue;
        blockers.push(r);
        drums.push({ x, z });
        colliders.push({ ...r, minY: 0, maxY: 0.95, k: 'prop', name: 'drum' });
      }
    }
  }
  // jersey barriers forming chicanes at the road mouths
  for (const [mx, mz, ax] of mouths) {
    for (const d of [-14, 14]) for (const side of [-1, 1]) {
      const px = ax === 'v' ? mx + 2.4 * side : mx + d, pz = ax === 'v' ? mz + d : mz + 2.4 * side;
      const q = ax === 'v' ? 1 : 0;
      const hx = q ? 0.3 : 1.5, hz = q ? 1.5 : 0.3;
      const r = rectOf(px, pz, hx, hz);
      if (!free(r, { onRoad: true, m: 0.4, tm: 1 })) continue;
      blockers.push(r);
      barriers.push({ x: px, z: pz, q });
      colliders.push({ ...r, minY: 0, maxY: 0.9, k: 'prop', name: 'barrier' });
    }
  }
  // street lamps
  for (const ln of lines) {
    for (const side of [-1, 1]) {
      for (let a = ln.a0 + 12; a < ln.a1 - 6; a += 24) {
        const off = ln.c + side * (HW + 0.9);
        const x = ln.axis === 'h' ? a : off, z = ln.axis === 'h' ? off : a;
        const r = rectOf(x, z, 0.5, 0.5);
        let ok = true;
        for (const b of blockers) if (overlap(r, b, 0.3)) { ok = false; break; }
        if (!ok) continue;
        // lamp arm points over the road
        const rot = ln.axis === 'h' ? (side < 0 ? 0 : Math.PI) : (side < 0 ? -Math.PI / 2 : Math.PI / 2);
        lamps.push({ x, z, rot });
      }
    }
  }

  // ---------- 7. forest: edge belt + pockets between buildings ----------
  const trees = [];
  function treeOK(x, z, minDist) {
    if (Math.abs(x) > MAP.bounds + 6 || Math.abs(z) > MAP.bounds + 6) return false;
    for (const b of blockers) if (circleHitsRect(x, z, 3.4, b)) return false;
    for (const b of roadAvoid) if (circleHitsRect(x, z, 5.0, b)) return false;
    for (const t of treeSpots) if ((t.x - x) ** 2 + (t.z - z) ** 2 < minDist * minDist) return false;
    return true;
  }
  function addTree(x, z, s) {
    const t = { k: 'tree', x, z, rot: R() * Math.PI * 2, s, v: Math.floor(R() * 9) };
    items.push(t); trees.push(t); treeSpots.push({ x, z });
  }
  for (let side = 0; side < 4; side++) {
    for (let t = -146; t <= 146; t += 16.5) {
      const d = 134 + rnd(-3, 3), a = t + rnd(-3, 3);
      const z = side === 0 ? -d : side === 1 ? d : a;
      const xx = side === 0 ? a : side === 1 ? a : (side === 2 ? -d : d);
      if (treeOK(xx, z, 9)) addTree(xx, z, rnd(1.0, 1.35));
    }
  }
  let pockets = 0; tries = 0;
  while (pockets < 20 && tries++ < 1500) {
    const x = rnd(-122, 122), z = rnd(-122, 122);
    if (Math.hypot(x, z) < 30) continue;
    if (!treeOK(x, z, 14)) continue;
    addTree(x, z, rnd(0.9, 1.2)); pockets++;
  }

  return { items, colliders, roads, lines, crates, drums, barriers, lamps, trees };
}
