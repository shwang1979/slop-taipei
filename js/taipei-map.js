import { GEO } from './taipei-geodata.js';
import {
  BOUNDS, ROAD_LINKS, ROAD_NAMES, CLS, LINK_FLAG, BUILDINGS, DISTRICTS, TAIPEI_LANDMARKS, STATIONS, PLACES, getLocationLabel,
  isTypingInField
} from './city-config.js';

// js/taipei-map.js
// The radar minimap (bottom left) & the full-screen street map ([M]): rivers, parks, the hills, buildings, every street
// (expressways & viaducts in amber, the MRT viaducts in red), district & place names, landmarks & MRT stations, road
// names when zoomed in. Zoomed out it draws a pre-rendered base map (3 m per pixel); zoomed in & on the radar it draws
// the vectors in view. Search streets, landmarks, stations & places; click to teleport.

const BASE_MPP = 3; // base map: metres per pixel
const MIN_ZOOM = 0.06;
const MAX_ZOOM = 6;
const CELL = 100;
const COLORS = {
  land: '#141a21', lot: '#171e26', water: '#1b3a55', park: '#1f3a2a', forest: '#1a3324', grass: '#22402c', pitch: '#26442f',
  sidewalk: '#202832', building: '#2b343f', buildingTall: '#36404c', road: '#4f5966', major: '#7b8592', highway: '#c08a3e',
  mrt: '#d0453a', label: 'rgba(235,240,245,0.86)', district: 'rgba(235,240,245,0.32)', airfield: '#2a2f36'
};
const ROAD_WIDTH_PX = (cls, zoom, w) => Math.max(cls <= CLS.secondary ? 1.6 : cls <= CLS.tertiary ? 1.1 : 0.7, w * zoom);

// Spatial buckets for the vector layers
function bucket(items, bounds) {
  const grid = new Map();
  items.forEach((it, i) => {
    const b = bounds(it);
    for (let ix = Math.floor(b[0] / CELL); ix <= Math.floor(b[2] / CELL); ix++) {
      for (let iz = Math.floor(b[1] / CELL); iz <= Math.floor(b[3] / CELL); iz++) {
        const k = `${ix},${iz}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(i);
      }
    }
  });
  return grid;
}
const ringBounds = (r) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    z0 = Math.min(z0, r[i + 1]);
    z1 = Math.max(z1, r[i + 1]);
  }
  return [x0, z0, x1, z1];
};

const POLY_LAYERS = [
  ['water', COLORS.water], ['park', COLORS.park], ['grass', COLORS.grass], ['forest', COLORS.forest], ['airfield', COLORS.airfield],
  ['apron', COLORS.airfield], ['plaza', COLORS.sidewalk], ['sidewalks', COLORS.sidewalk]
];

class TaipeiMapSystem {
  constructor({ controllerManager, cameraSystem, trafficSystem, onToggle, onTeleport }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.trafficSystem = trafficSystem;
    this.onToggle = onToggle;
    this.onTeleport = onTeleport;
    this.isFullMapOpen = false;
    this.waypoint = null;
    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.25;
    this.isPanning = false;
    this.panPointerId = null;
    this.dragMoved = false;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this.searchLinks = null;
    this.lastMini = { x: Infinity, z: Infinity, h: Infinity };

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    const counts = document.getElementById('fullmap-counts');
    if (counts) counts.textContent = `${ROAD_NAMES.length.toLocaleString('zh-TW')} 條路 · ${BUILDINGS.length.toLocaleString('zh-TW')} 棟建築`;

    // vector layers by cell
    this.polys = POLY_LAYERS.map(([key, col]) => ({ key, col, list: GEO[key] || [] }));
    for (const layer of this.polys) layer.grid = bucket(layer.list, (p) => ringBounds(p[0]));
    this.buildingGrid = bucket(BUILDINGS, (b) => [b.minX, b.minZ, b.maxX, b.maxZ]);
    this.linkGrid = bucket(ROAD_LINKS, (l) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < l.pts.length; i += 3) {
        x0 = Math.min(x0, l.pts[i]);
        x1 = Math.max(x1, l.pts[i]);
        z0 = Math.min(z0, l.pts[i + 2]);
        z1 = Math.max(z1, l.pts[i + 2]);
      }
      return [x0, z0, x1, z1];
    });
    this.mrtLines = GEO.viaducts.map(([, flat]) => flat);

    this.initEvents();
  }

  // --- Drawing -----------------------------------------------------------------------------------------------------------
  // Everything in the view { cx, cz, zoom (px per m), w, h } (rotation-free, north up)
  drawVectors(ctx, view, { buildings = true, detail = 1 } = {}) {
    const { cx, cz, zoom, w, h } = view;
    const X = (x) => (x - cx) * zoom + w / 2;
    const Z = (z) => (z - cz) * zoom + h / 2;
    const x0 = cx - w / 2 / zoom;
    const x1 = cx + w / 2 / zoom;
    const z0 = cz - h / 2 / zoom;
    const z1 = cz + h / 2 / zoom;
    const seen = new Set();
    const cells = (grid, fn) => {
      seen.clear();
      for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
        for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
          for (const i of grid.get(`${ix},${iz}`) || []) {
            if (seen.has(i)) continue;
            seen.add(i);
            fn(i);
          }
        }
      }
    };
    ctx.fillStyle = COLORS.land;
    ctx.fillRect(0, 0, w, h);
    const ring = (r) => {
      for (let i = 0; i < r.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(r[i]), Z(r[i + 1]));
      ctx.closePath();
    };
    for (const layer of this.polys) {
      ctx.beginPath();
      cells(layer.grid, (i) => {
        for (const r of layer.list[i]) ring(r);
      });
      ctx.fillStyle = layer.col;
      ctx.fill('evenodd');
    }
    if (buildings) {
      ctx.beginPath();
      const tall = new Path2D();
      cells(this.buildingGrid, (i) => {
        const b = BUILDINGS[i];
        const r = b.rings[0];
        const target = b.h > 40 ? tall : ctx;
        for (let k = 0; k < r.length; k += 2) (k ? target.lineTo : target.moveTo).call(target, X(r[k]), Z(r[k + 1]));
        target.closePath();
      });
      ctx.fillStyle = COLORS.building;
      ctx.fill();
      ctx.fillStyle = COLORS.buildingTall;
      ctx.fill(tall);
    }
    // streets by class (minor first), elevated on top
    const byStyle = new Map();
    cells(this.linkGrid, (i) => {
      const l = ROAD_LINKS[i];
      if (l.cls > CLS.service + (detail > 0.5 ? 0 : -2)) return;
      const elevated = l.flags & LINK_FLAG.ELEVATED;
      const key = elevated ? 'hw' : l.cls <= CLS.secondary ? 'major' : 'road';
      if (!byStyle.has(key)) byStyle.set(key, []);
      byStyle.get(key).push(l);
    });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const key of ['road', 'major', 'hw']) {
      const list = byStyle.get(key);
      if (!list) continue;
      ctx.strokeStyle = key === 'hw' ? COLORS.highway : key === 'major' ? COLORS.major : COLORS.road;
      for (const l of list) {
        ctx.beginPath();
        for (let i = 0; i < l.pts.length; i += 3) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(l.pts[i]), Z(l.pts[i + 2]));
        ctx.lineWidth = ROAD_WIDTH_PX(l.cls, zoom, l.w * (key === 'hw' ? 0.9 : 1));
        ctx.stroke();
      }
    }
    // MRT viaducts
    ctx.strokeStyle = COLORS.mrt;
    ctx.lineWidth = Math.max(1.2, 3 * zoom);
    ctx.beginPath();
    for (const f of this.mrtLines) for (let i = 0; i < f.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(f[i]), Z(f[i + 1]));
    ctx.stroke();
    // search highlight
    if (this.searchLinks) {
      ctx.strokeStyle = '#ffd34a';
      ctx.lineWidth = Math.max(3, 8 * zoom);
      ctx.beginPath();
      for (const l of this.searchLinks) for (let i = 0; i < l.pts.length; i += 3) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(l.pts[i]), Z(l.pts[i + 2]));
      ctx.stroke();
    }
    return { X, Z, x0, x1, z0, z1 };
  }

  // Base map for the zoomed-out views, rendered once (lazily)
  baseMap() {
    if (this._base) return this._base;
    const w = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / BASE_MPP);
    const h = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / BASE_MPP);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    this.drawVectors(canvas.getContext('2d'), {
      cx: (BOUNDS.minX + BOUNDS.maxX) / 2, cz: (BOUNDS.minZ + BOUNDS.maxZ) / 2, zoom: 1 / BASE_MPP, w, h
    }, { detail: 0.4 });
    this._base = canvas;
    return canvas;
  }

  drawLabels(ctx, view, T, { minimap = false } = {}) {
    const { zoom, w, h } = view;
    const boxes = [];
    const free = (x, y, bw, bh) => {
      if (x < 0 || y < 0 || x + bw > w || y + bh > h) return false;
      for (const b of boxes) if (x < b[0] + b[2] && x + bw > b[0] && y < b[1] + b[3] && y + bh > b[1]) return false;
      boxes.push([x, y, bw, bh]);
      return true;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
    // districts (zoomed out)
    if (!minimap && zoom < 0.5) {
      ctx.font = `700 ${Math.round(15 + zoom * 20)}px ${font}`;
      ctx.fillStyle = COLORS.district;
      for (const d of DISTRICTS) {
        let sx = 0, sz = 0, n = 0;
        for (const r of d.rings) for (let i = 0; i < r.length; i += 2) {
          sx += r[i];
          sz += r[i + 1];
          n++;
        }
        const x = T.X(sx / n);
        const y = T.Z(sz / n);
        const tw = ctx.measureText(d.name).width;
        if (free(x - tw / 2, y - 10, tw, 20)) ctx.fillText(d.name, x, y);
      }
    }
    // road names along the bigger streets (zoomed in)
    if (zoom > 0.45) {
      ctx.font = `600 ${minimap ? 10 : 12}px ${font}`;
      const done = new Set();
      const named = ROAD_LINKS.filter((l) => l.name && l.cls <= (zoom > 1.2 ? CLS.residential : CLS.tertiary) && l.len * zoom > 80);
      for (const l of named) {
        if (done.has(l.name)) continue;
        const i = Math.floor(l.cum.length / 2);
        const j = Math.min(l.cum.length - 1, i + 1);
        const ax = l.pts[(j - 1) * 3], az = l.pts[(j - 1) * 3 + 2], bx = l.pts[j * 3], bz = l.pts[j * 3 + 2];
        const mx = T.X((ax + bx) / 2);
        const my = T.Z((az + bz) / 2);
        if (mx < 0 || my < 0 || mx > w || my > h) continue;
        let ang = Math.atan2(bz - az, bx - ax);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const tw = ctx.measureText(l.name).width;
        if (!free(mx - tw / 2, my - 7, tw, 14)) continue;
        done.add(l.name);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(10,14,18,0.85)';
        ctx.strokeText(l.name, 0, 0);
        ctx.fillStyle = COLORS.label;
        ctx.fillText(l.name, 0, 0);
        ctx.restore();
      }
    }
    // MRT stations
    ctx.font = `700 ${minimap ? 10 : 12}px ${font}`;
    for (const s of STATIONS) {
      const x = T.X(s.x);
      const y = T.Z(s.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.fillStyle = s.mrt ? '#ffffff' : '#c9d1d9';
      ctx.strokeStyle = COLORS.mrt;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, minimap ? 3.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (zoom > 0.12 || minimap) {
        const label = s.name.endsWith('站') ? s.name : `${s.name}站`;
        const tw = ctx.measureText(label).width;
        if (free(x + 6, y - 7, tw, 14)) {
          ctx.textAlign = 'left';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(10,14,18,0.85)';
          ctx.strokeText(label, x + 7, y);
          ctx.fillStyle = '#ffb3a8';
          ctx.fillText(label, x + 7, y);
          ctx.textAlign = 'center';
        }
      }
    }
    // landmarks
    ctx.font = `800 ${minimap ? 11 : 13}px ${font}`;
    for (const l of TAIPEI_LANDMARKS) {
      if (l.r < 60 && zoom < 0.6) continue;
      const x = T.X(l.x);
      const y = T.Z(l.z);
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
      ctx.fillStyle = '#ffc61a';
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 5, y);
      ctx.fill();
      const tw = ctx.measureText(l.name).width;
      if (free(x - tw / 2, y - 22, tw, 14)) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(10,14,18,0.9)';
        ctx.strokeText(l.name, x, y - 14);
        ctx.fillStyle = '#ffe28a';
        ctx.fillText(l.name, x, y - 14);
      }
    }
    // neighbourhood names (zoomed in a bit)
    if (!minimap && zoom > 0.18) {
      ctx.font = `600 12px ${font}`;
      ctx.fillStyle = 'rgba(200,210,220,0.55)';
      for (const p of PLACES) {
        const x = T.X(p.x);
        const y = T.Z(p.z);
        const tw = ctx.measureText(p.name).width;
        if (free(x - tw / 2, y - 7, tw, 14)) ctx.fillText(p.name, x, y);
      }
    }
  }

  drawPlayer(ctx, T, size = 9) {
    const ent = this.controllerManager.getActiveEntity();
    const x = T.X(ent.position.x);
    const y = T.Z(ent.position.z);
    const h = ent.heading;
    // heading: (sin h, cos h) in x/z, z down the screen
    const fx = Math.sin(h);
    const fy = Math.cos(h);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(255,198,26,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, size * 4.5, Math.atan2(fy, fx) - 0.5, Math.atan2(fy, fx) + 0.5);
    ctx.fill();
    ctx.rotate(Math.atan2(fy, fx) + Math.PI / 2);
    ctx.fillStyle = '#ffc61a';
    ctx.strokeStyle = '#111317';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.8);
    ctx.lineTo(0, size * 0.4);
    ctx.lineTo(-size * 0.7, size * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  updateMinimap() {
    const c = this.miniCanvas;
    if (!c || !c.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ent = this.controllerManager.getActiveEntity();
    const p = ent.position;
    const moved = Math.hypot(p.x - this.lastMini.x, p.z - this.lastMini.z) > 1.5 || Math.abs(ent.heading - this.lastMini.h) > 0.03;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    } else if (!moved && this.lastMiniFrame++ % 30) return;
    this.lastMini = { x: p.x, z: p.z, h: ent.heading };
    this.lastMiniFrame = 1;
    const ctx = c.getContext('2d');
    // zoom out with speed & altitude
    const zoom = dpr * (ent.type === 'helicopter' ? Math.max(0.12, 0.9 - p.y / 500) : Math.max(0.55, 1.35 - Math.abs(ent.speed) / 30));
    const view = { cx: p.x, cz: p.z, zoom, w, h };
    const T = this.drawVectors(ctx, view, { buildings: true });
    ctx.save();
    ctx.scale(1, 1);
    this.drawLabels(ctx, { ...view }, T, { minimap: true });
    ctx.restore();
    this.drawPlayer(ctx, T, 8 * dpr);
  }

  fullSize() {
    const c = this.fullCanvas;
    return { w: c ? c.width : window.innerWidth, h: c ? c.height : window.innerHeight };
  }

  screenToWorld(mx, my, w, h) {
    const scale = this.fullCanvas ? this.fullCanvas.width / w : 1;
    return {
      x: this.viewCenterX + (mx * scale - this.fullCanvas.width / 2) / this.viewZoom,
      z: this.viewCenterZ + (my * scale - this.fullCanvas.height / 2) / this.viewZoom
    };
  }

  renderFullMap() {
    if (!this.isFullMapOpen || !this.fullCanvas) return;
    const ctx = this.fullCanvas.getContext('2d');
    const { w, h } = this.fullSize();
    const view = { cx: this.viewCenterX, cz: this.viewCenterZ, zoom: this.viewZoom, w, h };
    let T;
    if (this.viewZoom < 0.5) {
      // the pre-rendered base map, scaled
      const base = this.baseMap();
      ctx.fillStyle = COLORS.land;
      ctx.fillRect(0, 0, w, h);
      const s = this.viewZoom * BASE_MPP;
      const ox = (BOUNDS.minX - this.viewCenterX) * this.viewZoom + w / 2;
      const oz = (BOUNDS.minZ - this.viewCenterZ) * this.viewZoom + h / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(base, ox, oz, base.width * s, base.height * s);
      T = { X: (x) => (x - this.viewCenterX) * this.viewZoom + w / 2, Z: (z) => (z - this.viewCenterZ) * this.viewZoom + h / 2 };
      if (this.searchLinks) {
        ctx.strokeStyle = '#ffd34a';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const l of this.searchLinks) for (let i = 0; i < l.pts.length; i += 3) (i ? ctx.lineTo : ctx.moveTo).call(ctx, T.X(l.pts[i]), T.Z(l.pts[i + 2]));
        ctx.stroke();
      }
    } else {
      T = this.drawVectors(ctx, view);
    }
    // district outlines
    ctx.strokeStyle = 'rgba(200,210,220,0.12)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    for (const d of DISTRICTS) for (const r of d.rings) {
      for (let i = 0; i < r.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, T.X(r[i]), T.Z(r[i + 1]));
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    this.drawLabels(ctx, view, T);
    if (this.waypoint) {
      ctx.fillStyle = '#5ee08f';
      ctx.beginPath();
      ctx.arc(T.X(this.waypoint.x), T.Z(this.waypoint.z), 6, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawPlayer(ctx, T, 11);
    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) this.elPlayerInfo.textContent = `你在 ${getLocationLabel(ent.position.x, ent.position.z).replace(' · ', '　').replace(' & ', '・')}`;
  }

  // --- Interaction -------------------------------------------------------------------------------------------------------
  initEvents() {
    const miniCard = document.getElementById('minimap-card');
    if (miniCard) miniCard.addEventListener('click', () => this.toggleFullMap(true));
    document.getElementById('close-fullmap-btn')?.addEventListener('click', () => this.toggleFullMap(false));
    document.getElementById('map-zoom-in')?.addEventListener('click', () => {
      this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
      this.renderFullMap();
    });
    document.getElementById('map-zoom-out')?.addEventListener('click', () => {
      this.viewZoom = Math.max(MIN_ZOOM, this.viewZoom / 1.45);
      this.renderFullMap();
    });
    document.getElementById('map-center-player')?.addEventListener('click', () => {
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.viewZoom = 1.2;
      this.renderFullMap();
    });
    document.getElementById('map-view-all')?.addEventListener('click', () => this.fitAll());
    if (this.elSearchInput) this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) this.toggleFullMap(false);
      else if (e.code === 'KeyM' && !isTypingInField(e)) this.toggleFullMap(!this.isFullMapOpen);
    });

    const c = this.fullCanvas;
    if (!c) return;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
      e.preventDefault();
      this.panPointerId = e.pointerId;
      c.setPointerCapture(e.pointerId);
      this.isPanning = true;
      this.dragMoved = false;
      this.panStart = { x: e.clientX, y: e.clientY, cx: this.viewCenterX, cz: this.viewCenterZ };
      this.fullCanvasWrap?.classList.add('is-panning');
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.isFullMapOpen) return;
      const rect = c.getBoundingClientRect();
      const scale = c.width / rect.width;
      if (this.isPanning && e.pointerId === this.panPointerId) {
        e.preventDefault();
        const dx = e.clientX - this.panStart.x;
        const dy = e.clientY - this.panStart.y;
        if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
        this.viewCenterX = this.panStart.cx - (dx * scale) / this.viewZoom;
        this.viewCenterZ = this.panStart.cz - (dy * scale) / this.viewZoom;
        this.renderFullMap();
        return;
      }
      if (e.pointerType !== 'mouse') return;
      const p = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      if (this.elHoverInfo) this.elHoverInfo.textContent = `${getLocationLabel(p.x, p.z)} · 點一下傳送到這裡`;
    });
    c.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.panPointerId) return;
      const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
      this.cancelPan();
      if (!clicked || !this.isFullMapOpen) return;
      const rect = c.getBoundingClientRect();
      const p = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      p.x = Math.max(BOUNDS.minX + 30, Math.min(BOUNDS.maxX - 30, p.x));
      p.z = Math.max(BOUNDS.minZ + 30, Math.min(BOUNDS.maxZ - 30, p.z));
      this.waypoint = { x: p.x, z: p.z, name: getLocationLabel(p.x, p.z) };
      if (this.onTeleport) this.onTeleport(p.x, p.z);
      this.renderFullMap();
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      c.addEventListener(type, (e) => {
        if (e.pointerId === this.panPointerId) this.cancelPan();
      });
    }
    window.addEventListener('blur', () => this.cancelPan());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = this.screenToWorld(mx, my, rect.width, rect.height);
      this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      const scale = c.width / rect.width;
      this.viewCenterX = before.x - (mx * scale - c.width / 2) / this.viewZoom;
      this.viewCenterZ = before.z - (my * scale - c.height / 2) / this.viewZoom;
      this.renderFullMap();
    }, { passive: false });
  }

  fitAll() {
    const { w, h } = this.fullSize();
    this.viewCenterX = (BOUNDS.minX + BOUNDS.maxX) / 2;
    this.viewCenterZ = (BOUNDS.minZ + BOUNDS.maxZ) / 2;
    this.viewZoom = Math.max(MIN_ZOOM, Math.min(w / ((BOUNDS.maxX - BOUNDS.minX) * 1.05), h / ((BOUNDS.maxZ - BOUNDS.minZ) * 1.05)));
    this.renderFullMap();
  }

  // Landmarks, MRT stations & places fly the map to them; road names highlight every stretch & frame them
  search(text) {
    const q = String(text || '').trim().replace(/臺/g, '台').toLowerCase();
    this.searchLinks = null;
    if (!q) {
      this.renderFullMap();
      return;
    }
    const norm = (s) => s.replace(/臺/g, '台').toLowerCase();
    const point = TAIPEI_LANDMARKS.find((l) => norm(l.name).includes(q))
      || STATIONS.find((s) => norm(s.name).includes(q.replace(/站$/, '').replace(/^捷運/, '')))
      || PLACES.find((p) => norm(p.name).includes(q));
    const roads = ROAD_NAMES.filter((r) => norm(r.name).includes(q));
    if (roads.length && !point) {
      const names = new Set(roads.map((r) => r.name));
      this.searchLinks = ROAD_LINKS.filter((l) => names.has(l.name));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const l of this.searchLinks) {
        for (let i = 0; i < l.pts.length; i += 3) {
          x0 = Math.min(x0, l.pts[i]);
          x1 = Math.max(x1, l.pts[i]);
          z0 = Math.min(z0, l.pts[i + 2]);
          z1 = Math.max(z1, l.pts[i + 2]);
        }
      }
      const { w, h } = this.fullSize();
      this.viewCenterX = (x0 + x1) / 2;
      this.viewCenterZ = (z0 + z1) / 2;
      this.viewZoom = Math.max(MIN_ZOOM, Math.min(1.6, Math.min(w / ((x1 - x0) * 1.3 + 1), h / ((z1 - z0) * 1.3 + 1))));
    } else if (point) {
      this.viewCenterX = point.x;
      this.viewCenterZ = point.z;
      this.viewZoom = Math.max(this.viewZoom, 1.0);
    }
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    this.fullCanvasWrap?.classList.remove('is-panning');
    if (id !== null && this.fullCanvas?.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) this.cancelPan();
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.viewZoom = 0.6;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const scale = Math.min(dpr, Math.sqrt(6e6 / (w * h)));
    this.fullCanvas.width = Math.round(w * scale);
    this.fullCanvas.height = Math.round(h * scale);
  }

  update() {
    this.updateMinimap();
    if (this.isFullMapOpen && !this.isPanning && (this._fullFrame = (this._fullFrame || 0) + 1) % 15 === 0) this.renderFullMap();
  }
}

export { TaipeiMapSystem };
