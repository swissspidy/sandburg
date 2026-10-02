/**
 * The generator's key vault: a sandboxed frame (srcdoc, no allow-same-origin, so its origin is
 * opaque) that the page creates before any generated code runs. The visitor types the API key here,
 * and the model is called from here: the page and the generated app, which share the page's origin,
 * can neither read this frame nor change its fetch. The page gets the model's answers, never the key.
 *
 * The vault calls the model only when the visitor asks in it (Generate, Fix), plus up to two error
 * fixes after a request when auto-fix is on: a generated app that takes over the page cannot spend
 * the key on its own calls. An opaque origin has no storage, so the key lasts for this visit only.
 */
import { call, listModels, MODELS, ProviderError, type Provider } from './llm.ts';
import type { FromVault, Prefs, ToVault } from './protocol.ts';

const CSS = `
:root { --bg: #f7f6f3; --panel: #fff; --ink: #1d1c1a; --muted: #6b6760; --line: #e2dfd8; --accent: #b4542d; --ok: #2f7d4f; --err: #b3261e; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #141412; --panel: #1d1c19; --ink: #ece9e2; --muted: #9c978d; --line: #2f2d28; --accent: #e0835a; --ok: #6cc08e; --err: #f08a80; color-scheme: dark; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; gap: 10px; padding: 1px; }
.settings { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; }
.settings summary { cursor: pointer; font-weight: 600; }
.settings summary .key-state { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 6px; }
.settings summary .key-state.set { color: var(--ok); }
.settings[open] summary { margin-bottom: 8px; }
.field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
.row { display: flex; gap: 8px; }
.row .field { min-width: 0; flex: 1; }
.with-button { display: flex; gap: 4px; }
.with-button select { flex: 1; min-width: 0; }
.check { display: flex; gap: 6px; align-items: center; font-size: 13px; margin-bottom: 6px; }
.hint { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.hint strong { color: var(--ink); font-weight: 600; }
select, input[type="password"], textarea { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { width: 100%; resize: vertical; min-height: 72px; display: block; }
:is(select, input, textarea, button):focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 6px 14px; }
button:disabled { opacity: 0.55; cursor: default; }
button.quiet, button.icon { background: transparent; color: var(--ink); border-color: var(--line); }
button.quiet:hover, button.icon:hover { border-color: var(--accent); }
button.icon { padding: 4px 9px; }
button.fix { background: transparent; border-color: var(--err); color: var(--err); }
.actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.spacer { flex: 1; }
.error { color: var(--err); font-size: 13px; margin: 6px 0 0; }
.error:empty { display: none; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[hidden] { display: none !important; }
`;

const HTML = `
<details class="settings" id="settings" open>
  <summary>Model and stack <span class="key-state" id="key-state">no API key</span></summary>
  <div class="row">
    <label class="field">Provider
      <select id="provider">
        <option value="anthropic">Anthropic (Claude)</option>
        <option value="gemini">Google (Gemini)</option>
      </select>
    </label>
    <label class="field">Model
      <span class="with-button">
        <select id="model"></select>
        <button type="button" id="load-models" class="icon" title="Load the provider's model list" aria-label="Load the provider's model list">↻</button>
      </span>
    </label>
  </div>
  <label class="field">API key
    <input id="api-key" type="password" autocomplete="off" spellcheck="false">
  </label>
  <p class="hint" id="key-hint"></p>
  <label class="field">Framework
    <select id="framework"></select>
  </label>
  <label class="check"><input id="autofix" type="checkbox"> Send errors back to the model to fix (up to 2 tries)</label>
</details>
<form id="composer">
  <label class="visually-hidden" for="task">What should the app do?</label>
  <textarea id="task" rows="3" placeholder="Describe the app…"></textarea>
  <div class="actions">
    <button type="button" id="new-app" class="quiet" hidden>New app</button>
    <span class="spacer"></span>
    <button type="button" id="fix" class="fix" hidden>Fix errors</button>
    <button type="button" id="stop" class="quiet" hidden>Stop</button>
    <button type="submit" id="generate">Generate</button>
  </div>
  <p class="error" id="error" role="alert"></p>
</form>
`;

/** A request the visitor allowed, for a few seconds: the page asks for the call right after the click. */
const GRANT_MS = 10_000;

function main(): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  document.body.innerHTML = HTML;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const ui = {
    settings: $<HTMLDetailsElement>('settings'),
    keyState: $('key-state'),
    provider: $<HTMLSelectElement>('provider'),
    model: $<HTMLSelectElement>('model'),
    loadModels: $<HTMLButtonElement>('load-models'),
    apiKey: $<HTMLInputElement>('api-key'),
    keyHint: $('key-hint'),
    framework: $<HTMLSelectElement>('framework'),
    autofix: $<HTMLInputElement>('autofix'),
    composer: $<HTMLFormElement>('composer'),
    task: $<HTMLTextAreaElement>('task'),
    newApp: $<HTMLButtonElement>('new-app'),
    fix: $<HTMLButtonElement>('fix'),
    stop: $<HTMLButtonElement>('stop'),
    generate: $<HTMLButtonElement>('generate'),
    error: $('error'),
  };

  // The keys, for this visit only: in this frame's memory and nowhere else.
  const keys: Partial<Record<Provider, string>> = {};
  let prefs: Prefs = { provider: 'anthropic', models: {}, modelLists: {}, framework: 'react', autofix: true };
  let grant = { call: 0, fixes: 0 };
  let abort: AbortController | null = null;

  const post = (message: FromVault) => window.parent.postMessage(message, '*');
  const savePrefs = () => post({ type: 'prefs', prefs });
  const fail = (message: string) => (ui.error.textContent = message);

  function renderProvider(): void {
    const p = prefs.provider;
    ui.provider.value = p;
    const list = prefs.modelLists[p]?.length ? prefs.modelLists[p]! : MODELS[p];
    ui.model.replaceChildren(...list.map((m) => new Option(m.label === m.id ? m.id : `${m.label} (${m.id})`, m.id)));
    const wanted = prefs.models[p] ?? MODELS[p][0].id;
    if (![...ui.model.options].some((o) => o.value === wanted)) ui.model.add(new Option(wanted, wanted));
    ui.model.value = wanted;
    ui.apiKey.value = keys[p] ?? '';
    ui.apiKey.placeholder = p === 'anthropic' ? 'sk-ant-…' : 'AIza…';
    const host = p === 'anthropic' ? 'api.anthropic.com' : 'generativelanguage.googleapis.com';
    ui.keyHint.innerHTML = `The key stays in this sandboxed frame, which the page and the generated app cannot read, and goes only to <code>${host}</code>. It is not stored: you enter it once per visit. <strong>If you are asked for it again after an app ran, reload the page.</strong>`;
    renderKeyState();
  }

  function renderKeyState(): void {
    const set = !!keys[prefs.provider];
    ui.keyState.textContent = set ? '· key set' : '· no API key';
    ui.keyState.classList.toggle('set', set);
  }

  ui.provider.addEventListener('change', () => {
    prefs.provider = ui.provider.value as Provider;
    savePrefs();
    renderProvider();
  });
  ui.model.addEventListener('change', () => {
    prefs.models[prefs.provider] = ui.model.value;
    savePrefs();
  });
  ui.apiKey.addEventListener('input', () => {
    keys[prefs.provider] = ui.apiKey.value.trim();
    renderKeyState();
  });
  ui.framework.addEventListener('change', () => {
    prefs.framework = ui.framework.value;
    savePrefs();
  });
  ui.autofix.addEventListener('change', () => {
    prefs.autofix = ui.autofix.checked;
    if (!prefs.autofix) grant.fixes = 0;
    savePrefs();
  });
  ui.loadModels.addEventListener('click', async () => {
    const key = keys[prefs.provider];
    if (!key) return ui.apiKey.focus();
    ui.loadModels.disabled = true;
    fail('');
    try {
      prefs.modelLists[prefs.provider] = await listModels(prefs.provider, key);
      savePrefs();
      renderProvider();
    } catch (e) {
      fail(`Could not load the model list: ${(e as Error).message}`);
    } finally {
      ui.loadModels.disabled = false;
    }
  });

  ui.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.task.value.trim();
    if (!text) return ui.task.focus();
    if (!keys[prefs.provider]) {
      ui.settings.open = true;
      ui.apiKey.focus();
      return fail('Add an API key for the provider first.');
    }
    fail('');
    ui.task.value = '';
    grant = { call: performance.now() + GRANT_MS, fixes: prefs.autofix ? 2 : 0 };
    ui.settings.open = false;
    post({ type: 'submit', text });
  });
  ui.task.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ui.composer.requestSubmit();
  });
  ui.fix.addEventListener('click', () => {
    if (!keys[prefs.provider]) {
      ui.settings.open = true;
      ui.apiKey.focus();
      return fail('Add an API key for the provider first.');
    }
    grant.fixes = Math.max(grant.fixes, 1);
    post({ type: 'fix' });
  });
  ui.newApp.addEventListener('click', () => post({ type: 'new-app' }));
  ui.stop.addEventListener('click', () => abort?.abort());

  async function run(id: number, system: string, turns: Parameters<typeof call>[0]['turns'], fix: boolean): Promise<void> {
    const allowed = fix ? grant.fixes > 0 : grant.call > performance.now();
    if (!allowed || abort) {
      post({ type: 'error', id, message: 'The vault calls the model only when you ask for it here (Generate or Fix errors).', aborted: false });
      return;
    }
    if (fix) grant.fixes--;
    else grant.call = 0;
    const provider = prefs.provider;
    const key = keys[provider];
    if (!key) {
      post({ type: 'error', id, message: 'Add an API key for the provider first.', aborted: false });
      return;
    }
    const model = ui.model.value;
    abort = new AbortController();
    ui.stop.hidden = false;
    post({ type: 'start', id, model });
    try {
      const result = await call({
        provider,
        model,
        apiKey: key,
        system,
        turns,
        signal: abort.signal,
        onText: (delta) => post({ type: 'text', id, delta }),
        onThinking: (delta) => post({ type: 'thinking', id, delta }),
      });
      post({ type: 'done', id, result });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      // Provider errors are worded for the visitor (llm.ts) and never carry the key.
      post({ type: 'error', id, message: e instanceof ProviderError || aborted ? (e as Error).message : `The request failed: ${(e as Error).message}`, aborted });
    } finally {
      abort = null;
      ui.stop.hidden = true;
    }
  }

  window.addEventListener('message', (e: MessageEvent<ToVault>) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (m?.type === 'init') {
      prefs = { ...prefs, ...m.prefs };
      ui.framework.replaceChildren(...m.frameworks.map((f) => new Option(f.label, f.id)));
      ui.framework.value = m.frameworks.some((f) => f.id === prefs.framework) ? prefs.framework : m.frameworks[0]?.id;
      ui.autofix.checked = prefs.autofix;
      renderProvider();
    } else if (m?.type === 'state') {
      ui.generate.disabled = m.busy;
      ui.task.disabled = m.busy;
      ui.generate.textContent = m.started ? 'Send' : 'Generate';
      ui.task.placeholder = m.started ? 'Ask for a change…' : 'Describe the app…';
      ui.newApp.hidden = m.busy || !m.started;
      ui.fix.hidden = m.busy || !m.errors;
      // The framework applies to a new app only.
      ui.framework.disabled = m.started;
    } else if (m?.type === 'fill') {
      ui.task.value = m.text;
      ui.task.focus();
    } else if (m?.type === 'call') {
      void run(m.id, m.system, m.turns, m.fix);
    }
  });

  new ResizeObserver(() => post({ type: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 })).observe(document.body);
  post({ type: 'ready' });
}

main();
