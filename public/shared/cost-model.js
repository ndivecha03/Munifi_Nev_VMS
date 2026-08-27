// SF Vendor Matrix — cost-model functions.
//
// estimateCost, estimateCostRange, procurementVehicle, and
// estimateAnnualPotential were all previously inline in dispatch.js with
// hardcoded coefficients. Moved here so the §14B memo (14b-memo.js) can
// eventually share the same source — Phase 2 wires the memo through this
// module as well; Phase 1 just centralizes the JS-side definition.
//
// Coefficients are calibrated from DataSF cqi5-hm2d. See
// data/sirp-cost-calibration.json for the audit trail and re-derive via
// scripts/calibrate-cost-model.py after any fresh DataSF pull.

import { COST_MODEL, POLICY } from './constants.js';

/**
 * Estimate a single-work-order cost for a 311 complaint.
 * If complaint.estimatedCost is provided, returns it verbatim.
 * Otherwise: base(severity) + bump(specialty).
 */
export function estimateCost(complaint) {
  if (complaint?.estimatedCost != null) {
    return Number(complaint.estimatedCost);
  }
  const sev  = (complaint?.severity || complaint?.priority || 'standard').toLowerCase();
  const spec = (complaint?.specialty_required || '').toLowerCase();
  const base = COST_MODEL.base[sev] ?? COST_MODEL.base.standard;
  const bump = COST_MODEL.bump[spec] ?? 0;
  return base + bump;
}

/** Typical Q1-Q3 range for the dispatcher's pre-quote sanity check. */
export function estimateCostRange(complaint) {
  const spec = (complaint?.specialty_required || complaint?.subtype || 'pavement_repair').toLowerCase();
  return COST_MODEL.ranges[spec] || COST_MODEL.ranges.pavement_repair || { low: 75_000, high: 350_000 };
}

/**
 * Which procurement vehicle applies to this complaint cost?
 * Returns null if cost exceeds the set-aside ceiling.
 */
export function procurementVehicle(estimatedCost) {
  const cost = Number(estimatedCost);
  if (!Number.isFinite(cost)) return null;
  if (cost <= POLICY.setAsideFloor) {
    return Object.freeze({
      label: 'Informal quote (NRS 333.335)',
      authority: 'NRS 333.335 — three ESB quotes',
      cityTimeline: '1–3 days',
      standardTimeline: '~90 days',
      daysSaved: 87,
    });
  }
  if (cost <= POLICY.quoteOnlyCeiling) {
    return Object.freeze({
      label: 'NRS 333.335 — Three-quote ESB',
      authority: 'three GOED ESB quotes required',
      cityTimeline: '7–14 days',
      standardTimeline: '~90 days',
      daysSaved: 76,
    });
  }
  if (cost <= POLICY.setAsideCeiling) {
    return Object.freeze({
      label: '§NRS 338.0117 ESB SET-ASIDE',
      authority: 'NRS 338.0117 — restricted to GOED ESB pool',
      cityTimeline: '30–45 days',
      standardTimeline: '~90 days',
      daysSaved: 50,
    });
  }
  return null;
}

/**
 * Annual-potential range for an overlooked Nevada ESB firm.
 * Anchored to the NDOT median ESB-scale work order ($90K) and
 * estimated 6–12 work orders/yr capacity for an active ESB firm.
 */
export function estimateAnnualPotential() {
  const median = COST_MODEL.nvMedianWorkOrder;
  const { low, high } = COST_MODEL.nvEsbAnnualCapacity;
  return Object.freeze({
    low:  median * low,
    high: median * high,
    avgContract: median,
  });
}
