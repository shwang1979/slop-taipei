import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import {
  ROAD_LINKS, ROAD_NODES, CLS, LINK_FLAG, SIGNALS, signalPhase, linkPointAt, SIDEWALKS, SIDEWALK_HEIGHT, hillHeight, LITE
} from './city-config.js';
import { createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, buildSteerableWheelGeo, createLoftedCarMaterial, BUS_SPEC,
  buildLoftedBusBodyGeometry, buildBusSignGeometry, buildBusWheelGeo, createBusWheelMaterial, createLoftedBusMaterial
} from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import {
  SCOOTER_FRAME, SCOOTER_CRANK, SCOOTER_PAINTS, buildScooterGeometry, buildScooterLowGeometry, buildHelmetGeometry,
  buildDeliveryBoxGeometry, createScooterMaterial
} from './scooter-model.js';
import { createGarbageTruckMesh } from './garbage-truck.js';

// js/traffic.js
// Taipei traffic on the real street network: the swarms of scooters (機車) riding the kerbside of every lane and
// queueing in the scooter boxes at the lights, taxis (小黃) & private cars, city buses, and the people on the sidewalks
// & pedestrian streets. Vehicles follow directed lanes built from the street links (city-config.js), keep their
// distance (Intelligent Driver Model), stop for the signals (the scooters at the front box, the cars behind it), swing
// round the junctions on Bézier curves and are spawned & recycled around the camera.

const NUM_CARS = LITE ? 60 : 170;
const NUM_SCOOTERS = LITE ? 120 : 360;
const NUM_BUSES = LITE ? 5 : 14;
const NUM_PEDS = LITE ? 80 : 260;
const SPAWN_MIN = 70;
const SPAWN_MAX = 420;
const DESPAWN = 520;
const CAR_PROXY_DISTANCE = 90;
const SCOOTER_NEAR = 70;

const V0 = [22, 17, 14, 13, 11.5, 9, 7.5, 5, 5.5, 0]; // desired speed by road class (m/s)
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function createBusDestinationTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, 256, 64);
  // orange LED: route number & terminus (the 307 runs 撫遠街 - 板橋 across the city)
  ctx.fillStyle = '#ff9d1c';
  ctx.textBaseline = 'middle';
  ctx.font = '900 34px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText('307', 10, 33);
  ctx.font = '800 22px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.fillText('撫遠街→板橋', 92, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// --- Directed lanes ---------------------------------------------------------------------------------------------------
function buildLaneGraph() {
  const edges = [];
  const out = ROAD_NODES.map(() => []);
  for (const l of ROAD_LINKS) {
    if (l.flags & LINK_FLAG.NO_CARS || l.cls > CLS.service) continue;
    const dirs = l.oneway === 1 ? [1] : l.oneway === -1 ? [-1] : [1, -1];
    for (const dir of dirs) {
      const n = l.oneway ? l.lanes : Math.max(1, Math.floor(l.lanes / 2));
      const span = l.oneway ? l.w : l.w / 2;
      const lw = span / n;
      const from = dir > 0 ? l.a : l.b;
      const to = dir > 0 ? l.b : l.a;
      let sStart = ROAD_NODES[from].r;
      let sEnd = l.len - ROAD_NODES[to].r;
      if (sEnd - sStart < 0.5) {
        sStart = Math.min(sStart, l.len * 0.45);
        sEnd = Math.max(sEnd, l.len * 0.55);
      }
      const toNode = ROAD_NODES[to];
      let sig = null;
      let phase = 0;
      if (toNode.signal >= 0 && !(ROAD_NODES[from].signal === toNode.signal)) {
        sig = SIGNALS[toNode.signal];
        phase = sig.phaseOf.get(`${l.id}:${to}`) ?? 0;
      }
      const e = {
        id: edges.length, link: l, dir, from, to, n, lw, off0: (l.oneway ? -l.w / 2 : 0) + lw / 2,
        len: l.len, sStart, sEnd, cls: l.cls, v0: V0[l.cls] || 6, sig, phase, out: null,
        lanes: Array.from({ length: n }, () => []), scooters: n > 1 ? [] : null
      };
      edges.push(e);
      out[from].push(e);
    }
  }
  for (const e of edges) e.out = out[e.to];
  return edges;
}

// Point on edge e at distance s from its start, `lat` metres right of the direction of travel
const _p = {};
function edgePoint(e, s, lat, o) {
  linkPointAt(e.link, e.dir > 0 ? s : e.len - s, _p);
  const dx = _p.dx * e.dir;
  const dz = _p.dz * e.dir;
  o.x = _p.x - dz * lat;
  o.z = _p.z + dx * lat;
  o.y = _p.y;
  o.dx = dx;
  o.dz = dz;
  return o;
}

const headingOf = (e, atEnd) => {
  const p = edgePoint(e, atEnd ? e.sEnd : e.sStart, 0, {});
  return Math.atan2(p.dx, p.dz);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function createTrafficSystem(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiTraffic';
  scene.add(group);
  const edges = buildLaneGraph();
  for (const e of edges) {
    e.hStart = headingOf(e, false);
    e.hEnd = headingOf(e, true);
  }
  // Spawn grid: edges by 100 m cell of their middle, weighted by length & class
  const CELL = 100;
  const grid = new Map();
  for (const e of edges) {
    if (e.cls > CLS.residential) continue;
    const m = edgePoint(e, (e.sStart + e.sEnd) / 2, 0, {});
    const k = `${Math.floor(m.x / CELL)},${Math.floor(m.z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
  }

  // --- Vehicles ----------------------------------------------------------------------------------------------------------
  const TYPES = {
    sedan: { len: 4.5, a: 1.6, b: 2.6, T: 1.3, s0: 2.2, vf: 1.0 },
    suv: { len: 4.6, a: 1.5, b: 2.6, T: 1.3, s0: 2.2, vf: 1.0 },
    taxi: { len: 4.5, a: 1.8, b: 2.8, T: 1.1, s0: 2.0, vf: 1.08 },
    bus: { len: 11.6, a: 1.0, b: 2.0, T: 1.6, s0: 3.0, vf: 0.85 },
    scooter: { len: 1.9, a: 2.4, b: 3.2, T: 0.7, s0: 1.0, vf: 1.0 },
    garbage: { len: 7.6, a: 0.8, b: 2.2, T: 1.8, s0: 3.0, vf: 0.38 }
  };
  const vehicles = [];
  const make = (kind, i) => ({
    kind, ...TYPES[kind], id: i, active: false, edge: null, lane: 0, s: 0, v: 0, acc: 0, lat: 0, latTarget: 0,
    next: null, nextLane: 0, conn: null, x: 0, y: 0, z: 0, prevX: 0, prevZ: 0, yaw: 0, roll: 0, wheelSpin: 0, steer: 0,
    drive: 0.85 + Math.random() * 0.3, wait: 0, gap: Infinity, leaderSpeed: 0, seed: Math.random() * 100,
    paint: null, box: Math.random() < 0.14 ? (Math.random() < 0.55 ? 1 : 2) : 0, rider: Math.floor(Math.random() * 6)
  });
  const SEDAN_PAINTS = [0xf2f2f0, 0x1c2026, 0xb8bec4, 0x6a7078, 0x2a3c5a, 0x7a1e22, 0xd8d0c0, 0x3a4a3a];
  const cars = [];
  for (let i = 0; i < NUM_CARS; i++) {
    const kind = i % 4 === 0 ? 'taxi' : i % 3 === 0 ? 'suv' : 'sedan';
    const v = make(kind, i);
    const c = new THREE.Color(kind === 'taxi' ? 0xffc61a : SEDAN_PAINTS[i % SEDAN_PAINTS.length]);
    v.paint = [Math.fround(c.r), Math.fround(c.g), Math.fround(c.b)];
    cars.push(v);
    vehicles.push(v);
  }
  const scooters = [];
  for (let i = 0; i < NUM_SCOOTERS; i++) {
    const v = make('scooter', i);
    v.paint = new THREE.Color(SCOOTER_PAINTS[i % SCOOTER_PAINTS.length]);
    scooters.push(v);
    vehicles.push(v);
  }
  const buses = [];
  for (let i = 0; i < NUM_BUSES; i++) {
    const v = make('bus', i);
    buses.push(v);
    vehicles.push(v);
  }
  // the garbage truck, crawling the lanes with its Für Elise (garbage-truck.js)
  const garbageTruck = make('garbage', 0);
  vehicles.push(garbageTruck);
  const truckMesh = createGarbageTruckMesh();
  truckMesh.visible = false;
  group.add(truckMesh);

  const listOf = (v, e = v.edge, lane = v.lane) => (v.kind === 'scooter' && e.scooters ? e.scooters : e.lanes[Math.min(lane, e.n - 1)]);
  const laneLat = (v, e, lane) => {
    if (v.kind === 'scooter') {
      // the kerbside half of the rightmost lane, two abreast
      const right = e.off0 + (e.n - 1) * e.lw;
      return right + e.lw * (e.scooters ? 0.18 : 0.12) + ((v.seed * 7.3) % 1 - 0.5) * Math.min(0.9, e.lw * 0.35);
    }
    return e.off0 + Math.min(lane, e.n - 1) * e.lw;
  };

  function chooseNext(v, e) {
    const cands = e.out.filter((o) => o.link !== e.link || e.out.length === 1);
    if (!cands.length) return null;
    let total = 0;
    const w = cands.map((o) => {
      const turn = wrap(o.hStart - e.hEnd);
      let k = Math.abs(turn) < 0.45 ? 3.0 : Math.abs(turn) > 2.5 ? 0.04 : turn < 0 ? 1.0 : 0.7;
      if (o.cls > e.cls + 1) k *= o.cls >= CLS.residential ? 0.15 : 0.4;
      if (v.kind === 'bus' && o.cls > CLS.tertiary) k *= 0.05;
      if (v.kind === 'garbage') k *= o.cls <= CLS.secondary || o.link.flags & LINK_FLAG.ELEVATED ? 0.05 : 3;
      if (o.link.flags & LINK_FLAG.ELEVATED && v.kind === 'scooter') k *= 0.02; // scooters keep off the expressways
      total += k;
      return k;
    });
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) {
      r -= w[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  function laneFor(v, from, to) {
    if (!to) return 0;
    const turn = wrap(to.hStart - from.hEnd);
    if (turn < -0.45) return to.n - 1; // right turn: kerb lane
    if (turn > 0.45) return 0; // left turn: inside lane
    return Math.min(to.n - 1, Math.floor(Math.random() * to.n));
  }

  function place(v, e, s, lane) {
    v.edge = e;
    v.lane = lane;
    v.s = s;
    v.lat = v.latTarget = laneLat(v, e, lane);
    v.next = chooseNext(v, e);
    v.nextLane = laneFor(v, e, v.next);
    v.conn = null;
    v.active = true;
    v.wait = 0;
    listOf(v).push(v);
    const p = edgePoint(e, s, v.lat, {});
    v.x = v.prevX = p.x;
    v.z = v.prevZ = p.z;
    v.y = p.y;
    v.yaw = Math.atan2(p.dx, p.dz);
  }

  function remove(v) {
    if (!v.active) return;
    const list = listOf(v);
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    v.active = false;
    v.edge = null;
  }

  function trySpawn(v, fx, fz) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = fx + Math.cos(ang) * r;
      const z = fz + Math.sin(ang) * r;
      const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
      if (!list || !list.length) continue;
      const e = list[Math.floor(Math.random() * list.length)];
      if (v.kind === 'bus' && e.cls > CLS.tertiary) continue;
      if (v.kind === 'garbage' && (e.cls < CLS.tertiary || r > 220)) continue;
      if (e.sEnd - e.sStart < 8) continue;
      const lane = Math.floor(Math.random() * e.n);
      const s = e.sStart + Math.random() * (e.sEnd - e.sStart);
      const target = v.kind === 'scooter' && e.scooters ? e.scooters : e.lanes[lane];
      if (target.some((o) => Math.abs(o.s - s) < (o.len + v.len) / 2 + 6)) continue;
      if (v.kind !== 'scooter' && e.n === 1 && e.lanes[0].length > 6) continue;
      place(v, e, s, lane);
      v.v = Math.min(e.v0, 6 + Math.random() * 6);
      return true;
    }
    return false;
  }

  // Leader on the vehicle's path (same lane, then the next edge's lane): sets v.gap & v.leaderSpeed
  function findLeader(v) {
    const list = listOf(v);
    let best = null;
    let bs = Infinity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o !== v && o.s > v.s && o.s < bs) {
        bs = o.s;
        best = o;
      }
    }
    if (best) {
      v.gap = best.s - v.s - (best.len + v.len) / 2;
      v.leaderSpeed = best.v;
      return;
    }
    v.gap = Infinity;
    v.leaderSpeed = 0;
    if (v.next) {
      const nl = listOf(v, v.next, v.nextLane);
      let m = null;
      let ms = Infinity;
      for (const o of nl) if (o.s < ms) {
        ms = o.s;
        m = o;
      }
      if (m) {
        // the rest of this lane, the junction (~12 m) & the leader's way into the next lane
        v.gap = (v.edge.sEnd - v.s) + Math.max(0, m.s - (v.next.sStart - 12)) + 6 - (m.len + v.len) / 2;
        v.leaderSpeed = m.v;
      }
    }
  }

  // Start the junction crossing onto v.next: a cubic Bézier from the lane's end to the next lane's start
  function enterNext(v) {
    const e = v.edge;
    const n = v.next;
    const lat0 = v.lat;
    const p0 = edgePoint(e, e.sEnd, lat0, {});
    const list = listOf(v);
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    v.edge = n;
    v.lane = v.nextLane;
    const lat1 = laneLat(v, n, v.lane);
    const p3 = edgePoint(n, n.sStart, lat1, {});
    const chord = Math.hypot(p3.x - p0.x, p3.z - p0.z);
    const k = chord * 0.4;
    v.conn = {
      p0, p3, len: Math.max(0.01, chord * 1.08),
      c1x: p0.x + p0.dx * k, c1z: p0.z + p0.dz * k, c2x: p3.x - p3.dx * k, c2z: p3.z - p3.dz * k
    };
    v.s = n.sStart - v.conn.len + (v.s - e.sEnd);
    v.lat = v.latTarget = lat1;
    listOf(v).push(v);
    v.next = chooseNext(v, n);
    v.nextLane = laneFor(v, n, v.next);
  }

  // --- Scooter riders: a seated pose per rider template, computed once in the scooter's frame ---------------------------
  const RIDERS = [];
  {
    const root = new THREE.Object3D();
    root.updateMatrixWorld(true);
    const templates = [
      { seed: 3.1, female: false, girth: 1.0, hair: 0.15 }, { seed: 8.4, female: true, girth: 0.95, hair: 0.85 },
      { seed: 15.9, female: false, girth: 1.08, hair: 0.1 }, { seed: 22.2, female: true, girth: 0.92, hair: 0.45 },
      { seed: 31.7, female: false, girth: 0.97, hair: 0.3 }, { seed: 47.3, female: true, girth: 1.0, hair: 0.95 }
    ];
    for (const t of templates) {
      const rig = new PersonRig({ ...t, scale: t.female ? 0.95 : 1.0 });
      rig.ride(root, SCOOTER_CRANK, SCOOTER_FRAME);
      RIDERS.push({ pose: rig.pose.slice(), head: rig.headPosition.clone(), headQ: rig.headQuaternion.clone() });
    }
  }
  const riderCrowd = new PersonCrowd(NUM_SCOOTERS, { farDistance: 45 });
  riderCrowd.meshes.forEach((m) => group.add(m));
  const riderProxy = { pose: new Float32Array(RIDERS[0].pose.length) };
  const _q = new THREE.Quaternion();
  const _qb = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const FWD = new THREE.Vector3(0, 0, 1);
  function poseRider(v) {
    const tpl = RIDERS[v.rider];
    const src = tpl.pose;
    const dst = riderProxy.pose;
    _yawQ.setFromAxisAngle(UP, v.yaw);
    _qb.setFromAxisAngle(FWD, v.roll);
    _yawQ.multiply(_qb);
    const bones = (src.length / 4 - 1) / 2;
    for (let b = 0; b < bones; b++) {
      const o = b * 8;
      _q.set(src[o], src[o + 1], src[o + 2], src[o + 3]).premultiply(_yawQ);
      dst[o] = _q.x;
      dst[o + 1] = _q.y;
      dst[o + 2] = _q.z;
      dst[o + 3] = _q.w;
      _v.set(src[o + 4], src[o + 5], src[o + 6]).applyQuaternion(_yawQ);
      dst[o + 4] = _v.x + v.x;
      dst[o + 5] = _v.y + v.y;
      dst[o + 6] = _v.z + v.z;
      dst[o + 7] = src[o + 7];
    }
    const info = src.length - 4;
    dst[info] = v.seed;
    dst[info + 1] = src[info + 1];
    dst[info + 2] = src[info + 2];
    dst[info + 3] = src[info + 3];
    return riderProxy;
  }

  // --- Meshes -------------------------------------------------------------------------------------------------------------
  const bodies = {};
  for (const kind of ['taxi', 'sedan', 'suv']) {
    const n = NUM_CARS;
    const mat = createLoftedCarMaterial(BODY_SPECS[kind]);
    const lod = (g) => {
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const m = new THREE.InstancedMesh(g, mat, n);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      return m;
    };
    bodies[kind] = { near: lod(buildCarGeometry(BODY_SPECS[kind], false)), far: lod(buildCarProxyGeometry(BODY_SPECS[kind])) };
  }
  const wheelMat = createLoftedCarMaterial(BODY_SPECS.sedan, 0xffc61a);
  const wheelL = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, -1), wheelMat, NUM_CARS * 2);
  const wheelR = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, 1), wheelMat, NUM_CARS * 2);
  for (const m of [wheelL, wheelR]) {
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  const busGeo = buildLoftedBusBodyGeometry();
  const busState = new THREE.InstancedBufferAttribute(new Float32Array(NUM_BUSES * 4), 4);
  busGeo.setAttribute('busState', busState);
  const busMesh = new THREE.InstancedMesh(busGeo, createLoftedBusMaterial(), NUM_BUSES);
  const busSign = new THREE.InstancedMesh(buildBusSignGeometry(), new THREE.MeshBasicNodeMaterial({ map: createBusDestinationTexture() }), NUM_BUSES);
  const busWheelMat = createBusWheelMaterial();
  const busWheelL = new THREE.InstancedMesh(buildBusWheelGeo(-1), busWheelMat, NUM_BUSES * 2);
  const busWheelR = new THREE.InstancedMesh(buildBusWheelGeo(1), busWheelMat, NUM_BUSES * 2);
  for (const m of [busMesh, busSign, busWheelL, busWheelR]) {
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  // scooters: full detail near, low detail beyond; helmets; delivery boxes
  const scooterMat = createScooterMaterial({ instanced: true });
  const scooterLod = (geo) => {
    const g = geo.clone();
    g.setAttribute('tint', new THREE.InstancedBufferAttribute(new Float32Array(NUM_SCOOTERS * 4), 4));
    const m = new THREE.InstancedMesh(g, scooterMat, NUM_SCOOTERS);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const scooterNear = scooterLod(buildScooterGeometry(true));
  const scooterFar = scooterLod(buildScooterLowGeometry());
  const helmetGeo = buildHelmetGeometry().clone();
  helmetGeo.setAttribute('tint', new THREE.InstancedBufferAttribute(new Float32Array(NUM_SCOOTERS * 4), 4));
  const helmetMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.1 });
  helmetMat.colorNode = attribute('tint', 'vec4').xyz;
  const helmets = new THREE.InstancedMesh(helmetGeo, helmetMat, NUM_SCOOTERS);
  helmets.count = 0;
  helmets.frustumCulled = false;
  helmets.castShadow = true;
  group.add(helmets);
  const boxGeo = buildDeliveryBoxGeometry().clone();
  const boxMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, NUM_SCOOTERS);
  boxes.count = 0;
  boxes.frustumCulled = false;
  boxes.castShadow = true;
  group.add(boxes);
  const HELMET_COLORS = [0xf2f2ee, 0x1c1c1e, 0xc8202a, 0x2a5aa8, 0xe8c020, 0x9aa0a6, 0xf0a0b8, 0x2a7a4a].map((h) => new THREE.Color(h));
  const BOX_COLORS = [null, new THREE.Color(0xe21a73), new THREE.Color(0x06c167)];

  // contact shadows under the cars & buses
  const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadows = new THREE.InstancedMesh(unitPlane, createContactShadowMaterial(), NUM_CARS + NUM_BUSES + 1);
  shadows.count = 0;
  shadows.frustumCulled = false;
  shadows.renderOrder = 998;
  group.add(shadows);

  // --- Pedestrians on the sidewalks & pedestrian streets ------------------------------------------------------------------
  const pedCrowd = new PersonCrowd(NUM_PEDS);
  pedCrowd.meshes.forEach((m) => group.add(m));
  const peds = [];
  for (let i = 0; i < NUM_PEDS; i++) {
    const female = Math.random() < 0.5;
    peds.push({
      rig: new PersonRig({ seed: i * 1.37 + 0.5, scale: (female ? 0.93 : 1.0) * (0.94 + Math.random() * 0.1), female, girth: 0.9 + Math.random() * 0.22, hair: female ? 0.3 + Math.random() * 0.7 : Math.random() * 0.35 }),
      active: false, placed: false, x: 0, z: 0, y: 0, heading: 0, v: 1.2 + Math.random() * 0.4, link: null, side: 1, off: 0, s: 0, sDir: 1, s0: 0, s1: 0,
      pause: 0
    });
  }
  const pedLinks = ROAD_LINKS.filter((l) => !(l.flags & LINK_FLAG.ELEVATED) && l.len > 25 && (l.cls <= CLS.tertiary || l.flags & LINK_FLAG.NO_CARS));
  const pedGrid = new Map();
  for (const l of pedLinks) {
    const m = linkPointAt(l, l.len / 2, {});
    const k = `${Math.floor(m.x / CELL)},${Math.floor(m.z / CELL)}`;
    if (!pedGrid.has(k)) pedGrid.set(k, []);
    pedGrid.get(k).push(l);
  }
  const pedGround = (_owner, x, z) => (hillHeight(x, z) > 0.05 ? hillHeight(x, z) : SIDEWALK_HEIGHT);
  const pedGroundFlat = (owner) => owner.y;
  function spawnPed(p, fx, fz) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 230;
      const list = pedGrid.get(`${Math.floor((fx + Math.cos(ang) * r) / CELL)},${Math.floor((fz + Math.sin(ang) * r) / CELL)}`);
      if (!list) continue;
      const l = list[Math.floor(Math.random() * list.length)];
      const street = !!(l.flags & LINK_FLAG.NO_CARS);
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = street ? (Math.random() - 0.5) * l.w * 0.8 : side * (l.w / 2 + 1.0 + Math.random() * 1.2);
      const s0 = ROAD_NODES[l.a].r + 3;
      const s1 = l.len - ROAD_NODES[l.b].r - 3;
      if (s1 - s0 < 10) continue;
      const s = s0 + Math.random() * (s1 - s0);
      const q = linkPointAt(l, s, {});
      const x = q.x - q.dz * off;
      const z = q.z + q.dx * off;
      if (!street && !SIDEWALKS.contains(x, z)) continue;
      Object.assign(p, { active: true, placed: false, link: l, off, s, s0, s1, sDir: Math.random() < 0.5 ? 1 : -1, street, pause: 0 });
      p.y = street ? 0.04 : SIDEWALK_HEIGHT;
      return true;
    }
    return false;
  }

  // --- Simulation -------------------------------------------------------------------------------------------------------
  let focusX = 0;
  let focusZ = 0;
  const playerObstacle = { x: 0, z: 0, active: false };

  function idm(v, gap, dv, v0) {
    const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.a * v.b)));
    const free = 1 - Math.pow(v.v / Math.max(0.5, v0), 4);
    const inter = gap < 1e5 ? Math.pow(sStar / Math.max(0.1, gap), 2) : 0;
    return v.a * (free - inter);
  }

  function step(v, dt, time) {
    const e = v.edge;
    findLeader(v);
    let gap = v.gap;
    let lead = v.leaderSpeed;
    // signal at the end of this lane
    if (e.sig && v.s < e.sEnd) {
      const stopAt = e.sEnd - (v.kind === 'scooter' ? 0.6 : 4.2) - 0.2;
      const state = signalPhase(time, e.sig, e.phase);
      const dist = stopAt - v.s - v.len / 2;
      if (dist > -0.5 && (state === 'red' || (state === 'amber' && dist > (v.v * v.v) / (2 * 3.5)))) {
        if (dist < gap) {
          gap = Math.max(0.01, dist);
          lead = 0;
        }
      }
    }
    // the player in front, in this vehicle's path
    if (playerObstacle.active) {
      const dx = playerObstacle.x - v.x;
      const dz = playerObstacle.z - v.z;
      const fwd = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      const side = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
      if (fwd > 0 && fwd < 40 && Math.abs(side) < (v.kind === 'scooter' ? 1.2 : 1.9)) {
        const g = fwd - v.len / 2 - 1.6;
        if (g < gap) {
          gap = Math.max(0.01, g);
          lead = 0;
        }
      }
    }
    const v0 = e.v0 * v.vf * v.drive;
    v.acc = clamp(idm(v, gap, v.v - lead, v0), -9, v.a);
    v.v = Math.max(0, v.v + v.acc * dt);
    v.s += v.v * dt;
    v.wait = v.v < 0.3 ? v.wait + dt : 0;
    if (v.s >= e.sEnd) {
      if (!v.next) {
        remove(v);
        return;
      }
      enterNext(v);
    }
  }

  const _o = {};
  function locate(v) {
    v.prevX = v.x;
    v.prevZ = v.z;
    const e = v.edge;
    if (v.conn && v.s < e.sStart) {
      const c = v.conn;
      const t = clamp(1 - (e.sStart - v.s) / c.len, 0, 1);
      const u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      v.x = b0 * c.p0.x + b1 * c.c1x + b2 * c.c2x + b3 * c.p3.x;
      v.z = b0 * c.p0.z + b1 * c.c1z + b2 * c.c2z + b3 * c.p3.z;
      v.y = c.p0.y + (c.p3.y - c.p0.y) * t;
      const dx = 3 * u * u * (c.c1x - c.p0.x) + 6 * u * t * (c.c2x - c.c1x) + 3 * t * t * (c.p3.x - c.c2x);
      const dz = 3 * u * u * (c.c1z - c.p0.z) + 6 * u * t * (c.c2z - c.c1z) + 3 * t * t * (c.p3.z - c.c2z);
      if (dx * dx + dz * dz > 1e-6) v.yaw = Math.atan2(dx, dz);
    } else {
      v.conn = null;
      edgePoint(e, clamp(v.s, 0, e.len), v.lat, _o);
      v.x = _o.x;
      v.z = _o.z;
      v.y = _o.y;
      v.yaw = Math.atan2(_o.dx, _o.dz);
    }
    // scooters lean into the bends
    if (v.kind === 'scooter') {
      const dyaw = wrap(Math.atan2(v.x - v.prevX, v.z - v.prevZ) - v.yaw);
      const target = clamp(-dyaw * 4 * Math.min(1, v.v / 6), -0.3, 0.3);
      v.roll += (target - v.roll) * 0.15;
    }
  }

  // --- Rendering --------------------------------------------------------------------------------------------------------
  const dummy = new THREE.Object3D();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const tmpColor = new THREE.Color();
  const visible = (x, y, z, r) => {
    sphere.center.set(x, y, z);
    sphere.radius = r;
    return frustum.intersectsSphere(sphere);
  };
  function placeWheels(v, i, rotY, radius, halfTrack, halfBase, left, right, baseRadius) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const scale = radius / baseRadius;
    dummy.scale.set(scale, scale, scale);
    for (let w = 0; w < 2; w++) {
      const wz = w === 0 ? halfBase : -halfBase;
      dummy.rotation.set(v.wheelSpin + w * 0.55, rotY + (w === 0 ? v.steer : 0), 0, 'YXZ');
      dummy.position.set(v.x - halfTrack * cosY + wz * sinY, v.y + radius, v.z + halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      left.setMatrixAt(i * 2 + w, dummy.matrix);
      dummy.position.set(v.x + halfTrack * cosY + wz * sinY, v.y + radius, v.z - halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      right.setMatrixAt(i * 2 + w, dummy.matrix);
    }
  }

  function render(camera) {
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    for (const b of Object.values(bodies)) b.near.count = b.far.count = 0;
    let wheels = 0;
    let shadowCount = 0;
    for (const c of cars) {
      if (!c.active) continue;
      const fwd = (c.x - c.prevX) * Math.sin(c.yaw) + (c.z - c.prevZ) * Math.cos(c.yaw);
      const spec = BODY_SPECS[c.kind];
      c.wheelSpin = (c.wheelSpin + fwd / spec.wheelRadius) % (Math.PI * 2);
      if (!visible(c.x, c.y + 1, c.z, 4)) continue;
      const near = Math.hypot(c.x - camera.position.x, c.z - camera.position.z) < CAR_PROXY_DISTANCE;
      const inst = near ? bodies[c.kind].near : bodies[c.kind].far;
      const slot = inst.count++;
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(0, c.yaw, 0, 'YXZ');
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(slot, dummy.matrix);
      const paint = inst.geometry.attributes.paintColor;
      paint.array.set(c.paint, slot * 3);
      const state = inst.geometry.attributes.carState;
      state.array[slot * 4] = c.acc < -0.8 || c.v < 0.3 ? 1 : 0;
      state.array[slot * 4 + 1] = state.array[slot * 4 + 2] = state.array[slot * 4 + 3] = 0;
      if (near) placeWheels(c, wheels++, c.yaw, spec.wheelRadius, spec.wheelX, spec.wheelZ, wheelL, wheelR, BODY_SPECS.sedan.wheelRadius);
      dummy.position.set(c.x, c.y + 0.02, c.z);
      dummy.rotation.set(0, c.yaw, 0);
      dummy.scale.set(2.2, 1, 5.0);
      dummy.updateMatrix();
      shadows.setMatrixAt(shadowCount++, dummy.matrix);
    }
    for (const b of Object.values(bodies)) {
      for (const inst of [b.near, b.far]) {
        if (!inst.count) continue;
        inst.instanceMatrix.needsUpdate = true;
        inst.geometry.attributes.paintColor.needsUpdate = true;
        inst.geometry.attributes.carState.needsUpdate = true;
      }
    }
    wheelL.count = wheelR.count = wheels * 2;
    wheelL.instanceMatrix.needsUpdate = wheelR.instanceMatrix.needsUpdate = true;

    let nb = 0;
    for (const b of buses) {
      if (!b.active) continue;
      const fwd = (b.x - b.prevX) * Math.sin(b.yaw) + (b.z - b.prevZ) * Math.cos(b.yaw);
      b.wheelSpin = (b.wheelSpin + fwd / BUS_SPEC.wheelRadius) % (Math.PI * 2);
      if (!visible(b.x, b.y + 1.5, b.z, 8)) continue;
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.yaw, 0, 'YXZ');
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      busMesh.setMatrixAt(nb, dummy.matrix);
      busSign.setMatrixAt(nb, dummy.matrix);
      busState.array[nb * 4] = b.acc < -0.8 || b.v < 0.3 ? 1 : 0;
      placeWheels(b, nb, b.yaw, BUS_SPEC.wheelRadius, BUS_SPEC.wheelX, BUS_SPEC.wheelZ, busWheelL, busWheelR, BUS_SPEC.wheelRadius);
      dummy.position.set(b.x, b.y + 0.02, b.z);
      dummy.rotation.set(0, b.yaw, 0);
      dummy.scale.set(2.9, 1, 12.0);
      dummy.updateMatrix();
      shadows.setMatrixAt(shadowCount++, dummy.matrix);
      nb++;
    }
    busMesh.count = busSign.count = nb;
    busWheelL.count = busWheelR.count = nb * 2;
    for (const m of [busMesh, busSign, busWheelL, busWheelR]) m.instanceMatrix.needsUpdate = true;
    busState.needsUpdate = true;
    const g = garbageTruck;
    truckMesh.visible = g.active;
    if (g.active) {
      truckMesh.position.set(g.x, g.y, g.z);
      truckMesh.rotation.set(0, g.yaw, 0);
      dummy.position.set(g.x, g.y + 0.02, g.z);
      dummy.rotation.set(0, g.yaw, 0);
      dummy.scale.set(2.6, 1, 8.0);
      dummy.updateMatrix();
      shadows.setMatrixAt(shadowCount++, dummy.matrix);
    }
    shadows.count = shadowCount;
    shadows.instanceMatrix.needsUpdate = true;

    // scooters, riders, helmets & boxes
    scooterNear.count = scooterFar.count = 0;
    let nh = 0;
    let nbx = 0;
    riderCrowd.begin();
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (const s of scooters) {
      if (!s.active || !visible(s.x, s.y + 1, s.z, 2)) continue;
      const d = Math.hypot(s.x - cx, s.z - cz);
      const inst = d < SCOOTER_NEAR ? scooterNear : scooterFar;
      const slot = inst.count++;
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.yaw, s.roll, 'YXZ');
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(slot, dummy.matrix);
      inst.geometry.attributes.tint.setXYZW(slot, s.paint.r, s.paint.g, s.paint.b, s.acc < -1 || s.v < 0.3 ? 1 : 0);
      if (d < 260) {
        const rp = poseRider(s);
        riderCrowd.add(rp, d);
        const tpl = RIDERS[s.rider];
        _v.copy(tpl.head).applyQuaternion(_yawQ).add(dummy.position);
        _q.copy(_yawQ).multiply(tpl.headQ);
        dummy.position.copy(_v).add(new THREE.Vector3(0, 0.155, -0.01).applyQuaternion(_q));
        dummy.quaternion.copy(_q);
        dummy.updateMatrix();
        helmets.setMatrixAt(nh, dummy.matrix);
        tmpColor.copy(HELMET_COLORS[Math.floor(s.seed) % HELMET_COLORS.length]);
        helmets.geometry.attributes.tint.setXYZW(nh, tmpColor.r, tmpColor.g, tmpColor.b, 0);
        nh++;
        if (s.box) {
          dummy.position.set(s.x, s.y, s.z);
          dummy.rotation.set(0, s.yaw, s.roll, 'YXZ');
          dummy.updateMatrix();
          boxes.setMatrixAt(nbx, dummy.matrix);
          boxes.setColorAt(nbx, BOX_COLORS[s.box]);
          nbx++;
        }
      }
    }
    riderCrowd.end();
    for (const inst of [scooterNear, scooterFar]) {
      inst.instanceMatrix.needsUpdate = true;
      inst.geometry.attributes.tint.needsUpdate = true;
    }
    helmets.count = nh;
    helmets.instanceMatrix.needsUpdate = true;
    helmets.geometry.attributes.tint.needsUpdate = true;
    boxes.count = nbx;
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;

    // pedestrians
    pedCrowd.begin();
    for (const p of peds) {
      if (!p.active || !p.placed) continue;
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (!visible(p.x, p.y + 1, p.z, 1.2)) continue;
      pedCrowd.add(p.rig, d);
    }
    pedCrowd.end();
  }

  let spawnBudget = 0;
  function update(dt, elapsed, focus, player, mode, camera) {
    focusX = focus.x;
    focusZ = focus.z;
    // when flying high, keep the traffic round the point under the camera
    playerObstacle.active = mode !== 'helicopter' && !!player;
    if (player) {
      playerObstacle.x = player.position.x;
      playerObstacle.z = player.position.z;
    }
    // recycle what has drifted out of range, spawn into the free slots a few per frame
    spawnBudget = Math.min(40, spawnBudget + dt * 120);
    for (const v of vehicles) {
      if (v.active && Math.hypot(v.x - focusX, v.z - focusZ) > DESPAWN) remove(v);
      if (!v.active && spawnBudget >= 1) {
        spawnBudget--;
        trySpawn(v, focusX, focusZ);
      }
    }
    const sub = dt > 0.034 ? 2 : 1;
    for (let k = 0; k < sub; k++) {
      for (const v of vehicles) if (v.active) step(v, dt / sub, elapsed);
    }
    for (const v of vehicles) if (v.active) locate(v);

    // pedestrians
    for (const p of peds) {
      if (p.active && Math.hypot(p.x - focusX, p.z - focusZ) > 300) p.active = false;
      if (!p.active) {
        if (spawnBudget >= 1) {
          spawnBudget--;
          spawnPed(p, focusX, focusZ);
        }
        if (!p.active) continue;
      }
      if (p.pause > 0) p.pause -= dt;
      else {
        p.s += p.sDir * p.v * dt;
        if (p.s < p.s0 || p.s > p.s1) {
          p.sDir = -p.sDir;
          p.s = clamp(p.s, p.s0, p.s1);
          p.pause = Math.random() * 2;
        }
      }
      const q = linkPointAt(p.link, p.s, _o);
      p.x = q.x - q.dz * p.off;
      p.z = q.z + q.dx * p.off;
      const heading = Math.atan2(q.dx * p.sDir, q.dz * p.sDir);
      const d = Math.hypot(p.x - focusX, p.z - focusZ);
      p.rig.update(dt, p.x, p.z, heading, p.street ? pedGroundFlat : pedGround, p, 0, d < 120);
      p.placed = true;
    }

    if (camera) render(camera);
  }

  console.info(`[traffic] ${edges.length} lanes, ${cars.length} cars, ${scooters.length} scooters, ${buses.length} buses, ${peds.length} pedestrians in ${Math.round(performance.now() - t0)} ms`);
  return { group, cars, scooters, buses, peds, vehicles, edges, garbageTruck, update };
}

export { createTrafficSystem };
