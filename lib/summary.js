// Post-call summary. Facts that code can know (duration, tools used, order
// IDs looked up) are computed deterministically; judgement calls (intent,
// resolution, sentiment, summary text) come from the LLM in JSON mode.
// If the LLM is unavailable we still return a useful heuristic summary.

import { chatCompletion, getConfig } from './groq.js';
import { normalizeOrderId, ORDERS } from './orders.js';

export const INTENTS = [
  'ORDER_TRACKING', 'RETURN_REQUEST', 'REFUND_REQUEST', 'CANCELLATION', 'DAMAGED_PRODUCT',
  'SHIPPING_INFO', 'COD_INFO', 'PRODUCT_QUERY', 'OUT_OF_SCOPE', 'OTHER', 'NO_INTERACTION',
];
export const RESOLUTIONS = ['RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED', 'ESCALATED', 'POLICY_DECLINED'];

const SUMMARY_PROMPT = `
You analyse customer support call transcripts for Aura Skincare and output ONLY a JSON object with exactly these keys:
{
  "customer_intent": one of ${JSON.stringify(INTENTS)} (the main reason for the call),
  "secondary_intents": array of other intents from the same list (may be empty),
  "order_id": the main order ID discussed like "ORD-101", or null,
  "resolution_status": one of ${JSON.stringify(RESOLUTIONS)},
  "customer_sentiment": one of ["POSITIVE","NEUTRAL","NEGATIVE"],
  "policy_applied": short phrase naming the policy that decided the outcome, or null,
  "actions_taken": array of short strings describing what the agent did,
  "follow_up_required": true or false,
  "call_summary": two sentences maximum, factual, past tense.
}
Use POLICY_DECLINED when the customer's request was refused because of Aura policy (e.g. return window expired, order not cancellable).
Use ESCALATED when a support ticket was raised. Base everything strictly on the transcript and tool results.
`.trim();

function transcriptToText(transcript) {
  return transcript
    .map((t) => {
      if (t.role === 'tool') return `[TOOL ${t.name}] args=${JSON.stringify(t.args ?? {})} result=${JSON.stringify(t.result ?? {})}`;
      return `${t.role === 'user' ? 'CUSTOMER' : 'AGENT'}: ${t.text}`;
    })
    .join('\n')
    .slice(0, 16000);
}

function deterministicFacts({ transcript, startedAt, endedAt }) {
  const tools = transcript.filter((t) => t.role === 'tool');
  const orderIds = new Set();
  for (const t of tools) {
    const id = normalizeOrderId(t.args?.order_id);
    if (id && ORDERS[id]) orderIds.add(id);
  }
  for (const t of transcript) {
    for (const m of String(t.text ?? '').matchAll(/\bORD[-\s]?(\d{3})\b/gi)) {
      const id = `ORD-${m[1]}`;
      if (ORDERS[id]) orderIds.add(id);
    }
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return {
    call_duration_seconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null,
    customer_turns: transcript.filter((t) => t.role === 'user').length,
    agent_turns: transcript.filter((t) => t.role === 'agent').length,
    tools_used: tools.map((t) => t.name),
    orders_referenced: [...orderIds],
    escalation_ticket: tools.find((t) => t.name === 'escalate_to_human')?.result?.ticket_id ?? null,
  };
}

function heuristicSummary(facts) {
  const tools = facts.tools_used;
  let intent = 'OTHER';
  if (tools.includes('cancel_order')) intent = 'CANCELLATION';
  else if (tools.includes('check_return_eligibility')) intent = 'RETURN_REQUEST';
  else if (tools.includes('get_order_details')) intent = 'ORDER_TRACKING';
  return {
    customer_intent: intent,
    secondary_intents: [],
    order_id: facts.orders_referenced[0] ?? null,
    resolution_status: facts.escalation_ticket ? 'ESCALATED' : 'UNRESOLVED',
    customer_sentiment: 'NEUTRAL',
    policy_applied: null,
    actions_taken: tools.map((t) => `Called ${t}`),
    follow_up_required: Boolean(facts.escalation_ticket),
    call_summary: 'Automatic summary unavailable; generated from call metadata only.',
  };
}

export async function summarizeCall({ transcript = [], startedAt, endedAt }) {
  const clean = Array.isArray(transcript) ? transcript.slice(-200) : [];
  const facts = deterministicFacts({ transcript: clean, startedAt, endedAt });

  if (facts.customer_turns === 0) {
    return {
      customer_intent: 'NO_INTERACTION',
      secondary_intents: [],
      order_id: null,
      resolution_status: 'UNRESOLVED',
      customer_sentiment: 'NEUTRAL',
      policy_applied: null,
      actions_taken: [],
      follow_up_required: false,
      call_summary: 'The call ended before the customer said anything.',
      ...facts,
      summary_source: 'rules',
    };
  }

  try {
    const { content } = await chatCompletion({
      model: getConfig().summaryModel,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcriptToText(clean) },
      ],
      temperature: 0,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
    });
    const parsed = JSON.parse(content);
    if (!INTENTS.includes(parsed.customer_intent)) parsed.customer_intent = 'OTHER';
    if (!RESOLUTIONS.includes(parsed.resolution_status)) parsed.resolution_status = 'UNRESOLVED';
    if (parsed.order_id) parsed.order_id = normalizeOrderId(parsed.order_id);
    return { ...parsed, ...facts, summary_source: 'llm' };
  } catch (err) {
    console.error('[summary]', err.message);
    return { ...heuristicSummary(facts), ...facts, summary_source: 'fallback' };
  }
}
