// SF Vendor Matrix — shared module barrel.
//
// Convenience re-export so consumers can do
//   import { POLICY, normalize, escapeHtml } from './shared/index.js';
// instead of separate imports per file. Individual modules can still be
// imported directly when that's clearer.

export * from './constants.js';
export * from './normalize.js';
export * from './escape.js';
export * from './format.js';
export * from './vendor.js';
export * from './cost-model.js';
