// Runtime tests for the browser speech classes, using fake versions of
// Chrome's SpeechRecognition and speechSynthesis (including their bugs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const instances = [];
class FakeRecognition {
  constructor() { instances.push(this); this.started = false; this.aborted = false; }
  start() { this.started = true; queueMicrotask(() => this.onstart?.()); }
  abort() { this.aborted = true; }
  // Simulate Chrome delivering a final result.
  say(text, confidence = 0.9) {
    const result = Object.assign([{ transcript: text, confidence }], { isFinal: true });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

const synth = { speaking: false, pending: false, paused: false, queue: [], cancelled: 0,
  speak(u) { this.queue.push(u); this.speaking = true; queueMicrotask(() => u.onstart?.()); },
  cancel() { this.cancelled++; this.queue = []; this.speaking = false; },
  resume() { this.paused = false; },
  getVoices: () => [] };

globalThis.window = { webkitSpeechRecognition: FakeRecognition, speechSynthesis: synth };
globalThis.speechSynthesis = synth;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

// Query string gives a fresh module instance that sees the fake window.
const { Listener, Speaker } = await import('../public/speech.js?runtime');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pause() turns the mic off and drops late echo; resume() starts a fresh session', async () => {
  instances.length = 0;
  const heard = [];
  const l = new Listener({ endpointMs: 10, onUtterance: (t) => heard.push(t) });
  l.start();
  await sleep(20);
  const first = instances.at(-1);
  assert.ok(first.started);

  l.pause(); // Aria starts speaking
  assert.ok(first.aborted, 'session aborted while Aria talks');
  first.say("hi I'm area from aura skin care"); // late echo from the old session
  await sleep(30);
  assert.deepEqual(heard, [], 'echo from the paused session is ignored');

  l.resume(); // Aria finished
  await sleep(200);
  const second = instances.at(-1);
  assert.notEqual(second, first, 'a brand-new recognition object is used');
  second.say('where is my order ORD-101');
  await sleep(30);
  assert.deepEqual(heard, ['where is my order ORD-101']);
  l.stop();
});

test('when Chrome ends a session, a new one replaces it (input never stops)', async () => {
  instances.length = 0;
  const heard = [];
  const l = new Listener({ endpointMs: 10, onUtterance: (t) => heard.push(t) });
  l.start();
  await sleep(20);
  for (let turn = 0; turn < 5; turn++) {
    const rec = instances.at(-1);
    rec.say(`question ${turn}`);
    await sleep(30);
    rec.onend(); // Chrome stops the session after silence / 60s
    await sleep(200);
  }
  assert.deepEqual(heard, ['question 0', 'question 1', 'question 2', 'question 3', 'question 4']);
  assert.ok(instances.length >= 6, 'each session end spawned a fresh recogniser');
  l.stop();
});

test('a session that never starts is replaced by the health check', async (t) => {
  instances.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origStart = FakeRecognition.prototype.start;
  FakeRecognition.prototype.start = function () { this.started = true; }; // never fires onstart
  const l = new Listener({});
  l.start();
  t.mock.timers.tick(1);
  assert.equal(instances.length, 1);
  FakeRecognition.prototype.start = origStart;
  t.mock.timers.tick(4100); // health check fires
  t.mock.timers.tick(200); // replacement session spawns
  assert.ok(instances.length >= 2, 'a new session was spawned');
  l.stop();
});

test('speaker recovers when Chrome speech gets stuck "speaking" forever', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let idle = 0;
  const s = new Speaker({ onIdle: () => idle++ });
  s.begin();
  s.speak('Your order is out for delivery.');
  await Promise.resolve(); // onstart fires; onend never will
  s.finish();
  assert.equal(idle, 0);
  synth.speaking = true; // engine claims it is still talking
  t.mock.timers.tick(9000);
  assert.equal(idle, 1, 'speaker gave up on the stuck sentence and went idle');
  assert.ok(synth.cancelled > 0, 'engine was reset');
});

test('speaker recovers when a sentence never starts', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let idle = 0;
  const origSpeak = synth.speak;
  synth.speak = function (u) { this.queue.push(u); this.speaking = true; }; // no onstart
  const s = new Speaker({ onIdle: () => idle++ });
  s.begin();
  s.speak('Hello there.');
  s.finish();
  t.mock.timers.tick(6000);
  synth.speak = origSpeak;
  assert.equal(idle, 1);
});
