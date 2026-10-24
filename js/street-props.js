import * as THREE from 'three/webgpu';
import { Fn, attribute, float, vec2, vec3, mix, step, mod, fract, color, uniform, texture, uv, smoothstep, abs, normalLocal } from 'three/tsl';
import { GEO } from './taipei-geodata.js';
import {
  ROAD_LINKS, ROAD_NODES, CLS, LINK_FLAG, SIGNALS, SIGNAL_TIMING, SIGNAL_CYCLE, SIDEWALKS, CARRIAGEWAY, WATER, buildingAt,
  hillHeight, linkPointAt, SIDEWALK_HEIGHT, LITE
} from './city-config.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createTreeField } from './trees.js';
import { cityUniforms } from './tsl-materials.js';
import { buildScooterLowGeometry, createScooterMaterial, SCOOTER_PAINTS } from './scooter-model.js';

// js/street-props.js
// Taipei's street furniture & greenery, placed from the street network & the land cover: street trees along the
// sidewalks & down the boulevard medians, park & hillside woods, street lamps, traffic signals on mast arms with the
// walking green man (小綠人) for the crossings, the shop signs that cover every street front (real shop names from
// OpenStreetMap, vertical 直式招牌 & horizontal 橫式招牌, lit at night) and the rows of parked scooters along the kerbs.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const strHash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};
const SIDEWALK_WIDTH = [0, 3.5, 4.0, 3.5, 2.5];

function ringContains(r, x, z) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const polyContains = (poly, x, z) => ringContains(poly[0], x, z) && !poly.slice(1).some((h) => ringContains(h, x, z));

// Zebra crossings by 20 m cell: trees, lamps & parked scooters keep clear of them
const crossingGrid = new Map();
for (const [x, z] of GEO.crossings) {
  const k = `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  if (!crossingGrid.has(k)) crossingGrid.set(k, []);
  crossingGrid.get(k).push([x, z]);
}
function nearCrossing(x, z, r) {
  const ix = Math.floor(x / 20);
  const iz = Math.floor(z / 20);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const [cx, cz] of crossingGrid.get(`${ix + dx},${iz + dz}`) || []) if (Math.abs(cx - x) < r && Math.abs(cz - z) < r) return true;
    }
  }
  return false;
}

// Walk along both kerbs of the street links: cb(link, x, z, dirX, dirZ, rightX, rightZ, side, s)
function alongKerbs(filter, spacing, cb, { margin = 8 } = {}) {
  const p = {};
  for (const l of ROAD_LINKS) {
    if (!filter(l)) continue;
    const ra = ROAD_NODES[l.a].r + margin;
    const rb = ROAD_NODES[l.b].r + margin;
    for (let s = ra; s < l.len - rb; s += spacing) {
      linkPointAt(l, s, p);
      if (p.y > 0.3) continue;
      const rx = -p.dz;
      const rz = p.dx;
      for (const side of [1, -1]) cb(l, p.x, p.z, p.dx, p.dz, rx * side, rz * side, side, s);
    }
  }
}

// --- Trees ----------------------------------------------------------------------------------------------------------
function treeSites() {
  const rand = mulberry32(2024);
  const sites = [];
  const streetLink = (l) => l.cls <= CLS.tertiary && !(l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.SLIP | LINK_FLAG.NO_CARS)) && l.len > 20;
  // Street trees: the species is the road's (Taipei plants a road with one species: 樟樹, 台灣欒樹, 榕樹 ...)
  alongKerbs(streetLink, LITE ? 30 : 11, (l, x, z, dx, dz, rx, rz) => {
    const sw = SIDEWALK_WIDTH[l.cls] || 2.5;
    const off = l.w / 2 + Math.min(1.1, sw * 0.4);
    const tx = x + rx * off;
    const tz = z + rz * off;
    if (!SIDEWALKS.contains(tx, tz) || buildingAt(tx, tz, 0) || nearCrossing(tx, tz, 5) || buildingAt(tx + rx * 1.2, tz + rz * 1.2)) return;
    const sp = Math.floor(strHash(l.name || String(l.id)) * 3);
    sites.push({ x: tx, y: SIDEWALK_HEIGHT, z: tz, species: sp, scale: 0.75 + rand() * 0.3, tier: 0 });
  }, { margin: 9 });
  // Boulevard medians (仁愛路, 敦化南路 ...): trees between the two one-way carriageways
  for (const l of ROAD_LINKS) {
    if (!l.oneway || l.cls > CLS.secondary || l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.SLIP) || l.len < 30) continue;
    const p = {};
    for (let s = ROAD_NODES[l.a].r + 10; s < l.len - ROAD_NODES[l.b].r - 10; s += 10) {
      linkPointAt(l, s, p);
      // left of the direction of travel
      const lx = p.dz * l.oneway;
      const lz = -p.dx * l.oneway;
      const off = l.w / 2 + 2.2;
      const mx = p.x + lx * off;
      const mz = p.z + lz * off;
      if (CARRIAGEWAY.contains(mx, mz) || SIDEWALKS.contains(mx, mz) || buildingAt(mx, mz, 0)) continue;
      let other = false;
      for (let d = 5; d <= 22; d += 3.5) if (CARRIAGEWAY.contains(p.x + lx * (off + d), p.z + lz * (off + d))) other = true;
      if (!other) continue;
      sites.push({ x: mx, y: 0.15, z: mz, species: 0, scale: 1.05 + rand() * 0.3, tier: 0 });
    }
  }
  const street = sites.length;
  // Parks, lawns & woods, scattered (riverside parks are open lawns: sparse), on the hills at their height
  const scatter = (polys, perM2, tier, scaleRange, maxPer = 4000) => {
    for (const poly of polys) {
      const r = poly[0];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
      for (let i = 0, n = r.length / 2; i < n; i++) {
        x0 = Math.min(x0, r[i * 2]);
        x1 = Math.max(x1, r[i * 2]);
        z0 = Math.min(z0, r[i * 2 + 1]);
        z1 = Math.max(z1, r[i * 2 + 1]);
        const j = (i + 1) % n;
        area += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
      }
      area = Math.abs(area / 2);
      const n = Math.min(maxPer, Math.round(area * perM2(area)));
      for (let k = 0; k < n * 1.6 && k < maxPer * 2; k++) {
        const x = x0 + rand() * (x1 - x0);
        const z = z0 + rand() * (z1 - z0);
        if (!polyContains(poly, x, z)) continue;
        if (CARRIAGEWAY.contains(x, z) || SIDEWALKS.contains(x, z) || WATER.contains(x, z) || buildingAt(x, z, 1.5)) continue;
        sites.push({ x, y: hillHeight(x, z), z, species: Math.floor(rand() * 3), scale: scaleRange[0] + rand() * (scaleRange[1] - scaleRange[0]), tier });
      }
    }
  };
  const k = LITE ? 4 : 1;
  scatter(GEO.park, (a) => (a > 120000 ? 1 / 1400 : 1 / 200) / k, 0, [0.9, 1.35]);
  scatter(GEO.forest, () => 1 / 110 / k, 1, [1.15, 1.7], 5000);
  scatter(GEO.grass, (a) => (a > 50000 ? 1 / 3000 : 1 / 900) / k, 1, [0.8, 1.2]);
  console.info(`[streetProps] ${sites.length} trees (${street} on the streets)`);
  return sites;
}

// --- Street lamps: grey poles with a curved arm over the road, on the main roads every ~30 m --------------------------
function buildLamps(group) {
  const sites = [];
  alongKerbs((l) => l.cls <= CLS.tertiary && !(l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.NO_CARS)) && l.len > 25, 31, (l, x, z, dx, dz, rx, rz, side, s) => {
    if ((Math.floor(s / 31) + (side > 0 ? 0 : 1)) % 2) return; // staggered sides
    const off = l.w / 2 + 0.45;
    const px = x + rx * off;
    const pz = z + rz * off;
    if (buildingAt(px, pz, 0) || nearCrossing(px, pz, 3)) return;
    sites.push({ x: px, z: pz, y: SIDEWALK_HEIGHT, yaw: Math.atan2(-rx, -rz) });
  }, { margin: 6 });
  // pole, arm & head in one mesh (one draw per chunk): `glow` marks the head, lit from below at night
  const parts = [
    [new THREE.CylinderGeometry(0.07, 0.12, 9, 8).translate(0, 4.5, 0), 0],
    [new THREE.BoxGeometry(0.08, 0.08, 2.2).translate(0, 8.8, 1.1), 0],
    [new THREE.BoxGeometry(0.34, 0.14, 0.7).translate(0, 8.75, 2.1), 1]
  ].map(([g, glow]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute('uv');
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(glow), 1));
    return geo;
  });
  const lampGeo = mergeGeometries(parts);
  const lampMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.55 });
  const glow = attribute('glow', 'float');
  lampMat.colorNode = mix(color(0x8a9096), color(0x5a5e62), glow);
  lampMat.emissiveNode = Fn(() => {
    const down = smoothstep(-0.6, -0.9, normalLocal.y);
    return color(0xffd9a0).mul(down.mul(6.0).add(0.2)).mul(glow).mul(smoothstep(0.55, 1.1, cityUniforms.uInteriorGlow));
  })();
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(1, sites.length));
  lamps.count = sites.length;
  lamps.name = 'StreetLamps';
  lamps.userData.cullDistance = 700;
  lamps.castShadow = true;
  lamps.receiveShadow = true;
  group.add(lamps);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  sites.forEach((site, i) => lamps.setMatrixAt(i, m.compose(p.set(site.x, site.y, site.z), q.setFromAxisAngle(up, site.yaw), one)));
  return sites.length;
}

// --- Traffic signals ----------------------------------------------------------------------------------------------------
// Each approach to a signalised junction: a pole at the right kerb before the crossing, a mast arm over the lanes with
// a horizontal head (red, amber, green, left to right) facing the traffic, and a pedestrian head for the crossing.
// The lit lamp is worked out on the GPU from the shared clock & each head's (junction offset, phase).
function signalState(clock, offsetNode, phaseNode) {
  const { green, amber, allRed } = SIGNAL_TIMING;
  const half = green + amber + allRed;
  const t = mod(clock.add(offsetNode), SIGNAL_CYCLE);
  const tt = mod(t.add(phaseNode.mul(half)), SIGNAL_CYCLE);
  const isGreen = step(tt, green);
  const isAmber = step(green, tt).mul(step(tt, green + amber));
  return { tt, isGreen, isAmber, isRed: float(1.0).sub(isGreen).sub(isAmber) };
}

function buildSignals(group, clock) {
  const heads = [];
  const peds = [];
  const audio = [];
  for (const sig of SIGNALS) {
    for (const [li, ni] of sig.approaches) {
      const l = ROAD_LINKS[li];
      if (l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.NO_CARS) || l.cls > CLS.residential) continue;
      const atB = l.b === ni;
      if (l.oneway === 1 && !atB) continue;
      if (l.oneway === -1 && atB) continue;
      const n = ROAD_NODES[ni];
      const d = n.r + 4.0;
      if (l.len < d + 6) continue;
      const p = linkPointAt(l, atB ? l.len - d : d);
      // direction of travel towards the junction & its right
      const dx = atB ? p.dx : -p.dx;
      const dz = atB ? p.dz : -p.dz;
      const rx = -dz;
      const rz = dx;
      const off = l.w / 2 + 0.6;
      const px = p.x + rx * off;
      const pz = p.z + rz * off;
      const phase = sig.phaseOf.get(`${li}:${ni}`) ?? 0;
      const reach = Math.min(off - 1.5, 7.5);
      heads.push({ x: px, z: pz, yaw: Math.atan2(-dx, -dz), reach, arm: Math.atan2(-rx, -rz), offset: sig.offset, phase });
      // the pedestrian head across the road, for walkers crossing this approach (they go with the cross traffic)
      peds.push({ x: px, z: pz, yaw: Math.atan2(-rx, -rz), offset: sig.offset, phase: 1 - phase });
      audio.push({ x: px, y: 2.6, z: pz, signal: sig, phase: 1 - phase });
    }
  }
  const N = heads.length;
  const pole = new THREE.CylinderGeometry(0.1, 0.13, 6.4, 8).translate(0, 3.2, 0);
  const arm = new THREE.BoxGeometry(0.14, 0.14, 1).translate(0, 6.1, 0.5);
  const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.55 });
  const instOffset = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
  const pedInfo = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2);
  // head: 1.5 m wide box, local x across (lamps at x = -0.48, 0, 0.48), facing local +z
  const headGeo = new THREE.BoxGeometry(1.5, 0.48, 0.32);
  headGeo.setAttribute('sig', instOffset);
  const headMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c1e20, roughness: 0.45 });
  headMat.emissiveNode = Fn(() => {
    const info = attribute('sig', 'vec2');
    const s = signalState(clock, info.x, info.y);
    const p = attribute('position', 'vec3');
    const front = step(0.5, normalLocal.z);
    const lamp = (cx) => smoothstep(0.17, 0.13, vec2(p.x.sub(cx), p.y).length());
    const red = lamp(-0.48).mul(s.isRed);
    const amb = lamp(0.0).mul(s.isAmber);
    const grn = lamp(0.48).mul(s.isGreen);
    return color(0xff2a1a).mul(red).add(color(0xffb020).mul(amb)).add(color(0x20ff90).mul(grn)).mul(front).mul(5.0);
  })();
  // the pole with the pedestrian head on it (one mesh): green walking man (bottom) or red standing man (top), the
  // last seconds of the green blinking; `ped` marks the head's vertices
  const PED_Y = 2.55;
  const poleParts = [[pole, 0], [new THREE.BoxGeometry(0.42, 0.75, 0.24).translate(0, PED_Y, 0.16), 1]].map(([g, ped]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute('uv');
    geo.setAttribute('ped', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(ped), 1));
    return geo;
  });
  const pedGeo = mergeGeometries(poleParts);
  pedGeo.setAttribute('sig', pedInfo);
  const pedMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.4 });
  const isPed = attribute('ped', 'float');
  pedMat.colorNode = mix(color(0x9aa0a4), color(0x1c1e20), isPed);
  pedMat.emissiveNode = Fn(() => {
    const info = attribute('sig', 'vec2');
    const s = signalState(clock, info.x, info.y);
    const p = attribute('position', 'vec3').sub(vec3(0, PED_Y, 0));
    const front = step(0.5, normalLocal.z);
    const walk = step(s.tt, SIGNAL_TIMING.walk);
    const blink = step(SIGNAL_TIMING.walk - 6, s.tt).mul(step(0.5, fract(clock.mul(2.0))));
    // a little figure: head & body blobs in the lower (green) or upper (red) panel
    const panelY = mix(float(0.18), float(-0.18), walk);
    const fig = smoothstep(0.06, 0.04, vec2(p.x, p.y.sub(panelY).sub(0.07)).length())
      .add(step(abs(p.x), 0.05).mul(step(abs(p.y.sub(panelY).add(0.05)), 0.09)));
    const green = color(0x30ff90).mul(walk).mul(float(1.0).sub(blink));
    const red = color(0xff3020).mul(float(1.0).sub(walk));
    return green.add(red).mul(fig.min(1.0)).mul(front).mul(isPed).mul(5.0);
  })();
  const mk = (geo, mat, count, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.count = count;
    mesh.name = name;
    mesh.userData.cullDistance = 600;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const arms = mk(arm, poleMat, N, 'SignalArms');
  const headMesh = mk(headGeo, headMat, N, 'SignalHeads');
  const pedMesh = mk(pedGeo, pedMat, N, 'SignalPoles');
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  heads.forEach((h, i) => {
    const y = SIDEWALK_HEIGHT;
    arms.setMatrixAt(i, m.compose(new THREE.Vector3(h.x, y, h.z), q.setFromAxisAngle(up, h.arm), new THREE.Vector3(1, 1, h.reach)));
    const hx = h.x + Math.sin(h.arm) * h.reach;
    const hz = h.z + Math.cos(h.arm) * h.reach;
    headMesh.setMatrixAt(i, m.compose(new THREE.Vector3(hx, y + 5.75, hz), q.setFromAxisAngle(up, h.yaw), one));
    instOffset.setXY(i, h.offset, h.phase);
    const p = peds[i];
    pedMesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, y, p.z), q.setFromAxisAngle(up, p.yaw), one));
    pedInfo.setXY(i, p.offset, p.phase);
  });
  return { count: N, audio };
}

// --- Shop signs -----------------------------------------------------------------------------------------------------------
const GENERIC = {
  convenience: ['便利商店', '超商'],
  food: ['小吃', '牛肉麵', '滷肉飯', '水餃', '便當', '火鍋', '熱炒', '麵店', '早餐', '鹹酥雞', '燒臘', '自助餐'],
  drink: ['手搖飲', '咖啡', '珍珠奶茶', '果汁', '豆花'],
  health: ['藥局', '診所', '牙醫', '眼鏡', '中醫', '藥妝'],
  bank: ['銀行', '彩券', '當舖'],
  beauty: ['髮廊', '美容', '按摩', '美甲'],
  hotel: ['旅館', '大飯店', '旅社', '商旅'],
  karaoke: ['KTV', '卡拉OK'],
  shop: ['服飾', '通訊行', '書局', '五金', '鞋店', '電器', '麵包', '水果', '文具', '寢具', '補習班', '汽機車']
};
const SIGN_STYLES = [
  ['#c8161e', '#ffffff'], ['#ffffff', '#c8161e'], ['#f6c400', '#b0101a'], ['#1450a0', '#ffffff'], ['#0a7a40', '#ffffff'],
  ['#e8601a', '#ffffff'], ['#111111', '#f6d000'], ['#ffffff', '#1450a0'], ['#7a1a8a', '#ffffff'], ['#f2efe6', '#222222']
];
const SLOT_V = [64, 256];
const SLOT_H = [256, 64];
const ATLAS_W = 2048;
const ATLAS_H = 4096;

function buildSignAtlas(texts) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  const font = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif';
  const perRowV = ATLAS_W / SLOT_V[0];
  const perRowH = ATLAS_W / SLOT_H[0];
  texts.forEach((text, i) => {
    const [bg, fg] = SIGN_STYLES[Math.floor(strHash(text) * SIGN_STYLES.length)];
    const chars = [...text];
    // vertical slot (top half): characters stacked
    {
      const x0 = (i % perRowV) * SLOT_V[0];
      const y0 = Math.floor(i / perRowV) * SLOT_V[1];
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y0, SLOT_V[0], SLOT_V[1]);
      ctx.strokeStyle = fg;
      ctx.lineWidth = 3;
      ctx.strokeRect(x0 + 4, y0 + 4, SLOT_V[0] - 8, SLOT_V[1] - 8);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ascii = /^[\x20-\x7e]+$/.test(text);
      if (ascii) {
        ctx.save();
        ctx.translate(x0 + SLOT_V[0] / 2, y0 + SLOT_V[1] / 2);
        ctx.rotate(Math.PI / 2);
        const size = Math.min(44, ((SLOT_V[1] - 24) / Math.max(1, text.length)) * 1.6);
        ctx.font = `900 ${size}px ${font}`;
        ctx.fillText(text, 0, 2);
        ctx.restore();
      } else {
        const n = Math.min(chars.length, 7);
        const size = Math.min(50, (SLOT_V[1] - 20) / n);
        ctx.font = `900 ${size}px ${font}`;
        for (let c = 0; c < n; c++) ctx.fillText(chars[c], x0 + SLOT_V[0] / 2, y0 + 10 + size * (c + 0.5) + ((SLOT_V[1] - 20 - size * n) / 2));
      }
    }
    // horizontal slot (bottom half)
    {
      const x0 = (i % perRowH) * SLOT_H[0];
      const y0 = ATLAS_H / 2 + Math.floor(i / perRowH) * SLOT_H[1];
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y0, SLOT_H[0], SLOT_H[1]);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = Math.min(46, ((SLOT_H[0] - 20) / Math.max(1, chars.length)) * (/^[\x20-\x7e]+$/.test(text) ? 1.7 : 1));
      ctx.font = `900 ${size}px ${font}`;
      ctx.fillText(text, x0 + SLOT_H[0] / 2, y0 + SLOT_H[1] / 2 + 2);
    }
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function slotRect(i, vertical) {
  if (vertical) {
    const perRow = ATLAS_W / SLOT_V[0];
    const x0 = (i % perRow) * SLOT_V[0];
    const y0 = Math.floor(i / perRow) * SLOT_V[1];
    return [x0 / ATLAS_W, 1 - (y0 + SLOT_V[1]) / ATLAS_H, SLOT_V[0] / ATLAS_W, SLOT_V[1] / ATLAS_H];
  }
  const perRow = ATLAS_W / SLOT_H[0];
  const x0 = (i % perRow) * SLOT_H[0];
  const y0 = ATLAS_H / 2 + Math.floor(i / perRow) * SLOT_H[1];
  return [x0 / ATLAS_W, 1 - (y0 + SLOT_H[1]) / ATLAS_H, SLOT_H[0] / ATLAS_W, SLOT_H[1] / ATLAS_H];
}

function createSignMaterial(tex, faceAxis) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.05 });
  const rect = attribute('slot', 'vec4');
  // the lettered faces: the box's ±x faces (vertical signs, read along the street) or its +z face (horizontal ones)
  const onFace = faceAxis === 'x' ? step(0.5, abs(normalLocal.x)) : step(0.5, normalLocal.z);
  const st = rect.xy.add(uv().mul(rect.zw));
  const tcol = texture(tex, st).rgb;
  mat.colorNode = mix(color(0x2a2c2e), tcol, onFace);
  mat.emissiveNode = tcol.mul(onFace).mul(smoothstep(0.45, 1.2, cityUniforms.uInteriorGlow).mul(1.8).add(0.05));
  return mat;
}

function buildSigns(group) {
  // The atlas: the most common real names (chains & franchises first) + generic shop words for the rest
  const counts = new Map();
  for (const s of GEO.signs) if (s[4]) counts.set(s[4], (counts.get(s[4]) || 0) + 1);
  const generic = Object.values(GENERIC).flat();
  const slots = 256; // 32 x 8 vertical slots in the top half, 8 x 32 horizontal ones in the bottom half
  const named = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, slots - generic.length).map(([ni]) => ni);
  const texts = [...generic, ...named.map((ni) => GEO.signNames[ni - 1])];
  const textIndex = new Map(named.map((ni, i) => [ni, generic.length + i]));
  const genericIndex = {};
  let gi = 0;
  for (const [cat, list] of Object.entries(GENERIC)) {
    genericIndex[cat] = list.map(() => gi++);
  }
  const tex = buildSignAtlas(texts);

  const vert = [];
  const horiz = [];
  for (const [x, z, ang, cat, ni, h] of GEO.signs) {
    const r = hash(x, z);
    const catName = GEO.signCats[cat] || 'shop';
    const ti = textIndex.get(ni) ?? genericIndex[catName][Math.floor(r * genericIndex[catName].length)];
    const nx = Math.sin(ang);
    const nz = Math.cos(ang);
    const ground = hillHeight(x, z);
    if (h >= 9 && r < 0.62) {
      const H = Math.min(9, Math.max(2.6, (h - 5) * (0.5 + r * 0.5)));
      const y0 = ground + 3.7 + (h - 5 - H) * hash(z, x) * 0.6;
      vert.push({ x: x + nx * 0.62, z: z + nz * 0.62, y: y0 + H / 2, yaw: ang, w: 0.95, h: H, t: 0.2, ti });
    } else {
      horiz.push({ x: x + nx * 0.12, z: z + nz * 0.12, y: ground + 3.9 + hash(z, x) * 0.6, yaw: ang, w: 3.6 + r * 2.4, h: 1.05, t: 0.16, ti });
    }
  }
  const mk = (list, vertical, name) => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const slot = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    geo.setAttribute('slot', slot);
    const mesh = new THREE.InstancedMesh(geo, createSignMaterial(tex, vertical ? 'x' : 'z'), Math.max(1, list.length));
    mesh.count = list.length;
    mesh.name = name;
    mesh.userData.cullDistance = 800;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((s, i) => {
      // local z = out of the wall (the sign's outward normal), x = along the wall
      const scale = vertical ? new THREE.Vector3(s.t, s.h, s.w) : new THREE.Vector3(s.w, s.h, s.t);
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(s.x, s.y, s.z), q.setFromAxisAngle(up, s.yaw), scale));
      const [u0, v0, du, dv] = slotRect(s.ti, vertical);
      slot.setXYZW(i, u0, v0, du, dv);
    });
    group.add(mesh);
    return mesh;
  };
  mk(vert, true, 'ShopSignsVertical');
  mk(horiz, false, 'ShopSignsHorizontal');
  return { vertical: vert.length, horizontal: horiz.length, names: named.length };
}

// --- Parked scooters: rows along the kerbs of the smaller streets & in the scooter bays of the bigger ones ------------
function buildParkedScooters(group) {
  const rand = mulberry32(77);
  const list = [];
  alongKerbs((l) => l.cls >= CLS.secondary && l.cls <= CLS.residential && !(l.flags & (LINK_FLAG.ELEVATED | LINK_FLAG.NO_CARS | LINK_FLAG.SLIP)) && l.len > 25 && l.w >= 6, 45, (l, x, z, dx, dz, rx, rz, side, s) => {
    if (rand() > (LITE ? 0.06 : 0.2)) return;
    const n = 3 + Math.floor(rand() * 9);
    const off = l.w / 2 - 0.95;
    const rear = rand() < 0.6; // rear wheel to the kerb
    for (let k = 0; k < n; k++) {
      const a = (k - n / 2) * 0.74;
      const px = x + dx * a + rx * off;
      const pz = z + dz * a + rz * off;
      if (nearCrossing(px, pz, 4) || !CARRIAGEWAY.contains(px, pz) || buildingAt(px, pz, 0)) continue;
      // facing out of the kerb (rear to the kerb) or into it, a little askew
      const fx = rear ? -rx : rx;
      const fz = rear ? -rz : rz;
      list.push({ x: px, z: pz, yaw: Math.atan2(fx, fz) + (rand() - 0.5) * 0.25, tint: SCOOTER_PAINTS[Math.floor(rand() * SCOOTER_PAINTS.length)] });
    }
  }, { margin: 10 });
  const geo = buildScooterLowGeometry().clone();
  const tint = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
  geo.setAttribute('tint', tint);
  const mesh = new THREE.InstancedMesh(geo, createScooterMaterial({ instanced: true }), Math.max(1, list.length));
  mesh.count = list.length;
  mesh.name = 'ParkedScooters';
  mesh.userData.cullDistance = 380;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  list.forEach((s, i) => {
    mesh.setMatrixAt(i, m.compose(new THREE.Vector3(s.x, 0.03, s.z), q.setFromAxisAngle(up, s.yaw), one));
    c.setHex(s.tint);
    tint.setXYZW(i, c.r, c.g, c.b, 0);
  });
  group.add(mesh);
  return list.length;
}

function buildStreetProps(scene, skip = new Set()) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'TaipeiStreetProps';
  scene.add(group);
  const signalClock = uniform(0);

  const trees = skip.has('trees') ? null : createTreeField(scene, treeSites());
  const lamps = skip.has('lamps') ? 0 : buildLamps(group);
  const signals = skip.has('signals') ? { count: 0, audio: [] } : buildSignals(group, signalClock);
  const signs = skip.has('signs') ? { vertical: 0, horizontal: 0, names: 0 } : buildSigns(group);
  const parked = skip.has('parked') ? 0 : buildParkedScooters(group);
  console.info(`[streetProps] ${lamps} lamps, ${signals.count} signal heads, ${signs.vertical + signs.horizontal} shop signs (${signs.names} real names in the atlas), ${parked} parked scooters in ${Math.round(performance.now() - t0)} ms`);

  return {
    group,
    trees,
    colliders: [],
    audioSignals: signals.audio,
    signalClock,
    update(dt, elapsed) {
      signalClock.value = elapsed;
    }
  };
}

export { buildStreetProps, treeSites, alongKerbs, mulberry32 };
