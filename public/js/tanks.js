// Procedural arctic tank model (no external assets). Faces -Z at yaw 0, like players.
import * as THREE from 'three';

export const TANK = { radius: 2.6, hullH: 1.0, maxSpeed: 9.5, reverse: 4.5, accel: 3.2, turn: 0.95, turretSlew: 2.4, reload: 2400 };

export function createTankModel() {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.85, metalness: 0.15 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x5b6652, roughness: 0.8, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3035, roughness: 0.9, metalness: 0.3 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, emissive: 0x222222 });
  const mats = [white, olive, dark];
  const add = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  };
  // hull
  add(group, new THREE.BoxGeometry(3.0, 0.9, 6.0), olive, 0, 1.05, 0);
  add(group, new THREE.BoxGeometry(2.6, 0.18, 5.4), white, 0, 1.56, 0.1);       // snow on the deck
  const nose = add(group, new THREE.BoxGeometry(3.0, 0.7, 1.4), olive, 0, 1.0, -3.4); nose.rotation.x = -0.35;
  // tracks + wheels
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(0.85, 1.15, 6.6), dark, sx * 1.9, 0.62, 0);
    add(group, new THREE.BoxGeometry(1.0, 0.12, 6.7), white, sx * 1.9, 1.24, 0);   // snow on tracks
    for (let i = 0; i < 6; i++) {
      const w = add(group, new THREE.CylinderGeometry(0.42, 0.42, 0.9, 14), olive, sx * 1.9, 0.5, -2.5 + i * 1.0);
      w.rotation.z = Math.PI / 2;
    }
  }
  // turret
  const turret = new THREE.Group();
  turret.position.set(0, 1.75, 0.2);
  group.add(turret);
  add(turret, new THREE.BoxGeometry(2.4, 0.85, 2.8), olive, 0, 0.42, 0);
  add(turret, new THREE.BoxGeometry(2.0, 0.14, 2.3), white, 0, 0.9, 0.05);
  add(turret, new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12), dark, 0.6, 1.0, 0.7);   // hatch
  const stripe = add(turret, new THREE.BoxGeometry(2.45, 0.12, 0.5), stripeMat, 0, 0.62, 0.8);
  const barrelPivot = new THREE.Group();
  barrelPivot.position.set(0, 0.5, -1.35);
  turret.add(barrelPivot);
  const barrel = add(barrelPivot, new THREE.CylinderGeometry(0.13, 0.15, 4.4, 10), dark, 0, 0, -2.2);
  barrel.rotation.x = Math.PI / 2;
  add(barrelPivot, new THREE.CylinderGeometry(0.22, 0.22, 0.5, 10), dark, 0, 0, -4.3).rotation.x = Math.PI / 2;
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -4.6); barrelPivot.add(muzzle);

  let wreck = false;
  return {
    group, turret, barrelPivot, muzzle, stripe: stripeMat,
    setTeam(hex) { stripeMat.color.setHex(hex); stripeMat.emissive.setHex(hex).multiplyScalar(0.25); },
    setWreck(w) {
      if (w === wreck) return; wreck = w;
      for (const m of mats) m.color.multiplyScalar(w ? 0.22 : 1 / 0.22);
      if (w) stripeMat.color.setHex(0x151515);
    },
  };
}
