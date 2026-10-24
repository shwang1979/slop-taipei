// tools/build-geodata.mjs — writes js/taipei-geodata.js from the OpenStreetMap extracts in tools/data
// usage: node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
// (fetch the extracts first: tools/fetch-osm.sh; npm install in tools/ for clipper-lib)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, q1, flat, toWorld, LAT0, LON0, M_LAT, M_LON, BOUNDS, BBOX, polyOut, tilePolys, clipOp, rectPath, polysToPaths, pathsToPolys } from './geo-common.mjs';
import { buildRoads, CLASSES } from './geo-roads.mjs';
import {
  buildBuildings, encodeBuildings, buildAreas, buildHills, buildRail, buildStations, buildSigns, buildDistricts, buildPlaces,
  LANDMARKS, KIND
} from './geo-city.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/taipei-geodata.js', import.meta.url));
const t0 = Date.now();

const roads = buildRoads();
const { buildings, landmarkRings } = buildBuildings();
const areas = buildAreas(roads.plazas);
const hills = buildHills(areas.forest, [...roads.carriageway, ...roads.sidewalks, ...buildings.map((b) => ({ outer: b.rings[0], holes: [] }))]);
const rail = buildRail();
const signs = buildSigns(buildings);
const { places, named } = buildPlaces(buildings);

// Landmarks: model anchor (the real coordinates) and the OSM footprint when there is one
const landmarks = Object.fromEntries(Object.entries(LANDMARKS).map(([id, l]) => {
  const [x, z] = toWorld(l.ll[1], l.ll[0]);
  const fp = landmarkRings[id];
  return [id, { name: l.name, x: q1(x), z: q1(z), ring: fp ? flat(fp.ring) : null, h: fp?.h ?? null }];
}));
// buildings under a hand-built landmark model (the Grand Hotel has no OSM building; 101's mall podium is modelled)
const clearRadius = { grandHotel: 70, taipei101: 0, libertyGate: 0 };
const keep = buildings.filter((b) => !Object.entries(clearRadius).some(([id, r]) => r && Math.hypot(b.cx - landmarks[id].x, b.cz - landmarks[id].z) < r));

const TELEPORTS = [
  // [id, name, subtitle, lat, lon, heading (rad, 0 = south, π/2 = east), road to stand on]
  ['taipei101', '台北101', '信義路五段 · 信義區', 25.03310, 121.56250, Math.PI * 0.5, '信義路五段'],
  ['station', '臺北車站', '忠孝西路 · 中正區', 25.04625, 121.51690, Math.PI * 0.5, '忠孝西路'],
  ['ximen', '西門町', '中華路 · 萬華區', 25.04300, 121.50780, Math.PI, '中華路一段'],
  ['cks', '中正紀念堂', '中山南路 · 中正區', 25.03600, 121.51850, Math.PI, '中山南路'],
  ['presidential', '總統府', '凱達格蘭大道 · 中正區', 25.04003, 121.51480, -Math.PI * 0.5, '凱達格蘭大道'],
  ['sys', '國父紀念館', '仁愛路四段 · 信義區', 25.03860, 121.55850, -Math.PI * 0.5, '仁愛路四段'],
  ['daan', '大安森林公園', '新生南路 · 大安區', 25.03000, 121.53300, Math.PI, '新生南路'],
  ['dongqu', '東區 · 忠孝敦化', '忠孝東路四段 · 大安區', 25.04150, 121.55000, Math.PI * 0.5, '忠孝東路四段'],
  ['longshan', '艋舺龍山寺', '廣州街 · 萬華區', 25.03650, 121.50000, -Math.PI * 0.5, '廣州街'],
  ['grandhotel', '圓山大飯店', '中山北路 · 中山區', 25.07580, 121.52280, Math.PI, '中山北路'],
  ['songshan', '松山機場', '敦化北路 · 松山區', 25.06100, 121.54980, Math.PI, '敦化北路'],
  ['dome', '臺北小巨蛋', '南京東路四段 · 松山區', 25.05200, 121.55000, Math.PI * 0.5, '南京東路四段'],
  ['huashan', '華山1914', '八德路一段 · 中正區', 25.04400, 121.52900, Math.PI * 0.5, '八德路'],
  ['gongguan', '公館 · 臺大', '羅斯福路四段 · 中正區', 25.01500, 121.53300, Math.PI, '羅斯福路']
].map(([id, name, sub, lat, lon, heading, road]) => {
  const [x, z] = toWorld(lon, lat);
  return { id, name, sub, x: q1(x), z: q1(z), heading: Math.round(heading * 1000) / 1000, road };
});

// Bare ground: the data box (plus a margin) minus the rivers & ponds
const ground = tilePolys(pathsToPolys(clipOp('diff', [rectPath(BOUNDS.minX - 200, BOUNDS.minZ - 200, BOUNDS.maxX + 200, BOUNDS.maxZ + 200)], polysToPaths(areas.water)), 0.5, 1));
log(`ground: ${ground.length} tiles`);

const GEO = {
  version: 1,
  frame: { lat0: LAT0, lon0: LON0, mLat: q1(M_LAT * 10) / 10, mLon: q1(M_LON * 10) / 10, bbox: BBOX, units: 'm', origin: 'data box centre (near 忠孝新生)' },
  bounds: { minX: q1(BOUNDS.minX), maxX: q1(BOUNDS.maxX), minZ: q1(BOUNDS.minZ), maxZ: q1(BOUNDS.maxZ) },
  roadClasses: CLASSES.map((c) => c.id),
  names: roads.names,
  // nodes [x, z, y, junction radius, ...]
  nodes: roads.nodes.flatMap((n) => [q1(n.x), q1(n.z), q1(n.y), q1(n.r)]),
  // links [node a, node b, name index, class, carriageway width, lanes, oneway (1 a->b, -1 b->a, 0 both), flags
  // (1 slip road, 2 elevated, 4 no cars), shape from a to b inclusive: [x, z, y, ...] when elevated, else [x, z, ...]]
  links: roads.links.map((l) => [l.a, l.b, l.name, l.cls, q1(l.w), l.lanes, l.oneway, l.flags,
    l.pts.flatMap(([x, z, y]) => (l.flags & 2 ? [q1(x), q1(z), q1(y)] : [q1(x), q1(z)]))]),
  carriageway: tilePolys(roads.carriageway).map(polyOut),
  pedestrian: tilePolys(roads.pedestrian).map(polyOut),
  sidewalks: tilePolys(roads.sidewalks).map(polyOut),
  crossings: roads.crossings,
  signals: roads.signals,
  water: tilePolys(areas.water).map(polyOut),
  ground: ground.map(polyOut),
  park: tilePolys(areas.park).map(polyOut),
  grass: tilePolys(areas.grass).map(polyOut),
  forest: tilePolys(areas.forest).map(polyOut),
  pitch: areas.pitch.map((p) => [p.sport, flat(p.outer)]),
  apron: tilePolys(areas.apron).map(polyOut),
  airfield: tilePolys(areas.airfield).map(polyOut),
  runways: areas.runways,
  parking: tilePolys(areas.parking).map(polyOut),
  plaza: tilePolys(areas.plaza).map(polyOut),
  hills,
  buildingKinds: Object.keys(KIND),
  buildings: encodeBuildings(keep),
  landmarks,
  viaducts: rail.viaducts,
  mrtStations: rail.stations,
  stations: buildStations(),
  signCats: signs.cats,
  signs: signs.signs,
  signNames: signs.names,
  districts: buildDistricts(),
  places,
  namedBuildings: named,
  teleports: TELEPORTS
};

const json = JSON.stringify(GEO);
const header = `// js/taipei-geodata.js — GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Real Taipei geography in the simulation's world frame: 1 unit = 1 m, x = east, z = south (north = -z), y = up,
// origin at the centre of the data box (${LAT0.toFixed(4)}°N ${LON0.toFixed(4)}°E). Polygons & polylines are flat
// [x0, z0, x1, z1, ...] arrays; polygons are [outer, ...holes].
// Source: © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
