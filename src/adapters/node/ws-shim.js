/*
 * WebSocket for app pages in a sandbox (ADR 0006). A service worker cannot
 * answer WebSocket requests, so this replaces window.WebSocket, before any app
 * script runs, for connections the sandbox serves itself: same-origin URLs and
 * http(s)/ws(s)://localhost:<port>. The host page (window.top) relays them to
 * the virtual server in the Node.js runtime. Anything else uses the browser's
 * WebSocket (and the egress rules).
 */

/*
 * The page also gets esbuild's __async helper. The runtime compiles async functions into generators
 * driven by it (compile.ts: AsyncLocalStorage context survives await), and a dev server that sends
 * one of its own functions to the page as source text (Function.prototype.toString: @nuxt/cli's
 * loading screen) sends the compiled form, which calls __async.
 */
globalThis.__async ??= (__this, __arguments, generator) =>
  new Promise((resolve, reject) => {
    const fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    const rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    const step = (x) => (x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected));
    step((generator = generator.apply(__this, __arguments)).next());
  });

(() => {
  const Native = window.WebSocket;
  let connect;
  try {
    connect = window.top.__sandburgWs;
  } catch {
    return;
  }
  if (typeof connect !== 'function' || Native.__sandburg) return;

  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  class SandburgWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const target = new URL(url, location.href);
      if (target.protocol === 'http:') target.protocol = 'ws:';
      if (target.protocol === 'https:') target.protocol = 'wss:';
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      const channel = new MessageChannel();
      if (!connect(target.href, list, channel.port2, location.href)) return new Native(url, protocols);
      this.url = target.href;
      this.readyState = CONNECTING;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._port = channel.port1;
      this._port.onmessage = (e) => this._receive(e.data);
    }

    _emit(event) {
      const handler = this[`on${event.type}`];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }

    _receive(m) {
      if (m.type === 'open') {
        this.readyState = OPEN;
        this.protocol = m.protocol;
        this.extensions = m.extensions;
        this._emit(new Event('open'));
      } else if (m.type === 'message') {
        let data = m.data;
        if (typeof data !== 'string' && this.binaryType === 'blob') data = new Blob([data]);
        this._emit(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
      } else if (m.type === 'close') {
        if (this.readyState === CLOSED) return;
        const failed = !m.wasClean && this.readyState === CONNECTING;
        this.readyState = CLOSED;
        if (failed || m.error) this._emit(new Event('error'));
        this._emit(new CloseEvent('close', { code: m.code, reason: m.reason, wasClean: m.wasClean }));
        this._port.close();
      }
    }

    send(data) {
      if (this.readyState === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      if (this.readyState !== OPEN) return;
      if (typeof data === 'string') this._port.postMessage({ type: 'send', data });
      else if (data instanceof Blob) data.arrayBuffer().then((buf) => this._port.postMessage({ type: 'send', data: buf }, [buf]));
      else {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const copy = view.slice().buffer;
        this._port.postMessage({ type: 'send', data: copy }, [copy]);
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      this._port.postMessage({ type: 'close', code, reason });
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    Object.defineProperty(SandburgWebSocket, name, { value });
    Object.defineProperty(SandburgWebSocket.prototype, name, { value });
  }
  SandburgWebSocket.__sandburg = true;
  window.WebSocket = SandburgWebSocket;
})();

/*
 * HTTP requests to http://localhost:<port>/… (and 127.0.0.1), as a dev setup with a CORS-enabled API
 * makes them: fetch, XMLHttpRequest and EventSource go to /__sandburg_backend/<port>/…, which the
 * sandbox serves from the server listening on that port.
 */
(() => {
  if (window.fetch.__sandburg) return;
  const re = /^(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)(\/[^#]*)?/;
  const map = (u) => {
    const m = re.exec(String(u instanceof Request ? u.url : u));
    return m ? `/__sandburg_backend/${m[1]}${m[2] || '/'}` : null;
  };
  const fetch = window.fetch;
  window.fetch = function (input, init) {
    const to = map(input);
    if (!to) return fetch.call(this, input, init);
    return fetch.call(this, input instanceof Request ? new Request(to, input) : to, init);
  };
  window.fetch.__sandburg = true;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, map(url) ?? url, ...rest);
  };
  if (window.EventSource) {
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      constructor(url, init) {
        super(map(url) ?? url, init);
      }
    };
  }
})();
