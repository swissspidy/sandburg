/** pagePort's test for a page whose server sends no Content-Type (src/adapters/node/process.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeHtml, sniffHtml } from '../../src/adapters/node/process.ts';

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
