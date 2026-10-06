/**
 * The generator page: a model writes a project from the visitor's description, and the page runs it
 * the way a Sandburg run does (mount, install, start, ready through window.__sandburg), with the
 * packages installed from the npm registry and modules compiled in the page (ADRs 0018, 0020). The
 * site serves static files only; sw.js answers the runtime's own files from runtime/.
 *
 * Later requests change the running app: files are written into the runtime and the dev server
 * reloads them. A change to packages or to a server's code starts a new run.
 *
 * The page never sees the API key. The generated app runs on this page's origin, so whatever the page
 * can read, the app can too. The key lives in a vault (vault.ts): a sandboxed frame with an opaque
 * origin, created before any generated code runs. The vault calls the model and sends the answers here.
 */
import type { HostApi } from '../../src/host/host.ts';
import type { FileTree, PackageJson, Project } from '../../src/types.ts';
import { detectFramework } from '../../src/framework.ts';
import { pageInstall } from '../../src/adapters/node/plan.ts';
import { applyEdits, DATA_FILES, needsRestart, parseAnswer, type FileEdit } from './files.ts';
import type { CallResult, Turn } from './llm.ts';
import type { FromVault, Prefs, ToVault } from './protocol.ts';
import { firstMessage, fixMessage, SYSTEM } from './prompt.ts';
import { template, TEMPLATES } from './templates.ts';
import { zip } from './zip.ts';
import { guardAppFrame } from '../frame-guard.js';
import { isolationFailure } from '../isolation.js';

const scope = new URL('./', location.href);
const site = new URL('../', location.href);
const sw = { url: new URL('sw.js', site).pathname, scope: scope.pathname };
Object.assign(window, { __sandburgBase: scope.pathname + '__sandburg', __sandburgServiceWorker: sw });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  vaultSlot: $('vault'),
  conversation: $('conversation'),
  status: $('status'),
  elapsed: $('elapsed'),
  frame: $<HTMLIFrameElement>('app'),
  placeholder: $('placeholder'),
  url: $('url'),
  reload: $<HTMLButtonElement>('reload'),
  download: $<HTMLButtonElement>('download'),
  terminal: $('terminal'),
  files: $('files'),
  fileList: $('file-list'),
  fileView: $('file-view'),
  tabTerminal: $<HTMLButtonElement>('tab-terminal'),
  tabFiles: $<HTMLButtonElement>('tab-files'),
};

/** The app being built: its files, the conversation that wrote them, and its run. */
const state = {
  templateId: '',
  files: {} as FileTree,
  turns: [] as Turn[],
  /** A run is up: later edits can go into it. */
  running: false,
  /** The framework of the running project (a change of framework needs a new run). */
  runningFramework: '',
  busy: false,
  /** Files the app wrote that a new run keeps: its SQLite databases (not shown or downloaded with the project). */
  data: {} as FileTree,
  /** What the runtime and the app reported since the last change, for the model to fix. */
  errors: [] as string[],
  fixesLeft: 0,
};

let api: HostApi | null = null;

// ---------------------------------------------------------------------------------------------
// The vault: settings, the request, and the calls to the model

const PREFS = 'sandburg-generator';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

/** The vault's settings (it has no storage of its own). None of them is secret. */
function loadPrefs(): Prefs {
  const fallback: Prefs = { provider: 'anthropic', models: {}, modelLists: {}, framework: 'react', autofix: true };
  try {
    const saved = JSON.parse(storage('local')?.getItem(PREFS) ?? '{}') as Partial<Prefs>;
    return { ...fallback, ...saved, models: { ...saved.models }, modelLists: { ...saved.modelLists } };
  } catch {
    return fallback;
  }
}

let prefs = loadPrefs();
let vault: HTMLIFrameElement | null = null;
let nextCall = 1;
const calls = new Map<number, { onStart(model: string): void; onText(d: string): void; onThinking(d: string): void; resolve(r: CallResult): void; reject(e: Error): void }>();

function toVault(message: ToVault): void {
  // An opaque origin cannot be named as a target; nothing sent to the vault is secret.
  vault?.contentWindow?.postMessage(message, '*');
}

/** The vault, as a sandboxed srcdoc frame: its script is fetched now, before any generated code runs. */
async function createVault(): Promise<void> {
  // Earlier versions kept keys in this origin's storage, where a generated app can read them.
  for (const s of [storage('local'), storage('session')]) for (const p of ['anthropic', 'gemini']) s?.removeItem(`sandburg-generator-key:${p}`);
  const script = await fetch(new URL('vault.js', scope)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`vault.js: ${r.status}`))));
  const frame = document.createElement('iframe');
  frame.id = 'vault';
  frame.title = 'Model, API key and request';
  // No allow-same-origin: an opaque origin, which this page (and the app) cannot read.
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>${script.replace(/<\/(script)/gi, '<\\/$1')}</script></body></html>`;
  window.addEventListener('message', (e: MessageEvent<FromVault>) => {
    if (!vault || e.source !== vault.contentWindow) return;
    onVault(e.data);
  });
  ui.vaultSlot.replaceWith(frame);
  vault = frame;
}

function onVault(m: FromVault): void {
  switch (m.type) {
    case 'ready':
      toVault({ type: 'init', prefs, frameworks: TEMPLATES.map((t) => ({ id: t.id, label: t.label })) });
      sendState();
      break;
    case 'height':
      vault!.style.height = `${Math.min(m.height, 900)}px`;
      break;
    case 'prefs':
      prefs = m.prefs;
      try {
        storage('local')?.setItem(PREFS, JSON.stringify(prefs));
      } catch {
        // storage blocked or full: the settings last for this visit
      }
      break;
    case 'submit':
      submit(m.text);
      break;
    case 'fix':
      if (!state.busy && state.errors.length) void fix();
      break;
    case 'new-app':
      newApp();
      break;
    case 'start':
      calls.get(m.id)?.onStart(m.model);
      break;
    case 'text':
      calls.get(m.id)?.onText(m.delta);
      break;
    case 'thinking':
      calls.get(m.id)?.onThinking(m.delta);
      break;
    case 'done':
      calls.get(m.id)?.resolve(m.result);
      calls.delete(m.id);
      break;
    case 'error': {
      const error = new Error(m.message);
      if (m.aborted) error.name = 'AbortError';
      calls.get(m.id)?.reject(error);
      calls.delete(m.id);
      break;
    }
  }
}

/** The page's state, for the vault's buttons. */
function sendState(): void {
  toVault({ type: 'state', busy: state.busy, started: state.turns.length > 0, errors: state.errors.length > 0 });
}

/** Asks the vault to call the model with the conversation: it does when the visitor asked for it there. */
function callModel(turns: Turn[], fix: boolean, handlers: { onStart(model: string): void; onText(d: string): void; onThinking(d: string): void }): Promise<CallResult> {
  const id = nextCall++;
  return new Promise((resolve, reject) => {
    calls.set(id, { ...handlers, resolve, reject });
    toVault({ type: 'call', id, system: SYSTEM, turns, fix });
  });
}

function submit(text: string): void {
  if (state.busy) return;
  if (!state.turns.length) {
    const tpl = template(prefs.framework);
    state.templateId = tpl.id;
    state.files = { ...tpl.files };
    renderFiles();
    void ask(firstMessage(text, tpl), text);
  } else void ask(text, text);
}

// ---------------------------------------------------------------------------------------------
// Conversation

function say(kind: 'user' | 'model' | 'error' | 'note', text: string): HTMLLIElement {
  ui.conversation.querySelector('.intro')?.remove();
  const li = document.createElement('li');
  li.className = kind;
  const p = document.createElement('p');
  p.textContent = text;
  li.append(p);
  ui.conversation.append(li);
  li.scrollIntoView({ block: 'end' });
  return li;
}

/** The model's message as it streams: its reasoning, what it says, and the files it writes. */
function modelMessage(label: string) {
  ui.conversation.querySelector('.intro')?.remove();
  const li = document.createElement('li');
  li.className = 'model';
  li.innerHTML = `<p class="who"></p><details class="thinking" hidden><summary>Thinking</summary><div></div></details><p class="prose"></p><ul class="file-chips"></ul><p class="meta"></p>`;
  li.querySelector('.who')!.textContent = label;
  ui.conversation.append(li);
  let thinking = '';
  let text = '';
  let frame = 0;
  const render = () => {
    frame = 0;
    const details = li.querySelector<HTMLDetailsElement>('.thinking')!;
    if (thinking) {
      details.hidden = false;
      details.querySelector('div')!.textContent = thinking;
    }
    const parsed = parseAnswer(text);
    li.querySelector('.prose')!.textContent = parsed.prose || (parsed.edits.length || parsed.open ? '' : thinking ? 'Thinking…' : 'Waiting for the model…');
    const chips = parsed.edits.map((e) => chip(e.path, 'delete' in e ? 'deleted' : `${kb((e as { content: string }).content.length)}`, 'delete' in e ? 'deleted' : 'done'));
    if (parsed.open) chips.push(chip(parsed.open.path, `writing… ${kb(parsed.open.chars)}`, 'active'));
    li.querySelector('.file-chips')!.replaceChildren(...chips);
    const atEnd = ui.conversation.scrollTop + ui.conversation.clientHeight >= ui.conversation.scrollHeight - 40;
    if (atEnd) li.scrollIntoView({ block: 'end' });
  };
  const schedule = () => (frame ||= requestAnimationFrame(render));
  return {
    li,
    onText(d: string) {
      text += d;
      schedule();
    },
    onThinking(d: string) {
      thinking += d;
      schedule();
    },
    finish(meta: string) {
      if (frame) cancelAnimationFrame(frame);
      render();
      li.querySelector('.meta')!.textContent = meta;
    },
  };
}

function chip(path: string, detail: string, kind: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.state = kind;
  const name = document.createElement('code');
  name.textContent = path;
  const d = document.createElement('span');
  d.textContent = detail;
  li.append(name, d);
  return li;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

// ---------------------------------------------------------------------------------------------
// Status, steps, terminal

let clock = 0;
let clockStart = 0;

function status(text: string, kind: 'idle' | 'active' | 'done' | 'failed'): void {
  ui.status.textContent = text;
  ui.status.dataset.state = kind;
  if (kind === 'active' && !clock) {
    clockStart = performance.now();
    clock = window.setInterval(() => (ui.elapsed.textContent = seconds(performance.now() - clockStart)), 100);
  } else if (kind !== 'active' && clock) {
    clearInterval(clock);
    clock = 0;
    ui.elapsed.textContent = seconds(performance.now() - clockStart);
  }
}

function step(id: string, kind: 'active' | 'done' | 'failed' | '', detail = ''): void {
  const el = document.querySelector<HTMLElement>(`[data-step="${id}"]`);
  if (!el) return;
  if (kind) el.dataset.state = kind;
  else delete el.dataset.state;
  el.querySelector('.time')!.textContent = detail;
}

function resetSteps(from: string): void {
  const ids = ['write', 'mount', 'install', 'start', 'ready'];
  for (const id of ids.slice(ids.indexOf(from))) step(id, '');
}

const ERROR_LINE = /\b(error|Error|ERR_|failed|Failed|Cannot find|Could not|not found|Uncaught|SyntaxError|TypeError|ReferenceError)\b/;

function print(text: string, kind: 'out' | 'err' | 'ok' | 'dim' = 'out'): void {
  const t = ui.terminal;
  const atEnd = t.scrollTop + t.clientHeight >= t.scrollHeight - 4;
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  t.append(line);
  while (t.childElementCount > 2000) t.firstElementChild!.remove();
  if (atEnd) t.scrollTop = t.scrollHeight;
}

/** An error the app or its dev server reported: shown, and kept for the model. */
function reportError(text: string): void {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!clean || state.errors.includes(clean)) return;
  state.errors.push(clean);
  if (state.errors.length > 40) state.errors.shift();
  sendState();
  scheduleAutoFix();
}

function hookConsole(): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const m = typeof args[0] === 'string' && /^\[runtime:(stdout|stderr)\] ([\s\S]*)$/.exec(args[0]);
      if (m) {
        print(m[2], m[1] === 'stderr' ? 'err' : 'out');
        if (m[1] === 'stderr' && ERROR_LINE.test(m[2])) reportError(m[2]);
      } else if (typeof args[0] === 'string' && args[0].startsWith('[sandburg demo]')) print(args[0].slice(16), 'dim');
      original(...args);
    };
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sandburg-demo') print(String(e.data.message), 'dim');
  });
}

/** Errors in the app's frame (same origin): uncaught exceptions and console.error. */
function watchFrame(): void {
  guardAppFrame(ui.frame, scope.pathname + 'app', (address) => (ui.url.textContent = `http://localhost${address}`));
  ui.frame.addEventListener('load', () => {
    let win: Window & typeof globalThis;
    try {
      win = ui.frame.contentWindow as Window & typeof globalThis;
      if (!win || win.location.href === 'about:blank' || !win.navigator.serviceWorker?.controller) return;
    } catch {
      return;
    }
    win.addEventListener('error', (e) => reportError(`[browser] ${e.message}${e.filename ? ` (${e.filename.replace(location.origin, '')}:${e.lineno})` : ''}`));
    win.addEventListener('unhandledrejection', (e) => reportError(`[browser] Unhandled rejection: ${e.reason?.stack ?? e.reason}`));
    const original = win.console.error.bind(win.console);
    win.console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : safeJson(a))).join(' ');
      // React's development warnings are advice, not failures.
      if (!/^Warning: /.test(text)) reportError(`[browser console] ${text.slice(0, 2000)}`);
      original(...args);
    };
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------------------------
// Running the project

async function phase<T>(id: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> {
  const t = performance.now();
  step(id, 'active');
  const result = await fn();
  if (!result.ok) {
    step(id, 'failed');
    throw new Error(result.error.message);
  }
  step(id, 'done', seconds(performance.now() - t));
  return result.value;
}

let runs = 0;

/** Runs the project from scratch: the previous run's runtime goes, and the packages install again. */
async function run(files: FileTree): Promise<boolean> {
  const id = ++runs;
  api ??= await loadHost();
  // The app's data outlives a restart (new packages, server code): its databases go into the next run,
  // as the runtime has them now (a database the app deleted stays deleted).
  if (state.running) {
    const data = await readData();
    if (data) state.data = data;
    else print("Could not read the app's databases from the runtime: the new run starts from the copy kept at the last restart, if any.", 'err');
  }
  // Also a run that failed before it started: it still has a runtime (workers, compiler) to end.
  await api.dispose();
  state.running = false;
  ui.frame.src = 'about:blank';
  ui.placeholder.hidden = true;
  resetSteps('mount');
  let packageJson: PackageJson | null = null;
  if (typeof files['package.json'] === 'string') {
    try {
      packageJson = JSON.parse(files['package.json']);
    } catch (e) {
      reportError(`package.json is not valid JSON: ${(e as Error).message}`);
      step('mount', 'failed');
      return false;
    }
  }
  const framework = detectFramework(files, packageJson);
  const project = { name: 'app', path: 'generated', files, packageJson, framework, snapshotId: '' } as Project;
  print(`\n$ npm install && npm run dev   (${framework === 'static' ? 'static site' : framework})`, 'dim');
  status('Installing and starting', 'active');
  try {
    await phase('mount', () => api!.mount({ ...files, ...state.data }, packageJson, framework));
    await phase('install', () => api!.install(pageInstall(project)));
    const started = await phase('start', () => api!.start());
    if (id !== runs) return false;
    state.running = true;
    state.runningFramework = framework;
    await phase('ready', () => api!.ready(scope.pathname + 'app' + started.url));
  } catch (e) {
    if (id !== runs) return false;
    reportError((e as Error).message);
    print((e as Error).message, 'err');
    status('The app did not start', 'failed');
    return false;
  }
  status('Running in your browser', 'done');
  ui.reload.disabled = false;
  return true;
}

/** The running app's databases, as the runtime has them now; null if it could not tell (failed, or no answer in time). */
async function readData(): Promise<FileTree | null> {
  const read = (window as unknown as { __sandburgReadFiles?: (match: string) => Promise<FileTree> }).__sandburgReadFiles;
  if (!read) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
  const data = await Promise.race([read(DATA_FILES).catch(() => null), timeout]);
  if (!data) return null;
  const names = Object.keys(data);
  if (names.length) print(`keeping the app's data: ${names.join(', ')}`, 'dim');
  return data;
}

async function loadHost(): Promise<HostApi> {
  await import(new URL('host.js', site).href);
  return (window as unknown as { __sandburg: HostApi }).__sandburg;
}

/** Applies the model's edits: into the running app when it can take them, else as a new run. */
async function apply(edits: FileEdit[]): Promise<void> {
  const before = state.files;
  const { files, changed, deleted } = applyEdits(before, edits);
  state.files = files;
  renderFiles();
  save();
  ui.download.disabled = !Object.keys(files).length;
  if (!changed.length && !deleted.length) {
    if (!state.running) await run(files);
    return;
  }
  state.errors = [];
  sendState();
  const framework = detectFramework(files, typeof files['package.json'] === 'string' ? safeParse(files['package.json']) : null);
  if (state.running && framework === state.runningFramework && !needsRestart(changed, deleted, framework)) {
    const write = (window as unknown as { __sandburgWriteFile?: (path: string, content: string) => void }).__sandburgWriteFile;
    if (write) {
      for (const path of changed) write(path, files[path] as string);
      print(`\nupdated ${changed.join(', ')}`, 'dim');
      // A static site or a plain Node server (Express serving public/) has no dev server to tell the page: load it again.
      if (framework === 'static' || framework === 'unknown') setTimeout(() => ui.frame.contentWindow?.location.reload(), 150);
      status('Updated', 'done');
      return;
    }
  }
  await run(files);
}

function safeParse(text: string): PackageJson | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The model

async function ask(text: string, display: string, isFix = false): Promise<void> {
  if (!isFix) state.fixesLeft = prefs.autofix ? 2 : 0;
  setBusy(true);
  say(isFix ? 'note' : 'user', display);
  const base = state.turns.length;
  state.turns.push({ role: 'user', text });
  resetSteps('write');
  step('write', 'active');
  status('Writing code', 'active');
  let started = performance.now();
  let model = '';
  let message: ReturnType<typeof modelMessage> | null = null;
  try {
    const result = await callModel(state.turns, isFix, {
      onStart(m) {
        model = m;
        started = performance.now();
        message = modelMessage(m);
      },
      onText: (d) => message?.onText(d),
      onThinking: (d) => message?.onThinking(d),
    });
    state.turns.push(result.turn);
    const parsed = parseAnswer(result.turn.text);
    const served = result.model !== model ? ` · answered by ${result.model}` : '';
    message!.finish(`${seconds(performance.now() - started)} · ${tokens(result.usage.input)} in · ${tokens(result.usage.output)} out${served}`);
    if (result.stop === 'refusal') throw new Error('The model declined this request.');
    if (result.stop === 'max_tokens') say('error', `The answer was cut off at the output limit${parsed.open ? ` while writing ${parsed.open.path}` : ''}. The complete files are applied; ask for the rest.`);
    if (parsed.rejected.length) say('error', `Ignored files outside the project: ${parsed.rejected.join(', ')}`);
    if (!parsed.edits.length && !Object.keys(state.files).length) throw new Error('The answer had no files.');
    step('write', 'done', seconds(performance.now() - started));
    // Busy until the run settles: a new request now would start a run beside this one.
    await apply(parsed.edits);
  } catch (e) {
    // The conversation goes back to where it was: it only ever grows by whole exchanges.
    state.turns.length = base;
    const aborted = (e as Error).name === 'AbortError';
    (message as ReturnType<typeof modelMessage> | null)?.finish(aborted ? 'stopped' : '');
    step('write', 'failed');
    status(aborted ? 'Stopped' : 'The model did not answer', 'failed');
    if (!aborted) say('error', (e as Error).message);
  } finally {
    setBusy(false);
    save();
    if (state.errors.length) scheduleAutoFix();
  }
}

let autoFixTimer = 0;

/** When the app reports errors and auto-fix is on: send them to the model, a moment later (more may come). */
function scheduleAutoFix(): void {
  if (!prefs.autofix || state.fixesLeft <= 0 || state.busy || autoFixTimer) return;
  autoFixTimer = window.setTimeout(() => {
    autoFixTimer = 0;
    if (!state.errors.length || state.busy || state.fixesLeft <= 0) return;
    state.fixesLeft--;
    void fix(`The app reported errors; asking the model to fix them (${2 - state.fixesLeft} of 2).`);
  }, 2500);
}

function fix(display = 'Fix the errors the app reported.'): Promise<void> {
  const errors = state.errors.slice();
  state.errors = [];
  return ask(fixMessage(errors, state.files), display, true);
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  sendState();
}

// ---------------------------------------------------------------------------------------------
// Files, saving, downloading

function renderFiles(): void {
  const paths = Object.keys(state.files).sort();
  ui.fileList.replaceChildren(
    ...paths.map((p) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p;
      b.addEventListener('click', () => {
        for (const x of ui.fileList.querySelectorAll('button')) x.removeAttribute('aria-current');
        b.setAttribute('aria-current', 'true');
        const c = state.files[p];
        ui.fileView.textContent = typeof c === 'string' ? c : '(binary)';
      });
      li.append(b);
      return li;
    }),
  );
  ui.fileView.textContent = paths.length ? 'Choose a file.' : '';
}

const SAVED = 'sandburg-generator-app';

/** The app survives a reload of the tab (not of the browser). */
function save(): void {
  try {
    storage('session')?.setItem(SAVED, JSON.stringify({ templateId: state.templateId, files: state.files, turns: state.turns }));
  } catch {
    // too big for session storage: a reload starts over
  }
}

function restore(): boolean {
  try {
    const saved = JSON.parse(storage('session')?.getItem(SAVED) ?? 'null') as { templateId: string; files: FileTree; turns: Turn[] } | null;
    if (!saved?.turns?.length) return false;
    Object.assign(state, { templateId: saved.templateId, files: saved.files, turns: saved.turns });
    for (const t of saved.turns) {
      if (t.role === 'user') say('user', t.text.startsWith('Stack: ') ? (/\nTask: ([\s\S]*)$/.exec(t.text)?.[1] ?? t.text) : t.text.startsWith('The app did not work.') ? 'Fix the errors the app reported.' : t.text);
      else {
        const m = modelMessage('model');
        m.onText(t.text);
        m.finish('');
      }
    }
    say('note', 'Restored this tab\'s app. Run it again with the button in the preview.');
    renderFiles();
    ui.download.disabled = false;
    return true;
  } catch {
    return false;
  }
}

function newApp(): void {
  if (state.busy) return;
  // The next app starts in a runtime of its own: edits must not go into this one.
  runs++;
  state.running = false;
  void api?.dispose();
  ui.frame.src = 'about:blank';
  ui.placeholder.hidden = false;
  ui.reload.disabled = true;
  ui.download.disabled = true;
  resetSteps('write');
  status('Ready', 'idle');
  state.turns = [];
  state.files = {};
  state.data = {};
  state.errors = [];
  storage('session')?.removeItem(SAVED);
  ui.conversation.replaceChildren();
  say('note', 'Starting over. Describe the next app.');
  renderFiles();
  setBusy(false);
}

// ---------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    status('Not supported', 'failed');
    say('error', 'This page needs service workers, which this browser (or this private window) does not offer.');
    return;
  }
  const reloaded = 'sandburg-reloaded:generate';
  if (!self.crossOriginIsolated) {
    // First visit: the service worker gives this page the headers for shared memory.
    await navigator.serviceWorker.register(sw.url, { scope: sw.scope });
    await navigator.serviceWorker.ready;
    if (storage('session')?.getItem(reloaded)) {
      storage('session')?.removeItem(reloaded);
      status('Not isolated', 'failed');
      say('error', isolationFailure());
      return;
    }
    storage('session')?.setItem(reloaded, '1');
    location.reload();
    return;
  }
  storage('session')?.removeItem(reloaded);
  // The vault comes first: before any generated code runs in this page.
  await createVault();
  hookConsole();
  watchFrame();

  for (const b of document.querySelectorAll<HTMLButtonElement>('.example')) {
    b.addEventListener('click', () => toVault({ type: 'fill', text: b.textContent ?? '' }));
  }
  ui.reload.addEventListener('click', () => ui.frame.contentWindow?.location.reload());
  ui.download.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zip(state.files, 'app')], { type: 'application/zip' }));
    a.download = 'app.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  for (const [tab, panel] of [
    [ui.tabTerminal, ui.terminal],
    [ui.tabFiles, ui.files],
  ] as const) {
    tab.addEventListener('click', () => {
      for (const [t, p] of [
        [ui.tabTerminal, ui.terminal],
        [ui.tabFiles, ui.files],
      ] as const) {
        t.setAttribute('aria-selected', String(t === tab));
        p.hidden = p !== panel;
      }
    });
  }

  // ?scaffold=<framework>: run a framework's scaffold as it is, without a model (the site's build checks each).
  const scaffold = new URLSearchParams(location.search).get('scaffold');
  if (scaffold) {
    const tpl = template(scaffold);
    state.files = { ...tpl.files };
    renderFiles();
    say('note', `Running the ${tpl.label} scaffold without a model.`);
    await run(state.files);
    return;
  }
  // A restored app runs when the visitor asks: generated code runs only after the vault is in place
  // and the visitor has seen the page as it should be.
  if (restore()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Run the restored app';
    button.addEventListener('click', () => void run(state.files), { once: true });
    ui.placeholder.querySelector('div')!.append(button);
  }
}

Object.assign(window, { __generator: state });
boot().catch((e) => {
  status('Failed', 'failed');
  say('error', String((e as Error)?.message ?? e));
});
