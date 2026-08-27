// SF Vendor Matrix — number / date / money formatters.
//
// Previously: `fmt()` in dispatch.js (Number.toLocaleString), `fmtMoney`
// inline closures inside vendorCardHtml + formatLastContract (compact M/K
// suffix), `fmtUSD` inside 14b-memo.js (Intl.NumberFormat). Three subtly
// different rounding behaviors. Now standardized.

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

/**
 * Compact money formatter — uses M/K suffixes.
 *   $1,234,567 -> "$1.2M"
 *   $12,500    -> "$13K"
 *   $250       -> "$250"
 *   null/NaN   -> "—"
 */
export function fmtMoneyCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000)     return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}

/** Full USD with commas. */
export function fmtMoneyFull(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return USD.format(Number(n));
}

/** Plain integer with thousands separator — replaces legacy `fmt()`. */
export function fmtInt(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

/**
 * Months between two ISO dates (or date+now).
 * Returns null on bad input.
 */
export function monthsBetween(isoFrom, isoTo) {
  const f = new Date(isoFrom);
  const t = isoTo ? new Date(isoTo) : new Date();
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null;
  return (t.getTime() - f.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

/**
 * Human-readable relative time.
 *   < 1 month  -> "this month"
 *   < 12 mo    -> "5 mo ago"
 *   ≥ 12 mo    -> "2.1 yr ago"
 */
export function fmtRelative(isoDate, now = new Date()) {
  const months = monthsBetween(isoDate, now.toISOString());
  if (months == null) return '';
  if (months < 1)  return 'this month';
  if (months < 12) return `${Math.round(months)} mo ago`;
  return `${(months / 12).toFixed(1)} yr ago`;
}
