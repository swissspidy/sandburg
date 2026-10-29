/** Which runtime a request went to (src/node-runtime/peer-requests.ts): what another runtime sends about it is dropped. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardedBodies, inflight, routedTo, sentBy } from '../../src/node-runtime/peer-requests.ts';

const runtime = () => ({ postMessage() {} });

afterEach(() => {
  inflight.clear();
  forwardedBodies.clear();
  routedTo.clear();
});

test('a message about a request is taken from the runtime it went to, while its response or body goes there', () => {
  const [child, sibling] = [runtime(), runtime()];
  inflight.set(-1, child);
  assert.equal(sentBy(-1, child), true);
  assert.equal(sentBy(-1, sibling), false);
  // Its response ended, its body still goes (a body read after the response).
  inflight.delete(-1);
  routedTo.set(-1, child);
  assert.equal(sentBy(-1, child), true);
  assert.equal(sentBy(-1, sibling), false);
  // A request from the parent, forwarded on with its body to come.
  forwardedBodies.set(7, sibling);
  assert.equal(sentBy(7, sibling), true);
  assert.equal(sentBy(7, child), false);
});

test('a message about a request no runtime has (answered, cancelled, or never made) is from none of them', () => {
  assert.equal(sentBy(-2, runtime()), false);
});
