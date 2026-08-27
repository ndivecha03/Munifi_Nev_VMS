// public/shared/audit.js — browser-side Munifi audit-event emitter.
//
// Fire-and-forget POST to /api/audit/event. Never throws, never blocks
// the UI. Multiple events sharing a correlation_id thread together
// across the dispatch lifecycle (queue selection -> ranking -> dispatch
// -> memo -> outcome).
//
// Usage:
//   import { emitAuditEvent, newCorrelationId } from './shared/audit.js';
//   const cid = newCorrelationId();
//   emitAuditEvent({ event_type: 'dispatch.initiated', correlation_id: cid, ... });
//   emitAuditEvent({ event_type: 'dispatch.completed', correlation_id: cid, ... });

const AUDIT_ENDPOINT = '/api/audit/event';

/** UUID v4 via crypto.randomUUID() with a fallback for older browsers. */
export function newCorrelationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Emit one audit event. Fire-and-forget.
 * @param {Object} ev
 * @param {string} ev.event_type        Required, e.g. 'dispatch.initiated'
 * @param {string} [ev.actor_type]      'human' | 'agent'  (default 'human' for browser)
 * @param {string} [ev.actor_id]        Logged-in user email
 * @param {string} [ev.subject_type]
 * @param {string} [ev.subject_id]
 * @param {string} [ev.tenant]          Default 'sf'
 * @param {string} [ev.correlation_id]
 * @param {Object} [ev.payload]
 */
export function emitAuditEvent(ev) {
  if (!ev || !ev.event_type) return;

  const body = {
    actor_type: 'human',
    tenant:     'sf',
    ...ev,
    source:     ev.source || `browser:${location.pathname}`,
  };

  // Use sendBeacon when possible — survives page navigation (e.g.
  // emitting auth.logout right before the redirect).
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      const ok = navigator.sendBeacon(AUDIT_ENDPOINT, blob);
      if (ok) return;
    }
  } catch (e) {
    // sendBeacon can throw under strict CSP; fall through to fetch
  }

  // Fallback: regular fetch, no-await, keepalive so it survives unload
  try {
    fetch(AUDIT_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      keepalive: true,
    }).catch(err => {
      // Silent — audit log loss is acceptable; user-facing work always wins
      if (typeof console !== 'undefined') console.debug('[audit] emit failed:', err.message);
    });
  } catch (e) {
    if (typeof console !== 'undefined') console.debug('[audit] emit threw:', e.message);
  }
}

/**
 * Convenience: emit a lifecycle marker (start, complete, error) sharing
 * one correlation_id. Returns the correlation_id so subsequent calls
 * can thread through it.
 */
export function emitLifecycle(phase, partial) {
  const cid = (partial && partial.correlation_id) || newCorrelationId();
  emitAuditEvent({ ...partial, event_type: phase, correlation_id: cid });
  return cid;
}
