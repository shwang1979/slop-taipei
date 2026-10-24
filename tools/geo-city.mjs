// tools/geo-city.mjs — buildings, land cover, hills, MRT viaducts, shop signs & districts
import {
  load, log, toWorld, q1, flat, BOUNDS, ringArea, centroid, bbox, rdp, rdpRing, openRing, pointInRing, elementPolygons,
  clipUnion, clipOp, rectPath, polysToPaths, pathsToPolys, bufferLines
} from './geo-common.mjs';

const num = (v) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
};
const hash = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const inBox = (x, z, m = 0) => x > BOUNDS.minX - m && x < BOUNDS.maxX + m && z > BOUNDS.minZ - m && z < BOUNDS.maxZ + m;

// --- Landmarks with hand-built models (js/landmarks.js); OSM buildings under them are left out -------------------------
export const LANDMARKS = {
  taipei101: { name: '台北101', ll: [25.03361, 121.56496], match: /^(台北101|臺北101)$/ },
  cksHall: { name: '中正紀念堂', ll: [25.03464, 121.52182], match: /^中正紀念堂$/ },
  libertyGate: { name: '自由廣場牌樓', ll: [25.03665, 121.51772], match: /^自由廣場門$/ },
  theater: { name: '國家戲劇院', ll: [25.03527, 121.51820], match: /^國家戲劇院$/ },
  concertHall: { name: '國家音樂廳', ll: [25.03705, 121.51925], match: /^國家音樂廳$/ },
  presidential: { name: '總統府', ll: [25.04000, 121.51198], match: /^中華民國總統府$/ },
  sysHall: { name: '國父紀念館', ll: [25.04001, 121.56029], match: /^國父紀念館$/ },
  mainStation: { name: '臺北車站', ll: [25.04772, 121.51711], match: /^臺北車站$/ },
  grandHotel: { name: '圓山大飯店', ll: [25.07883, 121.52624], match: /^(圓山大飯店|臺北圓山大飯店|The Grand Hotel)$/ },
  longshan: { name: '艋舺龍山寺', ll: [25.03728, 121.49988], match: /^艋舺龍山寺$/ },
  redHouse: { name: '西門紅樓', ll: [25.04213, 121.50650], match: /^西門紅樓$/ },
  northGate: { name: '北門', ll: [25.04773, 121.51122], match: /^臺北府城北門$/ },
  eastGate: { name: '東門', ll: [25.03902, 121.51768], match: /^臺北府城東門$/ },
  southGate: { name: '南門', ll: [25.03513, 121.51502], match: /^臺北府城南門$/ },
  smallSouthGate: { name: '小南門', ll: [25.03691, 121.50809], match: /^臺北府城小南門$/ }
};

// Building kinds (facade & roof styles in buildings.js)
export const KIND = { RESIDENTIAL: 0, COMMERCIAL: 1, CIVIC: 2, INDUSTRIAL: 3, TEMPLE: 4, CANOPY: 5, HOUSE: 6, STATION: 7 };
const KIND_OF = {
  apartments: 0, residential: 0, dormitory: 0, terrace: 0,
  commercial: 1, office: 1, retail: 1, hotel: 1, mall: 1, department_store: 1, supermarket: 1,
  school: 2, university: 2, college: 2, hospital: 2, public: 2, government: 2, civic: 2, kindergarten: 2, museum: 2, library: 2, stadium: 2, sports_hall: 2,
  industrial: 3, warehouse: 3, factory: 3, service: 3, garage: 6, garages: 3, parking: 3, construction: 3,
  temple: 4, shrine: 4, church: 2, chapel: 2,
  roof: 5, carport: 5,
  house: 6, detached: 6, hut: 6, shed: 6, outbuilding: 6, kiosk: 6, toilets: 6,
  train_station: 7, transportation: 7
};

export function buildBuildings() {
  const osm = load('osm_buildings.json');
  const out = [];
  const landmarkRings = {};
  let skipped = 0;
  for (const e of osm.elements) {
    const t = e.tags || {};
    // underground malls & stations (站前地下街, 東區地下街, the MRT station boxes) & indoor parts are not above ground;
    // the MRT stations' own buildings are modelled with their viaducts (elevated.js)
    const layer = num(t.layer) || 0;
    if ((layer < 0 && t.location !== 'surface') || /^(underground|indoor)$/.test(t.location || '')) continue;
    if (t.building === 'transportation' && /^捷運.*站/.test(t.name || '')) continue;
    const lm = Object.entries(LANDMARKS).find(([, l]) => t.name && l.match.test(t.name));
    for (const p of elementPolygons(e)) {
      const outer = rdpRing(p.outer, 0.25);
      if (outer.length < 3) continue;
      const area = Math.abs(ringArea(outer));
      const [cx, cz] = centroid(outer);
      if (!inBox(cx, cz)) continue;
      if (lm) {
        const prev = landmarkRings[lm[0]];
        if (!prev || prev.area < area) landmarkRings[lm[0]] = { area, ring: outer, h: num(t.height) };
        continue;
      }
      if (area < 10) {
        skipped++;
        continue;
      }
      const type = (t.building || 'yes').toLowerCase();
      let kind = KIND_OF[type];
      if (kind === undefined) kind = t.amenity === 'place_of_worship' ? KIND.TEMPLE : t.shop || t.office ? KIND.COMMERCIAL : KIND.RESIDENTIAL;
      if (type === 'construction') continue;
      const r = hash(cx, cz);
      let h = num(t.height);
      const levels = num(t['building:levels']);
      const base = num(t.min_height) || (num(t['building:min_level']) ? num(t['building:min_level']) * 3.3 : 0);
      if (!h && levels) h = levels * 3.3 + (kind === KIND.COMMERCIAL ? 1.2 : 0.6);
      if (!h) {
        // Taipei defaults: 4-5 storey 公寓 walk-ups, 7-12 storey 華廈 & offices on the arterials, low sheds & temples
        if (kind === KIND.CANOPY) h = 4.5;
        else if (kind === KIND.HOUSE) h = 3.3 * (1 + Math.floor(r * 2.2));
        else if (kind === KIND.TEMPLE) h = 7 + r * 4;
        else if (kind === KIND.INDUSTRIAL) h = 6 + r * 6;
        else if (kind === KIND.COMMERCIAL) h = 3.3 * (5 + Math.floor(r * 8));
        else if (kind === KIND.CIVIC) h = 3.6 * (3 + Math.floor(r * 3));
        else if (kind === KIND.STATION) h = 12;
        else h = area < 60 ? 3.3 * (1 + Math.floor(r * 3)) : 3.3 * (4 + Math.floor(r * (area > 600 ? 9 : 3))) + 0.6;
      }
      h = Math.max(base + 2.5, Math.min(h, 520));
      // outer counter-clockwise in (x, z), holes clockwise: the right-hand normal (uz, -ux) of every edge points out of the walls
      if (ringArea(outer) < 0) outer.reverse();
      const holes = p.holes.map((hr) => rdpRing(hr, 0.25)).filter((hr) => hr.length >= 3 && Math.abs(ringArea(hr)) > 8);
      for (const hr of holes) if (ringArea(hr) > 0) hr.reverse();
      const rings = [outer, ...holes];
      out.push({ rings, h, base, kind, area, name: t.name || '', cx, cz });
    }
  }
  log(`${out.length} buildings (${skipped} tiny skipped), landmark footprints: ${Object.keys(landmarkRings).join(' ')}`);
  return { buildings: out, landmarkRings };
}

// Compact building records: [h dm, base dm, kind, ring count, (n, x0 dm, z0 dm, dx1, dz1, ...) per ring]
export function encodeBuildings(buildings) {
  const B = [];
  for (const b of buildings) {
    B.push(Math.round(b.h * 10), Math.round(b.base * 10), b.kind, b.rings.length);
    for (const r of b.rings) {
      const o = r;
      B.push(o.length);
      let px = 0;
      let pz = 0;
      o.forEach(([x, z], i) => {
        const ix = Math.round(x * 10);
        const iz = Math.round(z * 10);
        if (i === 0) B.push(ix, iz);
        else B.push(ix - px, iz - pz);
        px = ix;
        pz = iz;
      });
    }
  }
  return B;
}

// --- Land cover ---------------------------------------------------------------------------------------------------------
export function buildAreas(roadPlazas) {
  const osm = load('osm_areas.json');
  const cats = { water: [], park: [], grass: [], forest: [], pitch: [], apron: [], parking: [], plaza: [] };
  const runways = [];
  for (const e of osm.elements) {
    const t = e.tags || {};
    let cat = null;
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'basin' || t.landuse === 'reservoir') cat = 'water';
    else if (/^(park|garden|playground|common|recreation_ground)$/.test(t.leisure || '') || t.landuse === 'recreation_ground') cat = 'park';
    else if (/^(grass|meadow|cemetery)$/.test(t.landuse || '') || t.natural === 'grassland' || t.leisure === 'golf_course') cat = 'grass';
    else if (t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'scrub') cat = 'forest';
    else if (t.leisure === 'pitch' || t.leisure === 'stadium') cat = 'pitch';
    else if (t.aeroway === 'apron') cat = 'apron';
    else if (t.amenity === 'parking') cat = 'parking';
    else if (t.aeroway === 'runway' || t.aeroway === 'taxiway') {
      if (e.type === 'way' && e.geometry) runways.push({ pts: e.geometry.map((g) => toWorld(g.lon, g.lat)), half: t.aeroway === 'runway' ? 30 : 11.5, runway: t.aeroway === 'runway', ref: t.ref || '' });
      continue;
    }
    if (!cat) continue;
    // A closed waterway=river way is a river line, not an area
    if (e.type === 'way' && t.waterway === 'river') continue;
    const polys = elementPolygons(e);
    for (const p of polys) {
      const a = Math.abs(ringArea(p.outer));
      if (a < 25) continue;
      if (cat === 'pitch' && t.sport) p.sport = t.sport;
      cats[cat].push(p);
    }
  }
  for (const r of roadPlazas) cats.plaza.push({ outer: openRing(r), holes: [] });
  const box = [rectPath(BOUNDS.minX - 200, BOUNDS.minZ - 200, BOUNDS.maxX + 200, BOUNDS.maxZ + 200)];
  const out = {};
  const water = clipOp('inter', clipUnion(polysToPaths(cats.water)), box);
  out.water = pathsToPolys(water, 0.8, 20);
  for (const cat of ['park', 'grass', 'forest', 'apron', 'parking', 'plaza']) {
    const u = clipOp('diff', clipOp('inter', clipUnion(polysToPaths(cats[cat])), box), water);
    out[cat] = pathsToPolys(u, cat === 'forest' ? 1.5 : 0.5, 15);
  }
  // pitches stay separate (each is one field / court with its own surface)
  out.pitch = cats.pitch
    .map((p) => ({ outer: rdpRing(p.outer, 0.3), holes: [], sport: p.sport || '' }))
    .filter((p) => inBox(...centroid(p.outer)));
  const airfield = clipOp('inter', clipUnion(bufferLines(runways)), box);
  out.airfield = pathsToPolys(airfield, 0.5, 15);
  out.runways = runways.filter((r) => r.runway).map((r) => flat(r.pts));
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) log(`  ${k}: ${v.length} polygons`);
  return out;
}

// --- Hills: forest close to a known summit rises from its edge (20 m grid, Uint8 metres, sparse 32x32 tiles) -----------
const PEAKS = [
  // [lat, lon, height m, reach m]
  [25.0268, 121.5767, 183, 900], // 象山
  [25.0285, 121.5855, 260, 1000], // 拇指山
  [25.0359, 121.5838, 140, 700], // 虎山
  [25.0215, 121.5835, 230, 900], // 九五峰 / 南港山
  [25.0115, 121.5530, 150, 800], // 福州山
  [25.0175, 121.5640, 170, 900], // 中埔山
  [25.0880, 121.5300, 150, 900], // 劍潭山
  [25.0815, 121.5280, 70, 450], // 圓山
  [25.0905, 121.5560, 190, 1300], // 大直 / 文間山
  [25.0125, 121.5410, 70, 450] // 蟾蜍山
];
export const HILL_RES = 20;
export function buildHills(forest, built) {
  const res = HILL_RES;
  const nx = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / res) + 1;
  const nz = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / res) + 1;
  const fill = (polys, grid) => {
    // even-odd scanline fill of each polygon (outer & holes) at cell centres
    for (const p of polys) {
      const rings = [p.outer, ...p.holes];
      const b = bbox(p.outer);
      const j0 = Math.max(0, Math.floor((b.z0 - BOUNDS.minZ) / res));
      const j1 = Math.min(nz - 1, Math.ceil((b.z1 - BOUNDS.minZ) / res));
      for (let j = j0; j <= j1; j++) {
        const z = BOUNDS.minZ + j * res;
        const xs = [];
        for (const r of rings) {
          for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
            const [xa, za] = r[k];
            const [xb, zb] = r[i];
            if (za > z !== zb > z) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
          }
        }
        xs.sort((a, b2) => a - b2);
        for (let s = 0; s + 1 < xs.length; s += 2) {
          const i0 = Math.max(0, Math.ceil((xs[s] - BOUNDS.minX) / res));
          const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - BOUNDS.minX) / res));
          for (let i = i0; i <= i1; i++) grid[j * nx + i] = 1;
        }
      }
    }
  };
  const forestMask = new Uint8Array(nx * nz);
  const builtMask = new Uint8Array(nx * nz);
  fill(forest, forestMask);
  fill(built, builtMask);
  // chamfer distance (metres) to the nearest cell outside / inside a mask
  const dist = (mask, inside) => {
    const d = new Float32Array(nx * nz);
    const INF = 1e9;
    for (let i = 0; i < d.length; i++) d[i] = (mask[i] === 1) === inside ? INF : 0;
    const a = res;
    const b = res * Math.SQRT2;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!d[k]) continue;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + a);
        if (j > 0) {
          v = Math.min(v, d[k - nx] + a);
          if (i > 0) v = Math.min(v, d[k - nx - 1] + b);
          if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b);
        }
        d[k] = v;
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        if (!d[k]) continue;
        let v = d[k];
        if (i < nx - 1) v = Math.min(v, d[k + 1] + a);
        if (j < nz - 1) {
          v = Math.min(v, d[k + nx] + a);
          if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b);
          if (i > 0) v = Math.min(v, d[k + nx - 1] + b);
        }
        d[k] = v;
      }
    }
    return d;
  };
  const dForest = dist(forestMask, true); // inside forest: distance to its edge
  const dBuilt = dist(builtMask, false); // anywhere: distance to the nearest road / building
  const peaks = PEAKS.map(([lat, lon, h, reach]) => [...toWorld(lon, lat), h, reach]);
  let h = new Float32Array(nx * nz);
  const ss = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!forestMask[k]) continue;
      const x = BOUNDS.minX + i * res;
      const z = BOUNDS.minZ + j * res;
      let env = 0;
      for (const [px, pz, ph, reach] of peaks) env = Math.max(env, ph * ss(reach, 0, Math.hypot(x - px, z - pz)));
      const n = 0.85 + 0.3 * hash(Math.floor(x / 140), Math.floor(z / 140));
      h[k] = Math.min(env, dForest[k] * 0.42 * n) * ss(8, 45, dBuilt[k]);
    }
  }
  // smooth (three box passes)
  for (let pass = 0; pass < 3; pass++) {
    const g = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
            s += h[jj * nx + ii];
            c++;
          }
        }
        g[j * nx + i] = forestMask[j * nx + i] || s > 0 ? s / c : 0;
      }
    }
    // keep the streets flat
    for (let k = 0; k < g.length; k++) if (dBuilt[k] < 6) g[k] = 0;
    h = g;
  }
  const T = 32;
  const tiles = [];
  for (let tj = 0; tj * T < nz; tj++) {
    for (let ti = 0; ti * T < nx; ti++) {
      const buf = new Uint8Array(T * T);
      let any = false;
      for (let j = 0; j < T; j++) {
        for (let i = 0; i < T; i++) {
          const ii = ti * T + i;
          const jj = tj * T + j;
          if (ii >= nx || jj >= nz) continue;
          const v = Math.min(255, Math.round(h[jj * nx + ii]));
          buf[j * T + i] = v;
          if (v > 0) any = true;
        }
      }
      if (any) tiles.push([ti, tj, Buffer.from(buf).toString('base64')]);
    }
  }
  let max = 0;
  for (const v of h) max = Math.max(max, v);
  log(`hills: ${nx}x${nz} @ ${res} m, ${tiles.length} tiles, highest ${max.toFixed(0)} m`);
  return { res, nx, nz, tile: T, x0: q1(BOUNDS.minX), z0: q1(BOUNDS.minZ), tiles };
}

// --- MRT viaducts (文湖線 & the elevated stretches) and their stations --------------------------------------------------
export function buildRail() {
  const osm = load('osm_rail.json');
  const lines = [];
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    const viaduct = t.bridge && t.bridge !== 'no';
    if (!viaduct || (t.tunnel && t.tunnel !== 'no')) continue;
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    if (!pts.some(([x, z]) => inBox(x, z, 50))) continue;
    lines.push({ name: t.name || '', pts: rdp(pts, 0.5) });
  }
  // stations next to a viaduct get an elevated station box
  const stations = [];
  for (const e of load('osm_nodes.json').elements) {
    const t = e.tags || {};
    if (t.railway !== 'station' || t.station !== 'subway' || !t.name) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    let best = null;
    let bd = 60;
    for (const l of lines) {
      for (let i = 1; i < l.pts.length; i++) {
        const [ax, az] = l.pts[i - 1];
        const [bx, bz] = l.pts[i];
        const ux = bx - ax;
        const uz = bz - az;
        const L2 = ux * ux + uz * uz || 1;
        const tt = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / L2));
        const d = Math.hypot(x - ax - tt * ux, z - az - tt * uz);
        if (d < bd) {
          bd = d;
          best = [ax + tt * ux, az + tt * uz, Math.atan2(ux, uz)];
        }
      }
    }
    if (best && !stations.some((s) => s[0] === t.name)) stations.push([t.name, q1(best[0]), q1(best[1]), Math.round(best[2] * 1000) / 1000]);
  }
  log(`MRT: ${lines.length} viaduct ways, ${stations.length} elevated stations`);
  return { viaducts: lines.map((l) => [l.name, flat(l.pts)]), stations };
}

// --- All stations (MRT & rail) for the map and labels --------------------------------------------------------------------
export function buildStations() {
  const seen = new Set();
  const out = [];
  for (const e of load('osm_nodes.json').elements) {
    const t = e.tags || {};
    if (t.railway !== 'station' || !t.name) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    if (!inBox(x, z) || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push([t.name, q1(x), q1(z), t.station === 'subway' ? 1 : 0]);
  }
  return out;
}

// --- Shop & restaurant signs, anchored on the nearest building wall that faces a street ---------------------------------
const SIGN_CATS = [
  ['convenience', /^(convenience)$/], ['food', /^(restaurant|fast_food|food_court|deli|bakery|confectionery)$/],
  ['drink', /^(cafe|beverages|tea|coffee|bar|pub)$/], ['health', /^(pharmacy|chemist|clinic|dentist|doctors|optician|hospital|medical_supply)$/],
  ['bank', /^(bank|lottery|money_lender|pawnbroker)$/], ['beauty', /^(hairdresser|beauty|massage|cosmetics|nail_salon)$/],
  ['hotel', /^(hotel|hostel|guest_house|motel)$/], ['karaoke', /^(karaoke_box|nightclub)$/],
  ['shop', /.*/]
];
export function buildSigns(buildings) {
  const CELL = 30;
  const grid = new Map();
  const gk = (ix, iz) => `${ix},${iz}`;
  buildings.forEach((b, bi) => {
    if (b.kind === KIND.CANOPY || b.h < 6) return;
    const r = b.rings[0];
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const c = r[(i + 1) % r.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 2.5) continue;
      const mx = (a[0] + c[0]) / 2;
      const mz = (a[1] + c[1]) / 2;
      const k = gk(Math.floor(mx / CELL), Math.floor(mz / CELL));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([bi, i]);
    }
  });
  const signs = [];
  const names = [];
  const nameIdx = new Map();
  for (const e of load('osm_nodes.json').elements) {
    const t = e.tags || {};
    const type = t.shop || t.amenity || t.tourism;
    if (!type || !(t.shop || /restaurant|cafe|fast_food|pharmacy|bank|clinic|dentist|karaoke_box|bar|pub/.test(t.amenity || '') || /hotel|hostel|guest_house/.test(t.tourism || ''))) continue;
    if (t.shop === 'vacant') continue;
    const [x, z] = toWorld(e.lon, e.lat);
    if (!inBox(x, z)) continue;
    let best = null;
    let bd = 22;
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const [bi, i] of grid.get(gk(ix + dx, iz + dz)) || []) {
          const r = buildings[bi].rings[0];
          const a = r[i];
          const c = r[(i + 1) % r.length];
          const ux = c[0] - a[0];
          const uz = c[1] - a[1];
          const L = Math.hypot(ux, uz);
          const tt = Math.max(0.15, Math.min(0.85, ((x - a[0]) * ux + (z - a[1]) * uz) / (L * L)));
          const px = a[0] + tt * ux;
          const pz = a[1] + tt * uz;
          const d = Math.hypot(x - px, z - pz);
          if (d < bd) {
            bd = d;
            // ring is counter-clockwise in (x, z) with z south: outward normal = (uz, -ux) / L
            best = [px, pz, Math.atan2(uz / L, -ux / L), bi, L];
          }
        }
      }
    }
    if (!best) continue;
    const cat = SIGN_CATS.findIndex(([, re]) => re.test(type));
    const name = (t.name || t['name:zh'] || '').replace(/\s*\(.*?\)\s*/g, '').trim().slice(0, 10);
    let ni = 0;
    if (name) {
      if (!nameIdx.has(name)) {
        nameIdx.set(name, names.length + 1);
        names.push(name);
      }
      ni = nameIdx.get(name);
    }
    const b = buildings[best[3]];
    signs.push([q1(best[0]), q1(best[1]), Math.round(best[2] * 1000) / 1000, cat, ni, Math.round(Math.min(b.h, 40))]);
  }
  log(`${signs.length} shop signs (${names.length} distinct names)`);
  return { cats: SIGN_CATS.map(([c]) => c), signs, names };
}

// --- Districts (行政區) for the location label ---------------------------------------------------------------------------
export function buildDistricts() {
  const out = [];
  for (const e of load('osm_districts.json').elements) {
    const polys = elementPolygons(e);
    if (!polys.length) continue;
    out.push([e.tags.name, polys.map((p) => flat(rdpRing(p.outer, 12)))]);
  }
  log(`${out.length} districts`);
  return out;
}

// --- Named places (neighbourhoods) & big named buildings for labels ----------------------------------------------------
export function buildPlaces(buildings) {
  const places = [];
  for (const e of load('osm_nodes.json').elements) {
    const t = e.tags || {};
    if (!/^(suburb|quarter|neighbourhood|village|locality)$/.test(t.place || '') || !t.name) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    if (inBox(x, z)) places.push([t.name, q1(x), q1(z), t.place === 'suburb' ? 2 : 1]);
  }
  const named = buildings
    .filter((b) => b.name && (b.area > 900 || b.h > 45))
    .map((b) => [b.name, q1(b.cx), q1(b.cz), Math.round(b.h)]);
  log(`${places.length} places, ${named.length} named buildings`);
  return { places, named };
}

export const pointInPolys = (x, z, polys) => polys.some((p) => pointInRing(x, z, p.outer) && !p.holes.some((h) => pointInRing(x, z, h)));
