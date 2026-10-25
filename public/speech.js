// Browser speech layer: Web Speech API recognition (STT) and speechSynthesis (TTS).

// Guarded so the pure helpers below can be unit-tested in Node.
const hasWindow = typeof window !== 'undefined';
const SR = hasWindow ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const sttSupported = Boolean(SR);
export const ttsSupported = hasWindow && 'speechSynthesis' in window;

/**
 * Continuous speech recogniser with our own end-of-turn detection.
 * Chrome marks a result "final" at short pauses; we wait `endpointMs` more
 * before treating the utterance as complete, so a customer reading out an
 * order ID with small pauses isn't cut off mid-sentence.
 */
export class Listener {
  constructor({ lang = 'en-IN', endpointMs = 750, onActivity, onUtterance, onFatal }) {
    Object.assign(this, { lang, endpointMs, onActivity, onUtterance, onFatal });
    this.active = false;
    this.muted = false;
    this.rec = null;
    this._clearBuffer();
  }

  start() {
    if (!sttSupported) return;
    this.active = true;
    this._clearBuffer();
    this._spawn();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    try { this.rec?.abort(); } catch { /* already stopped */ }
    this.rec = null;
  }

  /** Throw away anything heard so far (e.g. our own voice echoing back). */
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

  _spawn() {
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      if (this.muted) return;
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
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.active = false;
        this.onFatal?.(e.error);
      }
      // 'no-speech', 'aborted', 'network': onend fires next and we restart.
    };

    rec.onend = () => {
      // Chrome stops continuous recognition after silence or ~60s. Restart
      // transparently for as long as the call is live.
      if (this.active && this.rec === rec) {
        setTimeout(() => {
          if (!this.active || this.rec !== rec) return;
          try { rec.start(); } catch { this._spawn(); }
        }, 120);
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn('Speech recognition failed to start', err);
    }
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
  }

  begin() {
    this.cancel();
    this.closed = false;
    this.started = false;
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
      if (!this.started) {
        this.started = true;
        this.onFirstAudio?.();
      }
      this.onSentence?.(text);
    };
    u.onend = u.onerror = () => this._done(u);
    this.pending.add(u); // holding a reference also stops Chrome from GC-ing it mid-speech
    speechSynthesis.speak(u);
  }

  finish() {
    this.closed = true;
    if (this.pending.size === 0) this._idle();
  }

  cancel() {
    this.pending.clear();
    this.closed = true;
    clearInterval(this.watchdog);
    if (ttsSupported) speechSynthesis.cancel();
  }

  get busy() {
    return this.pending.size > 0 || !this.closed;
  }

  _done(u) {
    if (!this.pending.delete(u)) return;
    if (this.pending.size === 0 && this.closed) this._idle();
  }

  _idle() {
    clearInterval(this.watchdog);
    this.onIdle?.();
  }

  // Chrome occasionally never fires onend. If the engine says it is silent
  // twice in a row while we still think something is queued, move on.
  _startWatchdog() {
    clearInterval(this.watchdog);
    let silentTicks = 0;
    this.watchdog = setInterval(() => {
      if (!this.pending.size) return;
      const silent = !speechSynthesis.speaking && !speechSynthesis.pending;
      silentTicks = silent ? silentTicks + 1 : 0;
      if (silentTicks >= 3) {
        this.pending.clear();
        if (this.closed) this._idle();
      }
    }, 400);
  }
}

/**
 * Did the microphone just hear Aria's own voice (speakers -> mic), or is the
 * customer really talking? Count words that are NOT in what Aria is saying.
 */
export function isLikelyEcho(heard, agentText) {
  const words = (s) => s.toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) ?? [];
  const heardWords = words(heard);
  if (heardWords.length < 2) return true; // "uh", single noise words: not a barge-in
  const agentWords = new Set(words(agentText));
  const novel = heardWords.filter((w) => !agentWords.has(w)).length;
  return !(novel >= 2 && novel / heardWords.length >= 0.4);
}
