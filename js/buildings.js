import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { BUILDINGS, BUILDING_KIND, nearestLink, LINK_FLAG, CLS } from './city-config.js';
import { BUILDING_STYLE, createTaipeiBuildingMaterial, createCorrugatedMetalMaterial } from './tsl-materials.js';

// js/buildings.js
// Every OSM building footprint of central Taipei (~45,000) extruded to its height: walls & roofs merged into chunk
// meshes with the facade attributes the Taipei building material reads (tsl-materials.js), curved tile roofs on the
// temples, corrugated steel sheds (鐵皮屋加蓋) & water tanks on the walk-up roofs, and a polygon collider per building.

const CHUNK = 600;
const K = BUILDING_KIND;

// Growable typed arrays for the merged geometry
class GeoBuilder {
  constructor() {
    this.cap = 4096;
    this.n = 0;
    this.pos = new Float32Array(this.cap * 3);
    this.nor = new Float32Array(this.cap * 3);
    this.wa = new Float32Array(this.cap * 4);
    this.wb = new Float32Array(this.cap);
    this.idx = [];
  }

  grow(extra) {
    if (this.n + extra <= this.cap) return;
    while (this.n + extra > this.cap) this.cap *= 2;
    const re = (a, k) => {
      const b = new Float32Array(this.cap * k);
      b.set(a);
      return b;
    };
    this.pos = re(this.pos, 3);
    this.nor = re(this.nor, 3);
    this.wa = re(this.wa, 4);
    this.wb = re(this.wb, 1);
  }

  vert(x, y, z, nx, ny, nz, a0, a1, a2, a3, b) {
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.nor[i * 3] = nx;
    this.nor[i * 3 + 1] = ny;
    this.nor[i * 3 + 2] = nz;
    this.wa[i * 4] = a0;
    this.wa[i * 4 + 1] = a1;
    this.wa[i * 4 + 2] = a2;
    this.wa[i * 4 + 3] = a3;
    this.wb[i] = b;
    return i;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.n * 3), 3));
    g.setAttribute('wallA', new THREE.BufferAttribute(this.wa.slice(0, this.n * 4), 4));
    g.setAttribute('wallB', new THREE.BufferAttribute(this.wb.slice(0, this.n), 1));
    g.setIndex(this.n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function styleOf(b) {
  const r = b.seed;
  switch (b.kind) {
    case K.TEMPLE: return b.area < 4000 ? BUILDING_STYLE.temple : BUILDING_STYLE.civic;
    case K.CANOPY:
    case K.INDUSTRIAL: return BUILDING_STYLE.shed;
    case K.STATION:
    case K.CIVIC: return b.h > 45 ? BUILDING_STYLE.glass : BUILDING_STYLE.civic;
    case K.COMMERCIAL: return b.h >= 34 || (b.h > 20 && r > 0.65) ? BUILDING_STYLE.glass : BUILDING_STYLE.midrise;
    case K.HOUSE: return BUILDING_STYLE.walkup;
    default: return b.h <= 17.5 ? BUILDING_STYLE.walkup : BUILDING_STYLE.midrise;
  }
}

// Minimum-area oriented rectangle of a ring (edge directions as candidates): { cx, cz, ux, uz, hx, hz }
function orientedBox(ring) {
  const n = ring.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ux = ring[j * 2] - ring[i * 2];
    let uz = ring[j * 2 + 1] - ring[i * 2 + 1];
    const L = Math.hypot(ux, uz);
    if (L < 1) continue;
    ux /= L;
    uz /= L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2];
      const z = ring[k * 2 + 1];
      const a = x * ux + z * uz;
      const b = -x * uz + z * ux;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2;
      const cb = (b0 + b1) / 2;
      best = { area, cx: ca * ux - cb * uz, cz: ca * uz + cb * ux, ux, uz, hx: (a1 - a0) / 2, hz: (b1 - b0) / 2 };
    }
  }
  return best;
}

const hash = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function buildCityBlocks(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiBuildings';
  scene.add(group);
  const material = createTaipeiBuildingMaterial();
  const chunks = new Map();
  const colliders = [];
  const roofSites = [];
  const temples = [];

  const streetFilter = (l) => l.cls <= CLS.service && !(l.flags & LINK_FLAG.ELEVATED);

  for (const b of BUILDINGS) {
    const style = styleOf(b);
    const g0 = b.ground;
    const canopy = b.kind === K.CANOPY;
    // skybridges & covered walkways (base above the street) & canopies are slabs; everything else stands on the ground
    let yBot = b.base > 0 ? g0 + b.base : g0 - 1.5;
    const yTop = g0 + b.h;
    if (canopy) yBot = Math.max(g0 + 2.6, yTop - 0.45);
    const key = `${Math.floor(b.cx / CHUNK)},${Math.floor(b.cz / CHUNK)}`;
    let gb = chunks.get(key);
    if (!gb) chunks.set(key, (gb = new GeoBuilder()));
    const seed = Math.min(0.999, Math.max(0.001, b.seed));

    // Walls of every ring (outer counter-clockwise, holes clockwise in x/z: outward normal (uz, -ux))
    b.rings.forEach((ring, ri) => {
      const n = ring.length / 2;
      gb.grow(n * 4);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const nx = (bz - az) / L;
        const nz = -(bx - ax) / L;
        let front = 0;
        if (ri === 0 && !canopy && L > 2.5 && b.h > 5) {
          const mx = (ax + bx) / 2 + nx * 3;
          const mz = (az + bz) / 2 + nz * 3;
          const near = nearestLink(mx, mz, 9, streetFilter);
          if (near && near.d < near.link.w / 2 + 6) front = 1;
        }
        const wb = style * 2 + front + seed;
        // u restarts on each wall so every wall holds whole bays (the shader lays out bays per wall length)
        const i0 = gb.vert(ax, yBot, az, nx, 0, nz, 0, L, g0, b.h, wb);
        const i1 = gb.vert(bx, yBot, bz, nx, 0, nz, L, L, g0, b.h, wb);
        const i2 = gb.vert(bx, yTop, bz, nx, 0, nz, L, L, g0, b.h, wb);
        const i3 = gb.vert(ax, yTop, az, nx, 0, nz, 0, L, g0, b.h, wb);
        gb.idx.push(i0, i2, i1, i0, i3, i2);
      }
    });

    // Roof (and the underside of slabs): the footprint triangulated
    const outer = b.rings[0];
    const contour = [];
    for (let i = 0; i < outer.length; i += 2) contour.push(new THREE.Vector2(outer[i], outer[i + 1]));
    const holes = b.rings.slice(1).map((r) => {
      const h = [];
      for (let i = 0; i < r.length; i += 2) h.push(new THREE.Vector2(r[i], r[i + 1]));
      return h;
    });
    let tris;
    if (contour.length === 4 && !holes.length) tris = [[0, 1, 2], [0, 2, 3]];
    else {
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        tris = [];
      }
    }
    const all = holes.length ? contour.concat(...holes) : contour;
    const isTemple = style === BUILDING_STYLE.temple;
    const wb = style * 2 + seed;
    const slab = b.base > 0 || canopy;
    for (const pass of slab ? [1, -1] : [1]) {
      const y = pass > 0 ? yTop : yBot;
      gb.grow(all.length);
      const base = gb.n;
      for (const p of all) gb.vert(p.x, y, p.y, 0, pass, 0, 0, 0, g0, b.h, wb);
      for (const [a, c, d] of tris) {
        // face up (or down for the underside): (c - a) x (d - a) has y = (dz * cx - dx * cz) in x/z terms
        const pa = all[a], pc = all[c], pd = all[d];
        const cross = (pd.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pd.y - pa.y);
        if ((cross > 0) === (pass > 0)) gb.idx.push(base + a, base + c, base + d);
        else gb.idx.push(base + a, base + d, base + c);
      }
    }

    // Collider (polygon; the controllers push circles out of it). Slabs only block at their own height.
    if (!canopy) {
      colliders.push({
        minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ,
        minY: b.base > 0 ? yBot : -Infinity, maxY: yTop, poly: outer, building: b
      });
    }

    if (isTemple) temples.push(b);
    else if ((style === BUILDING_STYLE.walkup || style === BUILDING_STYLE.midrise) && b.area > 45 && b.h < 70 && !b.base) roofSites.push(b);
  }

  let wallTris = 0;
  for (const [key, gb] of chunks) {
    if (!gb.n) continue;
    const mesh = new THREE.Mesh(gb.geometry(), material);
    mesh.name = `Buildings_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    wallTris += gb.idx.length / 3;
    group.add(mesh);
  }

  const roofs = buildRooftops(group, roofSites);
  const templeRoofs = buildTempleRoofs(group, temples);
  console.info(`[buildings] ${BUILDINGS.length} buildings, ${chunks.size} chunks, ${(wallTris / 1e6).toFixed(2)}M triangles, ${roofs.sheds} roof sheds, ${roofs.tanks} water tanks, ${temples.length} temples in ${Math.round(performance.now() - t0)} ms`);

  return {
    group,
    colliders,
    allBlocks: BUILDINGS,
    update() {},
    updateLights() {}
  };
}

// Corrugated steel sheds (the illegal top-floor additions, 頂樓加蓋) in blue, teal, white or rusty steel, stair houses &
// stainless / blue plastic water tanks on the walk-up & mid-rise roofs
function buildRooftops(group, sites) {
  const shedMat = createCorrugatedMetalMaterial();
  const sheds = [];
  const tanks = [];
  const SHED_TINTS = [0x2f6db0, 0x3a8a9a, 0xd8d8d0, 0x5a8a5a, 0x8a9aa6, 0x2a5a8a, 0xb0b8b8, 0x9a5a3a];
  for (const b of sites) {
    const box = orientedBox(b.rings[0]);
    if (!box || box.hx < 2.2 || box.hz < 2.2) continue;
    const r1 = hash(b.cx, b.cz);
    const r2 = hash(b.cz, b.cx + 3.1);
    const r3 = hash(b.cx + 7.7, b.cz - 1.3);
    const roofY = b.ground + b.h;
    const yaw = Math.atan2(box.ux, box.uz); // turns local +z onto the box's u axis
    const walkup = b.h <= 17.5;
    // A shed covering part of the roof, against one end
    if (r1 < (walkup ? 0.72 : 0.3)) {
      const sx = box.hx * (0.55 + r2 * 0.35);
      const sz = box.hz * (0.6 + r3 * 0.3);
      const off = (box.hx - sx) * (r3 < 0.5 ? -1 : 1);
      sheds.push({
        x: box.cx + box.ux * off, z: box.cz + box.uz * off, y: roofY,
        w: sx * 2, d: sz * 2, h: 2.5 + r2 * 0.6, yaw, tint: walkup ? SHED_TINTS[Math.floor(r2 * SHED_TINTS.length)] : 0xc8c4bc
      });
    }
    // 1-3 water tanks on the free end
    const nt = 1 + Math.floor(r3 * Math.min(3, box.hx * box.hz / 20));
    for (let t = 0; t < nt; t++) {
      const along = (r1 < 0.5 ? 1 : -1) * (box.hx - 1.2) * (0.6 + 0.4 * hash(t, b.cx));
      const across = (t - (nt - 1) / 2) * 1.6;
      tanks.push({
        x: box.cx + box.ux * along - box.uz * across, z: box.cz + box.uz * along + box.ux * across, y: roofY + 0.35,
        r: 0.55 + r2 * 0.2, h: 1.3 + r3 * 0.4, kind: hash(t + 3, b.cz) < 0.6 ? 0 : hash(t, b.cz) < 0.7 ? 1 : 2
      });
    }
  }

  // Shed: a unit box (bottom at 0) under a shallow gabled prism, both instanced
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const prism = new THREE.BufferGeometry();
  {
    // ridge along local z at x = 0, eaves at x = ±0.5 (overhang), rise 0.18
    const P = [
      [-0.54, 0, -0.52], [0, 0.18, -0.52], [0, 0.18, 0.52], [-0.54, 0, 0.52],
      [0, 0.18, -0.52], [0.54, 0, -0.52], [0.54, 0, 0.52], [0, 0.18, 0.52],
      [-0.54, 0, -0.52], [0.54, 0, -0.52], [0, 0.18, -0.52],
      [-0.54, 0, 0.52], [0, 0.18, 0.52], [0.54, 0, 0.52]
    ];
    prism.setAttribute('position', new THREE.Float32BufferAttribute(P.flat(), 3));
    prism.setIndex([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12]);
    prism.computeVertexNormals();
  }
  const mk = (geo, list, place) => {
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    const g = geo.clone();
    g.setAttribute('tint', tint);
    const mesh = new THREE.InstancedMesh(g, shedMat, Math.max(1, list.length));
    mesh.count = list.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((s, i) => {
      const [p, sc, col] = place(s);
      mesh.setMatrixAt(i, m.compose(p, q.setFromAxisAngle(up, s.yaw || 0), sc));
      c.setHex(col);
      tint.setXYZ(i, c.r, c.g, c.b);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // the box's local x runs across (w), local z along (d): yaw turns local z onto the roof's long axis
  mk(boxGeo, sheds, (s) => [V(s.x, s.y, s.z), V(s.d, s.h, s.w), s.tint]).name = 'RoofSheds';
  mk(prism, sheds, (s) => [V(s.x, s.y + s.h, s.z), V(s.d, s.d * 0.9, s.w), s.tint]).name = 'RoofShedRoofs';

  // Water tanks: stainless steel (shiny), blue plastic, white plastic
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1).translate(0, 0.5, 0);
  const TANK = [0xd4d9de, 0x2860b4, 0xe8e6e0];
  const tankMat = new THREE.MeshStandardNodeMaterial({ metalness: 0.6, roughness: 0.35 });
  tankMat.colorNode = attribute('tint', 'vec3');
  const tankTint = new THREE.InstancedBufferAttribute(new Float32Array(tanks.length * 3), 3);
  const tg = tankGeo.clone();
  tg.setAttribute('tint', tankTint);
  const tankMesh = new THREE.InstancedMesh(tg, tankMat, Math.max(1, tanks.length));
  tankMesh.count = tanks.length;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  tanks.forEach((t, i) => {
    tankMesh.setMatrixAt(i, m.makeScale(t.r, t.h, t.r).setPosition(t.x, t.y, t.z));
    c.setHex(TANK[t.kind]);
    tankTint.setXYZ(i, c.r, c.g, c.b);
  });
  tankMesh.name = 'WaterTanks';
  tankMesh.castShadow = true;
  tankMesh.receiveShadow = true;
  group.add(tankMesh);
  return { sheds: sheds.length, tanks: tanks.length };
}

// Temple roofs: a hipped roof of glazed orange tile over each temple hall, its ridge sweeping up into swallowtails
// (燕尾) at both ends, eaves overhanging the walls. Built in each hall's oriented box.
function buildTempleRoofs(group, temples) {
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const tile = new THREE.Color(0xd0682a);
  const ridgeCol = new THREE.Color(0x3a8a5a);
  const add = (p, c) => {
    pos.push(p[0], p[1], p[2]);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  for (const b of temples) {
    const box = orientedBox(b.rings[0]);
    if (!box) continue;
    // long axis = u (ux, uz) if hx >= hz
    let { ux, uz, hx, hz } = box;
    if (hz > hx) {
      [ux, uz] = [-uz, ux];
      [hx, hz] = [hz, hx];
    }
    const vx = -uz;
    const vz = ux;
    const over = 0.8;
    const L = hx + over;
    const W = hz + over;
    const y0 = b.ground + b.h - 0.2;
    const rise = Math.min(4.5, hz * 0.75);
    const P = (a, c, y) => [box.cx + ux * a + vx * c, y, box.cz + uz * a + vz * c];
    // eave line curving up at the corners; ridge with swallowtail ends
    const N = 10;
    const ridgeHalf = Math.max(0.3, L - W * 0.6);
    for (const side of [-1, 1]) {
      // long slopes: rows from eave (c = side * W) to ridge (c = 0)
      const rows = 4;
      const base = pos.length / 3;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows; // 0 eave .. 1 ridge
        const c = side * W * (1 - t);
        const yRow = y0 + rise * (1 - Math.pow(1 - t, 1.6));
        for (let i = 0; i <= N; i++) {
          const s = i / N * 2 - 1; // -1..1 along
          const halfLen = L * (1 - t) + ridgeHalf * t;
          const a = s * halfLen;
          const cornerLift = (1 - t) * Math.pow(Math.abs(s), 6) * 0.9;
          const tail = t > 0.99 ? Math.pow(Math.abs(s), 8) * 1.6 : 0;
          add(P(a, c, yRow + cornerLift + tail), r === rows ? ridgeCol : tile);
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < N; i++) {
          const a = base + r * (N + 1) + i;
          const bq = a + N + 1;
          if (side > 0) idx.push(a, a + 1, bq + 1, a, bq + 1, bq);
          else idx.push(a, bq + 1, a + 1, a, bq, bq + 1);
        }
      }
    }
    // hip ends: triangles from the eave corners up to the ridge ends
    for (const end of [-1, 1]) {
      const e0 = add(P(end * L, -W, y0 + 0.9), tile);
      const e1 = add(P(end * L, W, y0 + 0.9), tile);
      const r0 = add(P(end * ridgeHalf, 0, y0 + rise), tile);
      if (end > 0) idx.push(e0, r0, e1);
      else idx.push(e0, e1, r0);
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'TempleRoofs';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

export { buildCityBlocks, orientedBox };
