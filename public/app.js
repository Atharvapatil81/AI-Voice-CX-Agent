import {
  Listener, Speaker, sttSupported, ttsSupported, takeSentences,
  rankVoices, loadVoices, isLikelyEcho,
} from './speech.js';

const GREETING = "Hi, I'm Aria from Aura Skincare. How can I help you today?";
const STILL_THERE = "Are you still there? I'm happy to help with anything about your Aura order.";
const SILENCE_PROMPT_MS = 15000;
const LOW_CONFIDENCE = 0.4;
// Spoken while a tool runs, so an order lookup doesn't leave dead air.
const FILLERS = ['Let me check that for you.', 'One moment, let me look that up.', 'Sure, checking that now.'];

const SCENARIOS = [
  { text: 'Where is my order ORD-101?', tag: 'tracking' },
  { text: 'I bought ORD-102 two weeks ago and opened it. Can I return it?', tag: 'policy' },
  { text: 'Please cancel my order ORD-103.', tag: 'cancel' },
  { text: 'Can you cancel ORD-101?', tag: 'not allowed' },
  { text: 'Can you check order ORD-999?', tag: 'invalid ID' },
  { text: 'I want to track my order.', tag: 'missing ID' },
  { text: 'Do you have cash on delivery?', tag: 'policy' },
  { text: 'Can you book me a flight to Goa?', tag: 'out of scope' },
  { text: 'Mera order ORD-101 kab tak aayega?', tag: 'Hinglish' },
];

const $ = (id) => document.getElementById(id);
const els = {
  orb: $('orb'), stateLabel: $('stateLabel'), stateDetail: $('stateDetail'), meterFill: $('meterFill'),
  timer: $('callTimer'), start: $('startBtn'), end: $('endBtn'), captions: $('captions'),
  live: $('liveTranscript'), form: $('textForm'), input: $('textInput'), send: $('sendBtn'),
  orders: $('orders'), scenarios: $('scenarios'), voice: $('voiceSelect'), bargeIn: $('bargeIn'),
  notice: $('notice'), configBadge: $('configBadge'), post: $('postCall'),
  finalTranscript: $('finalTranscript'), summaryJson: $('summaryJson'), badges: $('outcomeBadges'),
  copyJson: $('copyJson'), downloadJson: $('downloadJson'), newCall: $('newCall'),
};

const call = {
  phase: 'idle',        // idle | connecting | listening | thinking | speaking | ended
  messages: [],         // LLM conversation history (OpenAI format)
  transcript: [],       // what the user sees: {role, text, at, ...}
  startedAt: null,
  abort: null,          // AbortController of the in-flight /api/chat request
  reply: null,          // the agent reply currently being generated/spoken
  lastSpokeEndedAt: 0,
  lastReplyText: '',
  silenceTimer: null,
  promptedSilence: false,
  clock: null,
  media: null,
  audioCtx: null,
  summary: null,
};

// ---------- UI helpers ----------

const PHASE_TEXT = {
  idle: ['Ready to call', 'Click Start Call and allow microphone access.'],
  connecting: ['Connecting…', 'Waiting for microphone permission.'],
  listening: ['Listening', 'Go ahead, Aria is listening.'],
  thinking: ['Thinking', 'Aria is working on a reply.'],
  speaking: ['Speaking', 'Aria is talking. Speak to interrupt.'],
  ended: ['Call ended', 'See the transcript and summary below.'],
  error: ['Problem', ''],
};

function setPhase(phase, detail) {
  call.phase = phase;
  els.orb.dataset.phase = phase;
  els.stateLabel.dataset.phase = phase;
  els.stateLabel.textContent = PHASE_TEXT[phase][0];
  let text = detail ?? PHASE_TEXT[phase][1];
  if (phase === 'speaking' && (!els.bargeIn.checked || !listener)) text = 'Aria is talking.';
  if (phase === 'listening' && !listener) text = 'Text mode: type your message below.';
  els.stateDetail.textContent = text;

  if (listener) listener.muted = !els.bargeIn.checked && (phase === 'thinking' || phase === 'speaking');
  clearTimeout(call.silenceTimer);
  if (phase === 'listening' && !call.promptedSilence && listener) {
    call.silenceTimer = setTimeout(promptSilence, SILENCE_PROMPT_MS);
  }
}

function showNotice(html) {
  els.notice.innerHTML = html;
  els.notice.hidden = !html;
}

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function describeTool(entry) {
  const id = entry.args?.order_id ? ` ${entry.args.order_id}` : '';
  const r = entry.result ?? {};
  let outcome = '';
  if (r.error) outcome = r.found === false ? 'not found' : 'error';
  else if (entry.name === 'get_order_details') outcome = r.status;
  else if (entry.name === 'check_return_eligibility') outcome = r.eligible === true ? 'eligible' : r.eligible === 'needs_info' ? 'needs info' : 'not eligible';
  else if (entry.name === 'cancel_order') outcome = r.cancelled ? `cancelled (${r.cancellation_id})` : r.requires_confirmation ? 'awaiting confirmation' : 'not allowed';
  else if (entry.name === 'escalate_to_human') outcome = `ticket ${r.ticket_id}`;
  return `${entry.name}(${id.trim()}) → ${outcome}`;
}

function renderEntry(entry) {
  const li = document.createElement('li');
  const at = call.startedAt ? fmtClock(entry.at - call.startedAt) : '';
  if (entry.role === 'tool') {
    li.className = 'turn tool';
    li.innerHTML = `<details><summary>🔧 ${escapeHtml(describeTool(entry))} <span class="muted">${at}</span></summary><pre>${escapeHtml(JSON.stringify(entry.result, null, 2))}</pre></details>`;
    return li;
  }
  li.className = `turn ${entry.role}`;
  const who = entry.role === 'user' ? 'Customer' : 'Aria';
  const latency = entry.latencyMs ? `<span class="chip-latency" title="Time from end of your speech to Aria's first audio">⚡ ${(entry.latencyMs / 1000).toFixed(1)}s</span>` : '';
  const flags = [
    entry.interrupted ? '<span class="interrupted">interrupted</span>' : '',
    entry.unclear ? '<span class="interrupted">low confidence</span>' : '',
    entry.typed ? '<span class="muted">typed</span>' : '',
  ].join(' ');
  li.innerHTML = `<div class="who">${who} <span class="muted">${at}</span> ${latency} ${flags}</div><div class="text"></div>`;
  li.querySelector('.text').textContent = entry.text;
  return li;
}

function renderTranscript(target) {
  target.innerHTML = '';
  if (!call.transcript.length) {
    target.innerHTML = '<li class="empty">The conversation will appear here.</li>';
    return;
  }
  for (const entry of call.transcript) {
    const li = renderEntry(entry);
    entry.el = target === els.live ? li : entry.el;
    target.appendChild(li);
  }
  target.scrollTop = target.scrollHeight;
}

function addEntry(entry) {
  call.transcript.push(entry);
  if (call.transcript.length === 1) els.live.innerHTML = '';
  entry.el = renderEntry(entry);
  els.live.appendChild(entry.el);
  els.live.scrollTop = els.live.scrollHeight;
  return entry;
}

function refreshEntry(entry) {
  if (!entry?.el) return;
  const fresh = renderEntry(entry);
  entry.el.replaceWith(fresh);
  entry.el = fresh;
  els.live.scrollTop = els.live.scrollHeight;
}

// ---------- speech ----------

let listener = null;
const speaker = new Speaker({
  onFirstAudio: () => {
    const r = call.reply;
    if (r && !r.latencyMs && r.t0) {
      r.latencyMs = Math.round(performance.now() - r.t0);
      if (r.entry) { r.entry.latencyMs = r.latencyMs; refreshEntry(r.entry); }
    }
    if (call.phase === 'thinking' || call.phase === 'connecting') setPhase('speaking');
  },
  onSentence: (text) => {
    if (call.reply) call.reply.spoken.push(text);
  },
  onIdle: () => {
    call.lastSpokeEndedAt = performance.now();
    if (call.phase === 'speaking' || call.phase === 'thinking' || call.phase === 'connecting') {
      listener?.reset(); // drop anything the mic picked up from our own voice
      els.captions.textContent = '';
      setPhase('listening');
    }
  },
});

function onHeard(text) {
  if (call.phase === 'ended' || call.phase === 'idle') return;
  clearTimeout(call.silenceTimer);
  if (call.phase === 'listening') {
    els.captions.textContent = text ? `“${text}”` : '';
    return;
  }
  // Agent is thinking or talking: is this the customer barging in?
  if (els.bargeIn.checked && (call.phase === 'speaking' || call.phase === 'thinking')) {
    const agentText = call.reply?.text || call.lastReplyText;
    if (!isLikelyEcho(text, agentText)) {
      interrupt();
      els.captions.textContent = `“${text}”`;
    }
  }
}

function onUtterance(text, confidence) {
  if (call.phase === 'ended' || call.phase === 'idle') return;
  if (call.phase === 'speaking' || call.phase === 'thinking') {
    if (!els.bargeIn.checked || isLikelyEcho(text, call.reply?.text || call.lastReplyText)) return;
    interrupt();
  }
  // Late echo arriving just after Aria finished speaking.
  if (performance.now() - call.lastSpokeEndedAt < 1500 && isLikelyEcho(text, call.lastReplyText)) return;
  els.captions.textContent = '';
  const unclear = confidence !== null && confidence < LOW_CONFIDENCE;
  userTurn(text, { unclear });
}

/** Customer talked over Aria: stop audio and generation, keep what was said. */
function interrupt() {
  const r = call.reply;
  speaker.cancel();
  if (call.abort) call.abort.abort();
  call.abort = null;
  if (r) {
    r.interrupted = true;
    const spoken = r.spoken.join(' ');
    // Make the history reflect what the customer actually heard.
    if (r.done) {
      const last = [...call.messages].reverse().find((m) => m.role === 'assistant' && !m.tool_calls);
      if (last) last.content = spoken ? `${spoken} [cut off: customer interrupted]` : '[customer interrupted before Aria spoke]';
    } else if (spoken) {
      call.messages.push({ role: 'assistant', content: `${spoken} [cut off: customer interrupted]` });
    }
    if (r.entry) {
      r.entry.text = spoken || r.entry.text;
      r.entry.interrupted = true;
      refreshEntry(r.entry);
    }
    call.reply = null;
  }
  setPhase('listening', 'Interrupted, go ahead.');
}

// ---------- conversation ----------

function userTurn(text, { unclear = false, typed = false } = {}) {
  addEntry({ role: 'user', text, at: Date.now(), unclear, typed });
  call.messages.push({ role: 'user', content: unclear ? `[unclear audio] ${text}` : text });
  requestReply();
}

function speakScripted(text) {
  call.lastReplyText = text;
  const entry = addEntry({ role: 'agent', text, at: Date.now() });
  call.messages.push({ role: 'assistant', content: text });
  call.reply = { text, spoken: [], entry, done: true, t0: 0 };
  speaker.begin();
  speaker.speak(text);
  speaker.finish();
  if (!ttsSupported) setPhase('listening');
}

async function requestReply() {
  if (call.abort) call.abort.abort();
  const controller = new AbortController();
  call.abort = controller;
  listener?.reset();
  setPhase('thinking');

  const reply = { text: '', spoken: [], entry: null, done: false, t0: performance.now() };
  call.reply = reply;
  speaker.begin();
  let buffer = '';

  const flush = (all) => {
    const { sentences, rest } = takeSentences(buffer, all);
    buffer = rest;
    sentences.forEach((s) => speaker.speak(s));
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: call.messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        handleEvent(JSON.parse(line));
      }
    }

    function handleEvent(ev) {
      if (call.reply !== reply) return; // superseded by a barge-in
      if (ev.type === 'text') {
        reply.text += ev.delta;
        buffer += ev.delta;
        if (!reply.entry) reply.entry = addEntry({ role: 'agent', text: '', at: Date.now() });
        reply.entry.text = [reply.filler, reply.text.trim()].filter(Boolean).join(' ');
        reply.entry.el.querySelector('.text').textContent = reply.entry.text;
        els.live.scrollTop = els.live.scrollHeight;
        flush(false);
      } else if (ev.type === 'tool_start') {
        const id = ev.args?.order_id ? ` ${ev.args.order_id}` : '';
        const label = { get_order_details: 'Looking up order', check_return_eligibility: 'Checking return policy for', cancel_order: 'Processing cancellation for', escalate_to_human: 'Raising a support ticket' }[ev.name] || ev.name;
        els.stateDetail.textContent = `${label}${id}…`;
        if (!reply.text && !reply.filler) {
          reply.filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
          speaker.speak(reply.filler);
          reply.entry = addEntry({ role: 'agent', text: reply.filler, at: Date.now() });
        }
      } else if (ev.type === 'tool') {
        const entry = { role: 'tool', name: ev.name, args: ev.args, result: ev.result, at: Date.now() };
        // Keep the tool row above the reply text it produced.
        if (reply.entry) {
          call.transcript.splice(call.transcript.indexOf(reply.entry), 0, entry);
          entry.el = renderEntry(entry);
          reply.entry.el.before(entry.el);
        } else {
          addEntry(entry);
        }
      } else if (ev.type === 'done') {
        reply.done = true;
        call.messages.push(...ev.messages);
      } else if (ev.type === 'error') {
        console.warn('Agent error:', ev.message);
        if (ev.message === 'rate_limited') showNotice('The AI provider is rate-limiting requests right now. Wait a few seconds and try again.');
      }
    }

    if (call.reply !== reply) return;
    flush(true);
    call.lastReplyText = [reply.filler, reply.text].filter(Boolean).join(' ');
    if (!reply.done) call.messages.push({ role: 'assistant', content: reply.text });
    reply.done = true;
    speaker.finish();
    if ((!reply.text && !reply.filler) || !ttsSupported) setPhase('listening');
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    const msg = "Sorry, I'm having trouble connecting right now. Could you please try again in a moment?";
    showNotice(`Couldn't reach the agent: ${escapeHtml(err.message)}`);
    if (call.reply === reply) speakScripted(msg);
  } finally {
    if (call.abort === controller) call.abort = null;
  }
}

function promptSilence() {
  if (call.phase !== 'listening' || call.promptedSilence || listener?.heard) return;
  call.promptedSilence = true;
  speakScripted(STILL_THERE);
}

// ---------- call lifecycle ----------

async function startMicMeter() {
  try {
    call.media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow mic access in the address bar and try again.'
      : `Couldn't open the microphone (${err.name}).`);
  }
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(call.media).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    call.audioCtx = ctx;
    const tick = () => {
      if (call.audioCtx !== ctx) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      els.meterFill.style.width = `${Math.round(level * 100)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  } catch { /* meter is cosmetic */ }
}

function stopMic() {
  call.media?.getTracks().forEach((t) => t.stop());
  call.media = null;
  call.audioCtx?.close().catch(() => {});
  call.audioCtx = null;
  els.meterFill.style.width = '0';
}

async function startCall() {
  if (call.phase !== 'idle' && call.phase !== 'ended') return;
  Object.assign(call, {
    messages: [], transcript: [], startedAt: Date.now(), reply: null, summary: null,
    promptedSilence: false, lastReplyText: '', lastSpokeEndedAt: 0,
  });
  els.post.hidden = true;
  els.live.innerHTML = '';
  els.captions.textContent = '';
  showNotice('');
  els.start.disabled = true;
  setPhase('connecting');

  listener = null;
  let micOk = false;
  if (sttSupported) {
    try {
      await startMicMeter();
      micOk = true;
    } catch (err) {
      // Don't dead-end the evaluator: keep the call going in text mode.
      showNotice(`${escapeHtml(err.message)} The call will continue in text mode: type your messages below and Aria will still speak.`);
    }
  }
  if (micOk) {
    listener = new Listener({
      lang: 'en-IN',
      onActivity: onHeard,
      onUtterance,
      onFatal: (code) => {
        showNotice(`Speech recognition stopped (${escapeHtml(code)}). You can keep typing messages below.`);
      },
    });
    listener.start();
  }

  els.end.disabled = false;
  els.input.disabled = false;
  els.send.disabled = false;
  call.startedAt = Date.now();
  call.clock = setInterval(() => { els.timer.textContent = fmtClock(Date.now() - call.startedAt); }, 500);
  speakScripted(GREETING);
}

async function endCall() {
  if (call.phase === 'idle' || call.phase === 'ended') return;
  const endedAt = Date.now();
  setPhase('ended');
  clearInterval(call.clock);
  clearTimeout(call.silenceTimer);
  listener?.stop();
  listener = null;
  speaker.cancel();
  call.abort?.abort();
  call.abort = null;
  call.reply = null;
  stopMic();
  els.captions.textContent = '';
  els.start.disabled = false;
  els.end.disabled = true;
  els.input.disabled = true;
  els.send.disabled = true;

  els.post.hidden = false;
  renderTranscript(els.finalTranscript);
  els.summaryJson.textContent = 'Generating summary…';
  els.badges.innerHTML = '';
  els.post.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const transcript = call.transcript.map(({ role, text, at, name, args, result, interrupted }) =>
    role === 'tool'
      ? { role, name, args, result, at: new Date(at).toISOString() }
      : { role, text, at: new Date(at).toISOString(), ...(interrupted ? { interrupted } : {}) });

  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, startedAt: new Date(call.startedAt).toISOString(), endedAt: new Date(endedAt).toISOString() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    call.summary = { outcome: data, transcript };
    renderSummary(data);
  } catch (err) {
    els.summaryJson.textContent = `Could not generate the summary: ${err.message}`;
    call.summary = { outcome: null, transcript };
  }
}

function highlightJson(obj) {
  return escapeHtml(JSON.stringify(obj, null, 2)).replace(
    /(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (m, str, colon, bool, num) => {
      if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      if (bool) return `<span class="b">${bool}</span>`;
      return `<span class="n">${num}</span>`;
    },
  );
}

function renderSummary(data) {
  els.summaryJson.innerHTML = highlightJson(data);
  const badges = [data.customer_intent, data.resolution_status, data.order_id, data.customer_sentiment].filter(Boolean);
  els.badges.innerHTML = badges.map((b) => `<span>${escapeHtml(b)}</span>`).join('');
}

// ---------- side panel ----------

async function loadOrders() {
  try {
    const res = await fetch('/api/orders');
    const data = await res.json();
    els.orders.innerHTML = data.orders.map((o) => `
      <div class="order">
        <div class="order-top">
          <button class="order-id" data-copy="${o.order_id}" title="Copy order ID">${o.order_id}</button>
          <span class="status s-${o.status.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(o.status)}</span>
        </div>
        <dl>
          <dt>Customer</dt><dd>${escapeHtml(o.customer_name)}</dd>
          <dt>Product</dt><dd>${escapeHtml(o.product)}</dd>
          <dt>Value</dt><dd>₹${o.value_inr}</dd>
          ${o.courier ? `<dt>Courier</dt><dd>${escapeHtml(o.courier)} · ${escapeHtml(o.tracking_id)}</dd>` : ''}
          <dt>Notes</dt><dd>${escapeHtml(o.notes)}</dd>
        </dl>
      </div>`).join('');
    els.configBadge.hidden = false;
    if (data.configured) {
      els.configBadge.textContent = `LLM: ${data.model}`;
    } else {
      els.configBadge.textContent = 'GROQ_API_KEY missing';
      els.configBadge.classList.add('warn');
      showNotice('The server has no <code>GROQ_API_KEY</code> set, so Aria cannot reply yet. Add it to <code>.env</code> (local) or your host\'s environment variables.');
    }
  } catch {
    els.orders.innerHTML = '<p class="muted small">Could not load orders.</p>';
  }
}

function renderScenarios() {
  els.scenarios.innerHTML = SCENARIOS.map((s, i) =>
    `<button class="chip" data-i="${i}">${escapeHtml(s.text)} <small>· ${escapeHtml(s.tag)}</small></button>`).join('');
}

async function setupVoices() {
  const voices = rankVoices(await loadVoices());
  let saved = null;
  try { saved = localStorage.getItem('aura.voice'); } catch { /* storage blocked */ }
  els.voice.innerHTML = voices.length
    ? voices.map((v, i) => `<option value="${i}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`).join('')
    : '<option>Browser default voice</option>';
  const savedIdx = voices.findIndex((v) => v.name === saved);
  const idx = savedIdx >= 0 ? savedIdx : 0;
  els.voice.value = String(idx);
  speaker.voice = voices[idx] ?? null;
  els.voice.onchange = () => {
    speaker.voice = voices[Number(els.voice.value)] ?? null;
    try { localStorage.setItem('aura.voice', speaker.voice?.name ?? ''); } catch { /* ignore */ }
  };

  const hasIndian = voices.some((v) => v.lang.toLowerCase().replace('_', '-') === 'en-in');
  const tips = [];
  if (!sttSupported) tips.push('This browser has no built-in speech recognition. Open the page in <b>Chrome</b> or <b>Edge</b> to talk to Aria, or type messages below.');
  if (!ttsSupported) tips.push('This browser cannot speak; replies will show as text only.');
  else if (!hasIndian) tips.push('No Indian English voice was found in this browser. For the most natural Indian voice, open the page in <b>Microsoft Edge</b>.');
  if (tips.length && !els.notice.innerHTML) showNotice(tips.join(' '));
}

// ---------- wiring ----------

els.start.addEventListener('click', startCall);
els.end.addEventListener('click', endCall);
els.newCall.addEventListener('click', () => { els.post.hidden = true; startCall(); });

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || call.phase === 'idle' || call.phase === 'ended' || call.phase === 'connecting') return;
  els.input.value = '';
  if (call.phase === 'speaking' || call.phase === 'thinking') interrupt();
  userTurn(text, { typed: true });
});

els.scenarios.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  els.input.value = SCENARIOS[Number(btn.dataset.i)].text;
  if (!els.input.disabled) els.input.focus();
});

els.orders.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try { await navigator.clipboard.writeText(btn.dataset.copy); } catch { /* clipboard blocked */ }
  const old = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = old; }, 900);
});

els.bargeIn.addEventListener('change', () => setPhase(call.phase, call.phase === 'idle' ? undefined : els.stateDetail.textContent));

els.copyJson.addEventListener('click', async () => {
  if (!call.summary?.outcome) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(call.summary.outcome, null, 2));
    els.copyJson.textContent = 'Copied!';
    setTimeout(() => { els.copyJson.textContent = 'Copy JSON'; }, 1000);
  } catch { /* ignore */ }
});

els.downloadJson.addEventListener('click', () => {
  if (!call.summary) return;
  const blob = new Blob([JSON.stringify(call.summary, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aura-call-${new Date(call.startedAt).toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

window.addEventListener('beforeunload', () => { speaker.cancel(); listener?.stop(); });

renderScenarios();
renderTranscript(els.live);
setPhase('idle');
loadOrders();
setupVoices();
