// SF Vendor Matrix — HTML escape utility.
//
// Single canonical implementation; previously defined as a local function
// inside dispatch.js with inconsistent application across template strings
// (15 of ~30 user-controlled interpolation sites were unescaped). Phase 2
// of the refactor will introduce a template helper that escapes by default.

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escape a string for safe interpolation into an HTML template literal.
 * @param {string|number|null|undefined} s
 * @returns {string}
 */
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}
