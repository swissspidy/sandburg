// node:events as Node 24 has it, over the events package (which every `events` import in the runtime
// and its polyfills resolves here instead, bundle.ts): the package's constructor takes no options, and
// it has no errorMonitor, captureRejections, events.on or getMaxListeners. One prototype with the
// package's, so its emitters and these are one class (instanceof, readable-stream's streams).
'use strict';
const Base = require('events/events.js');

const kCapture = Symbol('kCapture');
const errorMonitor = Symbol('events.errorMonitor');
const captureRejectionSymbol = Symbol.for('nodejs.rejection');
const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol('events.maxEventTargetListenersWarned');

const received = (v) =>
  v == null ? ` Received ${v}` : typeof v === 'object' ? ` Received an instance of ${v.constructor?.name ?? 'Object'}` : ` Received type ${typeof v} (${typeof v === 'string' ? `'${v}'` : String(v)})`;
const argType = (name, expected, v) => Object.assign(new TypeError(`The ${name} must be ${expected}.${received(v)}`), { code: 'ERR_INVALID_ARG_TYPE' });
class AbortError extends Error {
  constructor(signal) {
    super('The operation was aborted', { cause: signal?.reason });
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}
const abortError = (signal) => new AbortError(signal);

let captureRejections = false;

function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
EventEmitter.prototype = Base.prototype;
Object.defineProperty(Base.prototype, 'constructor', { value: EventEmitter, writable: true, configurable: true });
Object.setPrototypeOf(EventEmitter, Base);

EventEmitter.init = function init(opts) {
  Base.init.call(this);
  if (opts?.captureRejections !== undefined) {
    if (typeof opts.captureRejections !== 'boolean') throw argType('"options.captureRejections" property', 'of type boolean', opts.captureRejections);
    this[kCapture] = opts.captureRejections;
  } else if (this[kCapture] === undefined) {
    this[kCapture] = captureRejections;
  }
};

// errorMonitor's listeners see an 'error' first, also when no 'error' listener takes it (it then throws);
// with captureRejections, a listener's rejected promise becomes an 'error' (or this[captureRejectionSymbol]).
const baseEmit = Base.prototype.emit;
Base.prototype.emit = function emit(type, ...args) {
  if (type === 'error' && this._events?.[errorMonitor] !== undefined) baseEmit.call(this, errorMonitor, ...args);
  if (this[kCapture] !== true) return baseEmit.call(this, type, ...args);
  const handler = this._events?.[type];
  if (handler === undefined) return baseEmit.call(this, type, ...args);
  for (const listener of typeof handler === 'function' ? [handler] : handler.slice()) {
    const result = Reflect.apply(listener, this, args);
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.then(undefined, (err) => process.nextTick(() => emitRejection(this, err, type, args)));
    }
  }
  return true;
};
function emitRejection(emitter, err, type, args) {
  if (typeof emitter[captureRejectionSymbol] === 'function') return emitter[captureRejectionSymbol](err, type, ...args);
  const prev = emitter[kCapture];
  // An 'error' listener's own rejection is not captured again.
  try {
    emitter[kCapture] = false;
    emitter.emit('error', err);
  } finally {
    emitter[kCapture] = prev;
  }
}

const isTarget = (t) => typeof t?.addEventListener === 'function' && typeof t?.removeEventListener === 'function' && !(t instanceof Base);
function getMaxListeners(emitterOrTarget) {
  if (emitterOrTarget instanceof Base) return emitterOrTarget.getMaxListeners();
  if (isTarget(emitterOrTarget)) return emitterOrTarget[kMaxEventTargetListeners] ?? EventEmitter.defaultMaxListeners;
  throw argType('"emitter" argument', 'an instance of EventEmitter or EventTarget', emitterOrTarget);
}
function setMaxListeners(n = EventEmitter.defaultMaxListeners, ...targets) {
  if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
    throw Object.assign(new RangeError(`The value of "n" is out of range. It must be a non-negative number. Received ${String(n)}`), { code: 'ERR_OUT_OF_RANGE' });
  }
  if (targets.length === 0) EventEmitter.defaultMaxListeners = n;
  for (const t of targets) {
    if (t instanceof Base) t.setMaxListeners(n);
    else if (isTarget(t)) {
      t[kMaxEventTargetListeners] = n;
      t[kMaxEventTargetListenersWarned] = false;
    } else throw argType('"eventTargets" argument', 'an instance of EventEmitter or EventTarget', t);
  }
}

function listen(target, name, fn, flags) {
  if (typeof target.on === 'function') {
    if (flags?.once) target.once(name, fn);
    else target.on(name, fn);
    return () => target.removeListener(name, fn);
  }
  target.addEventListener(name, fn, flags);
  return () => target.removeEventListener(name, fn, flags);
}

/** An async iterator of an emitter's (or EventTarget's) events: each one's arguments, until close, error or abort. */
function on(emitter, event, options = {}) {
  const { signal, close = [] } = options;
  if (signal?.aborted) throw abortError(signal);
  const queue = [];
  const waiting = [];
  let error = null;
  let finished = false;
  const offs = [];
  const target = !(emitter instanceof Base) && isTarget(emitter);
  const push = (value) => {
    if (waiting.length) waiting.shift().resolve({ value, done: false });
    else queue.push(value);
  };
  const fail = (err) => {
    if (finished) return;
    cleanup();
    if (waiting.length) waiting.shift().reject(err);
    else error = err;
    for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
  };
  const end = () => {
    if (finished) return;
    cleanup();
    for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
  };
  function cleanup() {
    finished = true;
    for (const off of offs.splice(0)) off();
  }
  offs.push(listen(emitter, event, target ? (ev) => push([ev]) : (...args) => push(args)));
  if (event !== 'error' && !target) offs.push(listen(emitter, 'error', fail));
  for (const name of close) offs.push(listen(emitter, name, end));
  if (signal) {
    const onAbort = () => fail(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    offs.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (error) {
        const e = error;
        error = null;
        return Promise.reject(e);
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      end();
      queue.length = 0;
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err) {
      fail(err);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** A promise of an emitter's (or EventTarget's) next event, its arguments; an 'error' or an abort rejects it. */
function once(emitter, name, options = {}) {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const offs = [];
    const done = (fn) => (value) => {
      for (const off of offs.splice(0)) off();
      fn(value);
    };
    const target = !(emitter instanceof Base) && isTarget(emitter);
    offs.push(listen(emitter, name, target ? (ev) => done(resolve)([ev]) : (...args) => done(resolve)(args), { once: true }));
    if (name !== 'error' && !target) offs.push(listen(emitter, 'error', done(reject), { once: true }));
    if (signal) {
      const onAbort = () => done(reject)(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      offs.push(() => signal.removeEventListener('abort', onAbort));
    }
  });
}

Object.defineProperty(EventEmitter, 'captureRejections', {
  enumerable: true,
  get: () => captureRejections,
  set: (v) => {
    if (typeof v !== 'boolean') throw argType('"EventEmitter.captureRejections" property', 'of type boolean', v);
    captureRejections = v;
  },
});
Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  enumerable: true,
  get: () => Base.defaultMaxListeners,
  set: (v) => {
    Base.defaultMaxListeners = v;
  },
});
Object.assign(EventEmitter, {
  EventEmitter,
  once,
  on,
  errorMonitor,
  captureRejectionSymbol,
  usingDomains: false,
  kMaxEventTargetListeners,
  kMaxEventTargetListenersWarned,
  getMaxListeners,
  setMaxListeners,
  listenerCount: Base.listenerCount,
});
module.exports = EventEmitter;
