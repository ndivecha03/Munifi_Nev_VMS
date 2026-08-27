// SF SIRP Vendor scoring engine — equity-first matrix.
//
// One file, two consumers:
//   • Browser (production): loaded via <script type="module"> from index.html.
//   • Node (testing):       imported by scripts/test-scorer.mjs.
//
// Public API:
//   rankTop(complaint, vendorPool, journal, options)  → array of ranked picks
//   scoreVendor(complaint, vendor, journal, options)  → single vendor's score
//
// SF Chapter 14B context:
//   SF Administrative Code Chapter 14B (Jan 2025 amendments) allows DPW to
//   route work orders up to $600K directly to Micro-LBE certified contractors
//   without competitive solicitation. This scoring engine surfaces the top-5
//   eligible contractors for each complaint location.

// ─────────────────────────────────────────────────────────────────────────────
// Constants

// Weights per the Concept 1 dispatch console build doc (2026-05-25):
// set-aside eligibility = 18, proximity = 15, total = 100.
// Earlier ordering (lbe=15, prox=18) was inverted; this reflects the
// product-design decision that set-aside applicability matters more than
// raw mileage within an SF-sized geography.
// Phase 1 refactor: weights and thresholds are now sourced from
// public/shared/constants.js — the single source of truth shared with
// dispatch.js and 14b-memo.js. Equity rationale (set-aside + overlooked
// weighted equally at 18, proximity intentionally only 15 within SF's
// small geography) is documented in docs/matrix-weights.md.
import { POLICY, SCORING_WEIGHTS, SPECIALTY_TO_NSCB } from './shared/constants.js?v=20260826j';

// Build the WEIGHTS object that's exported as both a named binding and
// the default. Backward-compat aliases (lbe_eligibility,
// baseline_capability) preserved for older call sites.
export const WEIGHTS = Object.freeze({
  ...SCORING_WEIGHTS,
  // backward-compat aliases
  lbe_eligibility:     SCORING_WEIGHTS.set_aside_eligibility ?? SCORING_WEIGHTS.esb_eligibility,
  set_aside_eligibility: SCORING_WEIGHTS.esb_eligibility ?? SCORING_WEIGHTS.set_aside_eligibility,
  baseline_capability: SCORING_WEIGHTS.capability,
});

// Keep the data-loader / UI happy with consistent key names
export { WEIGHTS as default };

const HARD_FILTERS = Object.freeze({
  radiusMiles: POLICY.radiusMiles,
  requireLicenseActive: true,
});

const DIRECT_PURCHASE_THRESHOLD = POLICY.setAsideCeiling;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || Number.isNaN(v))) return Infinity;
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 schema adapter — computes the legacy `scoring_inputs` block on the fly
// from the new structured vendor record. Idempotent: skips if already set.

function ensureScoringInputs(vendor) {
  if (vendor.scoring_inputs) return vendor;

  const lic = vendor.licensing || {};
  const lbe = vendor.lbe || {};
  const dem = vendor.demographics || {};
  const tr  = vendor.track_record || {};

  // Nevada schema: nv_license_status / nv_contractor_license; also handles SF cslb_status fallback
  const licenseActive = (lic.nv_license_status || lic.cslb_status || "").toLowerCase() === "active"
                     || lic.ca_business_license_active === true
                     || !!lbe.cmd_cert_active;
  const cmdActive     = !!lbe.cmd_cert_active;
  const tier          = (lbe.tier || "").toLowerCase();

  // Nevada ESB eligibility: GOED cert active + license active
  const esbEligible = cmdActive && licenseActive;
  // Legacy SF Micro-LBE eligibility
  const microEligible = tier.includes("micro") && cmdActive && licenseActive;

  // Demographic equity scoring (cap at WEIGHTS.demographic_equity)
  let demoPts = 0;
  const tags = [];
  if (tier.includes("micro")) { demoPts += 6; tags.push("Micro-LBE"); }
  else if (tier.includes("small")) { demoPts += 4; tags.push("Small-LBE"); }
  else if (tier.includes("sba")) { demoPts += 4; tags.push("SBA-LBE"); }
  else if (tier.includes("lbe") && !tier.startsWith("non")) { demoPts += 2; tags.push("LBE"); }
  // Nevada-specific cert fields
  if (dem.dbe_certified)    { demoPts += 5; tags.push("DBE"); }
  if (dem.wbe_certified)    { demoPts += 4; tags.push("WBE"); }
  if (dem.dvbe_certified)   { demoPts += 3; tags.push("DVBE"); }
  if (dem.lgbtbe_certified) { demoPts += 3; tags.push("LGBTBE"); }
  if (dem.dobe_certified)   { demoPts += 3; tags.push("DOBE"); }
  // SF fallbacks
  if (dem.calcert_mbe) { demoPts += 4; tags.push("MBE"); }
  if (dem.calcert_wbe) { demoPts += 4; tags.push("WBE"); }
  if (dem.sba_8a)      { demoPts += 3; tags.push("SBA 8(a)"); }
  if (dem.veteran_owned) { demoPts += 2; tags.push("Veteran-owned"); }
  if (dem.disabled_veteran_owned) { demoPts += 1; tags.push("DVBE"); }
  demoPts = Math.min(demoPts, WEIGHTS.demographic_equity);

  // Overlooked-but-qualified inputs — NV reads prior_ndot_contracts_count/value
  const awardCount5yr = tr.prior_ndot_contracts_count ?? tr.prior_dpw_contracts_count ?? 0;
  const yearsLicensed = 5;
  const yearsSinceLastAward = tr.last_city_contract_date
    ? Math.max(0, (Date.now() - new Date(tr.last_city_contract_date).getTime()) / (1000*60*60*24*365.25))
    : yearsLicensed;

  const nvLicense = lic.nv_contractor_license || lic.cslb_license || '';

  vendor.scoring_inputs = {
    reliability_proxy: {
      licenseActive,
      terminations: tr.terminations_24mo || 0,
      outcome_rate:    (vendor.outcome_stats && vendor.outcome_stats.survey_count > 0) ? Number(vendor.outcome_stats.completion_rate) : null,
      outcome_surveys: vendor.outcome_stats ? (vendor.outcome_stats.survey_count || 0) : 0,
    },
    lbe_eligibility: {
      eligible: esbEligible || microEligible,
      reasons: {
        esbCertActive: esbEligible,
        microLbeTier: tier.includes("micro"),
        cmdCertActive: cmdActive,
        licenseActive,
        licenseClassCorrect: (lic.classifications || [lic.cslb_class || '']).some(c => c.includes('C-8') || c.includes('A') || c.includes('B')),
      },
    },
    demographic_points: demoPts,
    demographic_tags: tags,
    overlooked: {
      awardCount5yr,
      yearsLicensed,
      yearsSinceLastAward,
    },
    baseline_capability: !!(nvLicense && (lbe.cmd_cert_active || awardCount5yr > 0)),
    capacity_headroom_amount_12mo: tr.prior_ndot_contracts_value ?? tr.prior_dpw_contracts_value ?? 0,
  };
  return vendor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability matching — what specialty does this complaint actually need?

export function complaintRequiredSpecialty(defect) {
  const d = (defect || '').toLowerCase();
  // Return lowercase canonical form. Vendor specialties are matched case-
  // insensitively by vendorCanFulfill below, so any past data using mixed
  // case (e.g. legacy "ADA_ramp" tags) still resolves correctly.
  if (d.includes('ada') || (d.includes('ramp') && !d.includes('apron'))) return 'ada_ramp';
  if (d.includes('curb'))                                                  return 'curb_cut';
  if (d.includes('tree'))                                                  return 'tree_well';
  if (d.includes('driveway') || d.includes('apron'))                       return 'driveway_apron';
  return 'sidewalk';   // default for trip hazards, cracked panels, sunken panels, etc.
}

export function vendorCanFulfill(vendor, complaint) {
  // Prefer the explicit specialty_required field from Mithran's v2 complaint
  // ingest (live SF 311 data); fall back to defect-string inference for any
  // legacy / hand-authored complaints. Case-insensitive match — the ingest
  // emits "ada_ramp" but migrate-vendors.py historically wrote "ADA_ramp"
  // onto vendors. Normalize both sides to lowercase for comparison.
  const required = (complaint.specialty_required
                    || complaint.subtype
                    || complaintRequiredSpecialty(complaint.defect)
                    || '').toLowerCase();
  const have = (vendor.specialties || []).map(s => (s || '').toLowerCase());
  return !required || have.includes(required);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard filters

function hardFiltersPass(complaint, vendor, options = {}) {
  const radius = options.radiusMiles ?? HARD_FILTERS.radiusMiles;
  const fails = [];

  if (HARD_FILTERS.requireLicenseActive) {
    const active = vendor.scoring_inputs?.reliability_proxy?.licenseActive;
    if (!active) fails.push('license_inactive');
  }

  const miles = haversineMiles(
    complaint.lat, complaint.lng,
    vendor.address?.lat ?? vendor.lat,
    vendor.address?.lng ?? vendor.lng,
  );
  if (miles > radius) fails.push('outside_radius');

  // Capability hard filter — vendor's specialties must include the
  // specialty the complaint's defect type requires.
  if (!vendorCanFulfill(vendor, complaint)) {
    fails.push('cannot_fulfill_specialty');
  }

  // NSCB license classification hard filter (NAC Chapter 624 / NRS 338).
  // Vendor must hold at least one of the A-class codes required for the
  // complaint's work type. Vendors with no classifications on file pass
  // through (data gap — don't penalise missing data during rollout).
  const subtype = (complaint.subtype || complaint.defect || '').toLowerCase();
  const requiredCodes = SPECIALTY_TO_NSCB[subtype];
  if (requiredCodes) {
    const vendorCodes = (vendor.licensing?.classifications || []).map(c => c.toUpperCase());
    if (vendorCodes.length > 0 && !requiredCodes.some(rc => vendorCodes.includes(rc))) {
      fails.push('nscb_class_mismatch');
    }
  }

  if (options.microLbeOnly) {
    const eligible = vendor.scoring_inputs?.lbe_eligibility?.eligible;
    if (!eligible) fails.push('not_lbe_eligible');
  }

  return { pass: fails.length === 0, fails, distanceMiles: miles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workload balance — component 1 (inverse)

function workloadBalanceScore(vendor, journal) {
  if (!journal || journal.length === 0) {
    return { points: WEIGHTS.workload_balance, weighted_dispatches: 0 };
  }
  const now = Date.now();
  const HALF_LIFE_DAYS = 60;
  let weighted = 0;
  for (const dispatch of journal) {
    if (dispatch.vendor_id !== vendor.id) continue;
    const dispatchTime = new Date(dispatch.dispatched_at).getTime();
    const daysAgo = (now - dispatchTime) / (1000 * 60 * 60 * 24);
    if (daysAgo < 0 || daysAgo > 365) continue;
    weighted += Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
  }
  const points = WEIGHTS.workload_balance / (1 + weighted);
  return { points, weighted_dispatches: weighted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlooked-but-qualified — component 2 (inverse, tenure-modulated)

function overlookedScore(vendor) {
  const o = vendor.scoring_inputs?.overlooked || {};
  const awardCount5yr = o.awardCount5yr ?? 0;
  const yearsLicensed = o.yearsLicensed ?? 0;
  const yearsSinceLastAward = o.yearsSinceLastAward ?? yearsLicensed;

  const award_drought = 1 - Math.min(1, awardCount5yr / 10);
  // Clamp drought to the firm's tenure: a 1-year-old firm can't have 5 drought years.
  // (Previous formula yearsLicensed-(yearsLicensed-yearsSinceLastAward) cancelled to
  // yearsSinceLastAward, silently ignoring yearsLicensed. Fixed.)
  const drought_years = Math.min(yearsSinceLastAward, yearsLicensed);
  const inferred_drought_years = yearsLicensed === 0 ? 5 : drought_years;
  const tenure_bonus = Math.min(1, inferred_drought_years / 5);

  const underuse_factor = award_drought * tenure_bonus;
  const points = WEIGHTS.overlooked_but_qualified * underuse_factor;
  return { points, award_drought, tenure_bonus, underuse_factor };
}

// ─────────────────────────────────────────────────────────────────────────────
// LBE set-aside eligibility — component 3 (binary)
//
// If complaint.estimatedCost > $600K (Chapter 14B Micro-LBE ceiling), the
// set-aside doesn't apply and this component contributes zero.

function lbeEligibilityScore(complaint, vendor) {
  const estimatedCost = complaint.estimatedCost ?? 0;
  const ruleApplies = estimatedCost <= DIRECT_PURCHASE_THRESHOLD;
  if (!ruleApplies) {
    return { points: 0, eligible: false, rule_applies: false,
             reason: `estimated_cost_${estimatedCost}_exceeds_${DIRECT_PURCHASE_THRESHOLD}` };
  }
  const dpe = vendor.scoring_inputs?.lbe_eligibility ||
              vendor.scoring_inputs?.direct_purchase_eligibility || {};
  const eligible = !!dpe.eligible;
  return {
    points: eligible ? WEIGHTS.lbe_eligibility : 0,
    eligible,
    rule_applies: true,
    reasons: dpe.reasons || {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demographic equity — component 4
// Pre-computed points in scoring_inputs.demographic_points by data-loader.

function demographicScore(vendor) {
  const points = vendor.scoring_inputs?.demographic_points ?? 0;
  const tags = vendor.scoring_inputs?.demographic_tags ?? [];
  return { points: Math.min(points, WEIGHTS.demographic_equity), tags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proximity — component 5 (quadratic decay)

function proximityScore(distanceMiles) {
  if (distanceMiles == null || !Number.isFinite(distanceMiles)) {
    return { points: 0, miles: null };
  }
  const m = distanceMiles / 3;
  const factor = 1 / (1 + m * m);
  return { points: WEIGHTS.proximity * factor, miles: distanceMiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reliability — component 6

function reliabilityScore(vendor) {
  const r = vendor.scoring_inputs?.reliability_proxy || {};
  const active = !!r.licenseActive;
  const terminations = r.terminations || 0;
  let points = active ? Math.max(0, WEIGHTS.reliability - 2 * terminations) : 0;
  // Learning loop: when real citizen-survey outcomes exist, scale reliability by
  // the vendor's completion rate (0–1). No surveys yet → score is unchanged.
  if (points > 0 && r.outcome_rate != null && r.outcome_surveys > 0) {
    points = Math.max(0, +(points * (0.5 + 0.5 * r.outcome_rate)).toFixed(2));
  }
  return { points, license_active: active, terminations, outcome_rate: r.outcome_rate ?? null, outcome_surveys: r.outcome_surveys || 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline capability — component 7 (binary floor)

function capabilityScore(vendor) {
  const cap = !!vendor.scoring_inputs?.baseline_capability;
  return { points: cap ? WEIGHTS.baseline_capability : 0, capable: cap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacity headroom — component 8 (inverse)

function headroomScore(vendor) {
  const amount = vendor.scoring_inputs?.capacity_headroom_amount_12mo ?? 0;
  const factor = 1 - Math.min(1, amount / 500_000);
  const points = WEIGHTS.capacity_headroom * factor;
  return { points, recent_12mo_amount: amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score a single vendor against a complaint.

export function scoreVendor(complaint, vendor, journal = [], options = {}) {
  ensureScoringInputs(vendor);   // adapt v2 schema -> internal scoring_inputs
  const filterResult = hardFiltersPass(complaint, vendor, options);
  if (!filterResult.pass) {
    return {
      vendor_id: vendor.id || vendor.name,
      vendor_name: vendor.name,
      eligible: false,
      reason_excluded: filterResult.fails,
      distance_miles: filterResult.distanceMiles,
      total: 0,
      components: {},
    };
  }

  const wb  = workloadBalanceScore(vendor, journal);
  const ov  = overlookedScore(vendor);
  const lbe = lbeEligibilityScore(complaint, vendor);
  const dem = demographicScore(vendor);
  const px  = proximityScore(filterResult.distanceMiles);
  const rel = reliabilityScore(vendor);
  const cap = capabilityScore(vendor);
  const hd  = headroomScore(vendor);

  const total =
    wb.points + ov.points + lbe.points + dem.points +
    px.points + rel.points + cap.points + hd.points;

  // Build badges array for UI — reads v2 schema with v1 fallbacks
  const badges = [];
  const lbeTier = (vendor.lbe?.tier || vendor.lbe_type || '').toLowerCase();
  if (lbeTier.includes('micro'))      badges.push('Micro-LBE');
  else if (lbeTier.includes('small')) badges.push('Small-LBE');
  else if (lbeTier.includes('sba'))   badges.push('SBA-LBE');
  else if (lbeTier.includes('lbe'))   badges.push('LBE');

  const cmdCertId = vendor.lbe?.cmd_cert_number || vendor.cert_id;
  const cmdActive = vendor.lbe?.cmd_cert_active;
  if (cmdCertId && cmdActive) badges.push('CMD Certified');
  if (cmdCertId && !cmdActive) badges.push('CMD cert unverified');

  if (lbe.eligible) badges.push('Set-Aside Eligible');

  if ((vendor.track_record?.prior_dpw_contracts_count ?? 0) === 0 && lbeTier.includes('micro')) {
    badges.push('Overlooked');
  }
  if (vendor.address?.supervisor_district === complaint.supervisor_district) {
    badges.push('Same district');
  }

  return {
    vendor_id: vendor.id || vendor.name,
    vendor_name: vendor.name,
    eligible: true,
    distance_miles: filterResult.distanceMiles,
    total: Math.round(total * 10) / 10,
    components: {
      workload_balance:         Math.round(wb.points  * 10) / 10,
      overlooked_but_qualified: Math.round(ov.points  * 10) / 10,
      lbe_eligibility:          Math.round(lbe.points * 10) / 10,
      demographic_equity:       Math.round(dem.points * 10) / 10,
      proximity:                Math.round(px.points  * 10) / 10,
      reliability:              Math.round(rel.points * 10) / 10,
      baseline_capability:      Math.round(cap.points * 10) / 10,
      capacity_headroom:        Math.round(hd.points  * 10) / 10,
    },
    details: { workload: wb, overlooked: ov, lbe: lbe,
               demographic: dem, proximity: px, reliability: rel,
               capability: cap, headroom: hd },
    badges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor tiering — three-stage pool used by rankTop.
//   eligible  = Micro-LBE certified + active CSLB C-8 + CMD cert active
//   almost    = Small-LBE or SBA-LBE certified + active license
//   other     = CMD cert only, unconfirmed, or no certification

export function vendorTier(vendor) {
  const dpe = vendor.scoring_inputs?.lbe_eligibility ||
              vendor.scoring_inputs?.direct_purchase_eligibility;
  if (!dpe) return 'other';
  if (dpe.eligible) return 'eligible';
  // Fix: ensureScoringInputs never sets r.hasLbeCertification, so checking it
  // always returned 'other' for Small-LBE/SBA-LBE, making tier2Almost permanently
  // empty. Check the tier string directly instead.
  const tier = (vendor.lbe?.tier || '').toLowerCase();
  const licActive = vendor.scoring_inputs?.reliability_proxy?.licenseActive;
  const isSmallOrSba = (tier.includes('small') || tier.includes('sba'))
                       && !tier.startsWith('non');
  if (isSmallOrSba && licActive) return 'almost';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank a vendor pool against a complaint, return top-N with breakdowns.
//
// Three-stage selection:
//   1. Try just the eligible pool (Micro-LBE, Chapter 14B set-aside eligible).
//   2. If fewer than topN within radius, expand to "almost eligible" (Small-LBE, SBA-LBE).
//   3. If still fewer, expand to the full pool (all CMD-certified + DPW-bonded vendors).

export function rankTop(complaint, vendorPool, journal = [], options = {}) {
  const topN = options.topN ?? 5;
  const allowAlmost = options.allowAlmost !== false;
  const allowOther  = options.allowOther  !== false;

  const all = vendorPool.map(v => {
    const result = scoreVendor(complaint, v, journal, options);
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
    poolStats: {
      tier1Eligible: tier1Eligible.length,
      tier2Almost:   tier2Almost.length,
      tier3Other:    tier3Other.length,
      withinRadius:  candidates.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser global fallback for non-module script tags.

if (typeof window !== 'undefined') {
  window.VendorScorer = { scoreVendor, rankTop, WEIGHTS };
}
