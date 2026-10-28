import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { anchors, brokenLinks, links, slug } from '../../scripts/doc-links.ts';

// The security policy is added by its own pull request; until it is on this branch, its link is the one allowed to dangle.
const PENDING = existsSync(new URL('../../SECURITY.md', import.meta.url)) ? [] : ['docs/guide/security.md: ../../SECURITY.md (no SECURITY.md)'];

test('every relative link in the README, the community files and docs/ resolves, to a heading where it names one', () => {
  assert.deepEqual(
    brokenLinks().filter((b) => !PENDING.includes(b)),
    [],
    'fix the link, or the heading it points at (node scripts/doc-links.ts lists them)',
  );
});

test("anchors are GitHub's: code and punctuation dropped, repeats numbered", () => {
  assert.equal(slug('Checks in the page (`--checks-in page`)'), 'checks-in-the-page---checks-in-page');
  assert.equal(slug('The `v0` tag'), 'the-v0-tag');
  assert.equal(slug('result.json'), 'resultjson');
  assert.deepEqual([...anchors('# A\n## A\n```\n# not a heading\n```\n### B')], ['a', 'a-1', 'b']);
  assert.deepEqual(links('[x](a.md#b) `[y](c.md)` ![i](img.png "t")\n```\n[z](d.md)\n```'), ['a.md#b', 'img.png']);
});
