/**
 * The client end of a WebSocket connection to a virtual server (RFC 6455), in
 * the runtime. The app frame's WebSocket talks to the host page in whole
 * messages; this turns them into the bytes a real client would send over the
 * upgraded socket (masked frames), and the server's bytes (the 101 response,
 * then frames) back into messages. So servers built on `ws` (socket.io,
 * Next.js' HMR, Vite-style dev tools) see a real client.
 */

export interface WsEvents {
  accept(protocol: string, extensions: string): void;
  reject(status: number, body: string): void;
  message(data: string | Uint8Array): void;
  closed(code: number, reason: string, wasClean: boolean): void;
  /** Bytes to write to the server (pong and close replies). */
  reply(bytes: Uint8Array): void;
}

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** A masked client frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = crypto.getRandomValues(new Uint8Array(4))): Uint8Array {
  const len = payload.length;
  const headerLen = 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + 4;
  const out = new Uint8Array(headerLen + len);
  out[0] = 0x80 | opcode;
  let o = 2;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) {
    out[1] = 0x80 | 126;
    out[2] = len >> 8;
    out[3] = len & 0xff;
    o = 4;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(len));
    o = 10;
  }
  out.set(mask, o);
  o += 4;
  for (let i = 0; i < len; i++) out[o + i] = payload[i] ^ mask[i & 3];
  return out;
}

export function closePayload(code: number, reason: string): Uint8Array {
  const r = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + r.length);
  out[0] = code >> 8;
  out[1] = code & 0xff;
  out.set(r, 2);
  return out;
}

export class WsClientCodec {
  private buffer = new Uint8Array(0);
  private state: 'handshake' | 'open' | 'closed' = 'handshake';
  private fragments: Uint8Array[] = [];
  private fragmentOp = 0;
  private closeSent = false;
  private events: WsEvents;

  constructor(events: WsEvents) {
    this.events = events;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Bytes the server wrote to the socket. */
  receive(bytes: Uint8Array): void {
    if (this.state === 'closed') return;
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    if (this.state === 'handshake' && !this.handshake()) return;
    while (this.state === 'open' && this.frame());
  }

  /** The server ended or destroyed the socket. */
  end(): void {
    if (this.state === 'handshake') this.events.reject(502, 'the server closed the connection during the WebSocket handshake');
    else if (this.state === 'open') this.events.closed(1006, '', false);
    this.state = 'closed';
  }

  send(data: string | Uint8Array): Uint8Array {
    return typeof data === 'string' ? encodeFrame(OP.text, new TextEncoder().encode(data)) : encodeFrame(OP.binary, data);
  }

  /** A close frame from the client (the app called close()). */
  close(code = 1000, reason = ''): Uint8Array {
    this.closeSent = true;
    return encodeFrame(OP.close, code === 1005 ? new Uint8Array(0) : closePayload(code, reason));
  }

  private handshake(): boolean {
    const text = new TextDecoder('latin1').decode(this.buffer);
    const end = text.indexOf('\r\n\r\n');
    if (end === -1) return false;
    const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const rest = this.buffer.subarray(end + 4);
    if (status !== 101) {
      this.state = 'closed';
      this.events.reject(status || 502, new TextDecoder().decode(rest));
      return false;
    }
    this.buffer = rest.slice();
    this.state = 'open';
    this.events.accept(headers['sec-websocket-protocol'] ?? '', headers['sec-websocket-extensions'] ?? '');
    return true;
  }

  /** Parses one frame from the buffer; false if it is incomplete. */
  private frame(): boolean {
    const b = this.buffer;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let o = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = (b[2] << 8) | b[3];
      o = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      len = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(2));
      o = 10;
    }
    const maskKey = masked ? b.subarray(o, o + 4) : null;
    if (masked) o += 4;
    if (b.length < o + len) return false;
    const payload = b.slice(o, o + len);
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    this.buffer = b.slice(o + len);

    if (opcode === OP.ping) this.events.reply(encodeFrame(OP.pong, payload));
    else if (opcode === OP.pong) {
      // nothing to do
    } else if (opcode === OP.close) {
      const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
      const reason = new TextDecoder().decode(payload.subarray(2));
      if (!this.closeSent) this.events.reply(this.close(code === 1005 ? 1000 : code, ''));
      this.state = 'closed';
      this.events.closed(code, reason, true);
      return false;
    } else if (opcode === OP.continuation || opcode === OP.text || opcode === OP.binary) {
      if (opcode !== OP.continuation) this.fragmentOp = opcode;
      this.fragments.push(payload);
      if (fin) {
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        const data = new Uint8Array(total);
        let p = 0;
        for (const f of this.fragments) {
          data.set(f, p);
          p += f.length;
        }
        this.fragments = [];
        this.events.message(this.fragmentOp === OP.text ? new TextDecoder().decode(data) : data);
      }
    }
    return true;
  }
}
