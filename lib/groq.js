// Minimal Groq client (OpenAI-compatible Chat Completions) using fetch.
// No SDK, so the same code runs on Node, Vercel and Render unchanged.

// gpt-oss-120b: reliable function calling and still very fast on Groq.
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export class GroqError extends Error {
  constructor(status, body) {
    super(`Groq API error ${status}: ${String(body).slice(0, 500)}`);
    this.status = status;
    this.body = String(body);
  }
  /** The model occasionally emits a malformed tool call; Groq rejects it with this code. */
  get isToolUseFailure() {
    return this.body.includes('tool_use_failed');
  }
}

export function getConfig() {
  return {
    apiKey: process.env.GROQ_API_KEY,
    // Any OpenAI-compatible endpoint works; Groq is the default for its latency.
    baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
    summaryModel: process.env.GROQ_SUMMARY_MODEL || process.env.GROQ_MODEL || DEFAULT_MODEL,
    reasoningEffort: process.env.GROQ_REASONING_EFFORT || 'low',
    // Each Groq model has its own rate limit, so falling back to another
    // model on a 429 keeps the call alive instead of going silent.
    fallbackModels: (process.env.GROQ_FALLBACK_MODELS ?? 'openai/gpt-oss-20b,qwen/qwen3.8-27b')
      .split(',').map((m) => m.trim()).filter(Boolean),
  };
}

// Models that just returned 429, and when they can be tried again.
const cooldownUntil = new Map();
const RETRYABLE = new Set([404, 429, 500, 502, 503]);

function retryAfterMs(status, body) {
  if (status !== 429) return 0;
  const m = String(body).match(/try again in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 10_000;
}

// Reasoning models think before answering. For a voice call we keep that
// short: a little reasoning helps tool choice, a lot adds dead air.
function reasoningParams(model, effort) {
  if (/gpt-oss/.test(model)) return { reasoning_effort: effort, include_reasoning: false };
  if (/qwen3/.test(model)) return { reasoning_effort: 'none' };
  return {};
}

/**
 * Call the chat completions endpoint.
 * With stream=true, text deltas are passed to onText as they arrive and
 * tool-call fragments are stitched together.
 * Resolves to { content, toolCalls }.
 */
export async function chatCompletion({
  messages,
  tools,
  stream = false,
  onText,
  signal,
  model,
  temperature = 0.3,
  maxTokens = 400, // includes hidden reasoning tokens on reasoning models
  responseFormat,
}) {
  const { apiKey, baseUrl, model: defaultModel, reasoningEffort, fallbackModels } = getConfig();
  if (!apiKey) throw new GroqError(500, 'GROQ_API_KEY is not set on the server.');

  const primary = model || defaultModel;
  const candidates = [primary, ...fallbackModels.filter((m) => m !== primary)];
  const now = Date.now();
  // Prefer models that aren't cooling down; if all are, try them anyway.
  const ordered = [
    ...candidates.filter((m) => (cooldownUntil.get(m) ?? 0) <= now),
    ...candidates.filter((m) => (cooldownUntil.get(m) ?? 0) > now),
  ];

  let res;
  for (let i = 0; i < ordered.length; i++) {
    const chosenModel = ordered[i];
    const body = {
      model: chosenModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream,
      ...reasoningParams(chosenModel, reasoningEffort),
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = false;
    }
    if (responseFormat) body.response_format = responseFormat;

    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) break;

    const errBody = await res.text();
    const wait = retryAfterMs(res.status, errBody);
    if (wait) cooldownUntil.set(chosenModel, Date.now() + wait);
    if (!RETRYABLE.has(res.status) || i === ordered.length - 1) throw new GroqError(res.status, errBody);
    console.warn(`[groq] ${chosenModel} returned ${res.status}; falling back to ${ordered[i + 1]}`);
  }

  if (!stream) {
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    return { content: msg.content ?? '', toolCalls: msg.tool_calls ?? [] };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];

  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const json = JSON.parse(data);
    if (json.error) throw new GroqError(400, JSON.stringify(json.error));
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? toolCalls.length;
      toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handleLine(buffer);

  return {
    content,
    toolCalls: toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_${Date.now()}_${i}` })),
  };
}
