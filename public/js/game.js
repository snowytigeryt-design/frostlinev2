import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Net } from './net.js';
import { Sfx } from './audio.js';
import { buildVillage, trunkOffsets } from './village.js';
import {
  CFG, TEAMS, clamp, lerp, damp, lerpAngle,
  movePlayer, floorHeight, blockedAt, rayPlayer, yawToward,
} from './shared.js';

/* ======================================================================
   helpers
   ====================================================================== */
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const DEBUG = Q.has('debug');
const store = {
  get(k, d) { try { const v = localStorage.getItem('fl_' + k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fl_' + k, v); } catch (e) { /* ignore */ } },
};
const showError = (e) => { if (window.__showErr) window.__showErr(String((e && e.stack) || e)); else console.error(e); };
const rand = (a, b) => a + Math.random() * (b - a);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const INTERP_MS = 110;      // remote players are rendered this far in the past
const SEND_MS = 50;         // our state is sent at 20 Hz
const LEAN_DIST = CFG.leanDist;
const LEAN_ROLL = 0.22;     // camera roll (radians) at full lean
const LEAN_BODY = 0.25;     // body tilt of other players leaning
const QUALITY = {
  low: { cull: 105, shadow: 1024, pr: 1.0 },
  med: { cull: 150, shadow: 2048, pr: 1.5 },
  high: { cull: 190, shadow: 2048, pr: 1.75 },
};
const QNAME = QUALITY[Q.get('q')] ? Q.get('q') : (QUALITY[store.get('quality', 'med')] ? store.get('quality', 'med') : 'med');
const QSET = QUALITY[QNAME];

/* ======================================================================
   renderer / scene
   ====================================================================== */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QSET.pr));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Q.has('exp') ? +Q.get('exp') : 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;

const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();
const HORIZON = [0.74, 0.80, 0.87];
const FOG_COL = new THREE.Color().setRGB(HORIZON[0], HORIZON[1], HORIZON[2]);
renderer.setClearColor(FOG_COL, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COL, Q.has('fog') ? +Q.get('fog') : 0.0085);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 700);
camera.rotation.order = 'YXZ';

// viewmodel (first-person rifle) is drawn in its own pass so it never clips into walls
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 10);
vmScene.add(vmCamera);

function makeSky() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { sunDir: { value: SUN_DIR.clone() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vDir; uniform vec3 sunDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 horizon = vec3(${HORIZON[0]}, ${HORIZON[1]}, ${HORIZON[2]});
          vec3 zenith = vec3(0.26, 0.44, 0.72);
          vec3 col = mix(horizon, zenith, pow(h, 0.5));
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += vec3(1.0, 0.85, 0.6) * (pow(s, 700.0) * 4.0 + pow(s, 10.0) * 0.28);
          if (d.y < 0.0) col = horizon;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
  );
  m.frustumCulled = false;
  m.renderOrder = -100;
  return m;
}
const sky = makeSky();
scene.add(sky);

// image-based lighting built from the sky itself (gives metal and snow believable ambient light)
try {
  const envScene = new THREE.Scene();
  envScene.add(makeSky());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(envScene, 0.02, 0.1, 1000).texture;
  scene.environment = envTex;
  vmScene.environment = envTex;
  scene.environmentIntensity = Q.has('env') ? +Q.get('env') : 0.9;
  vmScene.environmentIntensity = 1.1;
} catch (e) { showError(e); }

const hemi = new THREE.HemisphereLight(0xcfe2ff, 0xdfe7ef, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.9);
sun.castShadow = true;
sun.shadow.mapSize.set(QSET.shadow, QSET.shadow);
{
  const sc = sun.shadow.camera;
  sc.left = -50; sc.right = 50; sc.top = 50; sc.bottom = -50; sc.near = 1; sc.far = 320;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.05;
}
scene.add(sun, sun.target);

vmScene.add(new THREE.HemisphereLight(0xdfeaff, 0x8a96a3, 0.9));
const vmSun = new THREE.DirectionalLight(0xfff0dc, 2.4);
vmSun.position.set(0.6, 1, 0.8);
vmScene.add(vmSun);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  vmCamera.aspect = innerWidth / innerHeight; vmCamera.updateProjectionMatrix();
});

/* ======================================================================
   shared textures
   ====================================================================== */
function softDotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function flashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.25, 'rgba(255,205,110,.85)'); r.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  g.translate(64, 64); g.strokeStyle = 'rgba(255,230,160,.9)'; g.lineWidth = 5; g.lineCap = 'round';
  for (let i = 0; i < 6; i++) { g.rotate(Math.PI / 3); g.beginPath(); g.moveTo(8, 0); g.lineTo(58 - (i % 2) * 14, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const TEX_DOT = softDotTexture();
const TEX_FLASH = flashTexture();

/* ======================================================================
   world state (filled once the map is loaded)
   ====================================================================== */
const World = {
  boxes: [],        // walkable-collision boxes  {minX,maxX,minY,maxY,minZ,maxZ,kind}
  occluders: [],    // meshes bullets collide with
  treeMarks: [],    // tree cluster centres (for the maps)
  layout: null,     // village layout (roads etc.)
  village: null,
  spawnRef: new THREE.Vector3(0, CFG.groundY, 23),
};
const AV = { tpl: null, ready: false, rest: {}, yawFix: 0, scale: 1, offset: new THREE.Vector3() };
const RF = { tpl: null };

function boxFromObject(obj, shrink) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj, true);
  let minX = b.min.x, maxX = b.max.x, minZ = b.min.z, maxZ = b.max.z;
  if (shrink) {
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const hx = Math.min((maxX - minX) * shrink / 2, 1.5), hz = Math.min((maxZ - minZ) * shrink / 2, 1.5);
    minX = cx - hx; maxX = cx + hx; minZ = cz - hz; maxZ = cz + hz;
  }
  return { minX, maxX, minY: b.min.y, maxY: b.max.y, minZ, maxZ };
}

function buildWorld(gltf) {
  const root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const TPLN = {};

  for (const node of [...root.children]) {
    const nm = node.name.replace(/_/g, ' ').toLowerCase();

    if (nm === 'roblox character') { root.remove(node); AV.tpl = node; continue; }
    if (nm === 'winter assault rifle') { root.remove(node); RF.tpl = node; continue; }
    if (nm === 'spawn point') { node.visible = false; World.spawnRef.copy(node.position); continue; }

    const isGround = nm === 'ground';
    const isTree = /pines|fir/.test(nm);
    TPLN[nm] = node;

    node.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = !isGround;
      o.receiveShadow = true;
      o.frustumCulled = o.isSkinnedMesh ? false : o.frustumCulled;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map) m.map.anisotropy = maxAniso; }
      if (!isTree) { o.userData.kind = isGround ? 'ground' : 'solid'; World.occluders.push(o); }
    });

    if (isGround) continue;
    if (isTree) {
      // trees block movement only at their trunks
      for (const [ox, oz] of trunkOffsets(node)) {
        const p = new THREE.Vector3(ox, 0, oz).applyMatrix4(node.matrixWorld);
        World.boxes.push({ minX: p.x - 0.4, maxX: p.x + 0.4, minZ: p.z - 0.4, maxZ: p.z + 0.4, minY: CFG.groundY, maxY: CFG.groundY + 14, kind: 'tree', name: 'trunk' });
      }
      World.treeMarks.push({ x: node.position.x, z: node.position.z, s: 1 });
      continue;
    }
    if (nm === 'frostline radar tower') {
      // open lattice: collide with the four legs only, so you can walk underneath
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const cx = node.position.x + sx * 2.05, cz = node.position.z + sz * 2.05;
        World.boxes.push({ minX: cx - 0.5, maxX: cx + 0.5, minZ: cz - 0.5, maxZ: cz + 0.5, minY: CFG.groundY, maxY: CFG.groundY + 15.9, kind: 'solid', name: 'tower-leg' });
      }
      continue;
    }
    const box = boxFromObject(node, 0);
    box.kind = 'solid';
    box.name = nm;
    World.boxes.push(box);
  }

  // the village: clones of the map's own buildings, containers, sandbags, towers and trees
  const T = (n) => { if (!TPLN[n]) throw new Error('The map is missing the "' + n + '" object needed to build the village.'); return TPLN[n]; };
  const treeNodes = Object.keys(TPLN).filter((k) => /pines|fir/.test(k)).sort().map((k) => TPLN[k]);
  World.village = buildVillage({
    scene, World, groundY: CFG.groundY, quality: QSET, aniso: maxAniso,
    tpl: {
      house: T('arctic barracks'), container: T('military freight container'),
      sandA: T('north sandbags'), sandB: T('snow sandbag cover'), tower: T('frostline radar tower'), trees: treeNodes,
    },
  });
  if (DEBUG) console.log('village objects:', World.village.count, 'colliders:', World.boxes.length);
  if (DEBUG) console.table(World.boxes.map((b) => ({ n: b.name, x0: b.minX.toFixed(1), x1: b.maxX.toFixed(1), z0: b.minZ.toFixed(1), z1: b.maxZ.toFixed(1), top: (b.maxY - CFG.groundY).toFixed(1) })));
  if (!AV.tpl) throw new Error('The map has no "Roblox Character" node to use as the player model.');
  if (!RF.tpl) throw new Error('The map has no "Winter assault rifle" node.');
  prepareAvatarTemplate();
  prepareRifleTemplate();
}

/* ======================================================================
   avatar (the Roblox R15 character from the map, posed procedurally)
   ====================================================================== */
const ANIM_BONES = ['LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm',
  'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg', 'Head_1', 'UpperTorso', 'LowerTorso'];

function boneMap(model) {
  const m = {};
  model.traverse((o) => { if (o.isBone) m[o.name] = o; });
  return m;
}

function prepareAvatarTemplate() {
  const tpl = AV.tpl;
  // the map placed this character small and rotated; undo that so we can normalise it ourselves
  tpl.position.set(0, 0, 0); tpl.quaternion.identity(); tpl.scale.set(1, 1, 1);
  tpl.updateMatrixWorld(true);
  const bones = boneMap(tpl);
  const missing = ANIM_BONES.filter((n) => !bones[n]);
  if (missing.length) console.warn('Avatar bones missing:', missing.join(', '));

  const box = new THREE.Box3().setFromObject(tpl, true);
  const height = Math.max(0.01, box.max.y - box.min.y);
  AV.scale = CFG.height / height;

  // work out which way the character faces: front = up x right (right-handed rig)
  const wl = new THREE.Vector3(), wr = new THREE.Vector3();
  if (bones.LeftUpperArm && bones.RightUpperArm) {
    bones.LeftUpperArm.getWorldPosition(wl); bones.RightUpperArm.getWorldPosition(wr);
  } else { wl.set(-1, 0, 0); wr.set(1, 0, 0); }
  const right = wr.sub(wl); right.y = 0; right.normalize();
  const front = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right);
  AV.yawFix = Math.PI - Math.atan2(front.x, front.z) + (Q.has('flip') ? Math.PI : 0);

  // feet at the origin, centred
  let cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, fy = box.min.y;
  if (bones.LeftFoot && bones.RightFoot && bones.LowerTorso) {
    // trust the skeleton over the mesh bounds if they disagree
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    bones.LeftFoot.getWorldPosition(a); bones.RightFoot.getWorldPosition(b); bones.LowerTorso.getWorldPosition(c);
    const bx = (a.x + b.x + c.x) / 3, bz = (a.z + b.z + c.z) / 3;
    if (Math.hypot(bx - cx, bz - cz) > 0.08 * height) { console.warn('avatar: mesh bounds and skeleton disagree; using skeleton'); cx = bx; cz = bz; }
    const ankle = Math.min(a.y, b.y);
    if (fy > ankle || fy < ankle - 0.2 * height) fy = ankle - 0.02 * height;
  }
  AV.offset.set(cx, fy, cz).multiplyScalar(AV.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), AV.yawFix).negate();

  // per-bone: rest rotation + the "right" axis expressed in the parent's frame
  const q = new THREE.Quaternion();
  for (const n of ANIM_BONES) {
    const b = bones[n];
    if (!b) continue;
    b.parent.getWorldQuaternion(q);
    AV.rest[n] = { q: b.quaternion.clone(), axis: right.clone().applyQuaternion(q.invert()).normalize() };
  }
  tpl.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  AV.ready = true;
}

function prepareRifleTemplate() {
  const t = RF.tpl;
  t.position.set(0, 0, 0); t.quaternion.identity(); t.scale.set(1, 1, 1);
  t.updateMatrixWorld(true);
  t.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
}

function makeRifle() {
  // rifle local space: muzzle +Z, up +Y, origin near the receiver. Rotate so the muzzle points -Z.
  const gun = SkeletonUtils.clone(RF.tpl);
  gun.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; } });
  const holder = new THREE.Group();
  holder.rotation.y = Math.PI;
  holder.add(gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.24, 0.47);
  gun.add(muzzle);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: TEX_FLASH, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 0,
  }));
  flash.position.copy(muzzle.position);
  flash.scale.setScalar(0.3);
  gun.add(flash);
  return { holder, gun, muzzle, flash };
}

const tagCache = new Map();
function nameTagTexture(name, color) {
  const key = name + color;
  if (tagCache.has(key)) return tagCache.get(key);
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 34px Rajdhani, Segoe UI, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(name, 128, 34);
  g.fillStyle = color; g.fillText(name, 128, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  tagCache.set(key, t);
  return t;
}

function makeAvatar(team, name) {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  const body = new THREE.Group();
  group.add(body);

  const model = SkeletonUtils.clone(AV.tpl);
  const tint = new THREE.Color(TEAMS[team].tint);
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.frustumCulled = false;
    o.castShadow = true;
    o.receiveShadow = false;
    if (!/head|hand|foot/i.test(o.name) && o.material && o.material.color) {
      o.material = o.material.clone();
      o.material.color.lerp(tint, 0.5);
    }
  });
  const fix = new THREE.Group();
  fix.rotation.y = AV.yawFix;
  fix.scale.setScalar(AV.scale);
  fix.position.copy(AV.offset);
  fix.add(model);
  body.add(fix);

  const aim = new THREE.Group();            // shoulder pivot; pitches with the player's aim
  aim.position.set(0, 1.4, 0);
  group.add(aim);
  const rifle = makeRifle();
  rifle.holder.position.set(0.16, -0.2, -0.12);
  rifle.gun.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  aim.add(rifle.holder);

  const tag = new THREE.Sprite(new THREE.SpriteMaterial({
    map: nameTagTexture(name, TEAMS[team].color), transparent: true, depthTest: false, depthWrite: false, fog: false,
  }));
  tag.scale.set(1.5, 0.375, 1);
  tag.position.set(0, 2.15, 0);
  tag.renderOrder = 999;
  group.add(tag);

  return { group, body, aim, rifle, tag, bones: boneMap(model) };
}

const _q = new THREE.Quaternion();
function swing(bones, name, angle) {
  const b = bones[name], r = AV.rest[name];
  if (!b || !r) return;
  _q.setFromAxisAngle(r.axis, angle);
  b.quaternion.copy(_q).multiply(r.q);
}

function poseAvatar(a, speed, phase, pitch, crouchT, air) {
  const bones = a.bones;
  const k = clamp(speed / 4.5, 0, 1) * (1 - crouchT * 0.4);
  const s = Math.sin(phase) * 0.85 * k;
  const bendL = Math.max(0, Math.sin(phase + 1.3)) * 0.9 * k;
  const bendR = Math.max(0, Math.sin(phase + 1.3 + Math.PI)) * 0.9 * k;
  const squat = crouchT * 0.5;
  swing(bones, 'LeftUpperLeg', air ? 0.5 : s + squat);
  swing(bones, 'RightUpperLeg', air ? -0.2 : -s + squat);
  swing(bones, 'LeftLowerLeg', air ? -0.9 : -bendL - squat * 1.2);
  swing(bones, 'RightLowerLeg', air ? -0.4 : -bendR - squat * 1.2);
  // arms raised to hold the rifle; they follow the aim pitch
  const lift = 1.28 + pitch * 0.9;
  swing(bones, 'RightUpperArm', lift);
  swing(bones, 'LeftUpperArm', lift + 0.08);
  swing(bones, 'RightLowerArm', 0.35);
  swing(bones, 'LeftLowerArm', 0.3);
  swing(bones, 'Head_1', pitch * 0.7);
  swing(bones, 'UpperTorso', pitch * 0.25);
  a.aim.rotation.x = pitch;
}

/* ======================================================================
   effects: particles, tracers, bullet holes, snow
   ====================================================================== */
const FX = { sprites: [], tracers: [], decals: [], decalIdx: 0, snow: null };

function initFX() {
  for (let i = 0; i < 120; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_DOT, transparent: true, depthWrite: false }));
    s.visible = false;
    scene.add(s);
    FX.sprites.push({ s, vel: new THREE.Vector3(), life: 0, max: 1, grav: 0, size: 0.1, grow: 0 });
  }
  const tg = new THREE.BoxGeometry(0.012, 0.012, 1);
  tg.translate(0, 0, 0.5);
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    m.visible = false; m.frustumCulled = false;
    scene.add(m);
    FX.tracers.push({ m, life: 0, max: 0.07 });
  }
  const dg = new THREE.CircleGeometry(0.055, 10);
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({
      color: 0x14171b, transparent: true, opacity: 0.8, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    m.visible = false;
    scene.add(m);
    FX.decals.push(m);
  }
  // falling snow, wrapped around the camera
  const N = 2600;
  const pos = new Float32Array(N * 3), spd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = rand(-35, 35); pos[i * 3 + 1] = rand(0, 30); pos[i * 3 + 2] = rand(-35, 35);
    spd[i] = 0.7 + Math.random() * 1.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.1, map: TEX_DOT, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true,
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  FX.snow = { pts, pos, spd, N };
}

function emit(p, n, o) {
  o = o || {};
  for (let k = 0; k < n; k++) {
    const f = FX.sprites.find((x) => x.life <= 0);
    if (!f) return;
    f.life = f.max = (o.life || 0.5) * rand(0.7, 1.2);
    f.size = (o.size || 0.12) * rand(0.7, 1.3);
    f.grav = o.grav == null ? 6 : o.grav;
    f.grow = o.grow || 0;
    const sp = (o.speed || 3) * rand(0.35, 1);
    f.vel.set(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize().multiplyScalar(sp);
    if (o.dir) f.vel.addScaledVector(o.dir, (o.speed || 3) * 0.7);
    f.s.position.copy(p);
    f.s.material.color.setHex(o.color == null ? 0xffffff : o.color);
    f.s.material.opacity = 1;
    f.s.visible = true;
  }
}

function tracer(from, to) {
  const t = FX.tracers.find((x) => x.life <= 0);
  if (!t) return;
  const len = from.distanceTo(to);
  if (len < 0.5) return;
  t.life = t.max;
  t.m.position.copy(from);
  t.m.lookAt(to);
  t.m.scale.set(1, 1, len);
  t.m.material.opacity = 0.9;
  t.m.visible = true;
}

const _n = new THREE.Vector3();
const _im = new THREE.Matrix4();
function impact(hit, dir) {
  const p = hit.point;
  _n.set(0, 1, 0);
  if (hit.face) {
    if (hit.instanceId !== undefined && hit.object.isInstancedMesh) {
      hit.object.getMatrixAt(hit.instanceId, _im);
      _im.premultiply(hit.object.matrixWorld);
      _n.copy(hit.face.normal).transformDirection(_im);
    } else _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
  }
  if (_n.dot(dir) > 0) _n.negate();
  const ground = hit.object.userData.kind === 'ground';
  if (ground) {
    emit(p, 9, { color: 0xf4f8ff, speed: 2.6, life: 0.7, size: 0.16, grav: 3, grow: 1.5, dir: _n });
  } else {
    emit(p, 7, { color: 0xffd48a, speed: 5.5, life: 0.28, size: 0.045, grav: 12, dir: _n });
    emit(p, 4, { color: 0xdfe6ee, speed: 1.6, life: 0.6, size: 0.12, grav: 1, grow: 2, dir: _n });
    const d = FX.decals[FX.decalIdx++ % FX.decals.length];
    d.position.copy(p).addScaledVector(_n, 0.012);
    d.lookAt(p.x + _n.x, p.y + _n.y, p.z + _n.z);
    d.visible = true;
  }
}

function updateFX(dt, t) {
  for (const f of FX.sprites) {
    if (f.life <= 0) continue;
    f.life -= dt;
    if (f.life <= 0) { f.s.visible = false; continue; }
    f.vel.y -= f.grav * dt;
    f.s.position.addScaledVector(f.vel, dt);
    const k = 1 - f.life / f.max;
    f.s.material.opacity = (1 - k) * 0.9;
    f.s.scale.setScalar(f.size * (1 + f.grow * k));
  }
  for (const tr of FX.tracers) {
    if (tr.life <= 0) continue;
    tr.life -= dt;
    if (tr.life <= 0) { tr.m.visible = false; continue; }
    tr.m.material.opacity = (tr.life / tr.max) * 0.9;
  }
  const s = FX.snow;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const wx = 0.9 + Math.sin(t * 0.0003) * 0.5, wz = 0.3;
  const p = s.pos;
  for (let i = 0; i < s.N; i++) {
    const j = i * 3;
    let x = p[j] + wx * dt + Math.sin(t * 0.001 + i) * 0.004;
    let y = p[j + 1] - s.spd[i] * dt;
    let z = p[j + 2] + wz * dt;
    x = cx + ((((x - cx + 35) % 70) + 70) % 70) - 35;
    z = cz + ((((z - cz + 35) % 70) + 70) % 70) - 35;
    y = (cy - 12) + ((((y - (cy - 12)) % 30) + 30) % 30);
    p[j] = x; p[j + 1] = y; p[j + 2] = z;
  }
  s.pts.geometry.attributes.position.needsUpdate = true;
}

/* ======================================================================
   game state
   ====================================================================== */
const sfx = new Sfx();
const players = new Map();       // id -> {id,name,team,k,d,alive,remote?}
let scores = [0, 0];
let limit = 40;
let respawnMs = CFG.respawnMs;
let matchOver = false;
let connected = false;
let locked = false;
let sens = parseFloat(store.get('sens', '1')) || 1;

const me = {
  id: 0, team: 0, name: 'Player',
  alive: false, dead: false, wantSpawn: false, deadUntil: 0, lastSpawnReq: 0, deadAt: 0, killerId: 0, killerName: '',
  hp: 100, pos: new THREE.Vector3(0, CFG.groundY, 0), vel: new THREE.Vector3(), vy: 0, onGround: true,
  yaw: 0, pitch: 0, recP: 0, recY: 0, bloom: 0,
  crouchT: 0, adsT: 0, sprintT: 0, adsHeld: false, firing: false, sprinting: false,
  mag: CFG.mag, reloading: false, reloadStart: 0, nextShot: 0, lastEmpty: 0, lastFire: 0,
  lean: 0, speedH: 0, bobT: 0, stepAcc: 0, eye: CFG.eye, hurtFlash: 0, swayX: 0, swayY: 0, kick: 0,
};
const keys = {};
let lastSend = 0;
const dbgInfo = { sent: 0, ok: 0, rej: '' };

const net = new Net({
  welcome: onWelcome, join: onJoin, leave: onLeave, snap: onSnap, shoot: onRemoteShoot,
  hurt: onHurt, hitc: onHitConfirm, kill: onKill, spawned: onSpawned, hp: (m) => { me.hp = m.hp; },
  over: onOver, reset: onReset,
  rej: (m) => { dbgInfo.rej = m.why; if (DEBUG) notify('Hit ignored: ' + m.why, '#ff9a7a', true); },
  full: () => { net.ws.close(); menuMessage('That room is full (12 players). Try another room name.'); showMenu(); },
  closed: () => {
    if (connected) { connected = false; document.exitPointerLock && document.exitPointerLock(); menuMessage('Disconnected from server. Reload the page to reconnect.'); showMenu(); }
    else if (!$('menuMsg').textContent.startsWith('That room')) { menuMessage('Could not connect to the server. Try again.'); $('joinBtn').disabled = false; }
  },
});

/* ======================================================================
   remote players
   ====================================================================== */
class Remote {
  constructor(info) {
    this.id = info.id; this.name = info.name; this.team = info.team;
    this.alive = !!info.alive;
    this.buf = [];
    this.pos = new THREE.Vector3(info.x || 0, info.y == null ? CFG.groundY : info.y, info.z || 0);
    this.yaw = info.yaw || 0; this.pitch = info.pitch || 0; this.m = info.m || 0;
    this.speed = 0; this.phase = Math.random() * 6; this.crouchT = 0; this.deadT = 0; this.diedAt = 0;
    this.stepAcc = 0; this.flashT = 0; this.lx = this.pos.x; this.lz = this.pos.z;
    this.lean = 0; this.headOff = { x: 0, z: 0 }; this.dbg = null;
    this.av = makeAvatar(this.team, this.name);
    this.group = this.av.group;
    this.group.visible = this.alive;
    this.av.tag.visible = this.team === me.team;       // teammates are marked, enemies are not
    scene.add(this.group);
    if (this.alive) this.buf.push({ t: performance.now() - 1000, x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, m: this.m });
  }

  push(s) {
    this.buf.push(s);
    if (this.buf.length > 10) this.buf.shift();
  }

  respawnAt(x, y, z, yaw) {
    this.alive = true; this.deadT = 0;
    this.buf.length = 0;
    this.pos.set(x, y, z); this.lx = x; this.lz = z; this.yaw = yaw; this.pitch = 0; this.m = 0;
    this.buf.push({ t: performance.now() - 1000, x, y, z, yaw, pitch: 0, m: 0 });
    this.group.visible = true;
    this.group.rotation.x = 0;
  }

  die() { this.alive = false; this.diedAt = performance.now(); this.deadT = 0; }

  update(dt, now) {
    if (!this.alive) {
      if (!this.group.visible) return;
      this.deadT = Math.min(1, this.deadT + dt * 2.4);
      const e = this.deadT * this.deadT * (3 - 2 * this.deadT);
      this.group.rotation.x = e * Math.PI * 0.5;
      this.group.rotation.z = 0;
      if (this.dbg) this.dbg.g.visible = false;
      this.group.position.set(this.pos.x, this.pos.y + e * 0.18, this.pos.z);
      this.av.tag.visible = false;
      if (now - this.diedAt > 6000) this.group.visible = false;
      return;
    }
    // interpolate between the two snapshots around (now - INTERP_MS)
    const rt = now - INTERP_MS;
    const b = this.buf;
    let a = null, c = null;
    for (let i = b.length - 1; i >= 0; i--) { if (b[i].t <= rt) { a = b[i]; c = b[i + 1] || null; break; } }
    if (!a && b.length) a = b[0];
    if (a) {
      if (c) {
        const k = clamp((rt - a.t) / Math.max(1, c.t - a.t), 0, 1);
        this.pos.set(lerp(a.x, c.x, k), lerp(a.y, c.y, k), lerp(a.z, c.z, k));
        this.yaw = lerpAngle(a.yaw, c.yaw, k);
        this.pitch = lerp(a.pitch, c.pitch, k);
      } else {
        this.pos.set(a.x, a.y, a.z); this.yaw = a.yaw; this.pitch = a.pitch;
      }
      this.m = a.m;
    }
    const mv = Math.hypot(this.pos.x - this.lx, this.pos.z - this.lz);
    this.lx = this.pos.x; this.lz = this.pos.z;
    this.speed = damp(this.speed, Math.min(mv / Math.max(dt, 0.001), 9), 10, dt);
    this.phase += dt * this.speed * 1.7;
    const crouch = (this.m & 1) ? 1 : 0;
    this.crouchT = damp(this.crouchT, crouch, 12, dt);
    this.av.body.scale.y = lerp(1, CFG.heightCrouch / CFG.height, this.crouchT);
    this.av.aim.position.y = lerp(1.4, 1.4 * (CFG.heightCrouch / CFG.height), this.crouchT);
    this.av.tag.position.y = lerp(2.15, 1.75, this.crouchT);
    poseAvatar(this.av, this.speed, this.phase, this.pitch, this.crouchT, (this.m & 32) !== 0);

    const leanT = (this.m & 128 ? 1 : 0) - (this.m & 64 ? 1 : 0);
    this.lean = damp(this.lean, leanT, 11, dt);
    this.headOff.x = Math.cos(this.yaw) * this.lean * LEAN_DIST;
    this.headOff.z = -Math.sin(this.yaw) * this.lean * LEAN_DIST;

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.group.rotation.x = 0;
    this.group.rotation.z = -this.lean * LEAN_BODY;
    if (DEBUG) this.updateDebugBox();

    // footsteps (crunching snow), positional
    if (this.speed > 1.4 && !(this.m & 1) && !(this.m & 32)) {
      this.stepAcc += this.speed * dt;
      if (this.stepAcc > (this.speed > 6 ? 2.7 : 2.0)) {
        this.stepAcc = 0;
        const d = camera.position.distanceTo(this.pos);
        if (d < 38) sfx.footstep(this.pos, 0.5);
      }
    }
    // muzzle flash decay
    this.flashT = Math.max(0, this.flashT - dt);
    this.av.rifle.flash.material.opacity = this.flashT > 0 ? 1 : 0;
    this.av.rifle.flash.material.rotation = Math.random() * 6;
  }

  updateDebugBox() {
    if (!this.dbg) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, depthTest: false, fog: false });
      const g = new THREE.Group();
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(CFG.hitRadius, CFG.hitRadius, 1, 12, 1, true), mat);
      const head = new THREE.Mesh(new THREE.SphereGeometry(CFG.headRadius, 10, 8), mat);
      g.add(cyl, head);
      scene.add(g);
      this.dbg = { g, cyl, head };
    }
    const H = (this.m & 1) ? CFG.heightCrouch : CFG.height, bh = H - 0.36;
    this.dbg.g.visible = true;
    this.dbg.cyl.scale.y = bh;
    this.dbg.cyl.position.set(this.pos.x, this.pos.y + bh / 2, this.pos.z);
    this.dbg.head.position.set(this.pos.x + this.headOff.x, this.pos.y + H - 0.2, this.pos.z + this.headOff.z);
  }

  setTeamTag() { this.av.tag.visible = this.team === me.team && this.alive; }
  dispose() { scene.remove(this.group); if (this.dbg) scene.remove(this.dbg.g); }
}

function remotes() {
  const out = [];
  for (const p of players.values()) if (p.remote) out.push(p.remote);
  return out;
}

function addPlayer(info) {
  if (players.has(info.id)) return;
  const p = { id: info.id, name: info.name, team: info.team, k: info.k || 0, d: info.d || 0, alive: !!info.alive };
  p.remote = new Remote(info);
  p.remote.group.visible = p.alive;
  players.set(info.id, p);
}

/* ======================================================================
   network handlers
   ====================================================================== */
function onWelcome(m) {
  me.id = m.id; me.team = m.team; me.name = m.name;
  limit = m.limit; respawnMs = m.respawnMs; scores = m.scores.slice();
  matchOver = !!m.over;
  for (const p of players.values()) if (p.remote) p.remote.dispose();
  players.clear();
  players.set(me.id, { id: me.id, name: me.name, team: me.team, k: 0, d: 0, alive: false, isMe: true });
  for (const p of m.players) addPlayer(p);
  connected = true;
  me.alive = false; me.dead = false; me.wantSpawn = true; me.deadUntil = 0;
  $('limitHud').textContent = limit;
  $('limitTxt').textContent = limit;
  const tag = $('teamTag');
  tag.textContent = 'TEAM ' + TEAMS[me.team].name;
  tag.style.color = TEAMS[me.team].color;
  updateScoreHud();
  notify('YOU ARE ON TEAM ' + TEAMS[me.team].name, TEAMS[me.team].color);
}

function onJoin(m) {
  addPlayer(m.p);
  notify(m.p.name + ' joined', '#cfe6ff', true);
}
function onLeave(m) {
  const p = players.get(m.id);
  if (!p) return;
  if (p.remote) p.remote.dispose();
  players.delete(m.id);
  notify(p.name + ' left', '#9db3c6', true);
}

function onSnap(m) {
  const t = performance.now();
  for (const r of m.p) {
    if (r[0] === me.id) continue;
    const p = players.get(r[0]);
    if (!p || !p.remote || !p.remote.alive) continue;
    p.remote.push({ t, x: r[1], y: r[2], z: r[3], yaw: r[4], pitch: r[5], m: r[6] });
  }
}

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
function onRemoteShoot(m) {
  const p = players.get(m.id);
  if (!p || !p.remote || !p.remote.alive) return;
  const r = p.remote;
  _o.set(m.o[0], m.o[1], m.o[2]);
  _d.set(m.d[0], m.d[1], m.d[2]).normalize();
  const hit = traceWorld(_o, _d, 120);
  _e.copy(_o).addScaledVector(_d, hit ? hit.distance : 120);
  r.av.rifle.muzzle.getWorldPosition(_o);
  tracer(_o, _e);
  if (hit) impact(hit, _d);
  r.flashT = 0.05;
  sfx.shot(r.pos);
}

function onHurt(m) {
  me.hp = m.hp;
  me.hurtFlash = 1;
  sfx.hurt();
  const a = players.get(m.from);
  if (a && a.remote) {
    const dx = a.remote.pos.x - me.pos.x, dz = a.remote.pos.z - me.pos.z;
    let rel = yawToward(dx, dz) - me.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const d = el('div', 'dmg');
    d.style.transform = `rotate(${-rel}rad)`;
    $('dmgdirs').appendChild(d);
    setTimeout(() => d.remove(), 1400);
  }
}

function onHitConfirm(m) {
  dbgInfo.ok++;
  const h = $('hitmarker');
  h.className = '';
  void h.offsetWidth;
  h.className = 'show' + (m.kill ? ' kill' : m.head ? ' head' : '');
  sfx.hitmarker(m.head, m.kill);
}

function onKill(m) {
  scores = m.scores.slice();
  const k = players.get(m.killer), v = players.get(m.victim);
  if (k) k.k = m.kk;
  if (v) { v.d = m.vd; v.alive = false; if (v.remote) v.remote.die(); }
  updateScoreHud();
  addKillfeed(k, v, m.head);
  if (m.victim === me.id) {
    me.alive = false; me.dead = true; me.deadAt = performance.now();
    me.deadUntil = performance.now() + (m.respawnMs || respawnMs);
    me.wantSpawn = true;
    me.killerId = m.killer; me.killerName = k ? k.name : '???';
    me.reloading = false; me.firing = false; me.adsHeld = false; me.lean = 0;
    sfx.die();
  } else if (m.killer === me.id && v) {
    notify('ELIMINATED ' + v.name.toUpperCase(), '#ffd24a');
  }
}

function onSpawned(m) {
  const p = players.get(m.id);
  if (m.id === me.id) {
    me.pos.set(m.x, m.y, m.z); me.yaw = m.yaw; me.pitch = 0;
    me.vel.set(0, 0, 0); me.vy = 0; me.onGround = true;
    me.hp = m.hp; me.alive = true; me.dead = false; me.wantSpawn = false;
    me.mag = CFG.mag; me.reloading = false; me.recP = me.recY = me.bloom = 0;
    me.eye = CFG.eye; me.crouchT = 0; me.adsT = 0; me.lean = 0;
    if (p) p.alive = true;
    $('dead').hidden = true;
    sfx.spawn();
    return;
  }
  if (p) {
    p.alive = true;
    if (p.remote) { p.remote.respawnAt(m.x, m.y, m.z, m.yaw); p.remote.setTeamTag(); }
  }
}

function onOver(m) {
  matchOver = true;
  scores = m.scores.slice();
  for (const r of m.players) { const p = players.get(r.id); if (p) { p.k = r.k; p.d = r.d; } }
  updateScoreHud();
  const win = m.winner === me.team;
  $('endTitle').textContent = win ? 'VICTORY' : 'DEFEAT';
  $('endTitle').style.color = win ? '#8dffa0' : '#ff7a6a';
  $('endSub').textContent = TEAMS[m.winner].name + ' WINS  ' + m.scores[0] + ' – ' + m.scores[1];
  fillScoreTables($('endA'), $('endB'));
  $('endscreen').hidden = false;
  $('scoreboard').hidden = true;
  endCountdown = performance.now() + 12000;
  me.firing = false; me.adsHeld = false;
}
let endCountdown = 0;

function onReset() {
  matchOver = false;
  scores = [0, 0];
  $('endscreen').hidden = true;
  for (const p of players.values()) {
    p.k = 0; p.d = 0; p.alive = false;
    if (p.remote) { p.remote.alive = false; p.remote.group.visible = false; }
  }
  me.alive = false; me.dead = false; me.wantSpawn = true; me.deadUntil = 0;
  updateScoreHud();
  notify('NEW MATCH', '#ffd24a');
}

/* ======================================================================
   spawning
   ====================================================================== */
function pickSpawn() {
  const enemies = remotes().filter((r) => r.alive && r.team !== me.team);
  const cands = [];
  for (let x = -120; x <= 120; x += 6) {
    for (let z = -120; z <= 120; z += 6) {
      if (me.team === 0 && z < 72) continue;        // FROST deploys from the south edge…
      if (me.team === 1 && z > -72) continue;       // …EMBER from the north edge
      if (blockedAt(x, z, World.boxes, 1.8)) continue;
      let dmin = 999;
      for (const e of enemies) dmin = Math.min(dmin, Math.hypot(e.pos.x - x, e.pos.z - z));
      cands.push({ x, z, score: dmin + Math.random() * 30 });
    }
  }
  if (!cands.length) return { x: World.spawnRef.x, z: World.spawnRef.z };
  cands.sort((a, b) => b.score - a.score);
  return cands[Math.floor(Math.random() * Math.min(8, cands.length))];
}

function requestSpawn(now) {
  const s = pickSpawn();
  const y = floorHeight({ x: s.x, y: CFG.groundY, z: s.z }, World.boxes);
  const yaw = yawToward(-s.x, -s.z);
  me.lastSpawnReq = now;
  net.send({ t: 'spawn', x: s.x, y, z: s.z, yaw });
}

/* ======================================================================
   input
   ====================================================================== */
addEventListener('keydown', (e) => {
  if (!connected || !locked) {
    if (e.code === 'Tab' && connected) { e.preventDefault(); showScoreboard(true); }
    return;
  }
  if (e.repeat) { e.preventDefault(); return; }
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); showScoreboard(true); }
  if (e.code === 'KeyR') startReload(performance.now());
  if (e.code === 'KeyM') toggleBigMap();
  if (e.code === 'Space' || e.code === 'ControlLeft' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') { e.preventDefault(); showScoreboard(false); }
});
addEventListener('blur', () => { for (const k in keys) keys[k] = false; me.firing = false; me.adsHeld = false; showScoreboard(false); });
addEventListener('mousedown', (e) => {
  if (!connected || !locked) return;
  if (e.button === 0) me.firing = true;
  if (e.button === 2) me.adsHeld = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) me.firing = false;
  if (e.button === 2) me.adsHeld = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (!locked || !me.alive || matchOver) return;
  const k = 0.0022 * sens * lerp(1, 0.62, me.adsT);
  me.yaw -= e.movementX * k;
  me.pitch = clamp(me.pitch - e.movementY * k, -1.5, 1.5);
  me.swayX = clamp(me.swayX - e.movementX * 0.00035, -0.05, 0.05);
  me.swayY = clamp(me.swayY + e.movementY * 0.00035, -0.05, 0.05);
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  $('pause').hidden = locked || !connected;
  if (!locked) { for (const k in keys) keys[k] = false; me.firing = false; me.adsHeld = false; }
});
document.addEventListener('pointerlockerror', () => { if (connected) $('pause').hidden = false; });
$('pause').addEventListener('click', () => { sfx.init(); canvas.requestPointerLock(); });

/* ======================================================================
   weapon
   ====================================================================== */
const rc = new THREE.Raycaster();
function traceWorld(o, d, max) {
  rc.set(o, d);
  rc.near = 0; rc.far = max;
  const hits = rc.intersectObjects(World.occluders, false);
  return hits.length ? hits[0] : null;
}

function startReload(now) {
  if (!me.alive || me.reloading || me.mag >= CFG.mag || matchOver) return;
  me.reloading = true; me.reloadStart = now;
  sfx.reload();
}

const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _org = new THREE.Vector3(), _mz = new THREE.Vector3(), _end = new THREE.Vector3();
let vmRifle = null;       // viewmodel parts (built after load)
let vmFlashT = 0;

function fire(now) {
  me.nextShot = now + CFG.fireInterval * 1000;
  me.lastFire = now;
  me.mag--;

  let spread = lerp(1.6, 0.22, me.adsT);
  if (me.speedH > 0.5) spread += me.sprinting ? 3 : 0.9 * (1 - me.adsT * 0.7);
  if (!me.onGround) spread += 3;
  if (me.crouchT > 0.5) spread *= 0.65;
  spread += me.bloom * 0.9;

  camera.updateMatrixWorld(true);
  camera.getWorldDirection(_dir);
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  _up.setFromMatrixColumn(camera.matrixWorld, 1);
  const ang = Math.tan(spread * Math.PI / 180) * Math.sqrt(Math.random());
  const phi = Math.random() * Math.PI * 2;
  _dir.addScaledVector(_right, ang * Math.cos(phi)).addScaledVector(_up, ang * Math.sin(phi)).normalize();
  _org.copy(camera.position);

  const world = traceWorld(_org, _dir, CFG.range);
  const maxT = world ? world.distance : CFG.range;
  let best = null;
  for (const r of remotes()) {
    if (!r.alive || r.team === me.team) continue;
    const h = rayPlayer(_org, _dir, r.pos, (r.m & 1) !== 0, r.headOff);
    if (h && h.t < maxT && (!best || h.t < best.t)) best = { t: h.t, head: h.head, r };
  }

  // visuals: tracer from the rifle muzzle to wherever the bullet ended
  const endT = best ? best.t : maxT;
  _end.copy(_org).addScaledVector(_dir, endT);
  _mz.copy(_org).addScaledVector(_right, 0.17).addScaledVector(_up, -0.13).addScaledVector(_dir, 0.75);
  if (endT > 4) tracer(_mz, _end);

  if (best) {
    net.send({ t: 'hit', id: best.r.id, head: best.head });
    dbgInfo.sent++;
    emit(_end, 6, { color: 0xb0161a, speed: 2.2, life: 0.35, size: 0.07, grav: 4, grow: 1.2 });
  } else if (world) {
    impact(world, _dir);
  }
  net.send({ t: 'shoot', o: [_org.x, _org.y, _org.z], d: [_dir.x, _dir.y, _dir.z] });

  me.recP += rand(0.010, 0.016) * lerp(1, 0.6, me.adsT);
  me.recY += rand(-0.006, 0.006) * lerp(1, 0.6, me.adsT);
  me.bloom = Math.min(1.6, me.bloom + 0.22);
  me.kick = 1;
  vmFlashT = 0.045;
  sfx.shot(null);
}

/* ======================================================================
   local player update
   ====================================================================== */
function updateLocal(dt, now) {
  const input = locked && !matchOver;
  const wantCrouch = input && (keys.KeyC || keys.ControlLeft);
  me.crouchT = damp(me.crouchT, wantCrouch ? 1 : 0, 12, dt);
  const crouched = me.crouchT > 0.5;

  const fwdIn = input ? (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) : 0;
  const strIn = input ? (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) : 0;
  const leanIn = input ? (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0) : 0;
  me.lean = damp(me.lean, leanIn, 11, dt);
  me.sprinting = input && !!keys.ShiftLeft && fwdIn > 0 && !crouched && !me.firing && !me.adsHeld && leanIn === 0;

  const sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
  let wx = -sy * fwdIn + cy * strIn, wz = -cy * fwdIn - sy * strIn;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }
  let speed = crouched ? CFG.crouch : me.sprinting ? CFG.sprint : CFG.walk;
  speed *= lerp(1, 0.66, me.adsT);
  if (me.reloading) speed *= 0.92;
  const k = 1 - Math.exp(-(me.onGround ? 13 : 2.2) * dt);
  me.vel.x += (wx * speed - me.vel.x) * k;
  me.vel.z += (wz * speed - me.vel.z) * k;

  if (input && keys.Space && me.onGround && !crouched) { me.vy = CFG.jump; me.onGround = false; }

  const n = Math.max(1, Math.ceil(dt / 0.01)), h = dt / n;
  for (let i = 0; i < n; i++) {
    movePlayer(me.pos, World.boxes, me.vel.x * h, me.vel.z * h);
    me.vy -= CFG.gravity * h;
    me.pos.y += me.vy * h;
    const fh = floorHeight(me.pos, World.boxes);
    if (me.vy <= 0 && me.pos.y <= fh) { me.pos.y = fh; me.vy = 0; me.onGround = true; } else me.onGround = false;
  }
  me.speedH = Math.hypot(me.vel.x, me.vel.z);

  // aim-down-sights, recoil recovery
  const wantAds = input && me.adsHeld && !me.sprinting && !me.reloading;
  me.adsT = damp(me.adsT, wantAds ? 1 : 0, 14, dt);
  me.sprintT = damp(me.sprintT, me.sprinting ? 1 : 0, 10, dt);
  me.recP = damp(me.recP, 0, 7, dt);
  me.recY = damp(me.recY, 0, 7, dt);
  me.bloom = Math.max(0, me.bloom - dt * 2.4);
  me.kick = damp(me.kick, 0, 18, dt);
  me.swayX = damp(me.swayX, 0, 7, dt);
  me.swayY = damp(me.swayY, 0, 7, dt);
  me.hurtFlash = damp(me.hurtFlash, 0, 3.5, dt);

  if (me.onGround && me.speedH > 0.6) {
    me.bobT += dt * me.speedH * 1.5;
    if (!crouched) {
      me.stepAcc += me.speedH * dt;
      if (me.stepAcc > (me.sprinting ? 2.7 : 2.0)) { me.stepAcc = 0; sfx.footstep(null, 0.28); }
    }
  }

  if (me.reloading && now - me.reloadStart >= CFG.reloadTime * 1000) { me.reloading = false; me.mag = CFG.mag; }
  me.eye = lerp(CFG.eye, CFG.eyeCrouch, me.crouchT);
}

function updateFire(now) {
  if (!me.alive || !locked || matchOver || !me.firing) return;
  if (me.reloading || me.sprinting || now < me.nextShot) return;
  if (me.mag <= 0) {
    if (now - me.lastEmpty > 350) { sfx.empty(); me.lastEmpty = now; }
    startReload(now);
    return;
  }
  fire(now);
}

/* ======================================================================
   camera + viewmodel
   ====================================================================== */
function eyeBlocked(x, z, y) {
  for (const b of World.boxes) {
    if (y < b.minY || y > b.maxY) continue;
    if (x > b.minX - 0.12 && x < b.maxX + 0.12 && z > b.minZ - 0.12 && z < b.maxZ + 0.12) return true;
  }
  return false;
}

const orbit = { t: Math.random() * 6 };
function updateCamera(dt, now) {
  if (me.alive) {
    const bob = me.onGround ? Math.sin(me.bobT * 2) * 0.012 * clamp(me.speedH / 5, 0, 1.4) * (1 - me.adsT * 0.8) : 0;
    const eyeY = me.pos.y + me.eye + bob;
    let lx = 0, lz = 0;
    if (Math.abs(me.lean) > 0.005) {
      // lean sideways, but never push the camera into a wall
      for (let k = 1; k > 0; k -= 0.25) {
        const tx = me.pos.x + Math.cos(me.yaw) * me.lean * LEAN_DIST * k;
        const tz = me.pos.z - Math.sin(me.yaw) * me.lean * LEAN_DIST * k;
        if (!eyeBlocked(tx, tz, eyeY)) { lx = tx - me.pos.x; lz = tz - me.pos.z; break; }
      }
    }
    camera.position.set(me.pos.x + lx, eyeY, me.pos.z + lz);
    const strafe = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const roll = -strafe * 0.012 * (1 - me.adsT) - me.lean * LEAN_ROLL;
    camera.rotation.set(me.pitch + me.recP, me.yaw + me.recY, roll);
    const fov = lerp(75, 52, me.adsT);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  } else if (me.dead) {
    // death cam: collapse to the ground and look toward the killer
    const k = clamp((now - me.deadAt) / 700, 0, 1);
    const killer = players.get(me.killerId);
    let yaw = me.yaw;
    if (killer && killer.remote) {
      const target = yawToward(killer.remote.pos.x - me.pos.x, killer.remote.pos.z - me.pos.z);
      yaw = lerpAngle(me.yaw, target, 0.04 + 0.0 * k);
      me.yaw = yaw;
    }
    camera.position.set(me.pos.x, me.pos.y + lerp(me.eye, 0.35, k), me.pos.z);
    camera.rotation.set(lerp(me.pitch, -0.1, k), yaw, k * 0.7);
    if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
  } else {
    // menu / waiting: slow fly-around of the map
    orbit.t += dt * 0.05;
    const r = 46, a = orbit.t;
    camera.position.set(Math.cos(a) * r, CFG.groundY + 17, Math.sin(a) * r);
    camera.lookAt(0, CFG.groundY + 4, 0);
    if (camera.fov !== 62) { camera.fov = 62; camera.updateProjectionMatrix(); }
  }
  camera.updateMatrixWorld(true);
  sky.position.copy(camera.position);

  // follow-the-player shadow frustum, snapped to avoid shimmering
  const sx = Math.round(camera.position.x / 0.5) * 0.5, sz = Math.round(camera.position.z / 0.5) * 0.5;
  sun.target.position.set(sx, CFG.groundY, sz);
  sun.position.set(sx + SUN_DIR.x * 130, CFG.groundY + SUN_DIR.y * 130, sz + SUN_DIR.z * 130);
  sun.target.updateMatrixWorld();
}

const VM_HIP = new THREE.Vector3(0.15, -0.34, -0.30);
const VM_ADS = new THREE.Vector3(0.0, -0.2965, -0.24);
function updateViewmodel(dt, now) {
  if (!vmRifle) return;
  const vm = vmRifle.holder;
  const show = me.alive;
  vm.visible = show;
  if (!show) return;
  const a = me.adsT;
  const bobAmt = (me.onGround ? clamp(me.speedH / 5, 0, 1.4) : 0.2) * (1 - a * 0.85);
  const px = lerp(VM_HIP.x, VM_ADS.x, a) + Math.cos(me.bobT) * 0.008 * bobAmt + me.swayX;
  const py = lerp(VM_HIP.y, VM_ADS.y, a) + Math.abs(Math.sin(me.bobT)) * -0.008 * bobAmt + me.swayY - me.sprintT * 0.07;
  const pz = lerp(VM_HIP.z, VM_ADS.z, a) + me.kick * 0.035;
  let rx = me.kick * 0.045 - me.sprintT * 0.5, ry = me.sprintT * 0.55, rz = me.sprintT * 0.2 - me.lean * LEAN_ROLL;
  let ox = 0, oy = 0;
  if (me.reloading) {
    const t = clamp((now - me.reloadStart) / (CFG.reloadTime * 1000), 0, 1);
    const e = Math.sin(t * Math.PI);
    rx -= 0.7 * e; rz += 0.5 * e; oy -= 0.13 * e; ox += 0.04 * e;
  }
  vm.position.set(px + ox, py + oy, pz);
  vm.rotation.set(rx, Math.PI * 0 + ry, rz);
  // the holder is rotated 180° inside the pivot; keep the pivot itself unrotated
  vmRifle.pivot.position.copy(vm.position);
  vmRifle.pivot.rotation.copy(vm.rotation);

  vmFlashT = Math.max(0, vmFlashT - dt);
  const f = vmRifle.flash;
  f.material.opacity = vmFlashT > 0 ? 1 : 0;
  f.material.rotation = Math.random() * 6;
  f.scale.setScalar(0.22 + Math.random() * 0.12);
  vmRifle.light.intensity = vmFlashT > 0 ? 7 : 0;
}

function buildViewmodel() {
  const r = makeRifle();
  const pivot = new THREE.Group();
  pivot.add(r.holder);
  vmScene.add(pivot);
  // reuse the rifle's own flash sprite; add a light that tints the gun when firing
  const light = new THREE.PointLight(0xffb060, 0, 2.5, 2);
  light.position.set(0, 0.24, 0.55);
  r.gun.add(light);
  r.holder.position.set(0, 0, 0);
  r.holder.rotation.set(0, Math.PI, 0);
  vmRifle = { holder: pivot, pivot, flash: r.flash, light };
  // updateViewmodel positions `holder` (alias of pivot) — keep both in sync
  vmRifle.holder = pivot;
}

/* ======================================================================
   HUD
   ====================================================================== */
let hudCache = {};
function setText(id, v) {
  if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; }
}

function updateHUD(now) {
  setText('hpNum', String(Math.max(0, Math.round(me.hp))));
  const fill = $('hpFill');
  const w = clamp(me.hp, 0, 100) + '%';
  if (hudCache.hpw !== w) { hudCache.hpw = w; fill.style.width = w; fill.classList.toggle('low', me.hp < 35); }
  setText('ammoMag', String(me.mag));
  const am = $('ammoMag');
  const low = me.mag <= 8;
  if (hudCache.low !== low) { hudCache.low = low; am.classList.toggle('low', low); }
  setText('reloadTxt', me.reloading ? 'RELOADING' : (me.mag === 0 ? 'PRESS R' : ''));

  const base = me.alive ? clamp((45 - me.hp) / 45, 0, 1) * 0.75 : 0;
  const vig = Math.max(base, me.hurtFlash * 0.7);
  const vs = vig.toFixed(2);
  if (hudCache.vig !== vs) { hudCache.vig = vs; $('vignette').style.opacity = vs; }

  const gap = 7 + (lerp(1.6, 0.22, me.adsT) + (me.speedH > 0.5 ? 1.6 : 0) + me.bloom * 1.4 + (me.onGround ? 0 : 3)) * 3.2 * (1 - me.adsT * 0.5);
  $('crosshair').style.setProperty('--gap', gap.toFixed(1) + 'px');
  $('crosshair').style.opacity = me.alive ? (1 - me.adsT * 0.85) : 0;

  setText('ping', net.rtt ? net.rtt + ' ms' : '');

  const dead = $('dead');
  if (me.dead && !matchOver) {
    if (dead.hidden) dead.hidden = false;
    setText('deadBy', 'Eliminated by ' + me.killerName);
    const left = Math.max(0, Math.ceil((me.deadUntil - now) / 1000));
    setText('deadTimer', left > 0 ? 'DEPLOYING IN ' + left : 'DEPLOYING…');
  } else if (!dead.hidden) dead.hidden = true;

  if (!$('endscreen').hidden) setText('endTimer', 'NEXT MATCH IN ' + Math.max(0, Math.ceil((endCountdown - now) / 1000)));
}

function updateScoreHud() {
  setText('scoreA', String(scores[0]));
  setText('scoreB', String(scores[1]));
}

function notify(text, color, small) {
  const d = el('div', null, text);
  if (color) d.style.color = color;
  if (small) d.style.fontSize = '16px';
  const box = $('notify');
  box.replaceChildren(d);
  setTimeout(() => { if (d.parentNode === box) d.remove(); }, 2300);
}

function addKillfeed(k, v, head) {
  if (!k || !v) return;
  const row = el('div', 'kf' + (k.id === me.id || v.id === me.id ? ' me' : ''));
  row.appendChild(el('span', k.team === 0 ? 'ta' : 'tb', k.name));
  row.appendChild(el('span', 'arrow', '▸'));
  if (head) row.appendChild(el('span', 'hs', '◎'));
  row.appendChild(el('span', v.team === 0 ? 'ta' : 'tb', v.name));
  const feed = $('killfeed');
  feed.appendChild(row);
  while (feed.children.length > 6) feed.firstChild.remove();
  setTimeout(() => row.remove(), 6500);
}

function scoreTable(team) {
  const rows = [...players.values()].filter((p) => p.team === team).sort((a, b) => b.k - a.k || a.d - b.d);
  const t = el('table', 'sb');
  const cap = el('caption', team === 0 ? 'ta' : 'tb', TEAMS[team].name + '  ' + scores[team]);
  t.appendChild(cap);
  const hr = el('tr');
  hr.appendChild(el('th', null, 'PLAYER'));
  hr.appendChild(el('th', 'n', 'K'));
  hr.appendChild(el('th', 'n', 'D'));
  t.appendChild(hr);
  for (const p of rows) {
    const tr = el('tr', (p.id === me.id ? 'me ' : '') + (p.alive ? '' : 'dead'));
    tr.appendChild(el('td', null, p.name));
    tr.appendChild(el('td', 'n', String(p.k)));
    tr.appendChild(el('td', 'n', String(p.d)));
    t.appendChild(tr);
  }
  return t;
}
function fillScoreTables(a, b) {
  a.replaceChildren(scoreTable(0));
  b.replaceChildren(scoreTable(1));
}
let sbTimer = 0;
function showScoreboard(on) {
  const sb = $('scoreboard');
  if (on && !matchOver) {
    fillScoreTables($('sbA'), $('sbB'));
    sb.hidden = false;
    clearInterval(sbTimer);
    sbTimer = setInterval(() => fillScoreTables($('sbA'), $('sbB')), 400);
  } else {
    sb.hidden = true;
    clearInterval(sbTimer);
  }
}

const mmCtx = $('minimap').getContext('2d');

// draws roads, buildings and trees in world coordinates (caller sets up the transform)
function drawMapLayers(g, S, big) {
  g.fillStyle = 'rgba(120,128,138,.55)';
  for (const r of World.layout.roads) g.fillRect(r.minX * S, r.minZ * S, (r.maxX - r.minX) * S, (r.maxZ - r.minZ) * S);
  g.fillStyle = 'rgba(70,130,90,.75)';
  for (const t of World.treeMarks) { g.beginPath(); g.arc(t.x * S, t.z * S, 3.4 * t.s * S, 0, Math.PI * 2); g.fill(); }
  for (const b of World.boxes) {
    if (b.kind === 'tree') continue;
    if (b.kind === 'prop' && !big) continue;
    g.fillStyle = b.kind === 'prop' ? 'rgba(170,125,70,.9)' : b.name === 'tower-leg' ? '#1d2228' : 'rgba(58,72,66,.95)';
    g.fillRect(b.minX * S, b.minZ * S, Math.max(1, (b.maxX - b.minX) * S), Math.max(1, (b.maxZ - b.minZ) * S));
  }
  g.strokeStyle = 'rgba(255,255,255,.35)';
  g.strokeRect(-CFG.bounds * S, -CFG.bounds * S, CFG.bounds * 2 * S, CFG.bounds * 2 * S);
}

function drawMinimap() {
  const W = 160, H = 160, S = 1.1;
  mmCtx.clearRect(0, 0, W, H);
  mmCtx.save();
  mmCtx.beginPath(); mmCtx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); mmCtx.clip();
  mmCtx.fillStyle = 'rgba(214,228,240,.22)'; mmCtx.fillRect(0, 0, W, H);
  mmCtx.translate(W / 2, H / 2);
  mmCtx.rotate(me.yaw);
  mmCtx.translate(-me.pos.x * S, -me.pos.z * S);
  if (World.layout) drawMapLayers(mmCtx, S, false);
  for (const r of remotes()) {
    if (!r.alive || r.team !== me.team) continue;
    mmCtx.fillStyle = '#6dff8d';
    mmCtx.beginPath(); mmCtx.arc(r.pos.x * S, r.pos.z * S, 3.2, 0, Math.PI * 2); mmCtx.fill();
  }
  mmCtx.restore();
  mmCtx.fillStyle = '#ffd24a';
  mmCtx.beginPath(); mmCtx.moveTo(W / 2, H / 2 - 7); mmCtx.lineTo(W / 2 + 5, H / 2 + 5); mmCtx.lineTo(W / 2 - 5, H / 2 + 5); mmCtx.closePath(); mmCtx.fill();
}

// full-map overlay (M)
const BIG = 720, BIGS = BIG / 300;
let bigStatic = null;
function buildBigStatic() {
  const c = document.createElement('canvas');
  c.width = c.height = BIG;
  const g = c.getContext('2d');
  g.fillStyle = '#cfdbe6'; g.fillRect(0, 0, BIG, BIG);
  g.save();
  g.translate(BIG / 2, BIG / 2);
  drawMapLayers(g, BIGS, true);
  g.font = '700 13px sans-serif'; g.textAlign = 'center';
  const label = (t, x, z, col) => { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText(t, x * BIGS + 1, z * BIGS + 1); g.fillStyle = col || '#10202e'; g.fillText(t, x * BIGS, z * BIGS); };
  label('OUTPOST', 0, -28);
  label('INDUSTRIAL YARD', 98, 66);
  label('RING ROAD', -90, 53);
  label('WATCHTOWER', -100, -92);
  label('WATCHTOWER', 100, -92);
  label('WATCHTOWER', -100, 108);
  label('FROST DEPLOY', 0, 128, '#1e66c0');
  label('EMBER DEPLOY', 0, -122, '#c4561f');
  g.restore();
  return c;
}
function drawBigMap() {
  if (!World.layout) return;
  if (!bigStatic) bigStatic = buildBigStatic();
  const g = $('bigmapCanvas').getContext('2d');
  g.drawImage(bigStatic, 0, 0);
  g.save();
  g.translate(BIG / 2, BIG / 2);
  for (const r of remotes()) {
    if (!r.alive || r.team !== me.team) continue;
    g.fillStyle = '#25c452';
    g.beginPath(); g.arc(r.pos.x * BIGS, r.pos.z * BIGS, 5, 0, Math.PI * 2); g.fill();
  }
  g.translate(me.pos.x * BIGS, me.pos.z * BIGS);
  g.rotate(-me.yaw);
  g.fillStyle = '#ffb400'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke();
  g.restore();
}
function toggleBigMap() {
  const m = $('bigmap');
  m.hidden = !m.hidden;
  if (!m.hidden) drawBigMap();
}

/* ======================================================================
   menu / boot
   ====================================================================== */
function menuMessage(t) { $('menuMsg').textContent = t || ''; }
function showMenu() {
  $('menu').hidden = false; $('hud').hidden = true; $('joinBtn').disabled = false; $('pause').hidden = true;
}

function setupMenu() {
  const nameEl = $('name'), roomEl = $('room');
  nameEl.value = store.get('name', '');
  roomEl.value = (Q.get('room') || store.get('room', 'main')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'main';
  const qsel = $('quality');
  qsel.value = QNAME;
  qsel.addEventListener('change', () => {
    store.set('quality', qsel.value);
    store.set('name', nameEl.value.trim()); store.set('room', roomEl.value.trim() || 'main');
    location.href = location.pathname + (Q.get('room') ? '?room=' + encodeURIComponent(Q.get('room')) : '');
  });
  $('sens').value = String(sens);
  $('vol').value = store.get('vol', '0.8');
  sfx.volume = parseFloat($('vol').value);
  $('sens').addEventListener('input', () => { sens = parseFloat($('sens').value); store.set('sens', String(sens)); });
  $('vol').addEventListener('input', () => { const v = parseFloat($('vol').value); store.set('vol', String(v)); sfx.setVolume(v); });

  $('copyLink').addEventListener('click', async () => {
    const room = roomEl.value.trim() || 'main';
    const link = location.origin + '/?room=' + encodeURIComponent(room);
    try { await navigator.clipboard.writeText(link); menuMessage('Invite link copied — send it to your friends.'); }
    catch (e) { menuMessage(link); }
  });

  const join = () => {
    const name = nameEl.value.trim() || 'Player' + Math.floor(Math.random() * 900 + 100);
    const room = (roomEl.value.trim() || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'main';
    store.set('name', name); store.set('room', room);
    sfx.init();
    menuMessage('Connecting…');
    $('joinBtn').disabled = true;
    net.connect(room, name);
    // wait for the server's welcome before entering the game view
    const started = performance.now();
    const wait = setInterval(() => {
      if (!connected && (!net.ws || net.ws.readyState > 1)) { clearInterval(wait); return; }
      if (connected) {
        clearInterval(wait);
        menuMessage('');
        $('menu').hidden = true; $('hud').hidden = false;
        canvas.requestPointerLock();
        setTimeout(() => { if (connected && !locked) $('pause').hidden = false; }, 600);
        history.replaceState(null, '', '?room=' + encodeURIComponent(room));
      } else if (performance.now() - started > 20000) {
        clearInterval(wait);
        menuMessage('Could not reach the server. Try again.');
        $('joinBtn').disabled = false;
      }
    }, 100);
  };
  $('joinBtn').addEventListener('click', join);
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  roomEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
}

function loadMap() {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load('/assets/map.glb', resolve, (e) => {
      if (e.lengthComputable) {
        const p = Math.round((e.loaded / e.total) * 100);
        $('loadbar').style.width = p + '%';
        $('loadtext').textContent = 'Loading map… ' + p + '%';
      }
    }, reject);
  });
}

/* Network tick: runs on a timer (not the render loop) so a tab that is in the
   background still spawns, and keeps sending its position. */
function netTick() {
  const now = performance.now();
  if (connected && me.wantSpawn && !me.alive && now >= me.deadUntil && now - me.lastSpawnReq > 700 && !matchOver) requestSpawn(now);
  if (connected && me.alive && now - lastSend >= SEND_MS - 3) {
    lastSend = now;
    const m = (me.crouchT > 0.5 ? 1 : 0) | (me.sprinting ? 2 : 0) | (me.adsT > 0.5 ? 4 : 0) | (me.reloading ? 8 : 0) |
      (now - me.lastFire < 150 ? 16 : 0) | (!me.onGround ? 32 : 0) | (me.lean < -0.5 ? 64 : 0) | (me.lean > 0.5 ? 128 : 0);
    net.send({ t: 's', x: +me.pos.x.toFixed(2), y: +me.pos.y.toFixed(2), z: +me.pos.z.toFixed(2), yaw: +me.yaw.toFixed(3), pitch: +me.pitch.toFixed(3), m });
  }
}

/* ======================================================================
   main loop
   ====================================================================== */
let last = performance.now();
let mmTimer = 0, cullT = 0, fpsAcc = 0, fpsN = 0, fpsShown = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);

  if (me.alive) updateLocal(dt, now);
  updateCamera(dt, now);
  updateFire(now);
  updateViewmodel(dt, now);

  if (World.village && now - cullT > 250) { cullT = now; World.village.update(camera.position.x, camera.position.z); }
  for (const r of remotes()) r.update(dt, now);
  updateFX(dt, now);
  sfx.setListener(camera.position, camera.getWorldDirection(_dir));

  if (!$('hud').hidden) {
    updateHUD(now);
    if (now - mmTimer > 90) { mmTimer = now; drawMinimap(); if (!$('bigmap').hidden) drawBigMap(); }
  }

  renderer.clear(true, true, true);
  renderer.render(scene, camera);
  if (me.alive && vmRifle) {
    renderer.clearDepth();
    renderer.render(vmScene, vmCamera);
  }

  if (DEBUG) {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fpsShown = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    const f = $('fps');
    f.hidden = false;
    f.textContent = `${fpsShown} fps  ${renderer.info.render.calls} calls  ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris\n` +
      `pos ${me.pos.x.toFixed(1)}, ${(me.pos.y - CFG.groundY).toFixed(2)}, ${me.pos.z.toFixed(1)}  players ${players.size}\n` +
      `hits sent ${dbgInfo.sent}  confirmed ${dbgInfo.ok}  last rejection: ${dbgInfo.rej || '-'}`;
  }
  renderer.info.reset();
}

async function boot() {
  initFX();
  setupMenu();
  setInterval(netTick, 50);
  const gltf = await loadMap();
  buildWorld(gltf);
  buildViewmodel();
  if (DEBUG) window.__fl = { scene, camera, me, players, World, AV, THREE, sfx };
  $('loading').hidden = true;
  $('menu').hidden = false;
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  showError(e);
  $('loadtext').textContent = 'Failed to start — see error below.';
});
