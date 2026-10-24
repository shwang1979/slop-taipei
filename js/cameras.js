import * as THREE from 'three/webgpu';
import { GEO } from './taipei-geodata.js';
import { hillHeight } from './city-config.js';

// js/cameras.js
// Multi-camera system supporting Third-Person Chase (with mouse/touch orbit + zoom),
// Low-Angle Action Cam, POV/Cockpit Cam, scenic Taipei vantage points, and Auto-Director Drone.

const CAMERA_PRESETS = [
  { id: 'chase',        name: '第三人稱追蹤',       short: '追蹤',   category: 'follow', fov: 56 },
  { id: 'action',       name: '低角度動作',         short: '動作',   category: 'follow', fov: 60 },
  { id: 'pov',          name: '第一人稱 / 駕駛座',   short: '第一人稱', category: 'follow', fov: 68 },
  { id: 'elephant',     name: '象山看台北101',      short: '象山',   category: 'scenic', fov: 46 },
  { id: 'observatory',  name: '台北101 觀景台',     short: '101觀景台', category: 'scenic', fov: 54 },
  { id: 'zhongxiao',    name: '忠孝東路 東區',      short: '忠孝東路', category: 'scenic', fov: 52 },
  { id: 'cks',          name: '自由廣場 · 中正紀念堂', short: '自由廣場', category: 'scenic', fov: 50 },
  { id: 'presidential', name: '凱達格蘭大道 · 總統府', short: '總統府', category: 'scenic', fov: 50 },
  { id: 'ximen',        name: '西門町',            short: '西門町', category: 'scenic', fov: 58 },
  { id: 'river',        name: '淡水河 · 大稻埕',    short: '淡水河', category: 'scenic', fov: 48 },
  { id: 'grandHotel',   name: '基隆河 · 圓山大飯店', short: '圓山',   category: 'scenic', fov: 46 },
  { id: 'drone',        name: '自動空拍導演',       short: '空拍',   category: 'scenic', fov: 50 }
];

// World position of a latitude / longitude (taipei-geodata.js frame)
const ll = (lat, lon) => [(lon - GEO.frame.lon0) * GEO.frame.mLon, -(lat - GEO.frame.lat0) * GEO.frame.mLat];
const P = {
  elephantDeck: ll(25.02705, 121.57405),
  t101: ll(25.03361, 121.56496),
  zhongxiao: ll(25.04155, 121.54930),
  zhongxiaoEast: ll(25.04110, 121.56600),
  cksGate: ll(25.03690, 121.51690),
  cksHall: ll(25.03464, 121.52182),
  ketagalan: ll(25.04000, 121.51700),
  presidential: ll(25.04000, 121.51198),
  ximen: ll(25.04330, 121.50730),
  ximenLook: ll(25.04190, 121.50830),
  riverCam: ll(25.05950, 121.50600),
  riverLook: ll(25.04700, 121.52000),
  grandCam: ll(25.07400, 121.52950),
  grandHotel: ll(25.07883, 121.52624)
};

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the mountains round the basin stand 10-30 km away (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'scooter') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'elephant': {
        // The 象山 viewpoint: Taipei 101 over 信義, the basin & the mountains beyond
        const sway = Math.sin(elapsed * 0.12) * 6.0;
        const [x, z] = P.elephantDeck;
        desiredPos.set(x + sway, hillHeight(x, z) + 6.0, z);
        desiredLook.set(P.t101[0], 230.0, P.t101[1]);
        break;
      }

      case 'observatory': {
        // Taipei 101's 89th floor observatory (382 m) looking north over the city & the river to 陽明山
        const pan = Math.sin(elapsed * 0.1) * 900.0;
        desiredPos.set(P.t101[0] - 6.0, 382.0, P.t101[1] - 26.0);
        desiredLook.set(P.t101[0] - 2400.0 + pan, 120.0, P.t101[1] - 3800.0);
        break;
      }

      case 'zhongxiao': {
        // 忠孝東路四段 at 敦化 looking east down the boulevard to 101
        const sway = Math.sin(elapsed * 0.25) * 1.5;
        desiredPos.set(P.zhongxiao[0], 7.0 + sway * 0.3, P.zhongxiao[1] + 6.0);
        desiredLook.set(P.zhongxiaoEast[0], 40.0, P.zhongxiaoEast[1]);
        break;
      }

      case 'cks': {
        // 自由廣場: under the Liberty Square gate looking down the plaza to the Chiang Kai-shek Memorial Hall
        const sway = Math.sin(elapsed * 0.2) * 2.0;
        desiredPos.set(P.cksGate[0] + 30.0, 4.0 + sway * 0.4, P.cksGate[1] + 12.0);
        desiredLook.set(P.cksHall[0], 30.0, P.cksHall[1]);
        break;
      }

      case 'presidential': {
        // 凱達格蘭大道 looking west at the Presidential Office's tower
        const sway = Math.sin(elapsed * 0.2) * 2.5;
        desiredPos.set(P.ketagalan[0], 3.5, P.ketagalan[1] + sway);
        desiredLook.set(P.presidential[0], 40.0, P.presidential[1]);
        break;
      }

      case 'ximen': {
        // 西門町's pedestrian streets: signs, crowds & the Red House
        const sway = Math.sin(elapsed * 0.3) * 1.5;
        desiredPos.set(P.ximen[0] + sway, 5.5, P.ximen[1]);
        desiredLook.set(P.ximenLook[0], 12.0, P.ximenLook[1]);
        break;
      }

      case 'river': {
        // Over the 淡水河 at 大稻埕 wharf, the city & 101 across the water
        const drift = Math.sin(elapsed * 0.12) * 60.0;
        desiredPos.set(P.riverCam[0], 40.0, P.riverCam[1] + drift);
        desiredLook.set(P.riverLook[0], 60.0, P.riverLook[1]);
        break;
      }

      case 'grandHotel': {
        // Across the 基隆河 from 大直: the Grand Hotel on its hill
        const sway = Math.sin(elapsed * 0.15) * 20.0;
        desiredPos.set(P.grandCam[0] + sway, 28.0, P.grandCam[1]);
        desiredLook.set(P.grandHotel[0], 55.0, P.grandHotel[1]);
        break;
      }

      case 'drone': {
        // Circling 信義 & 101 at 300-500 m
        const angle = elapsed * 0.06 + 0.65;
        const radius = 900.0 + Math.sin(elapsed * 0.23) * 200.0;
        const alt = 380.0 + Math.cos(elapsed * 0.19) * 110.0;
        desiredPos.set(P.t101[0] + Math.cos(angle) * radius, alt, P.t101[1] + Math.sin(angle) * radius);
        desiredLook.set(P.t101[0], 180.0, P.t101[1]);
        break;
      }
    }

    // keep the follow cameras out of the buildings: pull in to just short of the first wall between the target & it
    if (this.activePresetId === 'chase' || this.activePresetId === 'action') this.clipToBuildings(entity, desiredPos);

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

// Nearest crossing (0..1 along a -> b) of segment a-b with a polygon ring's edges (flat [x, z, ...]), or Infinity
function segmentRingHit(ax, az, bx, bz, ring) {
  let best = Infinity;
  const dx = bx - ax;
  const dz = bz - az;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const cx = ring[j * 2], cz = ring[j * 2 + 1];
    const ex = ring[i * 2] - cx;
    const ez = ring[i * 2 + 1] - cz;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((cx - ax) * ez - (cz - az) * ex) / den;
    const u = ((cx - ax) * dz - (cz - az) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

CameraSystem.prototype.clipToBuildings = function (entity, cam) {
  const cm = this.controllerManager;
  if (!cm.nearColliders) return;
  const ax = entity.position.x;
  const az = entity.position.z;
  const len = Math.hypot(cam.x - ax, cam.z - az);
  if (len < 0.5) return;
  let t = 1;
  for (const c of cm.nearColliders((ax + cam.x) / 2, (az + cam.z) / 2, len / 2 + 1)) {
    if (cam.y > c.maxY + 0.5 || cam.y + 1 < c.minY) continue;
    t = Math.min(t, segmentRingHit(ax, az, cam.x, cam.z, c.poly));
  }
  if (t < 1) {
    const keep = Math.max(0.15, t - 0.4 / len);
    cam.x = ax + (cam.x - ax) * keep;
    cam.z = az + (cam.z - az) * keep;
  }
};

export { CAMERA_PRESETS, CameraSystem };
