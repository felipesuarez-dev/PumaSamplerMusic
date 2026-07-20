import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidMediaId } from './validation.js';

test('isValidMediaId accepts an 11-char [A-Za-z0-9_-] id', () => {
  assert.equal(isValidMediaId('dQw4w9WgXcQ'), true);
  assert.equal(isValidMediaId('abc_-12345A'), true);
});

test('isValidMediaId rejects path-traversal payloads', () => {
  assert.equal(isValidMediaId('../../etc/passwd'), false);
  assert.equal(isValidMediaId('..%2F..%2Fetc'), false);
  assert.equal(isValidMediaId('../../../etc'), false);
});

test('isValidMediaId rejects a 10-char id (one short)', () => {
  assert.equal(isValidMediaId('abcdefghij'), false);
});

test('isValidMediaId rejects a 12-char id (one long)', () => {
  assert.equal(isValidMediaId('abcdefghijkl'), false);
});

test('isValidMediaId rejects non-string input', () => {
  assert.equal(isValidMediaId(undefined), false);
  assert.equal(isValidMediaId(null), false);
  assert.equal(isValidMediaId(12345678901), false);
});
