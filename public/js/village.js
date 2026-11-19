import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { generateLayout, rotOff } from './layout.js';

/**
 * Turns the pure layout (layout.js) into the village: clones the GLB's own buildings,
 * containers, sandbag emplacements, radar towers and fir clusters, and adds a few
 * simple procedural props (roads, lamps, crates, drums, jersey barriers).
 */

// ---------- trunk colliders (so trees are thin obstacles, not 8 m boxes) ----------
/** Local (x,z) offsets of each trunk in `node`'s own frame, found from the lowest vertices of the mesh. */
export function trunkOffsets(node) {
  node.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  const pts = [];
  let minY = Infinity, maxX = -Infinity, minX = Infinity, maxZ = -Infinity, minZ = Infinity;
  node.traverse((o) => {
    if (!o.isMesh) return;
    m4.multiplyMatrices(inv, o.matrixWorld);
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m4);
      pts.push(v.x, v.y, v.z);
      if (v.y < minY) minY = v.y;
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  });
  const clusters = [];
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] > minY + 0.6) continue;
    let c = null;
    for (const k of clusters) { if (Math.hypot(k.x - pts[i], k.z - pts[i + 2]) < 1.2) { c = k; break; } }
    if (!c) { c = { x: 0, z: 0, n: 0 }; clusters.push(c); }
    c.x = (c.x * c.n + pts[i]) / (c.n + 1);
    c.z = (c.z * c.n + pts[i + 2]) / (c.n + 1);
    c.n++;
  }
  const maxN = Math.max(1, ...clusters.map((c) => c.n));
  let out = clusters.filter((c) => c.n >= maxN * 0.15).map((c) => [c.x, c.z]);
  if (out.length < 1 || out.length > 6) out = [[(minX + maxX) / 2, (minZ + maxZ) / 2]];
  return out;
}

// ---------- procedural textures ----------
function canvasTexture(size, draw, aniso) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso || 1;
  return t;
}
function speckle(g, size, n, lo, hi, a) {
  for (let i = 0; i < n; i++) {
    const v = lo + Math.random() * (hi - lo);
    g.fillStyle = `rgba(${v},${v},${v + 4},${a})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function roadTexture(aniso) {
  return canvasTexture(256, (g, s) => {
    g.fillStyle = '#8c949b'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {           // darker packed patches
      g.fillStyle = `rgba(70,76,84,${0.05 + Math.random() * 0.1})`;
      g.beginPath(); g.ellipse(Math.random() * s, Math.random() * s, 10 + Math.random() * 36, 5 + Math.random() * 14, Math.random() * 3, 0, 7); g.fill();
    }
    for (let i = 0; i < 14; i++) {           // fresh snow drifts
      g.fillStyle = `rgba(240,246,250,${0.08 + Math.random() * 0.14})`;
      g.beginPath(); g.ellipse(Math.random() * s, Math.random() * s, 8 + Math.random() * 30, 4 + Math.random() * 10, Math.random() * 3, 0, 7); g.fill();
    }
    speckle(g, s, 2600, 60, 230, 0.35);
  }, aniso);
}
function crateTexture(aniso) {
  return canvasTexture(128, (g, s) => {
    g.fillStyle = '#9a7549'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) { g.fillStyle = 'rgba(40,24,10,.45)'; g.fillRect(0, y, s, 2); }
    g.strokeStyle = '#5b4125'; g.lineWidth = 8; g.strokeRect(4, 4, s - 8, s - 8);
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.moveTo(s - 8, 8); g.lineTo(8, s - 8); g.lineWidth = 5; g.stroke();
    speckle(g, s, 400, 40, 200, 0.25);
  }, aniso);
}
function concreteTexture(aniso) {
  return canvasTexture(128, (g, s) => {
    g.fillStyle = '#9aa0a6'; g.fillRect(0, 0, s, s);
    speckle(g, s, 1200, 70, 210, 0.3);
    g.fillStyle = 'rgba(230,236,242,.35)'; g.fillRect(0, 0, s, 18);   // snow on top edge
  }, aniso);
}

// ---------- main builder ----------
export function buildVillage(ctx) {
  const { scene, World, groundY: G, tpl, quality, aniso } = ctx;
  const layout = generateLayout();
  const cull = [];                                         // objects hidden by distance
  const tplTrunks = tpl.trees.map(trunkOffsets);

  // ----- roads -----
  const roadTex = roadTexture(aniso);
  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTex, roughness: 0.95, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  for (const r of layout.roads) {
    const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
    const geo = new THREE.PlaneGeometry(w, d);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 5, uv.getY(i) * d / 5);
    const m = new THREE.Mesh(geo, roadMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((r.minX + r.maxX) / 2, G + 0.05, (r.minZ + r.maxZ) / 2);
    m.receiveShadow = true;
    scene.add(m);
  }

  // ----- GLB clones -----
  const TPL = { house: tpl.house, container: tpl.container, sandA: tpl.sandA, sandB: tpl.sandB, tower: tpl.tower };
  const RAD = { house: 8, container: 5, sandA: 4, sandB: 4, tower: 5 };
  const CULL_MUL = { house: 1, container: 1, sandA: 0.85, sandB: 0.85, tower: 1.6 };

  function instance(srcNode, x, y, z, rotY, s, kind, occluder) {
    const o = SkeletonUtils.clone(srcNode);
    o.visible = true;
    o.position.set(x, y, z);
    o.rotation.set(0, rotY, 0);
    o.scale.setScalar(s);
    const meshes = [];
    o.traverse((m) => {
      if (!m.isMesh) return;
      meshes.push(m);
      m.castShadow = true;
      m.receiveShadow = true;
      if (m.isSkinnedMesh) m.frustumCulled = false;
      if (occluder) { m.userData = { kind: 'solid' }; World.occluders.push(m); }
    });
    scene.add(o);
    cull.push({ o, x, z, r: (RAD[kind] || 6) * s, mul: CULL_MUL[kind] || 0.88, meshes, vis: true, sh: true });
    return o;
  }

  for (const it of layout.items) {
    if (it.k === 'tree') {
      const vi = it.v % tpl.trees.length;
      instance(tpl.trees[vi], it.x, G, it.z, it.rot, it.s, 'tree', false);
      const c = Math.cos(it.rot), sn = Math.sin(it.rot);
      for (const [ox, oz] of tplTrunks[vi]) {
        const wx = it.x + (ox * c + oz * sn) * it.s, wz = it.z + (-ox * sn + oz * c) * it.s;
        const h = 0.4 * it.s;
        World.boxes.push({ minX: wx - h, maxX: wx + h, minZ: wz - h, maxZ: wz + h, minY: G, maxY: G + 14, kind: 'tree', name: 'trunk' });
      }
      World.treeMarks.push({ x: it.x, z: it.z, s: it.s });
      continue;
    }
    const src = TPL[it.k];
    if (!src) continue;
    instance(src, it.x, G + (it.y || 0), it.z, it.q * Math.PI / 2, it.s, it.k, true);
  }

  // colliders from the layout (houses, containers, sandbags, tower legs, props)
  for (const c of layout.colliders) {
    World.boxes.push({ minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ, minY: G + c.minY, maxY: G + c.maxY, kind: c.k, name: c.name });
  }

  // ----- procedural props (instanced) -----
  const M4 = new THREE.Matrix4(), Q4 = new THREE.Quaternion(), P3 = new THREE.Vector3(), S3 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function setM(mesh, i, x, y, z, yaw, sx, sy, sz) {
    Q4.setFromAxisAngle(UP, yaw);
    M4.compose(P3.set(x, y, z), Q4, S3.set(sx, sy == null ? sx : sy, sz == null ? sx : sz));
    mesh.setMatrixAt(i, M4);
  }
  function finish(mesh, occluder) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    if (occluder) { mesh.userData = { kind: 'solid' }; World.occluders.push(mesh); }
  }

  if (layout.crates.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: crateTexture(aniso), roughness: 0.9 }), layout.crates.length);
    const col = new THREE.Color();
    layout.crates.forEach((c, i) => {
      setM(mesh, i, c.x, G + c.y, c.z, ((c.x * 7.13 + c.z * 3.1) % 1) * 0.3 - 0.15, c.s);
      mesh.setColorAt(i, col.setScalar(0.8 + ((c.x * 13.7 + c.z * 5.3) % 1) * 0.35));
    });
    finish(mesh, true);
  }
  if (layout.drums.length) {
    const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.95, 14); geo.translate(0, 0.475, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.5 }), layout.drums.length);
    const colors = [0x3d6a9a, 0x9a3b30, 0x4f7a4a, 0x8a6a3a];
    const col = new THREE.Color();
    layout.drums.forEach((d, i) => { setM(mesh, i, d.x, G, d.z, 0, 1); mesh.setColorAt(i, col.setHex(colors[i % colors.length])); });
    finish(mesh, true);
  }
  if (layout.barriers.length) {
    const geo = new THREE.BoxGeometry(3, 0.9, 0.6); geo.translate(0, 0.45, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ map: concreteTexture(aniso), roughness: 0.95 }), layout.barriers.length);
    layout.barriers.forEach((b, i) => setM(mesh, i, b.x, G, b.z, b.q ? Math.PI / 2 : 0, 1));
    finish(mesh, true);
  }
  if (layout.lamps.length) {
    const n = layout.lamps.length;
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.1, 5.4, 8).translate(0, 2.7, 0),
      new THREE.MeshStandardMaterial({ color: 0x2c3238, roughness: 0.6, metalness: 0.6 }), n);
    const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 1.5).translate(0, 0, 0.75),
      new THREE.MeshStandardMaterial({ color: 0x2c3238, roughness: 0.6, metalness: 0.6 }), n);
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd890, emissiveIntensity: 2.4 }), n);
    layout.lamps.forEach((l, i) => {
      const dx = -Math.sin(l.rot), dz = Math.cos(l.rot);
      setM(pole, i, l.x, G, l.z, 0, 1);
      setM(arm, i, l.x, G + 5.3, l.z, l.rot, 1);
      setM(head, i, l.x + dx * 1.45, G + 5.18, l.z + dz * 1.45, 0, 1);
    });
    finish(pole, false); finish(arm, false); finish(head, false);
    head.castShadow = false;
  }

  World.layout = layout;

  // ----- per-frame distance culling (cheap, runs a few times per second) -----
  function update(cx, cz) {
    const base = quality.cull;
    for (const e of cull) {
      const d = Math.hypot(e.x - cx, e.z - cz);
      const vis = d < base * e.mul + e.r;
      if (vis !== e.vis) { e.vis = vis; e.o.visible = vis; }
      const sh = vis && d < 80 + e.r;
      if (sh !== e.sh) { e.sh = sh; for (const m of e.meshes) m.castShadow = sh; }
    }
  }
  update(0, 0);

  return { layout, update, count: cull.length, rotOff };
}
