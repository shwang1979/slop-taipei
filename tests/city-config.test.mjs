import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/taipei-geodata.js';
import {
  SIDEWALKS, ROAD_LINKS, LINK_FLAG, SIGNALS, SIGNAL_CYCLE, signalPhase, walkSignal, deckHeightAt, linkPointAt, getLocationLabel,
  TELEPORT_LOCATIONS, hillHeight, groundHeightAt, SIDEWALK_HEIGHT, buildingAt, BUILDINGS
} from '../js/city-config.js';

const ringIn = (r, x, z) => {
  let ins = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
};

test('the sidewalk point test agrees with brute force', () => {
  // (a point whose test segment runs exactly through a polygon vertex may come out wrong: allow one in 500)
  let mismatches = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1500; i++) {
    const x = GEO.bounds.minX + rand() * (GEO.bounds.maxX - GEO.bounds.minX);
    const z = GEO.bounds.minZ + rand() * (GEO.bounds.maxZ - GEO.bounds.minZ);
    let n = 0;
    for (const poly of GEO.sidewalks) for (const r of poly) if (ringIn(r, x, z)) n++;
    if (SIDEWALKS.contains(x, z) !== (n % 2 === 1)) mismatches++;
    assert.equal(groundHeightAt(x, z) >= (n % 2 ? SIDEWALK_HEIGHT : 0) || SIDEWALKS.contains(x, z) !== (n % 2 === 1), true);
  }
  assert.ok(mismatches <= 3, `${mismatches} mismatches`);
});

test('signals give each phase its green in turn, and walkers go with the parallel traffic', () => {
  const sig = SIGNALS[0];
  let green0 = 0;
  let green1 = 0;
  let both = 0;
  for (let t = 0; t < SIGNAL_CYCLE; t += 0.25) {
    const a = signalPhase(t, sig, 0) === 'green';
    const b = signalPhase(t, sig, 1) === 'green';
    green0 += a;
    green1 += b;
    both += a && b;
    if (walkSignal(t, sig, 0)) assert.equal(signalPhase(t, sig, 0), 'green');
  }
  assert.equal(both, 0);
  assert.equal(green0, green1);
});

test('decks lift vehicles on the viaducts but not under them', () => {
  const l = ROAD_LINKS.find((k) => k.flags & LINK_FLAG.ELEVATED && Math.max(...[...k.pts].filter((_, i) => i % 3 === 1)) > 8);
  const i = l.pts.findIndex((v, k) => k % 3 === 1 && v > 8);
  const p = linkPointAt(l, l.cum[(i - 1) / 3]);
  assert.ok(deckHeightAt(p.x, p.z, p.y + 1) > 7, 'on the deck');
  assert.equal(deckHeightAt(p.x, p.z, 1.2), 0, 'on the street below');
});

test('teleports land on their named roads, clear of buildings', () => {
  for (const t of Object.values(TELEPORT_LOCATIONS)) {
    assert.equal(buildingAt(t.x, t.z), null, t.id);
    assert.ok(getLocationLabel(t.x, t.z).length > 0, t.id);
  }
  assert.match(getLocationLabel(TELEPORT_LOCATIONS.taipei101.x, TELEPORT_LOCATIONS.taipei101.z), /信義路五段/);
  assert.ok(BUILDINGS.length > 40000);
});

test('the hills rise at 象山 and stay flat downtown', () => {
  const ll = (lat, lon) => [(lon - GEO.frame.lon0) * GEO.frame.mLon, -(lat - GEO.frame.lat0) * GEO.frame.mLat];
  assert.ok(hillHeight(...ll(25.0268, 121.5767)) > 40);
  assert.equal(hillHeight(...ll(25.0478, 121.5170)), 0);
});
