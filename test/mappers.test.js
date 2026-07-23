import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGopher } from '../src/lib/repository/gophers.js';
import { toHole } from '../src/lib/repository/holes.js';

test('toGopher maps a stored item and applies defaults', () => {
  const gopher = toGopher({
    id: 'g1',
    name: 'Gerry',
    location: { city: 'Plano', state: 'TX' },
    type: 'Western Pocket',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(gopher.id, 'g1');
  assert.equal(gopher.status, 'unknown');
  assert.equal(gopher.timesSeen, 0);
  assert.equal(gopher.type, 'Western Pocket');
});

test('toGopher returns undefined for a missing item', () => {
  assert.equal(toGopher(undefined), undefined);
});

test('toHole defaults status to visible and omits empty optionals', () => {
  const hole = toHole({ id: 'h1', description: 'by the hydrant', location: { latitude: '1', longitude: '2' } });
  assert.equal(hole.status, 'visible');
  assert.equal(hole.gopherId, undefined);
  assert.ok(!('comment' in hole));
});
