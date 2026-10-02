/**
 * The model, called from the page with the visitor's own API key: Anthropic's Messages API or the
 * Gemini API, both streamed (server-sent events). Both answer cross-origin requests; the key goes
 * from this page to the provider and nowhere else.
 */

export type Provider = 'anthropic' | 'gemini';

/** One turn of the conversation. A model's turn keeps the provider's own blocks, to send back unchanged. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** Anthropic content blocks (thinking blocks included, which must come back as they were). */
  anthropic?: { model: string; content: unknown[] };
}

export interface CallOptions {
  provider: Provider;
  model: string;
  apiKey: string;
  system: string;
  turns: Turn[];
  signal?: AbortSignal;
  /** The answer as it streams. */
  onText(delta: string): void;
  /** The model's reasoning (a summary), as it streams. */
  onThinking?(delta: string): void;
}

export interface CallResult {
  turn: Turn;
  /** Why the answer ended: complete, or cut off (max_tokens), or declined. */
  stop: 'end' | 'max_tokens' | 'refusal' | string;
  usage: { input: number; output: number };
  /** The model that answered (a fallback may answer instead of the one asked). */
  model: string;
}

export const MODELS: Record<Provider, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  ],
};

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function call(options: CallOptions): Promise<CallResult> {
  return options.provider === 'anthropic' ? anthropic(options) : gemini(options);
}

/** The provider's models that can write an app, for the model list. */
export async function listModels(provider: Provider, apiKey: string): Promise<{ id: string; label: string }[]> {
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: anthropicHeaders(apiKey) });
    if (!res.ok) throw await providerError(res);
    const body = (await res.json()) as { data: { id: string; display_name?: string }[] };
    return body.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
  }
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw await providerError(res);
  const body = (await res.json()) as { models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return body.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini-/.test(m.name) && !/(tts|image|embedding|audio|live|robotics|computer-use|transcribe)/.test(m.name))
    .map((m) => ({ id: m.name.slice('models/'.length), label: m.displayName ?? m.name }));
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    // The key is the visitor's own, typed into this page: the request comes from their browser.
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

/** Models that think adaptively and take an effort level (Claude 4.6 and later, not Haiku). */
const ADAPTIVE = /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])/;
/** Models whose safety classifiers may decline a request: another model then answers (server-side fallback). */
const FALLBACK = /^claude-(opus-5-5|sonnet-5-5|fable-5-1|opus-5$|fable-5$)/;

async function anthropic(o: CallOptions): Promise<CallResult> {
  const headers = anthropicHeaders(o.apiKey);
  const body: Record<string, unknown> = {
    model: o.model,
    max_tokens: /haiku|4-5/.test(o.model) ? 64000 : 128000,
    stream: true,
    system: o.system,
    // The conversation grows by appending: each request reads the earlier turns from the cache.
    cache_control: { type: 'ephemeral' },
    messages: o.turns.map((t) => ({ role: t.role, content: t.anthropic && t.anthropic.model === o.model ? t.anthropic.content : t.text })),
  };
  if (ADAPTIVE.test(o.model)) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort: 'medium' };
  }
  if (FALLBACK.test(o.model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await providerError(res);

  const content: Record<string, unknown>[] = [];
  let text = '';
  let stop = 'end';
  let model = o.model;
  const usage = { input: 0, output: 0 };
  for await (const event of sse(res)) {
    const e = event as { type: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown>; message?: { model?: string; usage?: Record<string, number> }; usage?: Record<string, number>; error?: { message?: string } };
    if (e.type === 'message_start') {
      model = e.message?.model ?? model;
      const u = e.message?.usage ?? {};
      usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } else if (e.type === 'content_block_start' && e.content_block) {
      content[e.index!] = { ...e.content_block };
      if (e.content_block.type === 'text' && typeof e.content_block.text === 'string' && e.content_block.text) {
        text += e.content_block.text;
        o.onText(e.content_block.text);
      }
    } else if (e.type === 'content_block_delta' && e.delta) {
      const block = content[e.index!];
      const d = e.delta;
      if (d.type === 'text_delta') {
        block.text = String(block.text ?? '') + d.text;
        text += d.text as string;
        o.onText(d.text as string);
      } else if (d.type === 'thinking_delta') {
        block.thinking = String(block.thinking ?? '') + d.thinking;
        o.onThinking?.(d.thinking as string);
      } else if (d.type === 'signature_delta') {
        block.signature = d.signature;
      }
    } else if (e.type === 'message_delta') {
      const reason = (e.delta as { stop_reason?: string } | undefined)?.stop_reason;
      if (reason) stop = reason === 'end_turn' ? 'end' : reason;
      usage.output = e.usage?.output_tokens ?? usage.output;
    } else if (e.type === 'error') {
      throw new ProviderError(e.error?.message ?? 'the model stopped with an error', 500);
    }
  }
  // A fallback block marks where another model took over; the turn goes back as it came.
  return { turn: { role: 'assistant', text, anthropic: { model: o.model, content: content.filter(Boolean) } }, stop, usage, model };
}

async function gemini(o: CallOptions): Promise<CallResult> {
  const body = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: o.turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
    generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true } },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, { method: 'POST', headers: { 'x-goog-api-key': o.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: o.signal });
  if (!res.ok) throw await providerError(res);
  let text = '';
  let stop = 'end';
  let model = o.model;
  const usage = { input: 0, output: 0 };
  for await (const event of sse(res)) {
    const e = event as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: Record<string, number>; modelVersion?: string; error?: { message?: string } };
    if (e.error) throw new ProviderError(e.error.message ?? 'the model stopped with an error', 500);
    model = e.modelVersion ?? model;
    const candidate = e.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      if (part.thought) o.onThinking?.(part.text);
      else {
        text += part.text;
        o.onText(part.text);
      }
    }
    const reason = candidate?.finishReason;
    if (reason) stop = reason === 'STOP' ? 'end' : reason === 'MAX_TOKENS' ? 'max_tokens' : /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(reason) ? 'refusal' : reason.toLowerCase();
    if (e.usageMetadata) usage.input = e.usageMetadata.promptTokenCount ?? usage.input;
    if (e.usageMetadata) usage.output = (e.usageMetadata.candidatesTokenCount ?? 0) + (e.usageMetadata.thoughtsTokenCount ?? 0);
  }
  return { turn: { role: 'assistant', text }, stop, usage, model };
}

/** The events of a server-sent event stream, parsed as JSON. */
async function* sse(res: Response): AsyncGenerator<unknown> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (done) break;
  }
}

/** An error answer, worded for the visitor. */
async function providerError(res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } | Array<{ error?: { message?: string } }> };
    const error = Array.isArray(body) ? body[0]?.error : body.error;
    detail = error?.message ?? '';
  } catch {
    // not JSON
  }
  const hint = res.status === 401 || res.status === 403 ? 'the API key was not accepted' : res.status === 429 ? 'rate limited, try again in a moment' : res.status === 402 ? 'the account has no credit left' : `HTTP ${res.status}`;
  return new ProviderError(detail ? `${hint}: ${detail}` : hint, res.status);
}
