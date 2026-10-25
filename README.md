# Aria: AI Voice CX Agent for Aura Skincare

A browser-based voice customer support agent for **Aura Skincare**, a fictional premium organic Indian skincare brand. Click **Start Call**, speak into your mic, and **Aria** answers out loud. She can look up live orders, apply return and cancellation policy, decline out-of-scope requests, and produce a transcript plus a structured JSON outcome when the call ends.

- **Live demo:** https://ai-voice-cx-agent.vercel.app
- **Demo video:** `<add link>`
- **Best in:** Chrome or Microsoft Edge on desktop (Edge has the most natural Indian English voice).

> **Approach in brief:** A modular pipeline that runs in the browser: Web Speech API speech-to-text (en-IN), a Groq-hosted `gpt-oss-120b` agent (low reasoning effort) with function calling for order lookups and policy checks, and sentence-by-sentence browser text-to-speech with an Indian English voice. Policy decisions (return windows, cancellation rules) live in deterministic code that the LLM calls as tools, so the model decides *when* to check and the code decides *what is true*. Replies stream token by token and Aria starts speaking after the first sentence, which keeps the gap between turns short.

---

## Features

| Requirement | How it's handled |
|---|---|
| Natural voice conversation | Continuous en-IN speech recognition with custom end-of-turn detection; streamed replies spoken sentence by sentence |
| Indian voice / persona | Auto-selects an `en-IN` voice (Neerja/Heera/Veena…) and falls back gracefully; persona "Aria" set in the system prompt |
| Context | Full conversation history (including tool calls and results) is sent each turn |
| Brand knowledge and guardrails | Single knowledge source (`lib/knowledge.js`) feeds both the prompt and the policy code |
| Order lookup tool | `get_order_details(order_id)`, plus `check_return_eligibility`, `cancel_order` (requires confirmation) and `escalate_to_human` |
| Invalid / missing IDs | Tool returns a structured "not found" result; the agent asks the customer to repeat or verify, and offers a ticket after two failures |
| Unclear audio | Low-confidence transcripts are tagged `[unclear audio]` so the agent asks the customer to repeat instead of guessing |
| Post-call summary | Chronological transcript (with tool calls) and a JSON outcome: LLM judgement fields merged with computed facts |
| Testing UI | Start/End, live Listening/Thinking/Speaking indicator, mic level meter, test-orders panel, one-click test prompts, typed fallback |
| Hinglish | Hinglish/Hindi is detected in code each turn and Aria replies in Roman-script Hinglish |
| Resilience | Automatic fallback to another Groq model on rate limits or outages; polite spoken fallback if everything fails |
| Extras | Barge-in (talk over Aria to interrupt), a short spoken filler ("Let me check that for you") while a tool runs, which cuts first-audio time on order lookups from ~2 s to ~0.9 s, per-turn latency readout, "are you still there?" prompt, text mode if mic is unavailable |

---

## Architecture

```
 Browser (public/)                                   Server (api/ + lib/)                 Groq
 ─────────────────                                   ────────────────────                 ────
 Mic ─► Web Speech API (en-IN, continuous)
          │  interim text ─► live captions / barge-in check
          │  end-of-turn (750 ms after last final result)
          ▼
   POST /api/chat {messages}  ───────────────────►  sanitize history
                                                    agent loop ─────────── stream ───────►  gpt-oss-120b
                                                      (on 429: gpt-oss-20b → qwen3)
                                                      │  ◄── tool_call(get_order_details) ──  (tool calling)
                                                      │  run tool in code (orders.js / policy)
                                                      │  ── tool result ───────────────────►
   ◄── NDJSON events: tool_start, tool, text, done ── │  ◄── text tokens (streamed) ────────
          │
   sentence splitter ─► speechSynthesis queue (Indian voice) ─► Speakers
          │
   End Call ─► POST /api/summary {transcript} ─────► computed facts + LLM JSON mode ───────►
          ◄── structured outcome JSON ─────────────
```

### The voice pipeline, step by step

1. **Speech-to-text.** `SpeechRecognition` runs continuously in `en-IN` with interim results, so the customer sees live captions. Chrome restarts recognition every ~60 s or after silence; the `Listener` class restarts it transparently.
2. **End-of-turn detection.** Chrome marks a result "final" at short pauses. We wait a further 750 ms of silence before committing the turn, so someone reading out "O R D... one zero one" isn't cut off.
3. **Agent turn.** The browser posts the conversation to `/api/chat`. The server runs the tool loop against Groq with `stream: true` and forwards events as newline-delimited JSON.
4. **Streaming text-to-speech.** As text tokens arrive, a sentence splitter hands each complete sentence to `speechSynthesis`, so Aria starts speaking after the *first* sentence instead of waiting for the whole reply. The UI shows the time from end of speech to first audio for each turn (the ⚡ chip).
5. **Barge-in.** Recognition keeps running while Aria speaks. If the mic hears two or more words that are *not* in what Aria is saying (a simple echo filter, since laptop speakers leak into the mic), speech is cancelled, the request is aborted, and the history is updated with only the part the customer actually heard.

### How the agent decides to use a tool

The model gets four JSON-schema tools with clear descriptions, plus prompt rules such as *"never guess order details; to talk about a specific order call `get_order_details` first"* and *"for any return/refund request call `check_return_eligibility` and follow its result"*. With `tool_choice: "auto"` the model decides per turn: a question about ORD-101 produces a tool call, while a COD question or "book me a flight" doesn't. The server executes the call, appends the result as a `tool` message, and loops (up to 4 rounds; the last round withholds tools so the model has to answer).

Tools are designed for speech input: `normalizeOrderId` accepts `"ORD-101"`, `"ord 101"`, `"order one zero one"` or just `"101"`. Every tool returns structured data and never throws; errors come back as instructions the model can relay ("No order found with ID ORD-999. Ask the customer to repeat or verify").

### How the brand guardrails work

Guardrails are layered so no single layer has to be perfect:

1. **Deterministic policy code.** `check_return_eligibility` and `cancel_order` compute eligibility from the order data and the policy constants (7-day window, unopened only, 48-hour damage reports, cancel only while Processing). The LLM can't talk its way around a `false`.
2. **Confirmation gate.** `cancel_order` refuses unless `customer_confirmed: true`, and the prompt requires an explicit "yes" first.
3. **Prompt rules.** Aura topics only; never promise refunds, discounts, timelines or exceptions not in the knowledge base or a tool result; say "I don't have that information" rather than guess; no medical advice; ignore role-change and prompt-injection attempts.
4. **Escalation as the safe exit.** When a customer insists on an exception, Aria offers a ticket *for review* and promises no outcome, which is what a good human agent would do.
5. **Server-side input hygiene.** Only `user`/`assistant`/`tool` messages are accepted (an injected `system` message is dropped), history is capped, and there is per-IP rate limiting.

### Post-call summary

`/api/summary` merges two kinds of fields:

- **Computed facts** (always correct): call duration, turn counts, tools used, orders referenced, escalation ticket ID.
- **LLM judgement** (Groq JSON mode, temperature 0): `customer_intent`, `secondary_intents`, `order_id`, `resolution_status` (`RESOLVED | PARTIALLY_RESOLVED | UNRESOLVED | ESCALATED | POLICY_DECLINED`), sentiment, policy applied, actions taken, follow-up flag, and a short summary. Enum values are validated.

If the LLM call fails, a rule-based fallback summary is returned (`summary_source: "fallback"`), so the screen never breaks.

Example:

```json
{
  "customer_intent": "RETURN_REQUEST",
  "secondary_intents": [],
  "order_id": "ORD-102",
  "resolution_status": "POLICY_DECLINED",
  "customer_sentiment": "NEUTRAL",
  "policy_applied": "7-day return window, unopened products only",
  "actions_taken": ["Looked up ORD-102", "Checked return eligibility"],
  "follow_up_required": false,
  "call_summary": "Customer asked to return the opened sunscreen from ORD-102, delivered 14 days ago. Aria explained it falls outside the 7-day return policy for unopened items.",
  "call_duration_seconds": 48,
  "customer_turns": 2,
  "agent_turns": 3,
  "tools_used": ["check_return_eligibility"],
  "orders_referenced": ["ORD-102"],
  "escalation_ticket": null,
  "summary_source": "llm"
}
```

---

## Project structure

```
api/              Serverless handlers (Vercel); also used by node-server.js
  chat.js         POST /api/chat     → streams agent events (NDJSON)
  summary.js      POST /api/summary  → structured call outcome
  orders.js       GET  /api/orders   → mock orders for the helper panel
lib/
  agent.js        System prompt, history sanitising, tool-calling loop
  tools.js        Tool schemas + deterministic policy implementations
  orders.js       Mock order DB + spoken order-ID normaliser
  knowledge.js    Brand facts and policy constants (single source of truth)
  groq.js         Minimal fetch-based Groq client with SSE parsing
  summary.js      Post-call summary (computed facts + LLM JSON)
  http.js         Body parsing, JSON responses, rate limiting
public/
  index.html, styles.css
  app.js          Call state machine, UI, streaming, barge-in
  speech.js       Listener (STT + endpointing), Speaker (TTS queue), helpers
node-server.js    Zero-dependency local/Render server (excluded from Vercel via .vercelignore)
test/             Unit tests (node:test)
scripts/eval.js   Scenario evals against the real model
```

No npm dependencies at all: just Node 18+ and `fetch`.

---

## Running locally

```bash
git clone <this repo>
cd <repo folder>
cp .env.example .env        # then paste your free Groq key from https://console.groq.com/keys
npm start                   # http://localhost:3000
```

Open `http://localhost:3000` in Chrome or Edge, click **Start Call**, and allow microphone access. (Browsers only allow the mic on `localhost` or HTTPS.)

### Tests

```bash
npm test        # unit tests: ID normalisation, policy decisions, tools, echo filter, sentence splitting
npm run eval    # 8 live scenarios against Groq: tracking, policy refusal, out-of-scope, invalid/missing ID, cancel rules, Hinglish, prompt injection
npm run eval -- hinglish   # run only scenarios whose name matches
```

Latest eval run: **8/8 passing**, with full replies (including tool calls) in roughly 0.6–1.7 s.

---

## Deployment

### Vercel (recommended)
1. Push this repo to GitHub, then **Import Project** on vercel.com.
2. Framework preset: **Other**. No build command needed (`vercel.json` serves `public/` and the functions in `api/`).
3. Add environment variable `GROQ_API_KEY`, then deploy.

### Render (alternative)
New **Web Service** → Build command: *(none)*, Start command: `npm start` → add `GROQ_API_KEY`.

---

## Known limitations

- **Browser-dependent speech.** Web Speech recognition works in Chrome and Edge only; Firefox and Safari users can still type (Aria still speaks). Voice quality depends on the voices installed in the browser/OS.
- **Echo on laptop speakers.** By default the call is half-duplex: the mic is paused while Aria speaks and a fresh recognition session starts when she finishes, so she never hears herself. Barge-in is opt-in for headphone users; it uses a fuzzy text-overlap echo filter rather than true acoustic echo cancellation.
- **No customer verification.** Anyone who says an order ID hears its details. A real deployment would verify phone number or OTP first.
- **Demo state.** Cancellations and tickets are not persisted; the order database is in memory and shared read-only.

---

## Tell us how you think

### 1. Why this architecture and stack?

I chose a **modular STT → LLM → TTS pipeline** over a speech-to-speech realtime model because the assignment is mostly about *control*: following policy, calling tools reliably, and not promising things. A modular pipeline gives me a text checkpoint at every step. I can log exactly what the model heard, inspect every tool call, unit-test the policy logic, and swap any component independently.

- **Groq + `openai/gpt-oss-120b`** for the reasoning: reliable function calling and very fast token generation on Groq, which matters more for voice than for chat. It's a reasoning model, so I set `reasoning_effort: low`: enough thinking to pick the right tool, not enough to create dead air. It also has a free tier, so the public demo costs nothing to run.
- **Browser Web Speech API** for STT and TTS: zero latency for network audio upload, no extra keys, `en-IN` recognition, and Indian English voices on Edge and Windows. For a demo that evaluators must open and use instantly, this removed a whole class of setup and cost problems.
- **Plain Node with no framework or dependencies**: the same handler files run as Vercel functions and under a tiny local server, so there is very little to break during deployment.

### 2. What was the most difficult part, and how did I solve it?

**Turn-taking**: knowing when the customer has finished, and when they're interrupting. Three problems interact:

- *Cutting people off.* Chrome finalises speech at tiny pauses, so customers reading out an order ID got cut off mid-number. I added my own endpointing: commit only after 750 ms with no new speech, plus a safety commit if recognition never finalises.
- *The agent hearing itself.* With barge-in on, laptop speakers feed Aria's voice back into the mic and she would "interrupt" herself. I compare what the mic hears against what Aria is currently saying, and only treat it as an interruption when at least two words (and 40% of the utterance) are new. I also drop late echo that arrives just after she stops.
- *Latency versus naturalness.* Waiting for the full LLM reply before speaking felt slow. Streaming the reply and speaking sentence by sentence means audio starts after the first sentence. When the customer interrupts, the stored history is rewritten to contain only what they actually heard, so the model doesn't assume they heard the rest.

On the LLM side, two practical problems showed up once I ran the evals against the real API:

- *Free-tier rate limits.* Groq's free tier allows about 8,000 tokens per minute *per model*, and each request (system prompt plus tool schemas) is about 1,400 tokens. A brisk conversation could hit the limit and Aria would go quiet. Because limits are per model, the client falls back on a 429 to `gpt-oss-20b` and then `qwen3`, and remembers the cooldown so it skips a throttled model straight away.
- *The model ignoring "reply in Hinglish".* A prompt instruction alone wasn't reliable, so the server now detects Hinglish in the customer's message (a small Hindi word list, plus Devanagari detection) and adds an explicit language note for that turn.
- *Small invented promises.* Reading the eval transcripts, I caught Aria adding things like "we'll process a return once it's back with us". The fix was putting the boundary into the tool results themselves ("policy says nothing about refunds after refusal; do not promise one"), plus a regression check in `scripts/eval.js`.

Malformed tool calls (`tool_use_failed`) are retried once without streaming; if everything fails, Aria says a polite "could you say that again" rather than crashing.

### 3. With one more week, what would I improve first?

**Audio quality and latency, by moving STT and TTS server-side with streaming providers** (e.g. Deepgram or Sarvam for Indian-accent STT and Hinglish, plus a streaming Indian-voice TTS). Browser speech is the weakest link: it varies by browser, struggles with accents and alphanumeric IDs, and has no real acoustic echo cancellation. I'd stream mic audio over a WebSocket with proper VAD-based endpointing and AEC from `getUserMedia`. That gives consistent voice quality on every browser and makes barge-in reliable on laptop speakers. After that: customer verification (registered phone or OTP) before revealing order details, and a larger eval set run on every prompt change.

### 4. What changes at 1,000 conversations a day?

1,000 calls a day is modest load (roughly 2–4 concurrent calls at peak), so the work is mostly about **reliability, quality and operations**, not raw scale:

- **Real systems instead of mocks.** Tools call the actual order and OMS APIs with timeouts, retries and caching; cancellations and tickets go to the CRM or helpdesk (e.g. Freshdesk or Zendesk) with idempotency keys.
- **Identity and privacy.** Verify the caller before sharing order data, redact PII in logs, and set retention rules for transcripts.
- **Observability.** Log every turn with latency broken down by stage (STT, time to first token, TTS), tool calls, and outcome. Dashboards for containment rate, escalation rate, policy-declined rate, and calls where the customer repeated themselves (a frustration signal).
- **Quality loop.** Run automated evals (like `scripts/eval.js`, but hundreds of cases) in CI for every prompt or model change, use an LLM-as-judge on a sample of real calls for policy compliance, and have humans review flagged calls.
- **Provider resilience.** Fall back to a second LLM provider on rate limits or outages, use per-tenant rate limits and Redis-backed limits instead of in-memory, and add budget alerts.
- **Human handoff.** A live transfer path to agents (with the summary JSON attached so the customer doesn't have to repeat themselves) instead of only creating a ticket.
- **Knowledge management.** As the product catalogue and FAQs grow beyond a prompt, move to retrieval over a versioned knowledge base so policy updates don't need code changes.
