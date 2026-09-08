'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeScores, computeNsfwScore, decideVerdict, topClass, evaluate, SCORE_KEYS, VERDICTS,
} = require('../../src/services/verdict');

const THRESHOLDS = { block: 0.7, review: 0.4 };
const OPTS = { sexyWeight: 0.5, thresholdBlock: 0.7, thresholdReview: 0.4 };

/** Builds a prediction array in nsfwjs's own shape from lowercase scores. */
const preds = (o) => [
  { className: 'Neutral', probability: o.neutral ?? 0 },
  { className: 'Drawing', probability: o.drawing ?? 0 },
  { className: 'Sexy', probability: o.sexy ?? 0 },
  { className: 'Porn', probability: o.porn ?? 0 },
  { className: 'Hentai', probability: o.hentai ?? 0 },
];

test('normalizeScores maps nsfwjs class names to the response keys', () => {
  const scores = normalizeScores(preds({ neutral: 0.1, drawing: 0.2, sexy: 0.3, porn: 0.25, hentai: 0.15 }));
  assert.deepStrictEqual(Object.keys(scores).sort(), [...SCORE_KEYS].sort());
  assert.strictEqual(scores.porn, 0.25);
  assert.strictEqual(scores.hentai, 0.15);
});

test('normalizeScores defaults missing classes to 0 instead of undefined', () => {
  const scores = normalizeScores([{ className: 'Porn', probability: 0.9 }]);
  assert.strictEqual(scores.porn, 0.9);
  for (const key of SCORE_KEYS.filter((k) => k !== 'porn')) {
    assert.strictEqual(scores[key], 0, `${key} should default to 0`);
  }
});

test('normalizeScores clamps out-of-range and non-numeric probabilities', () => {
  const scores = normalizeScores([
    { className: 'Porn', probability: 1.4 },
    { className: 'Sexy', probability: -0.2 },
    { className: 'Hentai', probability: NaN },
    { className: 'Neutral', probability: 'nope' },
  ]);
  assert.strictEqual(scores.porn, 1);
  assert.strictEqual(scores.sexy, 0);
  assert.strictEqual(scores.hentai, 0);
  assert.strictEqual(scores.neutral, 0);
});

test('normalizeScores tolerates null and empty input', () => {
  for (const input of [null, undefined, []]) {
    const scores = normalizeScores(input);
    assert.deepStrictEqual(scores, { neutral: 0, drawing: 0, sexy: 0, porn: 0, hentai: 0 });
  }
});

test('computeNsfwScore = porn + hentai + sexy * SEXY_WEIGHT', () => {
  const scores = { neutral: 0, drawing: 0, sexy: 0.4, porn: 0.2, hentai: 0.1 };
  assert.strictEqual(computeNsfwScore(scores, 0.5), 0.2 + 0.1 + 0.4 * 0.5);
  assert.strictEqual(computeNsfwScore(scores, 0), 0.2 + 0.1);
  assert.strictEqual(computeNsfwScore(scores, 1), 0.2 + 0.1 + 0.4);
});

test('computeNsfwScore clamps to 1', () => {
  assert.strictEqual(computeNsfwScore({ sexy: 1, porn: 1, hentai: 1 }, 0.5), 1);
});

test('decideVerdict: >= block is block, and the boundary itself blocks', () => {
  assert.strictEqual(decideVerdict(0.7, THRESHOLDS), VERDICTS.BLOCK);
  assert.strictEqual(decideVerdict(0.70001, THRESHOLDS), VERDICTS.BLOCK);
  assert.strictEqual(decideVerdict(1, THRESHOLDS), VERDICTS.BLOCK);
});

test('decideVerdict: just below block is review', () => {
  assert.strictEqual(decideVerdict(0.6999999, THRESHOLDS), VERDICTS.REVIEW);
});

test('decideVerdict: >= review is review, and the boundary itself reviews', () => {
  assert.strictEqual(decideVerdict(0.4, THRESHOLDS), VERDICTS.REVIEW);
  assert.strictEqual(decideVerdict(0.55, THRESHOLDS), VERDICTS.REVIEW);
});

test('decideVerdict: just below review is allow', () => {
  assert.strictEqual(decideVerdict(0.3999999, THRESHOLDS), VERDICTS.ALLOW);
  assert.strictEqual(decideVerdict(0, THRESHOLDS), VERDICTS.ALLOW);
});

test('decideVerdict: equal thresholds collapse the review band', () => {
  const t = { block: 0.5, review: 0.5 };
  assert.strictEqual(decideVerdict(0.5, t), VERDICTS.BLOCK);
  assert.strictEqual(decideVerdict(0.4999, t), VERDICTS.ALLOW);
});

test('decideVerdict: threshold 0 blocks everything', () => {
  assert.strictEqual(decideVerdict(0, { block: 0, review: 0 }), VERDICTS.BLOCK);
});

test('decideVerdict: threshold 1 only blocks a perfect score', () => {
  assert.strictEqual(decideVerdict(0.999999, { block: 1, review: 0.4 }), VERDICTS.REVIEW);
  assert.strictEqual(decideVerdict(1, { block: 1, review: 0.4 }), VERDICTS.BLOCK);
});

test('topClass picks the highest probability', () => {
  assert.strictEqual(topClass({ neutral: 0.1, drawing: 0.2, sexy: 0.05, porn: 0.6, hentai: 0.05 }), 'porn');
  assert.strictEqual(topClass({ neutral: 0.9, drawing: 0.1, sexy: 0, porn: 0, hentai: 0 }), 'neutral');
});

test('topClass resolves ties deterministically by declaration order', () => {
  assert.strictEqual(topClass({ neutral: 0.5, drawing: 0.5, sexy: 0, porn: 0, hentai: 0 }), 'neutral');
  assert.strictEqual(topClass({ neutral: 0, drawing: 0, sexy: 0, porn: 0, hentai: 0 }), 'neutral');
});

test('evaluate: clearly safe image allows', () => {
  const r = evaluate(preds({ neutral: 0.95, drawing: 0.04, sexy: 0.01 }), OPTS);
  assert.strictEqual(r.verdict, 'allow');
  assert.strictEqual(r.topClass, 'neutral');
  assert.ok(r.nsfwScore < 0.4);
});

test('evaluate: explicit image blocks', () => {
  const r = evaluate(preds({ porn: 0.85, hentai: 0.05, neutral: 0.1 }), OPTS);
  assert.strictEqual(r.verdict, 'block');
  assert.strictEqual(r.topClass, 'porn');
  assert.ok(r.nsfwScore >= 0.7);
});

test('evaluate: sexy alone lands in review at the default weight', () => {
  // sexy 0.9 * 0.5 = 0.45 -> review, never block on suggestiveness alone.
  const r = evaluate(preds({ sexy: 0.9, neutral: 0.1 }), OPTS);
  assert.strictEqual(r.nsfwScore, 0.45);
  assert.strictEqual(r.verdict, 'review');
  assert.strictEqual(r.topClass, 'sexy');
});

test('evaluate: SEXY_WEIGHT=1 can push the same image to block', () => {
  const r = evaluate(preds({ sexy: 0.9, neutral: 0.1 }), { ...OPTS, sexyWeight: 1 });
  assert.strictEqual(r.nsfwScore, 0.9);
  assert.strictEqual(r.verdict, 'block');
});

test('evaluate: porn and hentai combine across the block threshold', () => {
  const r = evaluate(preds({ porn: 0.4, hentai: 0.35, neutral: 0.25 }), OPTS);
  assert.ok(Math.abs(r.nsfwScore - 0.75) < 1e-9);
  assert.strictEqual(r.verdict, 'block');
  // topClass is the single highest class, which is not the verdict driver here.
  assert.strictEqual(r.topClass, 'porn');
});

test('evaluate returns exactly the documented shape', () => {
  const r = evaluate(preds({ neutral: 1 }), OPTS);
  assert.deepStrictEqual(Object.keys(r).sort(), ['nsfwScore', 'scores', 'topClass', 'verdict']);
});
