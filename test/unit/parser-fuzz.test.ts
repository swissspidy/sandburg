import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acceptFileChannel } from '../../src/orchestrator/host-socket.ts';
import { parseConnectTarget } from '../../src/orchestrator/egress-proxy.ts';

/**
 * Deterministic mutation fuzzing of the host's two app-driven parsers: the file channel's WebSocket
 * frame reader and the egress proxy's CONNECT target. The frame reader runs in an 'upgrade' handler's
 * `data` listener, outside any try/catch, so a parser throw there would be an uncaught host crash; the
 * CONNECT parser runs for every tunnel a page opens. Neither may throw on any input. A longer run of
 * these fuzzers (millions of iterations, several seeds) was done while writing them; this is the fast,
 * fixed-seed version that runs in CI.
 */
function mulberry(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A minimal Duplex the frame reader can attach to: records writes, swallows them. */
class MockSocket extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  write(): boolean {
    return true;
  }
  end(): this {
    this.destroyed = true;
    this.writableEnded = true;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
  setNoDelay(): void {}
}

const ORIGIN = 'http://box.sandburg.localhost:1';
const FRAME_OPCODES = [0x81, 0x82, 0x88, 0x89, 0x8a, 0x01, 0x02, 0x00, 0x8f];
const FRAME_LENGTHS = [0, 1, 5, 125, 126, 127];

test('the file channel frame reader never throws on arbitrary byte streams (fixed seed)', () => {
  const rnd = mulberry(0x5a5a5a);
  const serve = async (): Promise<{ status: number; body: Uint8Array }> => ({ status: 200, body: new Uint8Array(8) });
  for (let i = 0; i < 40_000; i++) {
    const sock = new MockSocket();
    const req = { headers: { origin: ORIGIN, 'sec-websocket-key': 'x', upgrade: 'websocket' } };
    acceptFileChannel(req as never, sock as never, ORIGIN, serve);
    const chunks = 1 + Math.floor(rnd() * 4);
    for (let c = 0; c < chunks && !sock.destroyed; c++) {
      const n = Math.floor(rnd() * 140);
      const buf = Buffer.alloc(n);
      for (let k = 0; k < n; k++) buf[k] = Math.floor(rnd() * 256);
      if (n >= 2 && rnd() < 0.5) {
        buf[0] = FRAME_OPCODES[Math.floor(rnd() * FRAME_OPCODES.length)];
        buf[1] = (rnd() < 0.7 ? 0x80 : 0) | FRAME_LENGTHS[Math.floor(rnd() * FRAME_LENGTHS.length)];
      }
      // A throw here would be uncaught in production; assert.doesNotThrow fails the test instead.
      assert.doesNotThrow(() => sock.emit('data', buf));
    }
  }
});

test('parseConnectTarget never throws and only ever returns a bracketless host and a 1-65535 port (fixed seed)', () => {
  const rnd = mulberry(0xc0ffee);
  const alphabet = 'abcABC0123.:-_[]%/\\ @\t\n\rÿ'.split('');
  const pieces = ['[', ']', '::1', '127.0.0.1', ':443', ':0443', 'host', '.sandburg.localhost', '%65', '99999', ':'];
  for (let i = 0; i < 200_000; i++) {
    let s = '';
    const n = Math.floor(rnd() * 24);
    for (let k = 0; k < n; k++) s += rnd() < 0.4 ? pieces[Math.floor(rnd() * pieces.length)] : alphabet[Math.floor(rnd() * alphabet.length)];
    let out: { host: string; port: number } | null = null;
    assert.doesNotThrow(() => (out = parseConnectTarget(s)), s);
    if (out !== null) {
      const t = out as { host: string; port: number };
      assert.ok(!t.host.includes('[') && !t.host.includes(']'), `brackets left in host for ${JSON.stringify(s)}`);
      assert.ok(Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535, `bad port for ${JSON.stringify(s)}`);
    }
  }
});
