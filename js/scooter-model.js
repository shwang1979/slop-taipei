import * as THREE from 'three/webgpu';
import { Fn, attribute, float, vec3, mix, step, smoothstep, uniform, color } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';

// js/scooter-model.js
// The 125 cc step-through scooter (機車) that fills Taipei's streets: front apron & fender, floorboard, the body under
// the seat, handlebar cowl with its headlight, small wheels, muffler, mirrors, plate & tail light. One merged geometry
// with per-vertex part data (colour, a paint mask for the body panels, light emission), so the traffic can draw every
// scooter in one instanced mesh with a per-instance paint colour. +Z forward, +X the rider's left, ground at y = 0.

// Rider placement for PersonRig.ride(): feet side by side on the floorboard (a near-zero crank)
const SCOOTER_FRAME = {
  seat: new THREE.Vector3(0, 0.83, -0.3),
  bars: new THREE.Vector3(0, 1.02, 0.36),
  gripHalf: 0.3,
  bracket: new THREE.Vector3(0, 0.36, 0.1),
  crankLength: 0.02
};
const SCOOTER_CRANK = 1.4; // fixed "crank" angle: both feet flat
const SCOOTER_WHEEL = { radius: 0.255, front: 0.64, rear: -0.6 };

const PART = { PAINT: 1, BLACK: 2, SEAT: 3, METAL: 4, HEAD: 5, TAIL: 6, TIRE: 7, PLATE: 8 };
const PART_COLORS = {
  [PART.PAINT]: 0xffffff, [PART.BLACK]: 0x1d1e21, [PART.SEAT]: 0x2a2624, [PART.METAL]: 0x9aa0a6,
  [PART.HEAD]: 0xf4f6ff, [PART.TAIL]: 0xc81820, [PART.TIRE]: 0x161618, [PART.PLATE]: 0xeeeeea
};

function part(geo, kind, m) {
  const g = (geo.index ? geo.toNonIndexed() : geo).clone();
  if (m) g.applyMatrix4(m);
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new THREE.Color(PART_COLORS[kind]);
  const col = new Float32Array(n * 3);
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    data[i * 2] = kind === PART.PAINT ? 1 : 0;
    data[i * 2 + 1] = kind === PART.HEAD ? 1 : kind === PART.TAIL ? 2 : 0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('part', new THREE.BufferAttribute(data, 2));
  return g;
}

const M = () => new THREE.Matrix4();
const TRS = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  M().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// A box whose top & bottom faces taper (scaled in x by `topX` / `botX`, in z by `topZ`): rounded-ish body panels
function taperedBox(w, h, d, { topX = 1, topZ = 1, botX = 1, frontDrop = 0, rearDrop = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / h + 0.5; // 0 bottom .. 1 top
    const z = p.getZ(i) / d + 0.5; // 0 rear .. 1 front
    p.setX(i, p.getX(i) * (botX + (topX - botX) * y));
    p.setZ(i, p.getZ(i) * (1 + (topZ - 1) * y));
    p.setY(i, p.getY(i) - y * (frontDrop * z + rearDrop * (1 - z)));
  }
  g.computeVertexNormals();
  return g;
}

// One wheel (tyre torus + rim disc) at the origin, its axle along x
function buildScooterWheelGeometry() {
  const W = SCOOTER_WHEEL;
  const tyre = new THREE.TorusGeometry(W.radius - 0.065, 0.065, 8, 20).rotateY(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(W.radius - 0.1, W.radius - 0.1, 0.09, 14).rotateZ(Math.PI / 2);
  return mergeGeometries([part(tyre, PART.TIRE), part(rim, PART.METAL)]);
}

const _scooterGeo = {};
// The whole scooter; without its wheels (`withWheels` false) for the player's, whose wheels turn
function buildScooterGeometry(withWheels = true) {
  if (_scooterGeo[withWheels]) return _scooterGeo[withWheels];
  const parts = [];
  const W = SCOOTER_WHEEL;
  if (withWheels) {
    const wheel = buildScooterWheelGeometry();
    for (const z of [W.front, W.rear]) parts.push(wheel.clone().translate(0, W.radius, z));
  }
  // Front fork & fender
  parts.push(part(new THREE.BoxGeometry(0.05, 0.5, 0.05), PART.METAL, TRS(0.08, 0.45, W.front - 0.06, -0.38)));
  parts.push(part(new THREE.BoxGeometry(0.05, 0.5, 0.05), PART.METAL, TRS(-0.08, 0.45, W.front - 0.06, -0.38)));
  parts.push(part(taperedBox(0.17, 0.07, 0.42, { topX: 0.8 }), PART.PAINT, TRS(0, W.radius * 2 + 0.03, W.front + 0.02, 0.12)));
  // Front apron (leg shield) leaning back over the fork, its inner black panel
  parts.push(part(taperedBox(0.44, 0.74, 0.17, { topX: 0.62, botX: 1.0, topZ: 0.8 }), PART.PAINT, TRS(0, 0.66, 0.42, -0.32)));
  parts.push(part(new THREE.BoxGeometry(0.36, 0.5, 0.03), PART.BLACK, TRS(0, 0.62, 0.31, -0.32)));
  // Floorboard
  parts.push(part(new THREE.BoxGeometry(0.36, 0.07, 0.5), PART.BLACK, TRS(0, 0.31, 0.06)));
  parts.push(part(new THREE.BoxGeometry(0.38, 0.12, 0.5), PART.PAINT, TRS(0, 0.24, 0.06)));
  // Body under the seat, tapering & dropping toward the tail
  parts.push(part(taperedBox(0.4, 0.42, 0.98, { topX: 0.82, topZ: 0.95, rearDrop: 0.1 }), PART.PAINT, TRS(0, 0.55, -0.42)));
  // Engine & swing arm, muffler on the right
  parts.push(part(new THREE.BoxGeometry(0.2, 0.2, 0.55), PART.BLACK, TRS(-0.06, 0.32, -0.42)));
  parts.push(part(new THREE.CylinderGeometry(0.055, 0.06, 0.48, 10).rotateX(Math.PI / 2), PART.METAL, TRS(-0.17, 0.3, -0.52, 0.12)));
  // Seat
  parts.push(part(taperedBox(0.32, 0.1, 0.72, { topX: 0.9, topZ: 0.94 }), PART.SEAT, TRS(0, 0.81, -0.32)));
  // Rear grab rail, tail light & plate
  parts.push(part(new THREE.BoxGeometry(0.34, 0.035, 0.22), PART.METAL, TRS(0, 0.8, -0.76)));
  parts.push(part(new THREE.BoxGeometry(0.22, 0.07, 0.06), PART.TAIL, TRS(0, 0.66, -0.92)));
  parts.push(part(new THREE.BoxGeometry(0.2, 0.12, 0.012), PART.PLATE, TRS(0, 0.5, -0.94, 0.25)));
  // Steering column, handlebar cowl with headlight, grips & mirrors
  parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), PART.BLACK, TRS(0, 0.84, 0.37, -0.32)));
  parts.push(part(taperedBox(0.42, 0.14, 0.2, { topX: 0.85 }), PART.PAINT, TRS(0, 1.0, 0.38)));
  parts.push(part(new THREE.BoxGeometry(0.2, 0.07, 0.04), PART.HEAD, TRS(0, 0.99, 0.49)));
  parts.push(part(new THREE.BoxGeometry(0.2, 0.08, 0.04), PART.HEAD, TRS(0, 0.72, 0.53, -0.32)));
  parts.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.66, 8).rotateZ(Math.PI / 2), PART.BLACK, TRS(0, 1.02, 0.35)));
  for (const s of [-1, 1]) {
    parts.push(part(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 6), PART.METAL, TRS(s * 0.2, 1.15, 0.36, 0, 0, -s * 0.25)));
    parts.push(part(new THREE.BoxGeometry(0.1, 0.06, 0.02), PART.BLACK, TRS(s * 0.25, 1.29, 0.36)));
  }
  const geo = mergeGeometries(parts);
  geo.computeBoundingSphere();
  _scooterGeo[withWheels] = geo;
  return geo;
}

// A low-detail scooter (~150 triangles) for the thousands parked along the kerbs & the far traffic
let _lowGeo = null;
function buildScooterLowGeometry() {
  if (_lowGeo) return _lowGeo;
  const W = SCOOTER_WHEEL;
  const wheel = new THREE.CylinderGeometry(W.radius, W.radius, 0.12, 8).rotateZ(Math.PI / 2);
  const parts = [
    part(wheel, PART.TIRE, TRS(0, W.radius, W.front)),
    part(wheel, PART.TIRE, TRS(0, W.radius, W.rear)),
    part(new THREE.BoxGeometry(0.4, 0.7, 0.16), PART.PAINT, TRS(0, 0.66, 0.42, -0.32)),
    part(new THREE.BoxGeometry(0.38, 0.14, 0.5), PART.PAINT, TRS(0, 0.26, 0.06)),
    part(new THREE.BoxGeometry(0.38, 0.4, 0.95), PART.PAINT, TRS(0, 0.55, -0.42)),
    part(new THREE.BoxGeometry(0.3, 0.1, 0.7), PART.SEAT, TRS(0, 0.8, -0.32)),
    part(new THREE.BoxGeometry(0.4, 0.13, 0.2), PART.PAINT, TRS(0, 1.0, 0.38)),
    part(new THREE.BoxGeometry(0.66, 0.04, 0.04), PART.BLACK, TRS(0, 1.02, 0.35)),
    part(new THREE.BoxGeometry(0.2, 0.07, 0.04), PART.TAIL, TRS(0, 0.66, -0.91))
  ];
  _lowGeo = mergeGeometries(parts);
  _lowGeo.computeBoundingSphere();
  return _lowGeo;
}

// Delivery box on the rear rack (外送箱): pink or green, per instance
let _boxGeo = null;
function buildDeliveryBoxGeometry() {
  if (_boxGeo) return _boxGeo;
  _boxGeo = new THREE.BoxGeometry(0.44, 0.42, 0.42).translate(0, 1.07, -0.62);
  return _boxGeo;
}

// Helmet: a shell dome with a visor rim (placed on the rider's head bone)
let _helmetGeo = null;
function buildHelmetGeometry() {
  if (_helmetGeo) return _helmetGeo;
  const shell = new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
  shell.scale(0.92, 0.95, 1.08);
  _helmetGeo = shell;
  return _helmetGeo;
}

/**
 * Scooter material. The body panels take the paint colour: the per-instance `tint` attribute (rgb, brake flag in w)
 * when `instanced`, else the material's userData.paint & userData.brake uniforms. Head & tail lights glow at night,
 * the tail light brighter under braking.
 */
function createScooterMaterial({ instanced = false, paint = 0xd8d8d0 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.1 });
  const uPaint = uniform(new THREE.Color(paint));
  const uBrake = uniform(0);
  const partData = attribute('part', 'vec2');
  const tint = instanced ? attribute('tint', 'vec4') : null;
  const paintCol = instanced ? tint.xyz : uPaint;
  const brake = instanced ? tint.w : uBrake;
  mat.colorNode = Fn(() => mix(attribute('color', 'vec3'), paintCol, partData.x))();
  mat.roughnessNode = mix(float(0.7), float(0.28), partData.x);
  mat.metalnessNode = mix(float(0.05), float(0.25), partData.x);
  mat.emissiveNode = Fn(() => {
    const night = smoothstep(0.5, 1.2, cityUniforms.uInteriorGlow);
    const head = step(0.5, partData.y).mul(step(partData.y, 1.5));
    const tail = step(1.5, partData.y);
    return vec3(1.0, 0.96, 0.88).mul(head).mul(night.mul(3.0)).add(color(0xff1810).mul(tail).mul(night.mul(1.2).add(brake.mul(2.5)).add(0.15)));
  })();
  mat.userData.paint = uPaint;
  mat.userData.brake = uBrake;
  return mat;
}

const SCOOTER_PAINTS = [0xe8e8e2, 0x1e1f22, 0xb8bcc0, 0x7a1c22, 0x2a4a7a, 0xd8cdb0, 0x5a6a52, 0x9aa8b4, 0xc84a2a, 0x3a3c40, 0xf0f0f0, 0x6a7a8a];

export {
  SCOOTER_FRAME, SCOOTER_CRANK, SCOOTER_WHEEL, SCOOTER_PAINTS,
  buildScooterGeometry, buildScooterLowGeometry, buildScooterWheelGeometry, buildDeliveryBoxGeometry, buildHelmetGeometry, createScooterMaterial
};
