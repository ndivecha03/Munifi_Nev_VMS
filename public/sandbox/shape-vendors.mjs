// public/sandbox/shape-vendors.mjs — v2 API -> scorer adapter for the
// SFDA sandbox dashboard.
//
// Extracted from public/dispatch.js's adaptApiVendor() (the production
// console's Postgres-API adapter) — see dispatch.js:1455 for the source
// this was lifted from. Without this shaping step, raw /api/v2/vendors
// records (vendor_specialties:[], certifications:[], top-level cslb_*
// fields) score 0 eligible in scorer.js, which expects the legacy
// baked-vendors-v2.json shape ({licensing, lbe, address, specialties}).
//
// shapeVendor() is source-agnostic: if the record already looks like a
// shaped v2 vendor (has a `licensing` object), it's passed through
// unchanged — so this works against both the live API and the local
// public/baked-vendors-v2.json fallback without branching at call sites.

function extractContractCount(title) {
  if (!title) return 0;
  const m = String(title).match(/(\d+)\s+prior\s+DPW/);
  return m ? Number(m[1]) : 0;
}

function isAlreadyShaped(record) {
  return record && typeof record.licensing === 'object' && record.licensing !== null;
}

/**
 * Shape one raw /api/v2/vendors record (with joined relations:
 * certifications, vendor_addresses, vendor_specialties, vendor_contracts)
 * into the {licensing, lbe, address, specialties, track_record, contact}
 * shape scorer.js and the sandbox dashboard expect.
 *
 * @param {Object} apiV           raw API record
 * @param {Object} [contactSource] optional JSON-sourced record to merge
 *                                 contact/audit/demographics from (these
 *                                 aren't served by the API)
 */
export function shapeVendor(apiV, contactSource) {
  if (isAlreadyShaped(apiV)) return apiV;

  const certs = apiV.certifications || [];
  const cslb  = certs.find(c => c.cert_type === 'cslb')    || {};
  const cmd   = certs.find(c => c.cert_type === 'cmd_lbe') || {};

  const addrs = apiV.vendor_addresses || [];
  const addr  = addrs.find(a => a.is_primary) || addrs[0] || {};

  const specs = (apiV.vendor_specialties || []).map(s => s.specialty);

  const contracts = apiV.vendor_contracts || [];
  const primeAgg = contracts.find(c => c.role === 'prime') || {};
  const subAgg   = contracts.find(c => c.role === 'sub')   || {};

  return {
    id:   apiV.pool_id || apiV.id,
    name: apiV.legal_name,

    licensing: {
      cslb_license:    cslb.cert_number   || apiV.cslb_license || null,
      cslb_class:      (apiV.cslb_class || []).join(', '),
      cslb_status:     cslb.status        || 'unverified',
      cslb_expires_on: cslb.expires_on    || null,
    },

    lbe: {
      tier:                   cmd.cert_tier         || null,
      cmd_cert_number:        cmd.cert_number       || null,
      cmd_cert_active:        cmd.status === 'active',
      cmd_cert_expires_on:    cmd.expires_on        || null,
      cmd_cert_last_verified: cmd.last_verified_at  || null,
    },

    address: {
      line1:               addr.address               || null,
      city:                addr.city                  || null,
      state:               addr.state                 || 'CA',
      zip:                 addr.zip                   || null,
      lat:                 addr.lat                   ?? null,
      lng:                 addr.lng                   ?? null,
      supervisor_district: addr.supervisor_district   || null,
    },

    // Contacts ship from the JSON merge only — the public API redacts PII.
    // The sandbox dashboard should call stripVendorPII() on top of this
    // regardless (see pii.mjs) before rendering anything vendor-related.
    contact: contactSource?.contact || { email: null, phone: null, website: null },

    specialties: specs,

    track_record: {
      prior_dpw_contracts_value:        Number(primeAgg.agreed_amount) || 0,
      prior_dpw_contracts_count:        extractContractCount(primeAgg.contract_title),
      prior_dpw_sub_value_upper_bound:  Number(subAgg.agreed_amount)   || 0,
      prior_dpw_sub_contracts_count:    extractContractCount(subAgg.contract_title),
      last_city_contract_date:          primeAgg.awarded_on || subAgg.awarded_on || null,
    },

    audit:        contactSource?.audit        || { warnings: [] },
    demographics: contactSource?.demographics || {},

    _api_id:  apiV.id ?? null,
    _source: 'api',
  };
}

/**
 * Shape a full vendor list. `jsonFallback` (optional) is the
 * baked-vendors-v2.json vendor array, used only to backfill contact/audit/
 * demographics for records keyed by pool_id — same merge dispatch.js does.
 */
export function shapeVendors(apiVendors, jsonFallback) {
  const jsonByPoolId = new Map();
  for (const v of (jsonFallback || [])) jsonByPoolId.set(v.id, v);
  return (apiVendors || []).map(av => shapeVendor(av, jsonByPoolId.get(av.pool_id)));
}
