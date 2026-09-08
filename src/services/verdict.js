'use strict';

/** nsfwjs class names, mapped to the lowercase keys used in the API response. */
const CLASS_KEYS = Object.freeze({
  Neutral: 'neutral',
  Drawing: 'drawing',
  Sexy: 'sexy',
  Porn: 'porn',
  Hentai: 'hentai',
});

const SCORE_KEYS = Object.freeze(['neutral', 'drawing', 'sexy', 'porn', 'hentai']);

const VERDICTS = Object.freeze({ ALLOW: 'allow', REVIEW: 'review', BLOCK: 'block' });

/**
 * Turns nsfwjs's `[{className, probability}]` into the fixed score object.
 * Missing classes default to 0 so a model change can never produce undefined
 * scores in a response.
 */
function normalizeScores(predictions) {
  const scores = {};
  for (const key of SCORE_KEYS) scores[key] = 0;
  for (const p of predictions || []) {
    const key = CLASS_KEYS[p.className] || String(p.className).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(scores, key)) {
      scores[key] = clamp01(p.probability);
    }
  }
  return scores;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** nsfwScore = porn + hentai + (sexy * SEXY_WEIGHT) */
function computeNsfwScore(scores, sexyWeight) {
  return clamp01(scores.porn + scores.hentai + scores.sexy * sexyWeight);
}

/** block at >= THRESHOLD_BLOCK, review at >= THRESHOLD_REVIEW, else allow. */
function decideVerdict(nsfwScore, { block, review }) {
  if (nsfwScore >= block) return VERDICTS.BLOCK;
  if (nsfwScore >= review) return VERDICTS.REVIEW;
  return VERDICTS.ALLOW;
}

/** The class with the highest probability; ties resolve by SCORE_KEYS order. */
function topClass(scores) {
  let best = SCORE_KEYS[0];
  for (const key of SCORE_KEYS) {
    if (scores[key] > scores[best]) best = key;
  }
  return best;
}

/**
 * @param {Array<{className:string, probability:number}>} predictions
 * @param {{sexyWeight:number, thresholdBlock:number, thresholdReview:number}} opts
 */
function evaluate(predictions, opts) {
  const scores = normalizeScores(predictions);
  const nsfwScore = computeNsfwScore(scores, opts.sexyWeight);
  return {
    verdict: decideVerdict(nsfwScore, { block: opts.thresholdBlock, review: opts.thresholdReview }),
    scores,
    nsfwScore,
    topClass: topClass(scores),
  };
}

module.exports = { CLASS_KEYS, SCORE_KEYS, VERDICTS, normalizeScores, computeNsfwScore, decideVerdict, topClass, evaluate, clamp01 };
