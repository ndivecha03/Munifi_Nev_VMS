// public/sandbox/pii.mjs — PII-safety helpers for the SFDA sandbox dashboard.
//
// The sandbox runs on public 311 data + synthetic fill, and is shown to an
// external reference (Herman Brown, DA CIO). Nothing it renders should ever
// include vendor contact info (email/phone/fax) or any complainant identity —
// DataSF 311 doesn't carry submitter contact at all, so that risk is already
// closed on the complaint side; this file closes it on the vendor side.
//
// IMPORTANT: /api/v2/vendors already blocks contacts at the Supabase RLS
// layer unless `include=contacts` is explicitly requested (see api/v2/vendors.js).
// stripVendorPII is belt-and-suspenders for the JSON-fallback path
// (baked-vendors-v2.json ships contact info for the production console).

/**
 * Remove PII fields from a single shaped vendor record. Non-mutating.
 */
export function stripVendorPII(vendor) {
  if (!vendor) return vendor;
  const { contact, ...rest } = vendor;
  return {
    ...rest,
    contact: { redacted: true },
  };
}

/**
 * Remove PII from an array of vendors.
 */
export function stripVendorsPII(vendors) {
  return (vendors || []).map(stripVendorPII);
}

// ─────────────────────────────────────────────────────────────────────────
// At-risk certification buckets — PII-free aggregate, safe to show on the
// DA's screen without calling /api/v2/watchdog (which returns contact_email
// and should never be called from this dashboard).

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / DAY_MS);
}

/**
 * Bucket vendors by CSLB / CMD certification freshness without exposing
 * which specific vendor is in which bucket beyond a PII-free label.
 * Buckets: EXPIRED (already past), 2WKS (expires within 14 days),
 * 60D (expires within 60 days).
 *
 * @param {Array} vendors  shaped vendor records ({licensing, lbe, ...})
 * @returns {{ buckets: {EXPIRED:number, '2WKS':number, '60D':number}, total:number, items: Array }}
 */
export function deriveAtRiskFromVendors(vendors) {
  const buckets = { EXPIRED: 0, '2WKS': 0, '60D': 0 };
  const items = [];

  for (const v of vendors || []) {
    const cslbExp = v?.licensing?.cslb_expires_on || null;
    const cmdExp  = v?.lbe?.cmd_cert_expires_on   || null;

    for (const [certType, exp] of [['cslb', cslbExp], ['cmd_lbe', cmdExp]]) {
      if (!exp) continue;
      const d = daysUntil(exp);
      if (d == null) continue;

      let bucket = null;
      if (d < 0)        bucket = 'EXPIRED';
      else if (d <= 14) bucket = '2WKS';
      else if (d <= 60) bucket = '60D';

      if (bucket) {
        buckets[bucket] += 1;
        items.push({
          vendor_id: v.id || null,   // id only — never name/contact — for audit cross-ref
          cert_type: certType,
          bucket,
          days_until_expiry: d,
        });
      }
    }
  }

  return {
    buckets,
    total: buckets.EXPIRED + buckets['2WKS'] + buckets['60D'],
    items,
  };
}
