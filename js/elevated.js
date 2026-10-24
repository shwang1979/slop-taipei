import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, step, smoothstep, fract, color, positionWorld } from 'three/tsl';
import { GEO } from './taipei-geodata.js';
import { ROAD_LINKS, ROAD_NODES, LINK_FLAG, BOUNDS } from './city-config.js';
import { createRoadSurfaceMaterial, cityUniforms } from './tsl-materials.js';

// js/elevated.js
// Taipei's elevated roads (市民大道高架, 建國高架, 環河 & 水源快速道路, the river bridges & their ramps) built from the
// elevated links of the street network: deck slabs with jersey barriers & piers; the elevated MRT (文湖線) on its
// guideway with the elevated stations, and its driverless trains shuttling along it.

const CHUNK = 1000;
const DECK = 1.3; // slab depth under the road surface
const BARRIER_H = 0.95;
const MRT_Y = 11.5; // top of the MRT guideway

function concreteMaterial(hex = 0xa9a59c) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const stain = smoothstep(0.3, 0.9, fract(p.y.mul(0.13).add(p.x.mul(0.011)).add(p.z.mul(0.017))));
    return color(hex).mul(mix(float(1.0), float(0.82), stain.mul(0.5)));
  })();
  return mat;
}

class Builder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.idx = [];
  }

  // Quad a, b, c, d: it faces the side from which a -> b -> c runs clockwise, i.e. -(b - a) x (d - a)
  quad(a, b, c, d) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uz * vy - uy * vz;
    let ny = ux * vz - uz * vx;
    let nz = uy * vx - ux * vy;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L;
    ny /= L;
    nz /= L;
    for (let k = 0; k < 4; k++) this.nor.push(nx, ny, nz);
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// Left & right edge points of a polyline ([x, y, z]...) at half-width hw (mitred)
function edges(pts, hw) {
  const L = [];
  const R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const rx = -dz;
    const rz = dx;
    const p = pts[i];
    L.push([p[0] - rx * hw, p[1], p[2] - rz * hw]);
    R.push([p[0] + rx * hw, p[1], p[2] + rz * hw]);
  }
  return [L, R];
}

function linkPoints(l) {
  const out = [];
  for (let i = 0; i < l.cum.length; i++) out.push([l.pts[i * 3], l.pts[i * 3 + 1], l.pts[i * 3 + 2]]);
  return out;
}

// Resample a polyline every `step` metres (keeps the ends)
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[2] - a[2]);
    let s = step - carry;
    while (s < seg) {
      const t = s / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      s += step;
    }
    carry = seg - (s - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function buildRoadDecks(group, colliders) {
  const tops = new Map();
  const sides = new Map();
  const get = (map, x, z) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    if (!map.has(key)) map.set(key, new Builder());
    return map.get(key);
  };
  const piers = [];
  for (const l of ROAD_LINKS) {
    if (!(l.flags & LINK_FLAG.ELEVATED)) continue;
    const pts = resample(linkPoints(l), 10).map((p) => [p[0], Math.max(0, p[1]), p[2]]);
    if (pts.length < 2) continue;
    const hw = l.w / 2 + 0.6;
    const [Lft, Rgt] = edges(pts, hw);
    const mid = pts[pts.length >> 1];
    const top = get(tops, mid[0], mid[2]);
    const side = get(sides, mid[0], mid[2]);
    const endA = ROAD_NODES[l.a];
    const endB = ROAD_NODES[l.b];
    let s = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[2] - a[2]);
      s += segLen;
      if (Math.max(a[1], b[1]) < 0.2) continue; // still in the street (the carriageway surface has it)
      const la = Lft[i], lb = Lft[i + 1], ra = Rgt[i], rb = Rgt[i + 1];
      const lift = 0.02;
      // road surface (up)
      top.quad([la[0], la[1] + lift, la[2]], [lb[0], lb[1] + lift, lb[2]], [rb[0], rb[1] + lift, rb[2]], [ra[0], ra[1] + lift, ra[2]]);
      // slab sides (outwards) down to the slab's underside, or the ground on a low ramp (retaining walls)
      const bot = (y) => Math.max(-0.3, y - DECK);
      side.quad([lb[0], bot(lb[1]), lb[2]], [lb[0], lb[1] + BARRIER_H, lb[2]], [la[0], la[1] + BARRIER_H, la[2]], [la[0], bot(la[1]), la[2]]);
      side.quad([ra[0], bot(ra[1]), ra[2]], [ra[0], ra[1] + BARRIER_H, ra[2]], [rb[0], rb[1] + BARRIER_H, rb[2]], [rb[0], bot(rb[1]), rb[2]]);
      // inner faces of the barriers, 0.35 m in
      const inset = (p, q, d) => {
        const dx = q[0] - p[0];
        const dz = q[2] - p[2];
        const n = Math.hypot(dx, dz) || 1;
        return [p[0] + (dx / n) * d, p[1], p[2] + (dz / n) * d];
      };
      const lai = inset(la, ra, 0.35), lbi = inset(lb, rb, 0.35), rai = inset(ra, la, 0.35), rbi = inset(rb, lb, 0.35);
      side.quad([la[0], la[1] + BARRIER_H, la[2]], [lb[0], lb[1] + BARRIER_H, lb[2]], [lbi[0], lbi[1] + BARRIER_H, lbi[2]], [lai[0], lai[1] + BARRIER_H, lai[2]]);
      side.quad([lai[0], lai[1], lai[2]], [lai[0], lai[1] + BARRIER_H, lai[2]], [lbi[0], lbi[1] + BARRIER_H, lbi[2]], [lbi[0], lbi[1], lbi[2]]);
      side.quad([rb[0], rb[1] + BARRIER_H, rb[2]], [ra[0], ra[1] + BARRIER_H, ra[2]], [rai[0], rai[1] + BARRIER_H, rai[2]], [rbi[0], rbi[1] + BARRIER_H, rbi[2]]);
      side.quad([rbi[0], rbi[1], rbi[2]], [rbi[0], rbi[1] + BARRIER_H, rbi[2]], [rai[0], rai[1] + BARRIER_H, rai[2]], [rai[0], rai[1], rai[2]]);
      // underside (down)
      if (Math.min(a[1], b[1]) > DECK + 0.5) {
        side.quad([ra[0], bot(ra[1]), ra[2]], [rb[0], bot(rb[1]), rb[2]], [lb[0], bot(lb[1]), lb[2]], [la[0], bot(la[1]), la[2]]);
      }
      // a pier every ~30 m where the deck is high enough to pass under
      const y = (a[1] + b[1]) / 2;
      const nearEnd = (s < 12 && endA.links.length > 2) || (l.len - s < 12 && endB.links.length > 2);
      if (y > 4.5 && !nearEnd && Math.floor((s - segLen) / 30) !== Math.floor(s / 30)) {
        const dx = (b[0] - a[0]) / segLen;
        const dz = (b[2] - a[2]) / segLen;
        const cx = (a[0] + b[0]) / 2;
        const cz = (a[2] + b[2]) / 2;
        const top = y - DECK;
        const wide = l.w > 11;
        piers.push({ x: cx, z: cz, h: top, yaw: Math.atan2(dx, dz), w: wide ? l.w * 0.75 : 0 });
        const hw2 = 0.9;
        colliders.push({
          minX: cx - 1.2, maxX: cx + 1.2, minZ: cz - 1.2, maxZ: cz + 1.2, minY: -Infinity, maxY: top,
          poly: new Float32Array([cx - hw2, cz - hw2, cx + hw2, cz - hw2, cx + hw2, cz + hw2, cx - hw2, cz + hw2])
        });
      }
    }
  }
  const road = createRoadSurfaceMaterial();
  const concrete = concreteMaterial();
  for (const [key, b] of tops) {
    if (!b.pos.length) continue;
    const mesh = new THREE.Mesh(b.geometry(), road);
    mesh.name = `ViaductDeck_${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }
  for (const [key, b] of sides) {
    if (!b.pos.length) continue;
    const mesh = new THREE.Mesh(b.geometry(), concrete);
    mesh.name = `ViaductSides_${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
  }
  // Piers: a column with a cap beam across the deck (T-piers under the wide decks)
  const column = new THREE.BoxGeometry(1.8, 1, 1.8).translate(0, 0.5, 0);
  const cap = new THREE.BoxGeometry(1, 1.1, 2.2).translate(0, -0.55, 0);
  const colMesh = new THREE.InstancedMesh(column, concrete, Math.max(1, piers.length));
  const capMesh = new THREE.InstancedMesh(cap, concrete, Math.max(1, piers.length));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  piers.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yaw);
    colMesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(1, p.h, 1)));
    capMesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.h, p.z), q, new THREE.Vector3(Math.max(2.4, p.w), 1, 1)));
  });
  colMesh.count = capMesh.count = piers.length;
  for (const mesh of [colMesh, capMesh]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  colMesh.name = 'ViaductPiers';
  capMesh.name = 'ViaductPierCaps';
  return piers.length;
}

// --- MRT 文湖線: chain the viaduct ways into continuous lines, a box girder per track, piers, stations, trains -------------
function chainLines(ways) {
  const parts = ways.map(([name, flat]) => {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], 0, flat[i + 1]]);
    return { name, pts };
  });
  const close = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]) < 1.0;
  const lines = [];
  while (parts.length) {
    let line = parts.shift().pts;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].pts;
        const head = line[0];
        const tail = line[line.length - 1];
        if (close(tail, p[0])) line = line.concat(p.slice(1));
        else if (close(tail, p[p.length - 1])) line = line.concat(p.slice(0, -1).reverse());
        else if (close(head, p[p.length - 1])) line = p.slice(0, -1).concat(line);
        else if (close(head, p[0])) line = p.slice(1).reverse().concat(line);
        else continue;
        parts.splice(i, 1);
        grew = true;
        break;
      }
    }
    lines.push(line);
  }
  return lines;
}

function lineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
  return s;
}

function buildMRT(group, colliders) {
  const lines = chainLines(GEO.viaducts).filter((l) => lineLength(l) > 120);
  const inside = (p, m) => p[0] > BOUNDS.minX + m && p[0] < BOUNDS.maxX - m && p[2] > BOUNDS.minZ + m && p[2] < BOUNDS.maxZ - m;
  const girder = new Builder();
  const piers = [];
  const tracks = [];
  for (const raw of lines) {
    const pts = resample(raw, 5);
    const len = lineLength(pts);
    // the guideway's height: MRT_Y, ramping down over 160 m at a portal inside the city (the line goes underground)
    const rampA = inside(pts[0], 60);
    const rampB = inside(pts[pts.length - 1], 60);
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
      let y = MRT_Y;
      if (rampA) y = Math.min(y, (s / 160) * MRT_Y);
      if (rampB) y = Math.min(y, ((len - s) / 160) * MRT_Y);
      pts[i][1] = y;
    }
    tracks.push({ pts, len });
    const [L, R] = edges(pts, 1.6);
    s = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[2] - a[2]);
      s += segLen;
      if (a[1] < 0.5 && b[1] < 0.5) continue;
      const la = L[i], lb = L[i + 1], ra = R[i], rb = R[i + 1];
      const d = 1.9;
      girder.quad([la[0], la[1], la[2]], [lb[0], lb[1], lb[2]], [rb[0], rb[1], rb[2]], [ra[0], ra[1], ra[2]]);
      girder.quad([lb[0], lb[1] - d, lb[2]], [lb[0], lb[1] + 0.6, lb[2]], [la[0], la[1] + 0.6, la[2]], [la[0], la[1] - d, la[2]]);
      girder.quad([ra[0], ra[1] - d, ra[2]], [ra[0], ra[1] + 0.6, ra[2]], [rb[0], rb[1] + 0.6, rb[2]], [rb[0], rb[1] - d, rb[2]]);
      girder.quad([ra[0], ra[1] - d, ra[2]], [rb[0], rb[1] - d, rb[2]], [lb[0], lb[1] - d, lb[2]], [la[0], la[1] - d, la[2]]);
      const y = (a[1] + b[1]) / 2;
      if (y > 5 && Math.floor((s - segLen) / 32) !== Math.floor(s / 32)) {
        const cx = (a[0] + b[0]) / 2;
        const cz = (a[2] + b[2]) / 2;
        piers.push({ x: cx, z: cz, h: y - d });
        colliders.push({ minX: cx - 1.1, maxX: cx + 1.1, minZ: cz - 1.1, maxZ: cz + 1.1, minY: -Infinity, maxY: y - d,
          poly: new Float32Array([cx - 0.8, cz - 0.8, cx + 0.8, cz - 0.8, cx + 0.8, cz + 0.8, cx - 0.8, cz + 0.8]) });
      }
    }
  }
  // Elevated stations: a long hall over the tracks on its own piers, curved roof, platform-screen glass
  const st = new Builder();
  const stationMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8d6cf, roughness: 0.55, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a7a86, roughness: 0.15, metalness: 0.5 });
  glassMat.emissiveNode = color(0xe8f0ff).mul(cityUniforms.uInteriorGlow.mul(0.35));
  const glass = new Builder();
  const stations = [];
  for (const [name, x, z, ang] of GEO.mrtStations) {
    const ux = Math.sin(ang);
    const uz = Math.cos(ang);
    const vx = -uz;
    const vz = ux;
    const hl = 55;
    const hw = 11;
    const P = (a, b, y) => [x + ux * a + vx * b, y, z + uz * a + vz * b];
    const y0 = MRT_Y - 4.5;
    const y1 = MRT_Y + 5.5;
    // floor slab, end walls, glass sides, barrel roof
    st.quad(P(-hl, -hw, y0), P(hl, -hw, y0), P(hl, hw, y0), P(-hl, hw, y0));
    st.quad(P(-hl, hw, y0), P(hl, hw, y0), P(hl, -hw, y0), P(-hl, -hw, y0));
    st.quad(P(-hl, -hw, y0 - 1.2), P(-hl, -hw, y0), P(-hl, hw, y0), P(-hl, hw, y0 - 1.2));
    st.quad(P(hl, hw, y0 - 1.2), P(hl, hw, y0), P(hl, -hw, y0), P(hl, -hw, y0 - 1.2));
    glass.quad(P(hl, -hw, y0), P(hl, -hw, y1), P(-hl, -hw, y1), P(-hl, -hw, y0));
    glass.quad(P(-hl, hw, y0), P(-hl, hw, y1), P(hl, hw, y1), P(hl, hw, y0));
    const N = 8;
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * Math.PI;
      const a1 = ((k + 1) / N) * Math.PI;
      const b0 = -Math.cos(a0) * (hw + 1);
      const b1 = -Math.cos(a1) * (hw + 1);
      const h0 = y1 + Math.sin(a0) * 3.5;
      const h1 = y1 + Math.sin(a1) * 3.5;
      st.quad(P(-hl - 2, b0, h0), P(-hl - 2, b1, h1), P(hl + 2, b1, h1), P(hl + 2, b0, h0));
    }
    // station piers
    for (const a of [-40, -15, 15, 40]) {
      for (const b of [-7, 7]) {
        const [px, , pz] = P(a, b, 0);
        piers.push({ x: px, z: pz, h: y0 });
      }
    }
    stations.push({ name, x, z, ux, uz });
    colliders.push({
      minX: x - 60, maxX: x + 60, minZ: z - 60, maxZ: z + 60, minY: y0 - 1.5, maxY: y1 + 4,
      poly: new Float32Array([...P(-hl, -hw, 0).filter((_, i) => i !== 1), ...P(hl, -hw, 0).filter((_, i) => i !== 1), ...P(hl, hw, 0).filter((_, i) => i !== 1), ...P(-hl, hw, 0).filter((_, i) => i !== 1)])
    });
  }
  const concrete = concreteMaterial(0xb5b1a8);
  const gm = new THREE.Mesh(girder.geometry(), concrete);
  gm.name = 'MRTGuideway';
  gm.castShadow = true;
  gm.receiveShadow = true;
  group.add(gm);
  const pierMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.85, 0.95, 1, 10).translate(0, 0.5, 0), concrete, Math.max(1, piers.length));
  const m = new THREE.Matrix4();
  piers.forEach((p, i) => pierMesh.setMatrixAt(i, m.makeScale(1, p.h, 1).setPosition(p.x, 0, p.z)));
  pierMesh.count = piers.length;
  pierMesh.name = 'MRTPiers';
  pierMesh.castShadow = true;
  pierMesh.receiveShadow = true;
  group.add(pierMesh);

  const stMesh = new THREE.Mesh(st.geometry(), stationMat);
  stMesh.name = 'MRTStations';
  stMesh.castShadow = true;
  stMesh.receiveShadow = true;
  group.add(stMesh);
  const glassMesh = new THREE.Mesh(glass.geometry(), glassMat);
  glassMesh.name = 'MRTStationGlass';
  group.add(glassMesh);

  // Trains: four rubber-tyred cars (white with a brown band), shuttling end to end along each long line, halting at
  // the stations
  const trainLines = tracks.filter((t) => t.len > 800);
  const CAR_LEN = 13.7;
  const trains = [];
  for (const t of trainLines) {
    const cum = [0];
    for (let i = 1; i < t.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][2] - t.pts[i - 1][2]));
    const stops = [];
    for (const s of stations) {
      let best = Infinity;
      let bs = 0;
      for (let i = 0; i < t.pts.length; i++) {
        const d = Math.hypot(t.pts[i][0] - s.x, t.pts[i][2] - s.z);
        if (d < best) {
          best = d;
          bs = cum[i];
        }
      }
      if (best < 12) stops.push(bs);
    }
    stops.sort((a, b) => a - b);
    for (let k = 0; k < Math.max(1, Math.round(t.len / 2500)); k++) {
      trains.push({ t, cum, stops, s: (t.len * (k + 0.3)) / Math.max(1, Math.round(t.len / 2500)), dir: k % 2 ? -1 : 1, v: 0, dwell: 0 });
    }
  }
  const carGeo = new THREE.BoxGeometry(2.5, 3.0, CAR_LEN - 0.6).translate(0, 1.5 + 0.6, 0);
  const carMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.2 });
  carMat.colorNode = Fn(() => {
    const y = attribute('position', 'vec3').y;
    const band = step(1.1, y).mul(step(y, 1.5));
    const win = step(1.9, y).mul(step(y, 3.0)).mul(step(0.25, fract(attribute('position', 'vec3').z.div(2.2))));
    return mix(mix(color(0xf0f0ec), color(0x7a3a24), band), color(0x1c2a32), win.mul(0.85));
  })();
  carMat.emissiveNode = Fn(() => {
    const y = attribute('position', 'vec3').y;
    const win = step(1.9, y).mul(step(y, 3.0)).mul(step(0.25, fract(attribute('position', 'vec3').z.div(2.2))));
    return color(0xe8f0ff).mul(win).mul(cityUniforms.uInteriorGlow.mul(0.6));
  })();
  const carMesh = new THREE.InstancedMesh(carGeo, carMat, Math.max(1, trains.length * 4));
  carMesh.count = trains.length * 4;
  carMesh.name = 'MRTTrains';
  carMesh.castShadow = true;
  carMesh.frustumCulled = false;
  group.add(carMesh);

  const at = (tr, s) => {
    const { pts } = tr.t;
    const cum = tr.cum;
    s = Math.max(0, Math.min(tr.t.len, s));
    let i = 1;
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    i = lo;
    const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    const a = pts[i - 1];
    const b = pts[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, Math.atan2(b[0] - a[0], b[2] - a[2])];
  };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  function update(dt) {
    let k = 0;
    for (const tr of trains) {
      const len = tr.t.len;
      if (tr.dwell > 0) tr.dwell -= dt;
      else {
        // next stop ahead (or the line's end), braking to stop at it
        const ahead = tr.dir > 0 ? tr.stops.find((s) => s > tr.s + 1) ?? len - CAR_LEN * 2 : [...tr.stops].reverse().find((s) => s < tr.s - 1) ?? CAR_LEN * 2;
        const dist = Math.abs(ahead - tr.s);
        const vMax = Math.min(19, Math.sqrt(2 * 1.0 * dist));
        tr.v = Math.min(vMax, tr.v + 1.0 * dt);
        tr.s += tr.dir * tr.v * dt;
        if (dist < 0.5) {
          tr.s = ahead;
          tr.v = 0;
          tr.dwell = 22;
          if (tr.s <= CAR_LEN * 2 + 0.5 || tr.s >= len - CAR_LEN * 2 - 0.5) tr.dir = -tr.dir;
        }
      }
      for (let c = 0; c < 4; c++) {
        const [x, y, z, yaw] = at(tr, tr.s - tr.dir * (c - 1.5) * CAR_LEN);
        quat.setFromAxisAngle(up, yaw);
        carMesh.setMatrixAt(k++, mat4.compose(pos.set(x, y, z), quat, one));
      }
    }
    carMesh.instanceMatrix.needsUpdate = true;
  }
  update(0);
  return { update, stations: stations.length, trains: trains.length, lines: tracks.length };
}

function buildElevated(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiElevated';
  scene.add(group);
  const colliders = [];
  const piers = buildRoadDecks(group, colliders);
  // the MRT has a group of its own: its trains move (scene-culling.js leaves it alone)
  const mrtGroup = new THREE.Group();
  mrtGroup.name = 'TaipeiMRT';
  scene.add(mrtGroup);
  const mrt = buildMRT(mrtGroup, colliders);
  console.info(`[elevated] ${piers} road piers, MRT: ${mrt.lines} guideways, ${mrt.stations} stations, ${mrt.trains} trains in ${Math.round(performance.now() - t0)} ms`);
  return { group, colliders, update: (dt) => mrt.update(dt) };
}

export { buildElevated };
