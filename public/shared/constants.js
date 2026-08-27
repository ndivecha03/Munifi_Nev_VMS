// Nevada Public Works — shared constants (single source of truth)
//
// Regulatory hook: NRS Chapter 338 (Public Works) + NRS Chapter 333 (State
// Purchasing). Nevada's Emerging Small Business (ESB) program (NRS 338.0117)
// is the primary equity lever — no mandatory set-aside ceiling exists, but
// ESB-certified firms receive a scoring preference on state contracts.
//
// Program administered by: Nevada Governor's Office of Economic Development
// (GOED) — diversifynevada.com / GOED ESB portal.

// ─── NRS ESB / public-works policy thresholds ────────────────────────────
// NRS 338.0117: ESB preference on state public works contracts.
// NRS 333.336: 5% bid-price preference for small NV businesses on state
//   purchasing contracts ≤ $1M.
// NRS 338.013–338.090: prevailing-wage requirements on public works ≥ $250K.
export const POLICY = Object.freeze({
  esbPreferencePct:         5,          // 5% bid-price preference (NRS 333.336)
  prevailingWageThreshold:  250_000,    // contracts above this require prev. wage
  setAsideCeiling:          500_000,    // informal ESB-preference ceiling (NDOT practice)
  setAsideFloor:             25_000,    // below this: informal quotes only
  quoteOnlyCeiling:         100_000,    // three-quote process (NRS 333.335)
  esbVerifyFreshnessDays:    30,        // re-verify GOED ESB cert monthly
  radiusMiles:               50,        // Nevada service radius (large geography)
});

// ─── Citation strings ────────────────────────────────────────────────────
export const CITATIONS = Object.freeze({
  setAsideAuthority:  'NRS 338.0117 (Nevada ESB preference) + NRS 333.336 (5% bid preference)',
  quoteOnlyAuthority: 'NRS 333.335 — Three-quote informal solicitation (contracts ≤ $100K)',
  longCitation:
    'NRS 338.0117 — Nevada Emerging Small Business (ESB) Preference: ' +
    'State agencies must give priority to ESB-certified firms on public-works ' +
    'contracts. GOED administers ESB certification; recertification required annually. ' +
    'NRS 333.336 grants a 5% bid-price preference to qualified small NV businesses ' +
    'on state purchasing contracts ≤ $1M. Prevailing wage applies to public works ' +
    'contracts ≥ $250,000 under NRS 338.013–338.090.',
});

// ─── Scoring weights — sum to 100 ────────────────────────────────────────
// ESB-eligibility and overlooked-but-qualified are co-primary equity levers.
// Nevada geography demands higher proximity weight than SF.
export const SCORING_WEIGHTS = Object.freeze({
  esb_eligibility:          18,   // GOED ESB cert + NRS 333.336 preference
  overlooked_but_qualified: 18,   // ESB + little/no recent state contract history
  workload_balance:         15,   // few recent NDOT/NPWD dispatches (60-day half-life)
  demographic_equity:       14,   // DBE/MBE/WBE/DVBE diversity certifications
  proximity:                15,   // county-region match; large NV geography
  reliability:              10,   // active GOED cert + insurance on file
  capability:                6,   // NV contractor license + specialty match
  capacity_headroom:         4,   // low 12-month state spend = more headroom
});

// ─── Cost model — calibrated from NDOT public contract data ──────────────
//
// Sources: NDOT awarded-contract news releases (dot.nv.gov) and NDOT contract
// value ranges (R1–R54 schedule). Major corridor projects ($10M–$41M for
// 6–32 highway miles) set the per-mile baseline. ESB-eligible discrete work
// orders are spot/segment repairs well under the $500K set-aside ceiling.
// Ranges represent Q1–Q3 of ESB-scale NDOT work orders by work type.
export const COST_MODEL = Object.freeze({
  base: Object.freeze({
    emergency: 350_000,   // emergency spot repair / blowout — NDOT rapid-response
    urgent:    160_000,   // urgent maintenance: significant damage, safety risk
    elevated:   95_000,   // elevated: scheduled maintenance, notable defect
    standard:   65_000,   // standard: routine maintenance work order
  }),
  bump: Object.freeze({
    bridge:         80_000,   // bridge work carries higher engineering + traffic control
    culvert:        40_000,   // culvert replacement: excavation + pipe + backfill
    guardrail:      25_000,   // guardrail: steel, posts, end treatments
    drainage:       30_000,   // drainage: inlet/pipe repair, grading
  }),
  ranges: Object.freeze({
    // Ranges sourced from NDOT R-series contract value scale + ESB award patterns.
    // "low" = 25th pct, "high" = 75th pct for ESB-eligible discrete work orders.
    pavement_repair:         Object.freeze({ low:  75_000, high: 350_000 }),
    asphalt_overlay:         Object.freeze({ low: 120_000, high: 480_000 }),
    concrete_repair:         Object.freeze({ low:  60_000, high: 280_000 }),
    drainage_repair:         Object.freeze({ low:  80_000, high: 380_000 }),
    culvert_replacement:     Object.freeze({ low: 120_000, high: 480_000 }),
    erosion_control:         Object.freeze({ low:  45_000, high: 200_000 }),
    striping_markings:       Object.freeze({ low:  55_000, high: 250_000 }),
    guardrail_installation:  Object.freeze({ low:  70_000, high: 320_000 }),
    sign_installation:       Object.freeze({ low:  35_000, high: 150_000 }),
    bridge_inspection:       Object.freeze({ low:  45_000, high: 200_000 }),
  }),
  // Median single NDOT ESB-scale work order; used for annual-potential estimate.
  nvMedianWorkOrder: 90_000,
  // Estimated work orders per year an active Nevada ESB can absorb at this scale.
  nvEsbAnnualCapacity: Object.freeze({ low: 6, high: 12 }),
});

// ─── Severity → priority mapping ─────────────────────────────────────────
export const SEVERITY_TO_PRIORITY = Object.freeze({
  emergency: 'high',
  urgent:    'high',
  elevated:  'medium',
  standard:  'low',
});

export const PRIORITY_ORDER = Object.freeze({
  high: 0, medium: 1, low: 2,
});

// ─── Nevada GOED ESB / DBE certifying bodies + point values ──────────────
export const CERTIFYING_BODIES = Object.freeze({
  goed_esb:    { name: 'GOED ESB',    cert_type: 'esb',      points: 9 },
  usdot_dbe:   { name: 'USDOT DBE',  cert_type: 'dbe',      points: 8 },
  nmsdc:       { name: 'NMSDC',      cert_type: 'mbe',      points: 7 },
  wbenc:       { name: 'WBENC',      cert_type: 'wbe',      points: 7 },
  navoba:      { name: 'NaVOBA',     cert_type: 'veteran',  points: 6 },
  disability_in: { name: 'Disability:IN', cert_type: 'dobe', points: 5 },
  nglcc:       { name: 'NGLCC',      cert_type: 'lgbtbe',   points: 4 },
});

// ─── Nevada regions (NDOT / NPWD district alignment) ─────────────────────
export const LOCALITY_TIERS = Object.freeze({
  clark:        { label: 'Clark County (Las Vegas Metro)',    points: 15 },
  washoe:       { label: 'Washoe County (Reno/Sparks)',       points: 15 },
  southern_nv:  { label: 'Southern Nevada (Henderson/BC)',    points: 12 },
  northern_nv:  { label: 'Northern Nevada (Carson/Elko)',     points: 12 },
  rural_central:{ label: 'Rural Central NV (Nye/Lander)',     points:  8 },
  statewide:    { label: 'Statewide capability',              points:  5 },
});

// ─── Work-order specialties (NDOT/NPWD taxonomy) ─────────────────────────
export const EVENT_CATEGORIES = Object.freeze([
  'pavement_repair',
  'bridge_inspection',
  'culvert_replacement',
  'guardrail_installation',
  'sign_installation',
  'striping_markings',
  'drainage_repair',
  'concrete_repair',
  'asphalt_overlay',
  'erosion_control',
]);

// ─── NSCB license class requirements per specialty (NAC Chapter 624) ─────
// Each specialty maps to the A-class codes that qualify a vendor to perform
// that work on Nevada public contracts. A vendor holding ANY listed code passes.
// Source: NSCB license classification list + NRS 338 public works scope.
export const SPECIALTY_TO_NSCB = Object.freeze({
  pavement_repair:        ['A-2', 'A-12', 'A-16'],
  asphalt_overlay:        ['A-2', 'A-12', 'A-16'],
  concrete_repair:        ['A-16', 'A-2'],
  drainage_repair:        ['A-15', 'A-7', 'A-2'],
  culvert_replacement:    ['A-15', 'A-7'],
  erosion_control:        ['A-7', 'A-12', 'A-2'],
  striping_markings:      ['A-8', 'A-2'],
  guardrail_installation: ['A-2'],
  sign_installation:      ['A-2'],
  bridge_inspection:      ['A-4', 'A-2'],
});

// ─── Cache-bust string ───────────────────────────────────────────────────
export const CACHE_BUST = '20260826j';
