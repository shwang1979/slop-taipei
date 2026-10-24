import * as THREE from 'three/webgpu';
import { GEO } from './taipei-geodata.js';
import { BOUNDS, SIDEWALK_HEIGHT, WATER_LEVEL, hillHeight } from './city-config.js';
import {
  createRoadSurfaceMaterial, createTaipeiSidewalkMaterial, createCurbMaterial, createLotGroundMaterial, createParkLawnMaterial,
  createForestFloorMaterial, createWaterMaterial, createParkPavingMaterial, createMountainMaterial
} from './tsl-materials.js';

// js/ground.js
// The ground of central Taipei from the generated geography (taipei-geodata.js): bare lots, carriageways, raised
// sidewalks with their kerbs, pedestrian streets & plazas, parks, lawns, sports grounds, the airfield, the rivers
// between their embankments, the forested hills (象山, 劍潭山 ...) and the mountains round the Taipei basin.

const TILE = 250; // polygons arrive cut into 250 m tiles (tools/geo-common.mjs tilePolys): their cut edges get no kerb
const CHUNK = 2000;

const onTileEdge = (ax, az, bx, bz) => {
  const on = (v) => Math.abs(v / TILE - Math.round(v / TILE)) * TILE < 0.06;
  return (on(ax) && on(bx) && Math.abs(ax - bx) < 0.06) || (on(az) && on(bz) && Math.abs(az - bz) < 0.06);
};

const ringArea = (r) => {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
  }
  return a / 2;
};

// Flat polygons [[outer, ...holes], ...] -> chunked meshes at height y (uv.x carries `style` for the paving material)
function flatLayer(group, polys, y, material, name, { style = 0, yAt = null } = {}) {
  const chunks = new Map();
  for (const poly of polys) {
    const outer = poly[0];
    const contour = [];
    for (let i = 0; i < outer.length; i += 2) contour.push(new THREE.Vector2(outer[i], outer[i + 1]));
    const holes = poly.slice(1).map((r) => {
      const h = [];
      for (let i = 0; i < r.length; i += 2) h.push(new THREE.Vector2(r[i], r[i + 1]));
      return h;
    });
    let tris;
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue;
    }
    const all = holes.length ? contour.concat(...holes) : contour;
    let cx = 0;
    let cz = 0;
    for (const p of contour) {
      cx += p.x;
      cz += p.y;
    }
    const key = `${Math.floor(cx / contour.length / CHUNK)},${Math.floor(cz / contour.length / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { pos: [], idx: [] }));
    const base = c.pos.length / 3;
    for (const p of all) c.pos.push(p.x, yAt ? yAt(p.x, p.y) + y : y, p.y);
    for (const [a, b, d] of tris) {
      const pa = all[a], pb = all[b], pd = all[d];
      // face up: (b - a) x (d - a) must have a positive y, i.e. (dz * bx - dx * bz) < 0 in x/z terms
      const cross = (pd.x - pa.x) * (pb.y - pa.y) - (pb.x - pa.x) * (pd.y - pa.y);
      if (cross > 0) c.idx.push(base + a, base + b, base + d);
      else c.idx.push(base + a, base + d, base + b);
    }
  }
  const meshes = [];
  for (const [key, c] of chunks) {
    if (!c.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
    const n = c.pos.length / 3;
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) uv[i * 2] = style;
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(c.idx, 1) : new THREE.Uint16BufferAttribute(c.idx, 1));
    if (yAt) g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material);
    mesh.name = `${name}_${key}`;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

// Vertical strips along polygon edges (kerbs, embankments), skipping the tile cuts; `inward` faces into the polygon
function edgeWalls(group, polys, y0, y1, material, name, { inward = false } = {}) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (const poly of polys) {
    poly.forEach((r, ri) => {
      // outer rings counter-clockwise, holes clockwise in x/z: then (uz, -ux) points out of the polygon's area
      const ccw = ringArea(r) > 0;
      const flip = (ri === 0 ? !ccw : ccw) !== inward;
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[j * 2], bz = r[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.02 || onTileEdge(ax, az, bx, bz)) continue;
        let nx = (bz - az) / L;
        let nz = -(bx - ax) / L;
        let [px, pz, qx, qz] = [ax, az, bx, bz];
        if (flip) {
          nx = -nx;
          nz = -nz;
          [px, pz, qx, qz] = [bx, bz, ax, az];
        }
        const base = pos.length / 3;
        pos.push(px, y0, pz, qx, y0, qz, qx, y1, qz, px, y1, pz);
        for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);
  return mesh;
}

// Sports pitches: flat coloured courts & fields (basketball blue/green, baseball dirt, running tracks red ...)
const SPORT_COLORS = {
  basketball: 0x3d6e8f, tennis: 0x3b7a5a, baseball: 0x9a6a46, soccer: 0x3f7a35, athletics: 0xa8503c, running: 0xa8503c,
  volleyball: 0x2f6a8a, badminton: 0x3a6e6a, table_tennis: 0x4a6a8a, softball: 0x9a6a46, multi: 0x6a8a5a, golf: 0x4a8a3a
};

// Distant mountains round the basin: massifs at their real places [lat, lon, height m, radius m]
const MASSIFS = [
  [25.165, 121.548, 1050, 7000], // 陽明山 七星山
  [25.180, 121.505, 980, 6000], // 大屯山
  [25.137, 121.427, 600, 3600], // 觀音山
  [25.120, 121.600, 520, 5500], // 五指山 / 內湖
  [25.060, 121.640, 420, 5000], // 汐止 / 南港
  [25.020, 121.610, 360, 3200], // 南港山 / 四獸山
  [24.960, 121.565, 480, 6500], // 新店 / 深坑
  [24.930, 121.470, 380, 6500], // 土城 / 中和南勢角
  [25.060, 121.360, 230, 7000], // 林口台地
  [24.880, 121.560, 800, 9000] // 烏來 / 北宜
];

function mountainHeight(x, z) {
  const lon0 = GEO.frame.lon0;
  const lat0 = GEO.frame.lat0;
  let h = 0;
  for (const [lat, lon, H, R] of MASSIFS) {
    const mx = (lon - lon0) * GEO.frame.mLon;
    const mz = -(lat - lat0) * GEO.frame.mLat;
    const d2 = ((x - mx) ** 2 + (z - mz) ** 2) / (R * R);
    h = Math.max(h, H * Math.exp(-d2 * 1.6));
  }
  // ridges & valleys
  const n = Math.sin(x * 0.0021 + Math.sin(z * 0.0013) * 2.0) * 0.5 + Math.sin(z * 0.0027 - x * 0.0009) * 0.35 + Math.sin((x + z) * 0.0061) * 0.15;
  h *= 0.8 + 0.28 * n;
  // flat inside the data box & the basin floor next to it
  const dx = Math.max(BOUNDS.minX - x, 0, x - BOUNDS.maxX);
  const dz = Math.max(BOUNDS.minZ - z, 0, z - BOUNDS.maxZ);
  const out = Math.hypot(dx, dz);
  const ramp = Math.min(1, Math.max(0, (out - 300) / 2500));
  return h * ramp * ramp * (3 - 2 * ramp);
}

function buildMountains(group) {
  const SIZE = 64000;
  const STEP = 400;
  const N = SIZE / STEP;
  const pos = [];
  const col = [];
  const idx = [];
  const vid = new Int32Array((N + 1) * (N + 1)).fill(-1);
  const city = new THREE.Color(0x8b857a);
  const low = new THREE.Color(0x4e6a3a);
  const high = new THREE.Color(0x2f4a2a);
  const top = new THREE.Color(0x56604a);
  const c = new THREE.Color();
  const inside = (x, z) => x > BOUNDS.minX + 150 && x < BOUNDS.maxX - 150 && z > BOUNDS.minZ + 150 && z < BOUNDS.maxZ - 150;
  const vert = (i, j) => {
    const k = j * (N + 1) + i;
    if (vid[k] >= 0) return vid[k];
    const x = -SIZE / 2 + i * STEP;
    const z = -SIZE / 2 + j * STEP;
    const h = mountainHeight(x, z);
    pos.push(x, h - 0.4, z);
    const t = Math.min(1, h / 60);
    c.copy(city).lerp(low, t);
    if (h > 300) c.lerp(high, Math.min(1, (h - 300) / 300));
    if (h > 850) c.lerp(top, Math.min(1, (h - 850) / 200));
    col.push(c.r, c.g, c.b);
    vid[k] = pos.length / 3 - 1;
    return vid[k];
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x0 = -SIZE / 2 + i * STEP;
      const z0 = -SIZE / 2 + j * STEP;
      if (inside(x0, z0) && inside(x0 + STEP, z0 + STEP)) continue;
      const a = vert(i, j), b = vert(i + 1, j), d = vert(i, j + 1), e = vert(i + 1, j + 1);
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, createMountainMaterial());
  mesh.name = 'BasinMountains';
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

// The forested hills inside the data box: a terrain grid over each heightfield tile with any height
function buildHills(group) {
  const H = GEO.hills;
  const pos = [];
  const idx = [];
  const res = H.res;
  for (const [ti, tj] of H.tiles) {
    const base = pos.length / 3;
    const n = H.tile + 1;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = H.x0 + (ti * H.tile + i) * res;
        const z = H.z0 + (tj * H.tile + j) * res;
        pos.push(x, hillHeight(x, z) - 0.06, z);
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, createForestFloorMaterial());
  mesh.name = 'Hills';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);
  return mesh;
}

function buildGround(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiGround';
  scene.add(group);

  flatLayer(group, GEO.ground, -0.03, createLotGroundMaterial(), 'Lots');
  const lawn = createParkLawnMaterial(false);
  flatLayer(group, GEO.park, 0.0, createParkLawnMaterial(true), 'Parks');
  flatLayer(group, GEO.grass, 0.008, lawn, 'Lawns');
  flatLayer(group, GEO.forest, 0.012, createForestFloorMaterial(), 'Woods', { yAt: (x, z) => Math.max(0, hillHeight(x, z) - 0.03) });
  const paving = createParkPavingMaterial();
  flatLayer(group, GEO.plaza, 0.02, paving, 'Plazas', { style: 1 });
  flatLayer(group, GEO.parking, 0.006, createLotGroundMaterial(), 'Parking');
  const road = createRoadSurfaceMaterial();
  flatLayer(group, GEO.carriageway, 0.03, road, 'Carriageway');
  flatLayer(group, GEO.apron, 0.02, road, 'Apron');
  flatLayer(group, GEO.airfield, 0.025, road, 'Runway');
  flatLayer(group, GEO.pedestrian, 0.035, paving, 'PedestrianStreets', { style: 1 });

  // Sports grounds
  const byColor = new Map();
  for (const [sport, ring] of GEO.pitch) {
    const key = SPORT_COLORS[sport.split(';')[0]] ?? 0x5a7a4a;
    if (!byColor.has(key)) byColor.set(key, []);
    byColor.get(key).push([ring]);
  }
  for (const [hex, polys] of byColor) {
    flatLayer(group, polys, 0.04, new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.82 }), 'Pitch');
  }

  // Raised sidewalks with their kerbs
  const sidewalk = createTaipeiSidewalkMaterial();
  flatLayer(group, GEO.sidewalks, SIDEWALK_HEIGHT, sidewalk, 'Sidewalks');
  edgeWalls(group, GEO.sidewalks, 0.0, SIDEWALK_HEIGHT, createCurbMaterial(), 'Kerbs');

  // Rivers & ponds between concrete embankments
  const water = flatLayer(group, GEO.water, WATER_LEVEL, createWaterMaterial(), 'Water');
  for (const m of water) m.receiveShadow = false;
  edgeWalls(group, GEO.water, WATER_LEVEL - 0.6, 0.0, new THREE.MeshStandardNodeMaterial({ color: 0x8a877e, roughness: 0.9 }), 'Embankments', { inward: true });

  buildHills(group);
  buildMountains(group);

  console.info(`[ground] ${group.children.length} meshes in ${Math.round(performance.now() - t0)} ms`);
  return { group };
}

export { buildGround, mountainHeight };
