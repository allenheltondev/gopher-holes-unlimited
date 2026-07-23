import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBody,
  validateNewGopher,
  validateNewHole,
  validateGopherStatus,
  validateHoleStatus
} from '../src/lib/validation.js';

test('parseBody rejects a missing body', () => {
  assert.throws(() => parseBody(undefined), /body is required/);
});

test('parseBody rejects invalid JSON', () => {
  assert.throws(() => parseBody('{ not json'), /valid JSON/);
});

test('validateNewGopher requires a name and a location', () => {
  assert.throws(() => validateNewGopher({ location: { latitude: '1', longitude: '2' } }), /'name' is required/);
  assert.throws(() => validateNewGopher({ name: 'Gerry' }), /location is required/);
});

test('validateNewGopher accepts a valid gopher', () => {
  assert.doesNotThrow(() =>
    validateNewGopher({ name: 'Gerry', status: 'at large', location: { city: 'Plano', state: 'TX' } })
  );
});

test('validateNewGopher rejects an unknown status enum', () => {
  assert.throws(
    () => validateNewGopher({ name: 'Gerry', status: 'napping', location: { city: 'Plano', state: 'TX' } }),
    /'status' must be one of/
  );
});

test('validateNewHole requires a description and location', () => {
  assert.throws(() => validateNewHole({ location: { latitude: '1', longitude: '2' } }), /'description' is required/);
});

test('status validators enforce their enums', () => {
  assert.throws(() => validateGopherStatus({ status: 'filled' }), /must be one of/);
  assert.throws(() => validateHoleStatus({ status: 'trapped' }), /must be one of/);
  assert.doesNotThrow(() => validateHoleStatus({ status: 'filled' }));
});
