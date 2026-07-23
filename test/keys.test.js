import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationKey, gopherKey, holeKey, linkKey } from '../src/lib/keys.js';

test('locationKey prefers coordinates when present', () => {
  assert.equal(locationKey({ latitude: '33.06', longitude: '-96.80' }), 'LOCATION#33.06#-96.80');
});

test('locationKey falls back to a normalized address', () => {
  const key = locationKey({ addressLine1: '123 Main St', city: 'Plano', state: 'TX' });
  assert.equal(key, 'LOCATION#123 main st#plano#tx');
});

test('locationKey returns undefined without enough information', () => {
  assert.equal(locationKey({}), undefined);
  assert.equal(locationKey(), undefined);
});

test('entity key helpers build single-table keys', () => {
  assert.deepEqual(gopherKey('abc'), { pk: 'GOPHER#abc', sk: 'GOPHER#abc' });
  assert.deepEqual(holeKey('xyz'), { pk: 'HOLE#xyz', sk: 'HOLE#xyz' });
  assert.deepEqual(linkKey('g1', 'h1'), { pk: 'GOPHER#g1', sk: 'LINK#HOLE#h1' });
});
