// tools/geo-roads.mjs — the street network: OSM highways -> a node/link graph with elevations (viaducts & ramps),
// carriageway & sidewalk surfaces, zebra crossings and signalised junctions
import { load, log, toWorld, q1, rdp, BOUNDS, bufferLines, clipUnion, clipOp, rectPath, pathsToPolys } from './geo-common.mjs';

// Road classes, most to least important; `lw` lane width (m), `lanes` default [two-way, one-way], `sw` sidewalk width
export const CLASSES = [
  { id: 'motorway', lw: 3.5, lanes: [4, 2], sw: 0 },
  { id: 'trunk', lw: 3.4, lanes: [4, 2], sw: 3.5 },
  { id: 'primary', lw: 3.3, lanes: [4, 3], sw: 4.0 },
  { id: 'secondary', lw: 3.2, lanes: [4, 2], sw: 3.5 },
  { id: 'tertiary', lw: 3.1, lanes: [2, 2], sw: 2.5 },
  { id: 'unclassified', lw: 3.0, lanes: [2, 1], sw: 0 },
  { id: 'residential', lw: 3.0, lanes: [2, 1], sw: 0 },
  { id: 'living_street', lw: 2.8, lanes: [1, 1], sw: 0 },
  { id: 'service', lw: 3.0, lanes: [1, 1], sw: 0 },
  { id: 'pedestrian', lw: 3.0, lanes: [2, 2], sw: 0 }
];
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c.id, i]));
export const FLAG = { LINK: 1, BRIDGE: 2, NOCAR: 4 };
const DECK_H = (layer) => 6.0 + Math.max(0, layer - 1) * 6.5; // deck height above the street per OSM layer
const RISE = 0.07; // steepest ramp grade

const num = (v) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
};

export function buildRoads() {
  const osm = load('osm_roads.json');
  const ways = [];
  const plazas = [];
  for (const e of osm.elements) {
    const t = e.tags || {};
    const hw = t.highway.replace(/_link$/, '');
    const cls = CLASS_INDEX.get(hw);
    if (cls === undefined || !e.geometry || e.geometry.length < 2) continue;
    if (t.area === 'yes') {
      plazas.push(e.geometry.map((g) => toWorld(g.lon, g.lat)));
      continue;
    }
    if (hw === 'service' && /parking_aisle|driveway|drive-through|emergency_access/.test(t.service || '')) continue;
    if (/^(private|no)$/.test(t.access || '') && cls >= 5) continue;
    const layer = num(t.layer) || 0;
    if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
    if (layer < 0) continue;
    const link = /_link$/.test(t.highway);
    const bridge = !!t.bridge && t.bridge !== 'no';
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || (hw === 'motorway' && t.oneway !== 'no') ? 1 : t.oneway === '-1' ? -1 : 0;
    const C = CLASSES[cls];
    let lanes = num(t.lanes);
    if (!lanes || lanes < 1) lanes = link ? 1 : C.lanes[oneway ? 1 : 0];
    lanes = Math.min(10, Math.round(lanes));
    let w = num(t.width);
    if (!w || w < 2.5 || w > 45) {
      w = lanes * C.lw;
      if (!oneway && cls >= 2 && cls <= 3 && !link) w += 2.0; // kerbside scooter lanes on the arterials
      if (cls >= 6 && cls <= 8) w = Math.min(w, lanes > 1 ? 6.5 : 4.0);
    }
    if (hw === 'pedestrian') w = Math.max(w, 6);
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    ways.push({
      pts, cls, link, bridge, oneway, lanes, w, layer: bridge ? Math.max(1, layer) : layer,
      name: t.name || t['name:zh'] || '', ref: t.ref || '', nocar: hw === 'pedestrian' || t.motor_vehicle === 'no'
    });
  }
  log(`${ways.length} drivable ways, ${plazas.length} pedestrian plazas`);

  // --- Vertices shared by coordinates (Overpass `out geom` drops node ids; shared nodes have identical coordinates) ---
  const key = (p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const verts = new Map(); // key -> { id, x, z, uses, ground, H, adj: [[vid, d]] }
  const vlist = [];
  const vertex = (p) => {
    const k = key(p);
    let v = verts.get(k);
    if (!v) {
      v = { id: vlist.length, x: p[0], z: p[1], uses: 0, ends: 0, ground: false, H: 0, adj: [] };
      verts.set(k, v);
      vlist.push(v);
    }
    return v;
  };
  for (const w of ways) {
    w.v = w.pts.map(vertex);
    w.v.forEach((v, i) => {
      v.uses++;
      if (i === 0 || i === w.v.length - 1) v.ends++;
      if (!w.bridge) v.ground = true;
      else v.H = Math.max(v.H, DECK_H(w.layer));
      if (i > 0) {
        const u = w.v[i - 1];
        const d = Math.hypot(v.x - u.x, v.z - u.z);
        u.adj.push([v.id, d]);
        v.adj.push([u.id, d]);
      }
    });
  }

  // --- Elevations: rise from the street at most RISE per metre up to each deck's height ------------------------------
  const y = new Float64Array(vlist.length).fill(Infinity);
  const heap = [];
  const push = (id, val) => {
    heap.push([val, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const v of vlist) {
    if (v.ground) {
      y[v.id] = 0;
      push(v.id, 0);
    }
  }
  while (heap.length) {
    const [val, id] = pop();
    if (val > y[id]) continue;
    for (const [nid, d] of vlist[id].adj) {
      const n = vlist[nid];
      if (n.ground) continue;
      const cand = Math.min(n.H, val + d * RISE);
      if (cand < y[nid] - 1e-6) {
        y[nid] = cand;
        push(nid, cand);
      }
    }
  }
  for (const v of vlist) if (!Number.isFinite(y[v.id])) y[v.id] = v.H; // decks that never touch the street
  // ramps meet the deck they climb to: lift deck vertices to within 9 % of their highest neighbour
  for (let it = 0; it < 200; it++) {
    let moved = 0;
    for (const v of vlist) {
      if (v.ground) continue;
      let need = y[v.id];
      for (const [nid, d] of v.adj) need = Math.max(need, y[nid] - d * 0.09);
      if (need > y[v.id] + 0.01) {
        y[v.id] = need;
        moved++;
      }
    }
    if (!moved) break;
  }

  // --- Split the ways into links between junction nodes ----------------------------------------------------------------
  const isNode = (v) => v.ends > 0 || v.uses > 1;
  const nodeId = new Map();
  const nodes = [];
  const nodeOf = (v) => {
    let id = nodeId.get(v.id);
    if (id === undefined) {
      id = nodes.length;
      nodeId.set(v.id, id);
      nodes.push({ x: v.x, z: v.z, y: y[v.id], links: [] });
    }
    return id;
  };
  const names = [];
  const nameIdx = new Map();
  const nameOf = (n) => {
    if (!nameIdx.has(n)) {
      nameIdx.set(n, names.length);
      names.push(n);
    }
    return nameIdx.get(n);
  };
  nameOf('');
  const links = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.v.length; i++) {
      if (!isNode(w.v[i]) && i < w.v.length - 1) continue;
      const seg = w.v.slice(start, i + 1);
      start = i;
      let len = 0;
      for (let k = 1; k < seg.length; k++) len += Math.hypot(seg[k].x - seg[k - 1].x, seg[k].z - seg[k - 1].z);
      if (len < 0.05) continue;
      const pts = seg.map((v) => [v.x, v.z, y[v.id]]);
      // simplify the shape (keeps the elevation profile within 0.3 m too, via RDP on x, z then a check below)
      const simp = rdp(pts, 0.35);
      const a = nodeOf(seg[0]);
      const b = nodeOf(seg[seg.length - 1]);
      const flags = (w.link ? FLAG.LINK : 0) | (Math.max(...pts.map((p) => p[2])) > 0.3 ? FLAG.BRIDGE : 0) | (w.nocar ? FLAG.NOCAR : 0);
      const link = { a, b, name: nameOf(w.name), ref: w.ref, cls: w.cls, w: w.w, lanes: w.lanes, oneway: w.oneway, flags, pts: simp, len };
      links.push(link);
      nodes[a].links.push(links.length - 1);
      nodes[b].links.push(links.length - 1);
    }
  }
  log(`road graph: ${nodes.length} nodes, ${links.length} links, ${links.filter((l) => l.flags & FLAG.BRIDGE).length} elevated, ${names.length} names`);

  // Junction radius: where the kerb lines of the crossing roads meet (markings stop & zebras sit just outside it)
  for (const n of nodes) {
    const ground = n.links.filter((li) => !(links[li].flags & FLAG.BRIDGE) || n.y < 0.3);
    n.r = ground.length >= 3 ? Math.max(...ground.map((li) => links[li].w / 2)) + 0.5 : 0;
  }

  // --- Carriageway & sidewalk surfaces (street level only) ---------------------------------------------------------------
  const groundRuns = (l) => {
    const runs = [];
    let cur = [];
    for (const p of l.pts) {
      if (p[2] < 0.3) cur.push([p[0], p[1]]);
      else {
        if (cur.length > 1) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) runs.push(cur);
    return runs;
  };
  const carLines = [];
  const pedLines = [];
  const walkLines = [];
  for (const l of links) {
    for (const run of groundRuns(l)) {
      if (l.flags & FLAG.NOCAR) pedLines.push({ pts: run, half: l.w / 2 });
      else carLines.push({ pts: run, half: l.w / 2 });
      const sw = CLASSES[l.cls].sw;
      if (sw && !(l.flags & FLAG.LINK)) walkLines.push({ pts: run, half: l.w / 2 + sw });
    }
  }
  const box = [rectPath(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxX, BOUNDS.maxZ)];
  const carPaths = clipOp('inter', clipUnion(bufferLines(carLines)), box);
  const pedPaths = clipOp('diff', clipOp('inter', clipUnion(bufferLines(pedLines)), box), carPaths);
  const allRoad = clipUnion(carPaths.concat(pedPaths));
  const walkPaths = clipOp('diff', clipOp('inter', clipUnion(bufferLines(walkLines)), box), allRoad);
  const carriageway = pathsToPolys(carPaths, 0.2, 2);
  const pedestrian = pathsToPolys(pedPaths, 0.2, 2);
  const sidewalks = pathsToPolys(walkPaths, 0.2, 2);
  log(`surfaces: ${carriageway.length} carriageway, ${pedestrian.length} pedestrian, ${sidewalks.length} sidewalk polygons`);

  // --- Zebra crossings (OSM crossing nodes on the carriageway) & signalised junctions ---------------------------------
  const CELL = 40;
  const segGrid = new Map();
  const gk = (ix, iz) => `${ix},${iz}`;
  links.forEach((l, li) => {
    if (l.flags & (FLAG.BRIDGE | FLAG.NOCAR) || l.cls >= 8) return;
    for (let i = 1; i < l.pts.length; i++) {
      const [ax, az] = l.pts[i - 1];
      const [bx, bz] = l.pts[i];
      for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz++) {
          const k = gk(ix, iz);
          if (!segGrid.has(k)) segGrid.set(k, []);
          segGrid.get(k).push([li, i]);
        }
      }
    }
  });
  const nearestSeg = (x, z, maxD) => {
    let best = null;
    let bd = maxD;
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const [li, i] of segGrid.get(gk(ix + dx, iz + dz)) || []) {
          const l = links[li];
          const [ax, az] = l.pts[i - 1];
          const [bx, bz] = l.pts[i];
          const ux = bx - ax;
          const uz = bz - az;
          const L2 = ux * ux + uz * uz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / L2));
          const d = Math.hypot(x - ax - t * ux, z - az - t * uz);
          if (d < bd) {
            bd = d;
            best = { li, ang: Math.atan2(ux, uz), px: ax + t * ux, pz: az + t * uz, d };
          }
        }
      }
    }
    return best;
  };
  const poi = load('osm_nodes.json').elements;
  const crossings = [];
  const placed = [];
  for (const e of poi) {
    if (e.tags?.highway !== 'crossing' || /no|informal/.test(e.tags.crossing || '')) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    const s = nearestSeg(x, z, 1.5);
    if (!s) continue;
    const l = links[s.li];
    if (l.cls > 6) continue;
    if (placed.some(([px, pz]) => Math.abs(px - s.px) < 5 && Math.abs(pz - s.pz) < 5)) continue;
    placed.push([s.px, s.pz]);
    crossings.push([q1(s.px), q1(s.pz), Math.round(s.ang * 1000) / 1000, q1(l.w)]);
  }
  log(`${crossings.length} zebra crossings`);

  // Signals: snap each OSM signal to its nearest junction node, then group the nodes of one crossroads (dual
  // carriageways map one junction as up to four nodes) into one controller
  const nodeGrid = new Map();
  nodes.forEach((n, i) => {
    if (n.links.length < 3 || n.y > 0.3) return;
    const k = gk(Math.floor(n.x / CELL), Math.floor(n.z / CELL));
    if (!nodeGrid.has(k)) nodeGrid.set(k, []);
    nodeGrid.get(k).push(i);
  });
  const signalNodes = new Set();
  for (const e of poi) {
    if (e.tags?.highway !== 'traffic_signals') continue;
    const [x, z] = toWorld(e.lon, e.lat);
    let best = -1;
    let bd = 18;
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const i of nodeGrid.get(gk(ix + dx, iz + dz)) || []) {
          const d = Math.hypot(nodes[i].x - x, nodes[i].z - z);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) signalNodes.add(best);
  }
  const parent = new Map([...signalNodes].map((i) => [i, i]));
  const find = (i) => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i))), parent.get(i)));
  const sig = [...signalNodes];
  for (let i = 0; i < sig.length; i++) {
    for (let j = i + 1; j < sig.length; j++) {
      const a = nodes[sig[i]];
      const b = nodes[sig[j]];
      if (Math.abs(a.x - b.x) < 45 && Math.abs(a.z - b.z) < 45 && Math.hypot(a.x - b.x, a.z - b.z) < 45) parent.set(find(sig[i]), find(sig[j]));
    }
  }
  const groups = new Map();
  for (const i of sig) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const signals = [...groups.values()].map((g) => {
    const cx = g.reduce((s, i) => s + nodes[i].x, 0) / g.length;
    const cz = g.reduce((s, i) => s + nodes[i].z, 0) / g.length;
    return [q1(cx), q1(cz), g];
  });
  log(`${signals.length} signalised junctions (${signalNodes.size} nodes)`);

  return {
    names,
    nodes,
    links,
    carriageway,
    pedestrian,
    sidewalks,
    crossings,
    signals,
    plazas
  };
}
