import * as THREE from 'three/webgpu';
import { Fn, attribute, float, mix, step, smoothstep, sin, fract, fwidth, color, positionWorld, normalWorldGeometry } from 'three/tsl';
import { GEO } from './taipei-geodata.js';
import { hillHeight } from './city-config.js';
import { orientedBox } from './buildings.js';
import { cityUniforms, createCurtainWallMaterial, createPreWarBuildingMaterial } from './tsl-materials.js';

// js/landmarks.js
// Hand-built models of Taipei's landmarks at their real places (taipei-geodata.js landmarks): Taipei 101, the Chiang
// Kai-shek Memorial Hall with Liberty Square's gate, National Theater & Concert Hall, the Presidential Office, the Sun
// Yat-sen Memorial Hall, Taipei Main Station, the Grand Hotel, Longshan Temple, the Red House and the old city gates.
// The palace-style buildings share one roof builder: hipped glazed-tile roofs, single or double eaves (重簷), with
// curved slopes and upturned corners.

// --- Geometry collector: positions, normals, colours & `aux` (u along the wall in metres, part: 0 plain, 1 glazed tile,
// 2 lit at night) ---------------------------------------------------------------------------------------------------
class Mesher {
  constructor() {
    this.pos = [];
    this.col = [];
    this.aux = [];
    this.idx = [];
  }

  v(x, y, z, c, u = 0, part = 0) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.aux.push(u, part);
    return this.pos.length / 3 - 1;
  }

  // Quad a-b-c-d (counter-clockwise seen from its front)
  quad(a, b, c, d, col, part = 0, uScale = null) {
    const L = uScale ?? Math.hypot(b[0] - a[0], b[2] - a[2]);
    const i0 = this.v(...a, col, 0, part);
    const i1 = this.v(...b, col, L, part);
    const i2 = this.v(...c, col, L, part);
    const i3 = this.v(...d, col, 0, part);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  // Vertical walls around a ring of [x, z] points (counter-clockwise in x/z), from y0 to y1, & a flat top
  prism(ring, y0, y1, col, { top = true, part = 0, topCol = col } = {}) {
    const n = ring.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % n];
      area += ax * bz - bx * az;
    }
    const r = area > 0 ? ring : ring.slice().reverse();
    for (let i = 0; i < n; i++) {
      const [ax, az] = r[i];
      const [bx, bz] = r[(i + 1) % n];
      // outward normal (bz - az, -(bx - ax)): quad seen from outside a, b along the edge
      this.quad([ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz], col, part);
    }
    if (top) {
      const contour = r.map(([x, z]) => new THREE.Vector2(x, z));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const base = this.pos.length / 3;
      for (const [x, z] of r) this.v(x, y1, z, topCol, 0, part);
      for (const [a, b, c] of tris) {
        const cross = (r[c][0] - r[a][0]) * (r[b][1] - r[a][1]) - (r[b][0] - r[a][0]) * (r[c][1] - r[a][1]);
        if (cross > 0) this.idx.push(base + a, base + b, base + c);
        else this.idx.push(base + a, base + c, base + b);
      }
    }
  }

  // Oriented box: centre (cx, cz), axes u (ux, uz) & v (-uz, ux), half sizes hu, hv, from y0 to y1
  box(cx, cz, ux, uz, hu, hv, y0, y1, col, opts) {
    const vx = -uz;
    const vz = ux;
    const P = (a, b) => [cx + ux * a + vx * b, cz + uz * a + vz * b];
    this.prism([P(-hu, -hv), P(hu, -hv), P(hu, hv), P(-hu, hv)], y0, y1, col, opts);
  }

  // A height field over an oriented rectangle (roofs): f(a, c) -> y, a in [-hu, hu], c in [-hv, hv]; skip(a, c)
  // leaves a cell out (the hole of a skirt roof)
  sheet(cx, cz, ux, uz, hu, hv, na, nc, f, col, part = 1, skip = null) {
    const vx = -uz;
    const vz = ux;
    const base = this.pos.length / 3;
    for (let j = 0; j <= nc; j++) {
      for (let i = 0; i <= na; i++) {
        const a = -hu + (2 * hu * i) / na;
        const c = -hv + (2 * hv * j) / nc;
        this.v(cx + ux * a + vx * c, f(a, c), cz + uz * a + vz * c, col, a, part);
      }
    }
    for (let j = 0; j < nc; j++) {
      for (let i = 0; i < na; i++) {
        if (skip) {
          const a = -hu + (2 * hu * (i + 0.5)) / na;
          const c = -hv + (2 * hv * (j + 0.5)) / nc;
          if (skip(a, c)) continue;
        }
        const k = base + j * (na + 1) + i;
        this.idx.push(k, k + na + 1, k + 1, k + 1, k + na + 1, k + na + 2);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aux', new THREE.Float32BufferAttribute(this.aux, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const C = (hex) => new THREE.Color(hex);

/**
 * Hipped roof (廡殿) over an oriented rectangle: eaves at y0 overhanging `over` past hu x hv, rising `rise` to a ridge
 * of half-length hu - hv * k; concave slopes, corners swept up by `lift` (飛簷). Double-sided sheet.
 */
function hipRoof(m, { cx, cz, ux, uz, hu, hv, y0, rise, over = 1.2, lift = 1.0, col, ridgeCol = null, swallow = 0 }) {
  const L = hu + over;
  const W = hv + over;
  const k = 0.75;
  m.sheet(cx, cz, ux, uz, L, W, 28, 14, (a, c) => {
    const tc = 1 - Math.abs(c) / W; // 0 at the eave .. 1 at the ridge line
    const ta = (L - Math.abs(a)) / (W * k); // hips
    const t = Math.max(0, Math.min(1, Math.min(tc, ta)));
    const curve = 1 - Math.pow(1 - t, 1.7);
    const corner = Math.pow(Math.abs(a) / L, 8) * Math.pow(Math.abs(c) / W, 2) + Math.pow(Math.abs(c) / W, 10) * Math.pow(Math.abs(a) / L, 3) * 0.6;
    return y0 + rise * curve + lift * Math.min(1, corner * 1.6);
  }, col, 1);
  // ridge beam (& swallowtail ends on the temples)
  const ridgeHalf = Math.max(0.5, L - W * k);
  const rc = ridgeCol || col;
  m.box(cx, cz, ux, uz, ridgeHalf, 0.35, y0 + rise - 0.1, y0 + rise + 0.55, rc, { part: 1 });
  if (swallow) {
    for (const s of [-1, 1]) {
      const ex = cx + ux * s * (ridgeHalf + 0.6);
      const ez = cz + uz * s * (ridgeHalf + 0.6);
      m.box(ex, ez, ux, uz, 0.9, 0.2, y0 + rise + 0.2, y0 + rise + 0.6 + swallow, rc, { part: 1 });
    }
  }
}

// Skirt roof of a double eave (重簷): from the body's walls (hu x hv) out & down to its eaves `over` beyond
function skirtRoof(m, { cx, cz, ux, uz, hu, hv, y0, rise, over, lift = 0.8, col }) {
  const L = hu + over;
  const W = hv + over;
  m.sheet(cx, cz, ux, uz, L, W, 30, 22, (a, c) => {
    const d = Math.max(Math.abs(a) - hu, Math.abs(c) - hv, 0); // outward from the walls
    const t = 1 - Math.min(1, d / over);
    const corner = Math.pow(Math.abs(a) / L, 8) * Math.pow(Math.abs(c) / W, 8);
    return y0 + rise * (1 - Math.pow(1 - t, 1.5)) + lift * Math.min(1, corner * 4);
  }, col, 1, (a, c) => Math.abs(a) < hu - 0.4 && Math.abs(c) < hv - 0.4);
}

// Glazed tile roofs, painted walls, stone & lit outlines: vertex colours; tiles get ribs along the slope & a sheen
function createLandmarkMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide });
  const aux = attribute('aux', 'vec2');
  const tile = step(0.5, aux.y).mul(step(aux.y, 1.5));
  const lit = step(1.5, aux.y);
  mat.colorNode = Fn(() => {
    // tile rows, fading to their mean before they shrink to a pixel (no moiré on the far roofs)
    const rowCoord = aux.x.div(0.32);
    const ribs = mix(sin(rowCoord.mul(Math.PI * 2)).mul(0.5).add(0.5), float(0.5), smoothstep(0.15, 0.45, fwidth(rowCoord)));
    const base = attribute('color', 'vec3');
    return mix(base, base.mul(mix(float(0.78), float(1.08), ribs)), tile);
  })();
  mat.roughnessNode = mix(float(0.75), float(0.32), tile);
  mat.metalnessNode = mix(float(0.0), float(0.15), tile);
  mat.emissiveNode = attribute('color', 'vec3').mul(lit).mul(smoothstep(0.5, 1.3, cityUniforms.uInteriorGlow).mul(2.2));
  return mat;
}

// Palace walls (宮殿): a colonnade of red columns every ~4 m over lattice doors & windows, a painted beam band (彩繪)
// under the eaves; u runs along the wall (aux.x). Lit from inside at night.
function createPalaceWallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7 });
  const aux = attribute('aux', 'vec2');
  const cell = fract(aux.x.div(4.2));
  const column = step(cell, 0.2).add(step(0.8, cell)).min(1.0);
  const yFrac = fract(positionWorld.y.div(9.0));
  mat.colorNode = Fn(() => {
    const base = attribute('color', 'vec3');
    const lattice = step(0.82, fract(aux.x.mul(3.0))).max(step(0.82, fract(positionWorld.y.mul(3.0))));
    const infill = mix(color(0x5a2418), color(0xc89a40), lattice.mul(0.6));
    const beam = smoothstep(0.84, 0.86, yFrac);
    const beamCol = mix(color(0x1f6a5a), color(0x2a4f9a), step(0.5, fract(aux.x.div(2.1))));
    return mix(mix(infill, base, column), beamCol, beam.mul(step(0.5, normalWorldGeometry.y.abs().oneMinus())));
  })();
  mat.emissiveNode = Fn(() => {
    const night = cityUniforms.uInteriorGlow.mul(0.55);
    const glow = float(1.0).sub(column).mul(step(fract(positionWorld.y.div(9.0)), 0.8));
    return color(0xffb860).mul(glow).mul(night).mul(0.5);
  })();
  return mat;
}

// --- Taipei 101 ------------------------------------------------------------------------------------------------------
// Square floor plan with notched corners; a tapering base (floors 1-26), eight flared 8-storey sections (節節高升,
// floors 27-90), the top tower, the pinnacle (508 m). Ruyi (如意) emblems on the base, the podium mall round its foot.
function notchedSquare(h, notch) {
  const d = h * notch;
  const pts = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    // corner (sx h, sz h) replaced by an inward notch, walking counter-clockwise
    const corner = [
      [sx * h, sz * (h - d)],
      [sx * (h - d), sz * (h - d)],
      [sx * (h - d), sz * h]
    ];
    pts.push(...(sx * sz > 0 ? corner : corner.reverse()));
  }
  return pts;
}

function frustum(m, cx, cz, h0, h1, y0, y1, col, part = 0) {
  const r0 = notchedSquare(h0, 0.12);
  const r1 = notchedSquare(h1, 0.12);
  let area = 0;
  for (let i = 0; i < r0.length; i++) area += r0[i][0] * r0[(i + 1) % r0.length][1] - r0[(i + 1) % r0.length][0] * r0[i][1];
  const s = area > 0 ? 1 : -1;
  const n = r0.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [a, b] = s > 0 ? [i, j] : [j, i];
    m.quad([cx + r0[a][0], y0, cz + r0[a][1]], [cx + r1[a][0], y1, cz + r1[a][1]], [cx + r1[b][0], y1, cz + r1[b][1]], [cx + r0[b][0], y0, cz + r0[b][1]], col, part);
  }
}

function capRing(m, cx, cz, hOuter, hInner, y, col, part = 0) {
  const ro = notchedSquare(hOuter, 0.12);
  const ri = notchedSquare(hInner, 0.12);
  let area = 0;
  for (let i = 0; i < ro.length; i++) area += ro[i][0] * ro[(i + 1) % ro.length][1] - ro[(i + 1) % ro.length][0] * ro[i][1];
  const n = ro.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [a, b] = area > 0 ? [i, j] : [j, i];
    // ledge facing up: inner a -> outer a -> outer b -> inner b seen from above
    m.quad([cx + ri[a][0], y, cz + ri[a][1]], [cx + ro[a][0], y, cz + ro[a][1]], [cx + ro[b][0], y, cz + ro[b][1]], [cx + ri[b][0], y, cz + ri[b][1]], col, part);
  }
}

// 101's night lights: each of the eight sections lit in the colour of the day of the week (Monday red ... Sunday purple)
const DAY_COLORS = [0x9a3cff, 0xff3030, 0xff8a20, 0xffe030, 0x40e060, 0x3a9cff, 0x4060ff];

function buildTaipei101(group, lm) {
  const t0 = performance.now();
  const glass = createCurtainWallMaterial({ glassTint: 0x3f8a7c, frameTint: 0x4f6e66, windowWidth: 1.7, floorHeight: 4.25, litProbability: 0.55, warmth: 0.2, reflectivity: 0.95, seed: 101 });
  const tower = new Mesher();
  const trim = new Mesher();
  const glassCol = C(0x3f8a7c);
  const steel = C(0x6f8580);
  const { x: cx, z: cz } = lm;
  // Tower base: floors 1-26, tapering from 31 m to 25 m half-width
  frustum(tower, cx, cz, 31, 25, 0, 112, glassCol);
  capRing(trim, cx, cz, 25, 21, 112, steel);
  // Eight flared sections of 8 floors (34 m each): 21 m at the foot, 26 m at the top
  let y = 112;
  for (let s = 0; s < 8; s++) {
    frustum(tower, cx, cz, 21, 26, y, y + 34, glassCol);
    capRing(trim, cx, cz, 26, 21, y + 34, steel);
    y += 34;
  }
  // Top tower (floors 91-101) & the roof platforms
  frustum(tower, cx, cz, 15, 13.5, y, y + 46, glassCol);
  capRing(trim, cx, cz, 15, 0.1, y, steel);
  y += 46;
  trim.prism(notchedSquare(13.5, 0.12).map(([a, b]) => [cx + a, cz + b]), y, y + 2, steel);
  trim.prism(notchedSquare(8, 0.12).map(([a, b]) => [cx + a, cz + b]), y + 2, y + 10, steel);
  // Pinnacle: tapering mast to 508 m
  const mast = new THREE.CylinderGeometry(0.4, 2.2, 508 - (y + 10), 12).translate(cx, (508 + y + 10) / 2, cz);

  const towerMesh = new THREE.Mesh(tower.geometry(), glass);
  towerMesh.name = 'Taipei101';
  towerMesh.castShadow = true;
  towerMesh.receiveShadow = true;
  group.add(towerMesh);

  // Ruyi (如意) emblems on the four faces at the top of the base: gold discs
  const gold = C(0xc8a24a);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = 16;
    const ex = cx + dx * 26.0;
    const ez = cz + dz * 26.0;
    const tx = -dz;
    const tz = dx;
    const disc = (r, out, col) => {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        const P = (a, rr) => [ex + dx * out + tx * Math.cos(a) * rr, 103 + Math.sin(a) * rr, ez + dz * out + tz * Math.cos(a) * rr];
        trim.quad(P(a1, 0.01), P(a0, 0.01), P(a0, r), P(a1, r), col);
      }
    };
    disc(7, 0.5, gold);
    disc(4.2, 0.9, C(0xe8cc80));
  }
  // night: a lit band under every section ledge
  const bandCol = C(DAY_COLORS[new Date().getDay()]);
  y = 112;
  for (let s = 0; s < 8; s++) {
    frustum(trim, cx, cz, 26.15, 26.15, y + 33.2, y + 34, bandCol, 2);
    y += 34;
  }
  const trimMat = createLandmarkMaterial();
  const trimMesh = new THREE.Mesh(trim.geometry(), trimMat);
  trimMesh.name = 'Taipei101Trim';
  trimMesh.castShadow = true;
  trimMesh.receiveShadow = true;
  group.add(trimMesh);
  const mastMesh = new THREE.Mesh(mast, new THREE.MeshStandardNodeMaterial({ color: 0x8a9694, metalness: 0.7, roughness: 0.35 }));
  mastMesh.castShadow = true;
  group.add(mastMesh);
  // aircraft warning light on the tip
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), new THREE.MeshBasicNodeMaterial({ color: 0xff2020 }));
  beacon.position.set(cx, 508.5, cz);
  group.add(beacon);

  // Podium mall (台北101購物中心): the OSM footprint at 30 m, glass & stone
  const podiumMat = createPreWarBuildingMaterial({ stoneColor: 0xc9c3b4, trimColor: 0x8d8a80, windowWidth: 3.6, floorHeight: 5.0, litProbability: 0.7, warmth: 0.8, seed: 7.1, cornerPier: 0 });
  const pod = new Mesher();
  if (lm.ring) {
    const r = [];
    for (let i = 0; i < lm.ring.length; i += 2) r.push([lm.ring[i], lm.ring[i + 1]]);
    pod.prism(r, -0.5, 30, C(0xc9c3b4));
  }
  const podMesh = new THREE.Mesh(pod.geometry(), podiumMat);
  podMesh.name = 'Taipei101Mall';
  podMesh.castShadow = true;
  podMesh.receiveShadow = true;
  group.add(podMesh);

  const colliders = [polyCollider(notchedSquare(31, 0.12).map(([a, b]) => [cx + a, cz + b]), 508)];
  if (lm.ring) colliders.push(polyCollider(ringPts(lm.ring), 30));
  console.info(`[landmarks] Taipei 101 in ${Math.round(performance.now() - t0)} ms`);
  return colliders;
}

const ringPts = (flat) => {
  const r = [];
  for (let i = 0; i < flat.length; i += 2) r.push([flat[i], flat[i + 1]]);
  return r;
};

function polyCollider(pts, maxY, minY = -Infinity) {
  const poly = new Float32Array(pts.flat());
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ, minY, maxY, poly };
}

function boxCollider(cx, cz, ux, uz, hu, hv, maxY) {
  const vx = -uz;
  const vz = ux;
  return polyCollider([[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]].map(([a, b]) => [cx + ux * a + vx * b, cz + uz * a + vz * b]), maxY);
}

// The OSM footprint's oriented box with u along `axis` ('long' / 'short') or the given direction
function boxOf(lm, axis = 'long') {
  const box = orientedBox(new Float32Array(lm.ring));
  let { ux, uz, hx, hz } = box;
  if ((axis === 'long' && hz > hx) || (axis === 'short' && hz < hx)) {
    [ux, uz] = [-uz, ux];
    [hx, hz] = [hz, hx];
  }
  return { cx: box.cx, cz: box.cz, ux, uz, hu: hx, hv: hz };
}

// --- Palace-style halls --------------------------------------------------------------------------------------------------
// White stone base platform(s), a colonnaded body, single or double hipped roof
function palaceHall(stone, walls, roofs, b, o) {
  const { cx, cz, ux, uz, hu, hv } = b;
  const g0 = o.ground ?? 0;
  let y = g0;
  // stepped stone terraces
  for (const [inset, h] of o.terraces || [[0, 1.5]]) {
    stone.box(cx, cz, ux, uz, hu - inset, hv - inset, y - 0.5, y + h, C(o.stoneCol ?? 0xe8e4da));
    y += h;
  }
  const bodyIn = o.bodyInset ?? 3;
  const bu = hu - bodyIn;
  const bv = hv - bodyIn;
  walls.box(cx, cz, ux, uz, bu, bv, y, y + o.bodyH, C(o.columnCol ?? 0xa8241c), { topCol: C(0x6a4a3a) });
  y += o.bodyH;
  const roofCol = C(o.roofCol ?? 0xd9a520);
  if (o.double) {
    skirtRoof(roofs, { cx, cz, ux, uz, hu: bu, hv: bv, y0: y - 0.6, rise: o.skirtRise ?? 3.2, over: o.over ?? 4, col: roofCol });
    // clerestory between the eaves
    walls.box(cx, cz, ux, uz, bu - 0.2, bv - 0.2, y, y + (o.clerestory ?? 4), C(o.columnCol ?? 0xa8241c), { top: false });
    y += o.clerestory ?? 4;
  }
  hipRoof(roofs, { cx, cz, ux, uz, hu: bu, hv: bv, y0: y, rise: o.rise ?? Math.min(bv * 0.7, 14), over: o.over ?? 4, lift: o.lift ?? 1.5, col: roofCol, ridgeCol: o.ridgeCol ? C(o.ridgeCol) : null, swallow: o.swallow || 0 });
  return y + (o.rise ?? Math.min(bv * 0.7, 14));
}

// Chiang Kai-shek Memorial Hall: three white terraces, a white marble hall, an octagonal double roof of blue glazed
// tile with a golden finial, the 89-step stairway to the west (toward Liberty Square)
function buildCKS(stone, roofs, lm) {
  const b = boxOf(lm);
  const { cx, cz } = b;
  const ux = 1;
  const uz = 0;
  const white = C(0xf1efe8);
  const blue = C(0x1d4fa8);
  // terraces (the footprint is the lowest: 168 m)
  const H = Math.min(b.hu, b.hv);
  stone.box(cx, cz, ux, uz, H, H, -0.5, 4, white);
  stone.box(cx, cz, ux, uz, H * 0.62, H * 0.62, 4, 10, white);
  stone.box(cx, cz, ux, uz, H * 0.45, H * 0.45, 10, 15.5, white);
  // the stairway down the west side
  for (let s = 0; s < 14; s++) {
    const t = s / 14;
    stone.box(cx - H * 0.45 - (1 - t) * 26, cz, ux, uz, 1.0, 10, -0.5, 15.5 * t + 1, white, { topCol: C(0xd8d4ca) });
  }
  // hall body
  const hw = H * 0.33;
  stone.box(cx, cz, ux, uz, hw, hw, 15.5, 40, white);
  // dark doorway on the west face
  stone.box(cx - hw - 0.05, cz, ux, uz, 0.1, 6, 15.5, 33, C(0x2a2622));
  // octagonal double roof: two blue tiers with white bands, gold finial
  const oct = (r, y0, y1, rTop) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = ((i + 0.5) / n) * Math.PI * 2;
      const a1 = ((i + 1.5) / n) * Math.PI * 2;
      roofs.quad(
        [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r], [cx + Math.cos(a1) * rTop, y1, cz + Math.sin(a1) * rTop],
        [cx + Math.cos(a0) * rTop, y1, cz + Math.sin(a0) * rTop], [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], blue, 1);
    }
  };
  const R = hw * 1.42;
  oct(R * 1.25, 40, 44, R * 0.78); // lower eave
  stone.prism(Array.from({ length: 8 }, (_, i) => [cx + Math.cos(((i + 0.5) / 8) * Math.PI * 2) * R * 0.8, cz + Math.sin(((i + 0.5) / 8) * Math.PI * 2) * R * 0.8]).reverse(), 44, 49, white);
  oct(R * 1.0, 49, 64, R * 0.12); // upper roof
  const finial = new THREE.Mesh(new THREE.ConeGeometry(1.8, 7, 10).translate(cx, 67.5, cz), new THREE.MeshStandardNodeMaterial({ color: 0xd8b040, metalness: 0.8, roughness: 0.3 }));
  return { finial, colliders: [boxCollider(cx, cz, ux, uz, H, H, 70)] };
}

// Liberty Square's gate (自由廣場牌樓): a white wall pierced by five arches (the middle one highest) under five blue
// glazed roofs
function buildLibertyGate(stone, roofs, lm) {
  const b = boxOf(lm, 'long');
  const { cx, cz, ux, uz, hu } = b;
  const white = C(0xf4f2ec);
  const blue = C(0x2156b0);
  const span = hu * 0.95;
  const bay = span / 2.5; // five bays
  const pier = 2.4;
  const depth = 4.2;
  const archTop = [10, 13, 17, 13, 10];
  const roofBase = [16, 20, 26, 20, 16];
  const at = (a) => [cx + ux * a, cz + uz * a];
  for (let i = 0; i <= 5; i++) {
    const a = -span + i * bay;
    const h = Math.max(archTop[Math.max(0, i - 1)], archTop[Math.min(4, i)]);
    stone.box(...at(a), ux, uz, pier, depth, -0.5, h, white);
  }
  for (let j = 0; j < 5; j++) {
    const a = -span + (j + 0.5) * bay;
    stone.box(...at(a), ux, uz, bay / 2 + pier, depth, archTop[j], roofBase[j], white);
    hipRoof(roofs, { cx: at(a)[0], cz: at(a)[1], ux, uz, hu: bay / 2 + pier, hv: depth, y0: roofBase[j], rise: j === 2 ? 5.5 : 4.2, over: 1.8, lift: 1.0, col: blue });
  }
  return [boxCollider(cx, cz, ux, uz, span + pier, depth, 32)];
}

// Presidential Office (總統府): red brick & white stone bands in the Japanese-era baroque, the 60 m central tower facing
// 凱達格蘭大道 to the east
function buildPresidential(group, lm) {
  const brick = createPreWarBuildingMaterial({ stoneColor: 0xa04a34, trimColor: 0xe6dfcf, windowWidth: 3.3, floorHeight: 4.6, litProbability: 0.45, warmth: 0.85, seed: 19.3, cornerPier: 0 });
  const m = new Mesher();
  const r = ringPts(lm.ring);
  m.prism(r, -0.5, 24, C(0xa04a34));
  const b = boxOf(lm, 'long');
  // tower on the east front (the side facing +x)
  const east = [...r].sort((p, q) => q[0] - p[0])[0][0];
  const tx = east - 7;
  const tz = b.cz;
  m.box(tx, tz, 1, 0, 7, 7, 24, 46, C(0xa04a34));
  m.box(tx, tz, 1, 0, 5.5, 5.5, 46, 54, C(0xe6dfcf));
  const mesh = new THREE.Mesh(m.geometry(), brick);
  mesh.name = 'PresidentialOffice';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  // the tower's cap & the corner pavilions' roofs
  const top = new Mesher();
  hipRoof(top, { cx: tx, cz: tz, ux: 1, uz: 0, hu: 5.5, hv: 5.5, y0: 54, rise: 6, over: 0.6, lift: 0.1, col: C(0x5a6a62) });
  top.box(tx, tz, 1, 0, 0.6, 0.6, 60, 64, C(0xe6dfcf));
  return { trim: top, colliders: [polyCollider(r, 24), boxCollider(tx, tz, 1, 0, 7, 7, 64)] };
}

// Red House (西門紅樓): the octagonal brick market hall with its pyramid roof & cupola, the cross-shaped hall behind
function buildRedHouse(group, lm) {
  const brick = createPreWarBuildingMaterial({ stoneColor: 0xa44a36, trimColor: 0xe8e0d0, windowWidth: 2.6, floorHeight: 4.6, litProbability: 0.6, warmth: 0.9, seed: 33.1, cornerPier: 0 });
  const b = boxOf(lm, 'long');
  const m = new Mesher();
  const front = b.ux > 0 ? 1 : -1; // the octagon stands at the east end
  const ox = b.cx + b.ux * front * (b.hu - 11);
  const oz = b.cz + b.uz * front * (b.hu - 11);
  const oct = Array.from({ length: 8 }, (_, i) => [ox + Math.cos((i / 8) * Math.PI * 2 + Math.PI / 8) * 11, oz + Math.sin((i / 8) * Math.PI * 2 + Math.PI / 8) * 11]);
  m.prism(oct, -0.5, 10, C(0xa44a36));
  // cross-shaped hall
  const hx = b.cx - b.ux * front * 11;
  const hz = b.cz - b.uz * front * 11;
  m.box(hx, hz, b.ux, b.uz, b.hu - 22, 9, -0.5, 8, C(0xa44a36));
  m.box(hx, hz, b.ux, b.uz, 9, b.hv, -0.5, 8, C(0xa44a36));
  const mesh = new THREE.Mesh(m.geometry(), brick);
  mesh.name = 'RedHouse';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  const roof = new Mesher();
  const grey = C(0x4e4e52);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const a1 = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
    roof.quad([ox + Math.cos(a1) * 12, 10, oz + Math.sin(a1) * 12], [ox + Math.cos(a1) * 2, 15, oz + Math.sin(a1) * 2], [ox + Math.cos(a0) * 2, 15, oz + Math.sin(a0) * 2], [ox + Math.cos(a0) * 12, 10, oz + Math.sin(a0) * 12], grey, 1);
  }
  roof.prism(Array.from({ length: 8 }, (_, i) => [ox + Math.cos((i / 8) * Math.PI * 2) * 2, oz + Math.sin((i / 8) * Math.PI * 2) * 2]), 15, 18, C(0xe8e0d0));
  hipRoof(roof, { cx: hx, cz: hz, ux: b.ux, uz: b.uz, hu: b.hu - 22, hv: 9, y0: 8, rise: 4, over: 0.8, lift: 0, col: grey });
  return { trim: roof, colliders: [polyCollider(oct, 18), boxCollider(hx, hz, b.ux, b.uz, b.hu - 22, 9, 12)] };
}

// The old city gates (臺北府城): stone base with an arched passage; 北門 a closed brick blockhouse, the others an open
// pavilion with red columns under a glazed roof
function buildGate(stone, walls, roofs, lm, closed) {
  const b = boxOf(lm, 'long');
  const { cx, cz, ux, uz } = b;
  const hu = Math.min(b.hu, 10);
  const hv = Math.min(b.hv, 7.5);
  stone.box(cx, cz, ux, uz, hu, hv, -0.5, 7, C(closed ? 0x9a8a78 : 0xb8b2a6));
  // the arch: a dark opening on both faces
  stone.box(cx, cz, ux, uz, 2.4, hv + 0.05, -0.5, 4.6, C(0x2a2622), { top: false });
  if (closed) {
    walls.box(cx, cz, ux, uz, hu - 1.5, hv - 1.5, 7, 12, C(0x8a5a44));
    hipRoof(roofs, { cx, cz, ux, uz, hu: hu - 1.5, hv: hv - 1.5, y0: 12, rise: 3.2, over: 0.9, lift: 0.3, col: C(0x6a4a3a), swallow: 0.6 });
  } else {
    walls.box(cx, cz, ux, uz, hu - 2.5, hv - 2.5, 7, 11.5, C(0xa8241c));
    hipRoof(roofs, { cx, cz, ux, uz, hu: hu - 2.5, hv: hv - 2.5, y0: 11.5, rise: 3.8, over: 1.8, lift: 1.0, col: C(0xd9a520), ridgeCol: 0x2a7a5a });
  }
  return [boxCollider(cx, cz, ux, uz, hu, hv, 16)];
}

function buildLandmarks(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiLandmarks';
  scene.add(group);
  const L = GEO.landmarks;
  const colliders = [];
  const stone = new Mesher();
  const walls = new Mesher();
  const roofs = new Mesher();
  const trims = [];

  colliders.push(...buildTaipei101(group, L.taipei101));

  if (L.cksHall.ring) {
    const { finial, colliders: c } = buildCKS(stone, roofs, L.cksHall);
    group.add(finial);
    colliders.push(...c);
  }
  if (L.libertyGate.ring) colliders.push(...buildLibertyGate(stone, roofs, L.libertyGate));
  // National Theater & Concert Hall: red colonnades under double yellow roofs
  for (const id of ['theater', 'concertHall']) {
    if (!L[id].ring) continue;
    const b = boxOf(L[id], 'long');
    palaceHall(stone, walls, roofs, b, { terraces: [[0, 2.5], [4, 2.5]], bodyInset: 9, bodyH: 15, double: true, clerestory: 5, skirtRise: 4.5, over: 4.5, rise: 17, lift: 2.4, roofCol: 0xe8b42a, ridgeCol: 0xe8b42a });
    colliders.push(boxCollider(b.cx, b.cz, b.ux, b.uz, b.hu, b.hv, 40));
  }
  // Sun Yat-sen Memorial Hall: pale walls, sweeping golden roof with its upturned eaves
  if (L.sysHall.ring) {
    const b = boxOf(L.sysHall, 'long');
    palaceHall(stone, walls, roofs, b, { terraces: [[0, 2.0]], bodyInset: 8, bodyH: 18, columnCol: 0xe8dcc8, over: 7, rise: 13, lift: 5.0, roofCol: 0xe0aa22 });
    colliders.push(boxCollider(b.cx, b.cz, b.ux, b.uz, b.hu, b.hv, 32));
  }
  // Taipei Main Station: cream walls & tall windows under a double brown-gold roof
  if (L.mainStation.ring) {
    const b = boxOf(L.mainStation, 'long');
    palaceHall(stone, walls, roofs, b, { terraces: [[0, 0.6]], bodyInset: 1, bodyH: 19, columnCol: 0xe2d6bc, double: true, clerestory: 4, skirtRise: 4.5, over: 5, rise: 12, lift: 1.6, roofCol: 0xb07a2a });
    colliders.push(boxCollider(b.cx, b.cz, b.ux, b.uz, b.hu, b.hv, 32));
  }
  // Grand Hotel (圓山大飯店): fourteen storeys of red columns under a huge golden double roof, on its hill over the
  // 基隆河; the main wing runs east-west
  {
    const g = L.grandHotel;
    const ground = hillHeight(g.x, g.z);
    const b = { cx: g.x, cz: g.z, ux: 1, uz: 0, hu: 78, hv: 16 };
    palaceHall(stone, walls, roofs, b, { ground, terraces: [[0, 3]], bodyInset: 2, bodyH: 44, double: true, clerestory: 6, skirtRise: 6, over: 6.5, rise: 20, lift: 3.4, roofCol: 0xe8a81e, ridgeCol: 0xe8a81e });
    colliders.push(boxCollider(b.cx, b.cz, 1, 0, b.hu, b.hv, ground + 70));
  }
  // Longshan Temple's main hall: double swallowtail roof of orange & green glazed tile
  if (L.longshan.ring) {
    const b = boxOf(L.longshan, 'long');
    palaceHall(stone, walls, roofs, b, { terraces: [[0, 1.0]], bodyInset: 1.5, bodyH: 6.5, double: true, clerestory: 2.5, over: 2.0, rise: 3.6, lift: 1.4, roofCol: 0xd06a2a, ridgeCol: 0x2a8a5a, swallow: 1.6 });
    colliders.push(boxCollider(b.cx, b.cz, b.ux, b.uz, b.hu, b.hv, 18));
  }
  for (const [id, closed] of [['northGate', true], ['eastGate', false], ['southGate', false], ['smallSouthGate', false]]) {
    if (L[id].ring) colliders.push(...buildGate(stone, walls, roofs, L[id], closed));
  }
  if (L.presidential.ring) {
    const p = buildPresidential(group, L.presidential);
    trims.push(p.trim);
    colliders.push(...p.colliders);
  }
  if (L.redHouse.ring) {
    const r = buildRedHouse(group, L.redHouse);
    trims.push(r.trim);
    colliders.push(...r.colliders);
  }

  const landmarkMat = createLandmarkMaterial();
  const add = (m, mat, name) => {
    if (!m.pos.length) return;
    const mesh = new THREE.Mesh(m.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(stone, landmarkMat, 'LandmarkStone');
  add(roofs, landmarkMat, 'LandmarkRoofs');
  add(walls, createPalaceWallMaterial(), 'LandmarkWalls');
  trims.forEach((t, i) => add(t, landmarkMat, `LandmarkTrim${i}`));

  console.info(`[landmarks] ${colliders.length} colliders in ${Math.round(performance.now() - t0)} ms`);
  return { group, colliders };
}

export { buildLandmarks, hipRoof, skirtRoof, Mesher, createLandmarkMaterial, createPalaceWallMaterial };
