import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeSentences, cleanForSpeech, isLikelyEcho, rankVoices } from '../public/speech.js';

test('takeSentences releases complete sentences while streaming', () => {
  let r = takeSentences('Your order is out for delivery. It should');
  assert.deepEqual(r.sentences, ['Your order is out for delivery.']);
  assert.equal(r.rest, 'It should');
  r = takeSentences('It costs 2.5 thousand');
  assert.deepEqual(r.sentences, [], 'decimals are not sentence ends');
  r = takeSentences('Anything else?', true);
  assert.deepEqual(r.sentences, ['Anything else?']);
});

test('cleanForSpeech makes text TTS friendly', () => {
  assert.equal(cleanForSpeech('**Total:** ₹699'), 'Total: 699 rupees');
  assert.equal(cleanForSpeech('order ORD-101'), 'order O R D 1 0 1');
});

test('isLikelyEcho separates our own voice from a real interruption', () => {
  const agent = 'Your Vitamin C Serum is out for delivery with BlueDart, expected by 6 PM today.';
  assert.equal(isLikelyEcho('out for delivery with blue dart', agent), true);
  assert.equal(isLikelyEcho('uh', agent), true);
  assert.equal(isLikelyEcho('wait actually I want to cancel it', agent), false);
});

test('isLikelyEcho ignores mis-heard echo of the greeting', () => {
  const greeting = "Hi, I'm Aria from Aura Skincare. How can I help you today?";
  assert.equal(isLikelyEcho("hi I'm area from aura skin care", greeting), true);
  assert.equal(isLikelyEcho('hi am aria from aura skincare how can i help you', greeting), true);
  assert.equal(isLikelyEcho('how can I help you to day', greeting), true);
  assert.equal(isLikelyEcho('where is my order ORD-101', greeting), false);
});

test('rankVoices prefers Indian English voices', () => {
  const voices = [
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Microsoft Neerja Online (Natural) - English (India)', lang: 'en-IN' },
    { name: 'Google हिन्दी', lang: 'hi-IN' },
    { name: 'Google français', lang: 'fr-FR' },
  ];
  const ranked = rankVoices(voices).map((v) => v.lang);
  assert.equal(ranked[0], 'en-IN');
  assert.ok(!ranked.includes('fr-FR'));
});
