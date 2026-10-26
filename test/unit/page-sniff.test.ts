/** pagePort's test for a page whose server sends no Content-Type (src/adapters/node/process.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeHtml, pagePortSettled, sniffHtml } from '../../src/adapters/node/process.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('a body that starts as an HTML document does is a page', () => {
  for (const body of ['<!DOCTYPE html><html>', '\n  <html lang="en">', '﻿<!doctype html>\n', '<head><title>x</title>', '<!-- app -->\n<html>', '<!--app-->\n<html>']) assert.ok(looksLikeHtml(enc(body)), body);
});

test('JSON, text, XML or a fragment is not', () => {
  for (const body of ['{"ok":true}', 'Hello', '<?xml version="1.0"?><rss>', '<div>api</div>', '']) assert.ok(!looksLikeHtml(enc(body)), body);
});

test("a streamed body's first bytes decide only once they tell", () => {
  for (const part of ['', '  \n', '<', '<!do', '<!DOCTYPE htm', '<htm', '<html', '<!-']) assert.equal(sniffHtml(enc(part)), null, part);
  assert.equal(sniffHtml(enc('<!do' + 'ctype html>')), true);
  for (const part of ['{', '<d', '<?xml', 'He']) assert.equal(sniffHtml(enc(part)), false, part);
  assert.equal(sniffHtml(enc(' '.repeat(512))), false, 'whitespace only, up to the limit');
});

test("pagePort takes a port that sent no HTML once no process is starting, unless a port said it is no page", () => {
  const at = { now: 10_000, lastPort: 8_000, patience: 60_000, starting: 0 as number | null, startingSince: 8_500, notPage: false };
  assert.equal(pagePortSettled(at), true, '1 s after the last port and report, nothing starting');
  assert.equal(pagePortSettled({ ...at, startingSince: 9_500 }), false, 'a report less than 1 s ago');
  assert.equal(pagePortSettled({ ...at, starting: 1 }), false, 'a process still starting');
  assert.equal(pagePortSettled({ ...at, starting: null }), false, 'a runtime that does not report');
  // A port that answered JSON (or 404) is an API: its process may start the page's server later.
  assert.equal(pagePortSettled({ ...at, notPage: true }), false);
  // The patience ends any wait.
  assert.equal(pagePortSettled({ ...at, starting: 1, notPage: true, now: 68_001 }), true);
  assert.equal(pagePortSettled({ ...at, starting: 1, notPage: true, now: 68_000 }), false);
});
