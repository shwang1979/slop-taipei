import * as THREE from 'three/webgpu';
import { Fn, attribute, step, fract, sin, time, color } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';

// js/garbage-truck.js
// Taipei's garbage truck (垃圾車): a yellow compactor truck crawling through the lanes every evening, its loudspeaker
// playing Beethoven's Für Elise so the neighbourhood knows to come down with the rubbish. The truck model and the
// melody, synthesised as a music-box chime through a horn loudspeaker and placed in 3D with a PannerNode.

// --- Model: cab, compactor body with a blue band, hopper, wheels, amber beacons; +Z forward, ground at y = 0 ----------
function buildGarbageTruckGeometry() {
  const parts = [];
  const add = (geo, hex, x, y, z, glow = 0) => {
    const g = geo.toNonIndexed();
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const c = new THREE.Color(hex);
    const col = new Float32Array(n * 3);
    const gl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3);
      gl[i] = glow;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(gl, 1));
    parts.push(g);
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  add(box(2.3, 2.2, 1.9), 0xf2c418, 0, 1.55, 2.6); // cab
  add(box(2.1, 0.75, 0.05), 0x22303a, 0, 2.0, 3.56); // windscreen
  add(box(2.42, 2.6, 5.0), 0xf2c418, 0, 1.9, -0.9); // body
  add(box(2.44, 0.32, 5.02), 0x1e5aa8, 0, 1.45, -0.9); // blue band
  add(box(2.3, 2.3, 0.9), 0xd8aa10, 0, 1.75, -3.8); // hopper
  add(box(2.0, 0.5, 0.3), 0x2a2c2e, 0, 0.72, -4.3); // hopper lip
  add(box(2.5, 0.35, 7.6), 0x2a2c2e, 0, 0.55, -0.6); // chassis
  const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 12).rotateZ(Math.PI / 2);
  for (const z of [2.4, -1.4, -2.6]) for (const x of [-1.05, 1.05]) add(wheel, 0x161618, x, 0.5, z);
  for (const x of [-0.8, 0.8]) add(new THREE.CylinderGeometry(0.13, 0.13, 0.18, 10), 0xffa010, x, 2.75, 2.5, 1); // beacons
  add(box(0.5, 0.35, 0.35), 0x3a3c3e, 0, 2.85, 2.2); // loudspeaker
  const g = mergeGeometries(parts);
  g.computeBoundingSphere();
  return g;
}

function createGarbageTruckMesh() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  // amber beacons flashing
  mat.emissiveNode = Fn(() => {
    const glow = attribute('glow', 'float');
    const flash = step(0.5, fract(time.mul(1.6))).mul(0.7).add(0.3).mul(sin(time.mul(10.0)).mul(0.2).add(0.8));
    return color(0xffa020).mul(glow).mul(flash).mul(cityUniforms.uInteriorGlow.mul(2.0).add(1.0));
  })();
  const mesh = new THREE.Mesh(buildGarbageTruckGeometry(), mat);
  mesh.name = 'GarbageTruck';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Für Elise (the opening), [MIDI note, sixteenths] -------------------------------------------------------------------
const PHRASE_A = [[76, 1], [75, 1], [76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1], [69, 3], [60, 1], [64, 1], [69, 1], [71, 3], [64, 1], [68, 1], [71, 1], [72, 3], [64, 1]];
const PHRASE_B = [[76, 1], [75, 1], [76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1], [69, 3], [60, 1], [64, 1], [69, 1], [71, 3], [64, 1], [72, 1], [71, 1], [69, 5]];
const MELODY = [...PHRASE_A, ...PHRASE_B];
const SIXTEENTH = 0.19;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

class GarbageTruckMusic {
  constructor(audioSystem) {
    this.audio = audioSystem;
    this.nodes = null;
    this.nextNote = 0;
    this.index = 0;
  }

  setup(ctx) {
    // music-box chime -> horn loudspeaker (band-limited, a little overdriven) -> 3D panner -> the city mix
    const speaker = ctx.createBiquadFilter();
    speaker.type = 'bandpass';
    speaker.frequency.value = 1300;
    speaker.Q.value = 0.7;
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    drive.curve = curve;
    const level = ctx.createGain();
    level.gain.value = 0.0;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 12;
    panner.maxDistance = 400;
    panner.rolloffFactor = 1.2;
    const bus = ctx.createGain();
    bus.gain.value = 0.55;
    bus.connect(speaker).connect(drive).connect(level).connect(panner).connect(this.audio.mix);
    this.nodes = { bus, level, panner };
    this.nextNote = ctx.currentTime + 0.2;
  }

  note(ctx, t, hz, dur) {
    const { bus } = this.nodes;
    for (const [mult, amp] of [[1, 0.5], [2, 0.18], [3.01, 0.07]]) {
      const osc = ctx.createOscillator();
      osc.type = mult === 1 ? 'triangle' : 'sine';
      osc.frequency.value = hz * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(0.35, dur * 1.8));
      osc.connect(g).connect(bus);
      osc.start(t);
      osc.stop(t + Math.max(0.4, dur * 1.9));
    }
  }

  // truck: { x, y, z, active } (traffic.js), audible within ~250 m
  update(truck) {
    const audio = this.audio;
    const ctx = audio.context;
    if (!ctx || ctx.state !== 'running' || !audio.enabled || !audio.mix) return;
    if (!this.nodes) this.setup(ctx);
    const { level, panner } = this.nodes;
    const on = truck && truck.active;
    level.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.3);
    if (!on) return;
    const now = ctx.currentTime;
    panner.positionX.setTargetAtTime(truck.x, now, 0.05);
    panner.positionY.setTargetAtTime(truck.y + 3, now, 0.05);
    panner.positionZ.setTargetAtTime(truck.z, now, 0.05);
    // schedule the melody ~0.4 s ahead, looping with a breath between the repeats
    if (this.nextNote < now) this.nextNote = now + 0.05;
    while (this.nextNote < now + 0.4) {
      const [m, len] = MELODY[this.index];
      this.note(ctx, this.nextNote, midiHz(m), len * SIXTEENTH);
      this.nextNote += len * SIXTEENTH;
      this.index++;
      if (this.index >= MELODY.length) {
        this.index = 0;
        this.nextNote += 1.6;
      }
    }
  }
}

export { createGarbageTruckMesh, GarbageTruckMusic };
