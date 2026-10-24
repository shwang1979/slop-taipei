// tools/geo-common.mjs — projection, OSM loading, polygon helpers shared by the geodata build
//
// World frame: 1 unit = 1 m, x = east, z = south (north = -z), y = up. Origin at the centre of the data box (near the
// 忠孝新生 intersection). A local equirectangular projection on the WGS84 ellipsoid: across the 9 x 8 km box its
// distortion stays under a centimetre per 100 m.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ClipperLib from 'clipper-lib';

export const DATA = process.env.GEO_DATA || fileURLToPath(new URL('./data', import.meta.url));
export const BBOX = { south: 25.012, west: 121.492, north: 25.085, east: 121.582 };
export const LAT0 = (BBOX.south + BBOX.north) / 2;
export const LON0 = (BBOX.west + BBOX.east) / 2;
const phi = (LAT0 * Math.PI) / 180;
export const M_LAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

export const toWorld = (lon, lat) => [(lon - LON0) * M_LON, -(lat - LAT0) * M_LAT];
export const toLonLat = (x, z) => [LON0 + x / M_LON, LAT0 - z / M_LAT];
const [X0, Z1] = toWorld(BBOX.west, BBOX.south);
const [X1, Z0] = toWorld(BBOX.east, BBOX.north);
export const BOUNDS = { minX: X0, maxX: X1, minZ: Z0, maxZ: Z1 };

export const log = (...a) => console.log('[geo]', ...a);
export const load = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
export const q1 = (v) => Math.round(v * 10) / 10;
export const flat = (pts) => pts.flatMap(([x, z]) => [q1(x), q1(z)]);

export function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid(r) {
  let x = 0;
  let z = 0;
  for (const p of r) {
    x += p[0];
    z += p[1];
  }
  return [x / r.length, z / r.length];
}

export function bbox(r) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, z0, x1, z1 };
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

// Ramer–Douglas–Peucker on an open polyline (points may carry extra fields after x, z)
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let best = -1;
    let bestD = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist(pts[i], pts[i0], pts[i1]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// RDP on a closed ring (no repeated closing point): split at the point farthest from the first
export function rdpRing(r, eps) {
  if (r.length < 5) return r.slice();
  let far = 0;
  let fd = -1;
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = rdp(r.slice(0, far + 1), eps);
  const b = rdp(r.slice(far).concat([r[0]]), eps);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : r.slice();
}

export function openRing(r) {
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) return r.slice(0, -1);
  return r;
}

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Multipolygon relation (or closed way) -> [{ outer, holes }] in world coordinates, chaining split member ways into
// closed rings
export function elementPolygons(e) {
  const P = (g) => toWorld(g.lon, g.lat);
  if (e.type === 'way') {
    const r = openRing((e.geometry || []).map(P));
    return r.length >= 3 ? [{ outer: r, holes: [] }] : [];
  }
  const chain = (role) => {
    const parts = (e.members || []).filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => m.geometry.map(P));
    const rings = [];
    const close = (a, b) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
    while (parts.length) {
      let ring = parts.shift();
      for (let guard = 0; guard < 5000 && !close(ring[0], ring[ring.length - 1]); guard++) {
        const end = ring[ring.length - 1];
        const i = parts.findIndex((p) => close(p[0], end) || close(p[p.length - 1], end));
        if (i < 0) break;
        const p = parts.splice(i, 1)[0];
        ring = ring.concat(close(p[0], end) ? p.slice(1) : p.reverse().slice(1));
      }
      if (close(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  };
  const outers = chain('outer');
  const inners = chain('inner');
  const polys = outers.map((outer) => ({ outer, holes: [] }));
  for (const h of inners) {
    const [hx, hz] = h[0];
    const owner = polys.find((p) => pointInRing(hx, hz, p.outer));
    if (owner) owner.holes.push(h);
  }
  return polys;
}

// --- Clipper (integer decimetres) ------------------------------------------------------------------------------------
export const CS = 10;
const toPath = (ring) => ring.map(([x, z]) => ({ X: Math.round(x * CS), Y: Math.round(z * CS) }));
const fromPath = (p) => p.map((pt) => [pt.X / CS, pt.Y / CS]);

export function clipUnion(paths) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

export function clipOp(type, subj, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  const t = { union: ClipperLib.ClipType.ctUnion, diff: ClipperLib.ClipType.ctDifference, inter: ClipperLib.ClipType.ctIntersection }[type];
  c.Execute(t, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

// Buffer open polylines (world [x, z] arrays) by their own half-widths; round joins & ends
export function bufferLines(lines) {
  const out = new ClipperLib.Paths();
  const co = new ClipperLib.ClipperOffset(2, 0.25 * CS);
  for (const { pts, half } of lines) {
    co.Clear();
    co.AddPath(toPath(pts), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    const sol = new ClipperLib.Paths();
    co.Execute(sol, half * CS);
    for (const p of sol) out.push(p);
  }
  return out;
}

export function polysToPaths(polys) {
  const out = [];
  for (const p of polys) {
    const o = toPath(p.outer);
    if (ClipperLib.Clipper.Orientation(o) === false) o.reverse();
    out.push(o);
    for (const h of p.holes) {
      const hp = toPath(h);
      if (ClipperLib.Clipper.Orientation(hp) === true) hp.reverse();
      out.push(hp);
    }
  }
  return out;
}

export const rectPath = (x0, z0, x1, z1) => toPath([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);

// Clipper paths (outers & holes mixed, oriented) -> [{ outer, holes }] via a PolyTree, simplified
export function pathsToPolys(paths, eps = 0.3, minArea = 1) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const polys = [];
  const walk = (node) => {
    for (const ch of node.Childs()) {
      if (!ch.IsHole()) {
        const outer = rdpRing(fromPath(ch.Contour()), eps);
        if (Math.abs(ringArea(outer)) >= minArea) {
          const holes = ch.Childs().map((h) => rdpRing(fromPath(h.Contour()), eps)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) >= minArea);
          polys.push({ outer, holes });
        }
        for (const h of ch.Childs()) walk(h);
      }
    }
  };
  walk(tree);
  return polys;
}

export const polyOut = (p) => [flat(p.outer), ...p.holes.map(flat)];

// Cut polygons into square tiles (runtime triangulation stays fast: a few holes per piece instead of thousands)
export function tilePolys(polys, size = 250) {
  const paths = polysToPaths(polys);
  const boxes = paths.map((pth) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const pt of pth) {
      x0 = Math.min(x0, pt.X);
      x1 = Math.max(x1, pt.X);
      z0 = Math.min(z0, pt.Y);
      z1 = Math.max(z1, pt.Y);
    }
    return [x0 / CS, z0 / CS, x1 / CS, z1 / CS];
  });
  const buckets = new Map();
  boxes.forEach(([x0, z0, x1, z1], i) => {
    for (let ix = Math.floor(x0 / size); ix <= Math.floor(x1 / size); ix++) {
      for (let iz = Math.floor(z0 / size); iz <= Math.floor(z1 / size); iz++) {
        const k = `${ix},${iz}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
      }
    }
  });
  const out = [];
  for (const [k, list] of buckets) {
    const [ix, iz] = k.split(',').map(Number);
    const rect = [rectPath(ix * size, iz * size, (ix + 1) * size, (iz + 1) * size)];
    const res = clipOp('inter', list.map((i) => paths[i]), rect);
    if (res.length) for (const p of pathsToPolys(res, 0.05, 0.5)) out.push(p);
  }
  return out;
}
