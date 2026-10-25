// Minimal Groq client (OpenAI-compatible Chat Completions) using fetch.
// No SDK, so the same code runs on Node, Vercel and Render unchanged.

export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export class GroqError extends Error {
  constructor(status, body) {
    super(`Groq API error ${status}: ${String(body).slice(0, 500)}`);
    this.status = status;
    this.body = String(body);
  }
  /** Llama occasionally emits a malformed tool call; Groq rejects it with this code. */
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
  };
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
  maxTokens = 300,
  responseFormat,
}) {
  const { apiKey, baseUrl, model: defaultModel } = getConfig();
  if (!apiKey) throw new GroqError(500, 'GROQ_API_KEY is not set on the server.');

  const body = {
    model: model || defaultModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = false;
  }
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new GroqError(res.status, await res.text());

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
