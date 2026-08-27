// SF Vendor Matrix — vendor accessor functions.
//
// Replaces the `vendor.track_record?.X || 0` pattern that was repeated
// 21+ times across dispatch.js, scorer.js, and 14b-memo.js. Each
// accessor returns the documented sentinel (0 / null / false) for
// missing data, never throws, and is pure (no mutation).
//
// Composite predicates (isSetAsideEligible, hasAnyCityHistory, etc.)
// were also duplicated in dispatch.js — moved here so all consumers
// share one definition.

import { POLICY } from './constants.js';

export const VendorAccessors = Object.freeze({
  // ─── Track record (DataSF-backfilled) ─────────────────────────────────
  priorPrimeValue:    v => Number(v?.track_record?.prior_dpw_contracts_value)        || 0,
  priorPrimeCount:    v => Number(v?.track_record?.prior_dpw_contracts_count)        || 0,
  priorSubValue:      v => Number(v?.track_record?.prior_dpw_sub_value_upper_bound)  || 0,
  priorSubCount:      v => Number(v?.track_record?.prior_dpw_sub_contracts_count)    || 0,
  lastContractDate:   v => v?.track_record?.last_city_contract_date || null,
  firstContractDate:  v => v?.track_record?.first_city_contract_date || null,
  terminations24mo:   v => Number(v?.track_record?.terminations_24mo) || 0,

  // ─── Licensing (CSLB) ─────────────────────────────────────────────────
  cslbLicense:        v => v?.licensing?.cslb_license || null,
  cslbClass:          v => (v?.licensing?.cslb_class || '').toUpperCase(),
  cslbStatus:         v => (v?.licensing?.cslb_status || '').toLowerCase(),
  cslbExpiresOn:      v => v?.licensing?.cslb_expires_on || null,
  isCslbActive:       v => (v?.licensing?.cslb_status || '').toLowerCase() === 'active',
  isC8Licensed:       v => (v?.licensing?.cslb_class || '').toUpperCase().includes('C-8'),

  // ─── CMD certification (LBE program) ──────────────────────────────────
  lbeTier:            v => (v?.lbe?.tier || '').toLowerCase(),
  cmdCertNumber:      v => v?.lbe?.cmd_cert_number || null,
  isCmdActive:        v => Boolean(v?.lbe?.cmd_cert_active),
  cmdCertLastVerified:v => v?.lbe?.cmd_cert_last_verified || null,
  cmdCertExpiresOn:   v => v?.lbe?.cmd_cert_expires_on || null,
  lbeSource:          v => v?.lbe?.source || null,

  isMicroLbe:         v => (v?.lbe?.tier || '').toLowerCase().includes('micro'),
  isSmallLbe:         v => (v?.lbe?.tier || '').toLowerCase().includes('small'),
  isSbaLbe:           v => (v?.lbe?.tier || '').toLowerCase().includes('sba'),
  hasAnyLbeTier:      v => Boolean((v?.lbe?.tier || '').toLowerCase()),

  // ─── Address ──────────────────────────────────────────────────────────
  addressLat:         v => {
    const n = Number(v?.address?.lat ?? v?.lat);
    return Number.isFinite(n) ? n : null;
  },
  addressLng:         v => {
    const n = Number(v?.address?.lng ?? v?.lng);
    return Number.isFinite(n) ? n : null;
  },
  supervisorDistrict: v => v?.address?.supervisor_district || null,

  // ─── Contact (PII — Phase 3 will move to server-only) ─────────────────
  email:              v => v?.contact?.email || null,
  phone:              v => v?.contact?.phone || null,

  // ─── Demographics ─────────────────────────────────────────────────────
  isMbe:              v => Boolean(v?.demographics?.calcert_mbe),
  isWbe:              v => Boolean(v?.demographics?.calcert_wbe),
  isSba8a:            v => Boolean(v?.demographics?.sba_8a),
  isVeteran:          v => Boolean(v?.demographics?.veteran_owned),
  isDvbe:             v => Boolean(v?.demographics?.disabled_veteran_owned),
});

// ─── Composite predicates — derived business questions ──────────────────

/** Does the vendor pass the NRS 338.0117 ESB set-aside test?
 *  Nevada vendors qualify if they have an active GOED ESB/DBE cert (lbe.cmd_cert_active)
 *  and an active NV contractor license. SF Micro-LBE tier check not applicable here.
 */
export function isVendorSetAsideEligible(vendor) {
  const isCmdActive  = VendorAccessors.isCmdActive(vendor);
  // Nevada: nv_license_status; SF fallback: cslb_status
  const nvLicActive  = (vendor?.licensing?.nv_license_status || '').toLowerCase() === 'active';
  const sfLicActive  = VendorAccessors.isCslbActive(vendor);
  const licActive    = nvLicActive || sfLicActive;
  // Nevada vendors don't use LBE tiers — treat any active-cert vendor as eligible
  const isMicro      = VendorAccessors.isMicroLbe(vendor);
  const isNvEsb      = isCmdActive && licActive;  // Nevada path
  const isSfMicro    = isMicro && isCmdActive && sfLicActive; // SF path
  return isNvEsb || isSfMicro;
}

/** Has the vendor received any DPW prime or sub contracts since FY2018? */
export function hasAnyCityHistory(vendor) {
  return VendorAccessors.priorPrimeValue(vendor) > 0
      || VendorAccessors.priorSubValue(vendor)   > 0;
}

/** Sub-only: never primed but appears as subcontractor. */
export function isSubOnly(vendor) {
  return VendorAccessors.priorPrimeValue(vendor) === 0
      && VendorAccessors.priorSubValue(vendor)    > 0;
}

/** Truly overlooked: zero prime, zero sub. The §14B.7 target profile. */
export function isOverlookedForPrime(vendor) {
  return !hasAnyCityHistory(vendor);
}

/** CMD cert verified within the freshness window? */
export function isCmdCertStale(vendor, nowMs = Date.now()) {
  const verified = VendorAccessors.cmdCertLastVerified(vendor);
  if (!verified) return true;
  const ageMs = nowMs - new Date(verified).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return !Number.isFinite(ageDays) || ageDays > POLICY.cmdVerifyFreshnessDays;
}
