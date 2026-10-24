import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/taipei-geodata.js';

const inside = (x, z, m = 0) => x >= GEO.bounds.minX - m && x <= GEO.bounds.maxX + m && z >= GEO.bounds.minZ - m && z <= GEO.bounds.maxZ + m;

test('the street network references valid nodes and carries elevations only on viaducts', () => {
  const nodes = GEO.nodes.length / 4;
  assert.ok(nodes > 10000);
  for (const [a, b, name, cls, w, lanes, oneway, flags, shape] of GEO.links) {
    assert.ok(a >= 0 && a < nodes && b >= 0 && b < nodes);
    assert.ok(name >= 0 && name < GEO.names.length);
    assert.ok(cls >= 0 && cls < GEO.roadClasses.length);
    assert.ok(w > 0 && lanes >= 1 && [-1, 0, 1].includes(oneway));
    assert.equal(shape.length % (flags & 2 ? 3 : 2), 0, 'elevated shapes are [x, z, y], the others [x, z]');
  }
});

test('buildings decode to closed footprints with plausible heights', () => {
  const B = GEO.buildings;
  let k = 0;
  let count = 0;
  let tallest = 0;
  while (k < B.length) {
    const h = B[k] / 10;
    const rings = B[k + 3];
    assert.ok(h > 0 && h <= 520);
    assert.ok(rings >= 1);
    k += 4;
    for (let r = 0; r < rings; r++) {
      const n = B[k++];
      assert.ok(n >= 3);
      k += n * 2;
    }
    tallest = Math.max(tallest, h);
    count++;
  }
  assert.equal(k, B.length);
  assert.ok(count > 40000, `${count} buildings`);
  assert.ok(tallest > 200 && tallest < 300, 'the tallest OSM building is 南山廣場 (Taipei 101 is a landmark model)');
});

test('landmarks & teleports lie in the data box', () => {
  for (const [id, l] of Object.entries(GEO.landmarks)) assert.ok(inside(l.x, l.z), id);
  assert.ok(GEO.landmarks.taipei101 && GEO.landmarks.cksHall && GEO.landmarks.presidential);
  for (const t of GEO.teleports) assert.ok(inside(t.x, t.z, -50), t.id);
});

test('polygon layers are [outer, ...holes] flat rings', () => {
  for (const key of ['carriageway', 'sidewalks', 'water', 'park', 'ground']) {
    assert.ok(GEO[key].length > 0, key);
    for (const poly of GEO[key]) for (const ring of poly) assert.ok(ring.length >= 6 && ring.length % 2 === 0, key);
  }
});
