// SF Vendor Matrix — canonical name normalization.
//
// Vendor-name canonicalization for matching across DataSF (cqi5-hm2d),
// the CMD LBE directory, the CSLB CSV, and the internal pool. This is
// the ONE implementation. The mirror at scripts/lib/normalize.py MUST
// match exactly — if you change one, change both and add a fixture.
//
// Previously this routine was duplicated 6× across the Python ETL stages
// (apply-enrichment-research.py, apply-specialty-enrichment.py,
// enrich-vendors.py, merge-csv-vendors.py, pull-datasf-awards.py,
// find-pool-aliases.py). The May 27 ADA-ramp outage was caused by one
// of those copies emitting mixed case.

const SUFFIX_RE = new RegExp(
  '\\b(' +
  'CORP(ORATION)?|INC(ORPORATED)?|LLC|LLP|LTD|LIMITED|CO|COMPANY|' +
  'CONSTRUCTION|CONSTRCTN|CONSTR|CONCRETE|CEMENT|ENGINEERING|ENG|' +
  'CONTRACTORS?|CONTRACTING|GENERAL|BUILDERS|DEVELOPMENT|SERVICES?|' +
  'GROUP|DBA|A\\s+CALIF(ORNIA)?\\s+CORP|A\\s+CA\\s+CORP|AND|THE' +
  ')\\b\\.?',
  'gi',
);
const APOSTROPHE_RE = /['’‘]/g;
const PUNCT_RE      = /[^\w\s]/g;
const WS_RE         = /\s+/g;

/**
 * Canonicalize a business name for cross-source matching.
 * Idempotent. Returns the empty string for null/empty input.
 *
 * @param {string|null|undefined} name
 * @returns {string} uppercase, suffix-stripped, single-spaced
 *
 * @example
 *   normalize("D'arcy & Harty Construction, Inc.") === "DARCY HARTY"
 *   normalize("DARCY & HARTY CONSTR INC")          === "DARCY HARTY"
 */
export function normalize(name) {
  if (!name) return '';
  let s = String(name).toUpperCase();
  s = s.replace(APOSTROPHE_RE, '');
  s = s.replace('&', ' AND ');
  s = s.replace(SUFFIX_RE, '');
  s = s.replace(PUNCT_RE, ' ');
  s = s.replace(WS_RE, ' ').trim();
  return s;
}
