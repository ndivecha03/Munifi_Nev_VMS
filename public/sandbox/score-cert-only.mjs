// public/sandbox/score-cert-only.mjs — certification-only ranking for the
// SFDA sandbox dashboard.
//
// Herman Brown is DA CIO, not DPW — his office's interest is fraud/audit
// risk, not equity routing. Per the build doc's guardrail ("keep demographic
// scoring off the screen — Coral Construction exposure"), this wraps the
// real scorer.js (the production matrix, unchanged) and strips the
// demographic_equity component from the output before anything reaches the
// dashboard. The real matrix in public/scorer.js still carries that
// component for production DPW use — this file does NOT modify scorer.js,
// it only post-processes its output for this one sandbox context.
//
// Rebased total: 100 - WEIGHTS.demographic_equity (15) = 85 max points.

import { scoreVendor, rankTop, vendorTier, WEIGHTS } from '../scorer.js';

export const CERT_ONLY_MAX = 100 - (WEIGHTS.demographic_equity || 0);

/**
 * Strip the demographic_equity component from one scoreVendor() result.
 * Non-mutating — returns a new object.
 */
function stripDemographic(result) {
  if (!result || !result.components) return result;
  const { demographic_equity, ...components } = result.components;
  const demoPoints = demographic_equity || 0;

  const details = result.details ? { ...result.details } : undefined;
  if (details) delete details.demographic;

  return {
    ...result,
    total: Math.round((result.total - demoPoints) * 10) / 10,
    components,
    details,
    cert_only: true,
    cert_only_max: CERT_ONLY_MAX,
  };
}

/**
 * Score one vendor against a complaint, certification-only (no demographic
 * component). Same call signature as scorer.js's scoreVendor().
 */
export function scoreCertOnly(complaint, vendor, journal = [], options = {}) {
  return stripDemographic(scoreVendor(complaint, vendor, journal, options));
}

/**
 * Rank top-N vendors for a complaint, certification-only. Re-implements
 * rankTop()'s three-tier fallback pool logic (eligible -> +almost -> +other)
 * but scores and sorts using the demographic-stripped total, so ranking
 * order can never be influenced by the component this exists to hide.
 */
export function rankCertOnly(complaint, vendorPool, journal = [], options = {}) {
  const topN = options.topN ?? 5;
  const allowAlmost = options.allowAlmost !== false;
  const allowOther  = options.allowOther  !== false;

  const all = vendorPool.map(v => {
    const result = stripDemographic(scoreVendor(complaint, v, journal, options));
    result.tier = vendorTier(v);
    return result;
  });

  const tier1Eligible = all.filter(s => s.eligible && s.tier === 'eligible');
  const tier2Almost   = all.filter(s => s.eligible && s.tier === 'almost');
  const tier3Other    = all.filter(s => s.eligible && s.tier === 'other');

  let candidates = [...tier1Eligible].sort((a, b) => b.total - a.total);
  let poolUsed = 'eligible-only';

  if (candidates.length < topN && allowAlmost) {
    candidates = [...tier1Eligible, ...tier2Almost].sort((a, b) => b.total - a.total);
    poolUsed = 'eligible-plus-almost';
  }
  if (candidates.length < topN && allowOther) {
    candidates = [...tier1Eligible, ...tier2Almost, ...tier3Other].sort((a, b) => b.total - a.total);
    poolUsed = 'full-pool';
  }

  const selected = candidates.slice(0, topN);
  selected.sort((a, b) => b.total - a.total);

  return {
    picks: selected.map((s, i) => ({ ...s, rank: i + 1 })),
    poolUsed,
    cert_only_max: CERT_ONLY_MAX,
    poolStats: {
      tier1Eligible: tier1Eligible.length,
      tier2Almost:   tier2Almost.length,
      tier3Other:    tier3Other.length,
      withinRadius:  candidates.length,
    },
  };
}
