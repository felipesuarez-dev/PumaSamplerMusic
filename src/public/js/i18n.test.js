import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js reads localStorage at module load time (to restore the saved
// locale) — this file is written for the browser and has no guard for a
// Node environment, so a minimal stub is installed before the dynamic
// import below. A static import would be hoisted above this stub and blow
// up with "localStorage is not defined".
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { dictionaries } = await import('./i18n.js');

const PLACEHOLDER_RE = /\{[a-zA-Z]+\}/g;

function placeholdersIn(str) {
  return new Set(str.match(PLACEHOLDER_RE) || []);
}

test('dictionaries: en and es expose the exact same set of keys', () => {
  const enKeys = Object.keys(dictionaries.en).sort();
  const esKeys = Object.keys(dictionaries.es).sort();
  assert.deepEqual(enKeys, esKeys);
});

test('dictionaries: no value is an empty string in either locale', () => {
  for (const [locale, table] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(table)) {
      assert.notEqual(value, '', `${locale}.${key} must not be an empty string`);
    }
  }
});

test('dictionaries: every {placeholder} in an EN value has a matching placeholder in the ES value for the same key, and vice versa', () => {
  const keys = Object.keys(dictionaries.en);
  for (const key of keys) {
    const enPlaceholders = placeholdersIn(dictionaries.en[key]);
    const esPlaceholders = placeholdersIn(dictionaries.es[key] ?? '');
    for (const placeholder of enPlaceholders) {
      assert.ok(
        esPlaceholders.has(placeholder),
        `${key}: EN placeholder ${placeholder} is missing from the ES value`,
      );
    }
    for (const placeholder of esPlaceholders) {
      assert.ok(
        enPlaceholders.has(placeholder),
        `${key}: ES placeholder ${placeholder} is missing from the EN value`,
      );
    }
  }
});

test('dictionaries: the new FX tooltip keys exist in both locales', () => {
  for (const key of ['tip.attack', 'tip.release', 'tip.reverse']) {
    assert.equal(typeof dictionaries.en[key], 'string');
    assert.equal(typeof dictionaries.es[key], 'string');
  }
});
