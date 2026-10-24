import * as THREE from 'three/webgpu';
import { GEO } from './taipei-geodata.js';
import { ROAD_LINKS, ROAD_NODES, CLS, LINK_FLAG, SIGNALS } from './city-config.js';
import { createRoadPaintMaterial } from './tsl-materials.js';

// js/road-paint.js
// Road markings painted from the street network, the way Taiwan marks its roads: double yellow centre lines on the
// two-way arterials (分向限制線), a dashed yellow one on smaller two-way streets, white dashed lane lines, solid
// edge lines, zebra crossings where OpenStreetMap has them, stop lines & scooter waiting boxes (機車停等區) at the
// signalised junctions. Strips for createRoadPaintMaterial: `paint` = (metres along, dash period, duty), `side` = the
// vertex's offset from the strip's centre line (the material widens strips thinner than a pixel and fades them).

const CHUNK = 1000;
const LIFT = 0.055; // above the asphalt (0.03)
const WHITE = new THREE.Color(0xf2f2ee);
const YELLOW = new THREE.Color(0xf0b81e);

class PaintBuilder {
  constructor() {
    this.chunks = new Map();
  }

  chunk(x, z) {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { pos: [], col: [], paint: [], side: [], idx: [] }));
    return c;
  }

  // Strip along polyline pts ([x, y, z] per point) offset `off` to its right, half-width hw; dashes of `period`
  // metres on for `duty` of each
  strip(pts, off, hw, col, period = 1, duty = 1, s0 = 0) {
    if (pts.length < 2) return;
    const mid = pts[pts.length >> 1];
    const c = this.chunk(mid[0], mid[2]);
    const base = c.pos.length / 3;
    let s = s0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dz = b[2] - a[2];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L;
      dz /= L;
      // right of the direction of travel: (-dz, dx)
      const rx = -dz;
      const rz = dx;
      if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[2] - pts[i - 1][2]);
      for (const sgn of [-1, 1]) {
        const o = off + sgn * hw;
        c.pos.push(p[0] + rx * o, p[1] + LIFT, p[2] + rz * o);
        c.col.push(col.r, col.g, col.b);
        c.paint.push(s, period, duty);
        c.side.push(rx * sgn * hw, rz * sgn * hw);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const k = base + i * 2;
      c.idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
  }

  meshes(group, material) {
    for (const [key, c] of this.chunks) {
      if (!c.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      const n = c.pos.length / 3;
      const nor = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) nor[i * 3 + 1] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
      g.setAttribute('paint', new THREE.Float32BufferAttribute(c.paint, 3));
      g.setAttribute('side', new THREE.Float32BufferAttribute(c.side, 2));
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(c.idx, 1) : new THREE.Uint16BufferAttribute(c.idx, 1));
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `RoadPaint_${key}`;
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      group.add(mesh);
    }
  }
}

// The link's polyline between s0 & s1 (metres from its start) as [x, y, z] points
function slice(link, s0, s1) {
  const { pts, cum } = link;
  const out = [];
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [0, 1, 2].map((k) => pts[(i - 1) * 3 + k] + (pts[i * 3 + k] - pts[(i - 1) * 3 + k]) * t);
  };
  out.push(at(s0));
  for (let i = 1; i < cum.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]);
  out.push(at(s1));
  return out;
}

function buildRoadPaint(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiRoadPaint';
  scene.add(group);
  const paint = new PaintBuilder();
  const junction = (n) => (n.links.length >= 3 ? n.r + 3.5 : 0.5);

  for (const l of ROAD_LINKS) {
    if (l.flags & LINK_FLAG.NO_CARS || l.cls >= CLS.living_street) continue;
    const major = l.cls <= CLS.secondary;
    const marked = major || l.cls === CLS.tertiary || (l.lanes >= 2 && l.w >= 7);
    if (!marked) continue;
    const s0 = junction(ROAD_NODES[l.a]);
    const s1 = l.len - junction(ROAD_NODES[l.b]);
    if (s1 - s0 < 3) continue;
    const pts = slice(l, s0, s1);
    const half = l.w / 2;
    if (l.oneway) {
      const lw = l.w / l.lanes;
      for (let k = 1; k < l.lanes; k++) paint.strip(pts, -half + k * lw, 0.075, WHITE, 10, 0.4);
      if (major || l.flags & LINK_FLAG.SLIP) {
        paint.strip(pts, -half + 0.35, 0.075, l.flags & LINK_FLAG.ELEVATED ? YELLOW : WHITE);
        paint.strip(pts, half - 0.35, 0.075, WHITE);
      }
    } else {
      const perDir = Math.max(1, Math.floor(l.lanes / 2));
      if (major) {
        // double yellow centre line
        paint.strip(pts, -0.13, 0.075, YELLOW);
        paint.strip(pts, 0.13, 0.075, YELLOW);
      } else {
        paint.strip(pts, 0, 0.075, YELLOW, 6, 0.5);
      }
      const lw = (half - (major ? 1.2 : 0)) / perDir;
      for (let k = 1; k < perDir; k++) {
        paint.strip(pts, k * lw, 0.075, WHITE, 10, 0.4);
        paint.strip(pts, -k * lw, 0.075, WHITE, 10, 0.4);
      }
      if (major) {
        // the kerbside scooter / slow lane line
        paint.strip(pts, half - 1.2, 0.07, WHITE);
        paint.strip(pts, -(half - 1.2), 0.07, WHITE);
      }
    }
  }

  // Zebra crossings: bars 3 m long (along the road) every 0.8 m across it
  for (const [x, z, ang, w] of GEO.crossings) {
    const ax = Math.cos(ang);
    const az = -Math.sin(ang); // across the road (perpendicular to its direction (sin, cos))
    const h = w / 2 + 0.3;
    paint.strip([[x - ax * h, 0, z - az * h], [x + ax * h, 0, z + az * h]], 0, 1.5, WHITE, 0.9, 0.5);
  }

  // Stop lines & scooter waiting boxes on every approach to a signalised junction
  for (const sig of SIGNALS) {
    for (const [li, ni] of sig.approaches) {
      const l = ROAD_LINKS[li];
      if (l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.NO_CARS) || l.cls > CLS.tertiary) continue;
      const atB = l.b === ni;
      // traffic towards the junction: one-way links only in their direction
      if (l.oneway === 1 && !atB) continue;
      if (l.oneway === -1 && atB) continue;
      const n = ROAD_NODES[ni];
      const d = n.r + 4.5; // behind the zebra
      if (l.len < d + 8) continue;
      const s = atB ? l.len - d : d;
      const p = slice(l, Math.max(0, s - 0.2), Math.min(l.len, s + 0.2));
      const c = p[0];
      const e = p[p.length - 1];
      let dx = e[0] - c[0];
      let dz = e[2] - c[2];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L;
      dz /= L;
      if (!atB) {
        dx = -dx;
        dz = -dz;
      }
      // the approaching half of the carriageway: right of the direction of travel (towards the junction)
      const rx = -dz;
      const rz = dx;
      const from = l.oneway ? -l.w / 2 : 0;
      const to = l.w / 2;
      const P = (o, back) => [c[0] + rx * o - dx * back, c[1], c[2] + rz * o - dz * back];
      paint.strip([P(from, 0), P(to, 0)], 0, 0.2, WHITE);
      if (l.w >= 9) {
        // 機車停等區: a box ahead of the cars' stop line (3 m back from the scooters' line)
        const bf = from + (to - from) * 0.15;
        paint.strip([P(bf, 3.2), P(to, 3.2)], 0, 0.12, WHITE);
        paint.strip([P(bf, 0), P(bf, 3.2)], 0, 0.08, WHITE);
      }
    }
  }

  paint.meshes(group, createRoadPaintMaterial());
  console.info(`[roadPaint] ${group.children.length} chunks in ${Math.round(performance.now() - t0)} ms`);
  return group;
}

export { buildRoadPaint };
