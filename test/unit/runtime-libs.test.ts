import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CRYPTO_LIB_KEYS, ZLIB_CONSTANTS, ZLIB_LIB_KEYS } from '../../src/node-runtime/libs.ts';

const require = createRequire(import.meta.url);

// node:crypto and node:zlib list the members they take from their runtime libraries without loading
// them (worker.ts, lazyMember): the lists must be what the libraries export.
test('node:crypto lists every member crypto-browserify exports', () => {
  assert.deepEqual(CRYPTO_LIB_KEYS, Object.keys(require('crypto-browserify')));
});

test('node:zlib lists every member browserify-zlib exports, and its constants', () => {
  const zlib = require('browserify-zlib') as Record<string, unknown>;
  const constants = Object.fromEntries(Object.entries(zlib).filter(([k, v]) => k.startsWith('Z_') && typeof v === 'number'));
  assert.deepEqual(ZLIB_CONSTANTS, constants);
  assert.deepEqual(ZLIB_LIB_KEYS, Object.keys(zlib).filter((k) => !(k in constants)));
});
