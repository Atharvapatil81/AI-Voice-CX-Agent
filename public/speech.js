// Browser speech layer: Web Speech API recognition (STT) and speechSynthesis (TTS).

// Guarded so the pure helpers below can be unit-tested in Node.
const hasWindow = typeof window !== 'undefined';
const SR = hasWindow ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const sttSupported = Boolean(SR);
export const ttsSupported = hasWindow && 'speechSynthesis' in window;

/**
 * Speech recogniser with our own end-of-turn detection.
 *
 * Chrome marks a result "final" at short pauses; we wait endpointMs more
 * before treating the utterance as complete, so a customer reading out an
 * order ID with small pauses isn't cut off mid-sentence.
 *
 * pause() / resume() let the call run half-duplex: the mic is fully off while
 * Aria speaks (so it can't hear her through the speakers), and every resume()
 * starts a brand-new recognition session, which also throws away any late
 * results Chrome was still holding from the echo.
 */
export class Listener {
  constructor({ lang = 'en-IN', endpointMs = 750, onActivity, onUtterance, onFatal }) {
    Object.assign(this, { lang, endpointMs, onActivity, onUtterance, onFatal });
    this.active = false;
    this.paused = false;
    this.rec = null;
    this.spawnTimer = null;
    this.healthTimer = null;
    this._clearBuffer();
  }

  start() {
    if (!sttSupported) return;
    this.active = true;
    this.paused = false;
    this._clearBuffer();
    this._spawnSoon(0);
  }

  stop() {
    this.active = false;
    this._clearBuffer();
    this._kill();
  }

  /** Turn the mic off (Aria is talking). Anything buffered is discarded. */
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this._clearBuffer();
    this._kill();
  }

  /** Start listening again with a fresh session. */
  resume() {
    if (!this.active) return;
    this.paused = false;
    this._clearBuffer();
    this._kill();
    this._spawnSoon();
  }

  /** Throw away anything heard so far, but keep the session running. */
  reset() {
    this._clearBuffer();
  }

  /** Text heard since the last reset, including words still being recognised. */
  get heard() {
    return `${this.finalText} ${this.interim}`.trim();
  }

  _clearBuffer() {
    clearTimeout(this.timer);
    this.finalText = '';
    this.interim = '';
    this.confidences = [];
  }

  /** Detach and abort the current session so none of its events reach us. */
  _kill() {
    clearTimeout(this.spawnTimer);
    clearTimeout(this.healthTimer);
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    rec.onresult = rec.onend = rec.onerror = rec.onstart = null;
    try { rec.abort(); } catch { /* already stopped */ }
  }

  _spawnSoon(delay = 150) {
    clearTimeout(this.spawnTimer);
    this.spawnTimer = setTimeout(() => {
      if (this.active && !this.paused && !this.rec) this._spawn();
    }, delay);
  }

  _spawn() {
    // A new object every time: restarting a used instance can silently die
    // in Chrome after a few sessions.
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let started = false;

    rec.onstart = () => { started = true; };

    rec.onresult = (e) => {
      if (this.rec !== rec || this.paused) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          this.finalText = `${this.finalText} ${r[0].transcript}`.trim();
          if (r[0].confidence > 0) this.confidences.push(r[0].confidence);
        } else {
          interim += r[0].transcript;
        }
      }
      this.interim = interim.trim();
      this.onActivity?.(this.heard);

      clearTimeout(this.timer);
      if (this.finalText && !this.interim) {
        this.timer = setTimeout(() => this._commit(), this.endpointMs);
      } else if (this.interim) {
        // Safety net: if the recogniser never finalises, commit anyway.
        this.timer = setTimeout(() => this._commit(), 2500);
      }
    };

    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.active = false;
        this.onFatal?.(e.error);
      }
      // 'no-speech', 'aborted', 'network': onend fires next and we respawn.
    };

    rec.onend = () => {
      // Chrome ends sessions after silence or ~60s. Replace it with a fresh one.
      if (this.rec !== rec) return;
      this.rec = null;
      if (this.active && !this.paused) this._spawnSoon();
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn('Speech recognition failed to start', err);
      this.rec = null;
      this._spawnSoon(500);
      return;
    }
    // Health check: if the session never actually starts, try again.
    clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => {
      if (this.rec === rec && !started && this.active && !this.paused) {
        this._kill();
        this._spawnSoon();
      }
    }, 4000);
  }

  _commit() {
    const text = this.heard;
    const conf = this.confidences.length
      ? this.confidences.reduce((a, b) => a + b, 0) / this.confidences.length
      : null;
    this._clearBuffer();
    if (text) this.onUtterance?.(text, conf);
  }
}

/** Make LLM text pleasant to hear. */
export function cleanForSpeech(text) {
  return text
    .replace(/<function[\s\S]*?(<\/function>|$)/gi, '')
    .replace(/[*_#`~>|]/g, '')
    .replace(/₹\s?(\d[\d,]*)/g, '$1 rupees')
    .replace(/\bRs\.?\s?(\d[\d,]*)/gi, '$1 rupees')
    .replace(/\bORD[-\s]?(\d+)/gi, (_, d) => `O R D ${d.split('').join(' ')}`)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull complete sentences off the front of a streaming buffer. */
export function takeSentences(buffer, flushAll = false) {
  const sentences = [];
  let rest = buffer;
  const re = /^([\s\S]*?[.!?।]+["')\]]*)\s+/;
  let m;
  while ((m = rest.match(re))) {
    if (m[1].trim()) sentences.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  // Very long clause without punctuation: split at a comma to start talking sooner.
  if (!flushAll && rest.length > 160) {
    const cut = rest.lastIndexOf(', ', 150);
    if (cut > 40) {
      sentences.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 2);
    }
  }
  if (flushAll && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences, rest };
}

/** Score voices so we pick an Indian English voice when the browser has one. */
export function rankVoices(voices) {
  const score = (v) => {
    const lang = v.lang.toLowerCase().replace('_', '-');
    const name = v.name.toLowerCase();
    let s = 0;
    if (lang === 'en-in') s += 100;
    else if (lang.startsWith('en-gb')) s += 25;
    else if (lang.startsWith('en')) s += 15;
    else if (lang === 'hi-in') s += 5;
    if (/natural|online|neural|premium|enhanced/.test(name)) s += 30;
    if (/neerja|heera|veena|isha|female|aditi|raveena|kajal/.test(name)) s += 15;
    if (/google/.test(name)) s += 8;
    return s;
  };
  return voices
    .filter((v) => /^(en|hi)/i.test(v.lang))
    .map((v) => ({ v, s: score(v) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

export function loadVoices() {
  return new Promise((resolve) => {
    if (!ttsSupported) return resolve([]);
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/**
 * Queue of sentences spoken one after another. A reply is opened with
 * begin(), fed with speak(), closed with finish(); onIdle fires once the last
 * queued sentence has been spoken.
 */
export class Speaker {
  constructor({ onFirstAudio, onSentence, onIdle }) {
    Object.assign(this, { onFirstAudio, onSentence, onIdle });
    this.voice = null;
    this.rate = 1.04;
    this.pending = new Set();
    this.closed = true;
    this.started = false;
    this.watchdog = null;
    this.watchdogRunning = false;
    this.current = null; // { u, startedAt, expectedMs } for the sentence being spoken
    this.lastProgress = 0;
  }

  begin() {
    this.cancel();
    this.closed = false;
    this.started = false;
    this.lastProgress = Date.now();
    this._startWatchdog();
  }

  speak(text) {
    const spoken = cleanForSpeech(text);
    if (!spoken || !ttsSupported) return;
    const u = new SpeechSynthesisUtterance(spoken);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang || 'en-IN';
    u.rate = this.rate;
    u.onstart = () => {
      if (!this.pending.has(u)) return;
      // Roughly 13 characters per second of speech, plus generous slack.
      this.current = { u, startedAt: Date.now(), expectedMs: (spoken.length * 80) / this.rate + 3000 };
      this.lastProgress = Date.now();
      if (!this.started) {
        this.started = true;
        this.onFirstAudio?.();
      }
      this.onSentence?.(text);
    };
    u.onend = u.onerror = () => this._done(u);
    if (!this.pending.size) this.lastProgress = Date.now();
    this.pending.add(u); // holding a reference also stops Chrome from GC-ing it mid-speech
    if (!this.watchdogRunning) this._startWatchdog();
    speechSynthesis.speak(u);
  }

  finish() {
    this.closed = true;
    if (this.pending.size === 0) this._idle();
  }

  cancel() {
    this.pending.clear();
    this.current = null;
    this.closed = true;
    this._stopWatchdog();
    if (ttsSupported) speechSynthesis.cancel();
  }

  get busy() {
    return this.pending.size > 0 || !this.closed;
  }

  _done(u) {
    if (!this.pending.delete(u)) return;
    if (this.current?.u === u) this.current = null;
    this.lastProgress = Date.now();
    if (this.pending.size === 0 && this.closed) this._idle();
  }

  _idle() {
    this._stopWatchdog();
    this.onIdle?.();
  }

  /** The speech engine is stuck: reset it and move on rather than hang the call. */
  _recover() {
    this.pending.clear();
    this.current = null;
    if (ttsSupported) speechSynthesis.cancel();
    if (this.closed) this._idle();
  }

  _stopWatchdog() {
    clearInterval(this.watchdog);
    this.watchdogRunning = false;
  }

  // Chrome's speechSynthesis has known hangs: onend never fires, "speaking"
  // stays true forever, or it pauses itself. Detect each one and recover.
  _startWatchdog() {
    clearInterval(this.watchdog);
    this.watchdogRunning = true;
    let silentTicks = 0;
    this.watchdog = setInterval(() => {
      if (!this.pending.size) return;
      if (speechSynthesis.paused) speechSynthesis.resume();
      const now = Date.now();
      const silent = !speechSynthesis.speaking && !speechSynthesis.pending;
      silentTicks = silent ? silentTicks + 1 : 0;
      const overran = this.current && now - this.current.startedAt > this.current.expectedMs;
      const neverStarted = !this.current && now - this.lastProgress > 5000;
      if (silentTicks >= 3 || overran || neverStarted) this._recover();
    }, 400);
  }
}

/**
 * Did the microphone just hear Aria's own voice (speakers -> mic), or is the
 * customer really talking? Speech recognition mishears our own voice
 * ("Aria" -> "area", "skincare" -> "skin care"), so words are matched
 * fuzzily against what Aria said, and it takes 3+ clearly new words to count
 * as a real interruption.
 */
export function isLikelyEcho(heard, agentText) {
  const words = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) ?? [];
  const heardWords = words(heard);
  if (heardWords.length < 3) return true; // too short to be a deliberate interruption
  const agentWords = words(agentText);
  const agentSet = new Set(agentWords);
  const joined = agentWords.join('');
  const close = (a, b) => {
    if (a[0] !== b[0] || Math.abs(a.length - b.length) > 2) return false;
    const limit = Math.max(a.length, b.length) > 5 ? 2 : 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i); // Levenshtein distance
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length] <= limit;
  };
  const known = (w) => agentSet.has(w) || (w.length >= 4 && joined.includes(w)) || agentWords.some((a) => close(a, w));
  const novel = heardWords.filter((w) => !known(w)).length;
  return !(novel >= 3 && novel / heardWords.length >= 0.6);
}
