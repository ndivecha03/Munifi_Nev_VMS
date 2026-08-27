// NV ESB Dispatch Console — entry-point module.
// Loads the open-complaint queue, the vendor pool, and the dispatch journal,
// renders the header + sidebar, wires filters, and exposes the selection
// callback that the main panel (Sections 3-6) will read.

const _V = '20260826j';
import { rankTop, WEIGHTS } from './scorer.js?v=20260826j';
import {
  CACHE_BUST,
  POLICY,
  SEVERITY_TO_PRIORITY,
  PRIORITY_ORDER,
} from './shared/constants.js?v=20260826j';
import { escapeHtml } from './shared/escape.js?v=20260826j';
import { fmtInt as fmt } from './shared/format.js?v=20260826j';
import {
  estimateCost,
  estimateCostRange,
  procurementVehicle,
  estimateAnnualPotential,
} from './shared/cost-model.js?v=20260826j';
import {
  isVendorSetAsideEligible,
  isSubOnly,
  isOverlookedForPrime,
  isCmdCertStale as _isCmdCertStale,
} from './shared/vendor.js?v=20260826j';
import { emitAuditEvent, newCorrelationId } from './shared/audit.js?v=20260826j';

// ─────────────────────────────────────────────────────────────────────────────
// Constants

// Complaint queue source. As of 2026-05-27, switched from the mock queue.json
// to Mithran's live ingest at complaints.json (200 open SIRP cases from
// DataSF vw6y-z8j6). Schema diffs are handled by normalizeComplaint() below.
// complaints.json refreshes every 6h via GitHub Actions — dynamic timestamp
// (15-min window) forces browsers to re-fetch after each ingest run instead
// of serving stale data. vercel.json also sets Cache-Control: must-revalidate.
// Live Clark County Public Works issues via SeeClickFix proxy (Vercel).
// Falls back to static complaints.json when the proxy isn't available (local dev).
const COMPLAINTS_API_URL = '/api/complaints';
const QUEUE_URL           = `./data/complaints.json?t=${Math.floor(Date.now() / (1000 * 60 * 15))}`;
const ASSIGNMENTS_URL     = `./data/assignments.json?t=${Math.floor(Date.now() / (1000 * 60 * 15))}`;
// baked-vendors-v2.json: legacy source-of-truth, still served for
// (a) Postgres-API fallback if /api/v2 is down,
// (b) PII fields (contacts + audit warnings) that the public Postgres
//     view intentionally doesn't return (RLS-locked).
const VENDORS_URL  = `./baked-vendors-v2.json?v=${CACHE_BUST}`;
// Postgres-backed vendor read endpoint introduced in foundation-Step-2
// (see docs/MUNIFI_PLATFORM_FOUNDATION.md). Returns the same 65-66
// vendors but joined with certifications, addresses, specialties,
// contracts in one shot.
const VENDORS_API_URL =
  `/api/v2/vendors?tenant=sf&include=certifications,addresses,specialties,contracts`;
const DISTRICTS    = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10','D11'];

// Normalize a v2-schema complaint (subtype/severity/reported_at) into the
// UI's expected shape (defect/priority/estimatedCost/opened_on).
// Idempotent — already-normalized complaints pass through unchanged.
function normalizeComplaint(c) {
  const openedOn = c.opened_on || c.reported_at || null;
  const daysOpen = openedOn
    ? Math.floor((Date.now() - new Date(openedOn).getTime()) / 86_400_000)
    : 0;
  return {
    ...c,
    address:             c.address || c.location || '—',
    supervisor_district: c.supervisor_district || c.district || '—',
    defect:              c.defect || c.subtype || '—',
    priority:            c.priority || SEVERITY_TO_PRIORITY[(c.severity || '').toLowerCase()] || 'low',
    estimatedCost:       estimateCost(c),
    opened_on:           openedOn,
    days_open:           daysOpen,
    // scorer needs lat/lng at top level
    lat:                 c.lat ?? c.address?.lat,
    lng:                 c.lng ?? c.address?.lng,
  };
}
const STORAGE_KEYS = {
  agent:     'nvesb_dispatch_agent_id',
  auditLog:  'nvesb_dispatch_audit_log',
};

// ─────────────────────────────────────────────────────────────────────────────
// Auth — session stored in localStorage under 'nvesb_session'

const SESSION_KEY = 'nvesb_session';

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function requireAuth() {
  const session = getSession();
  if (!session?.email) {
    window.location.replace('login.html');
    return null;
  }
  return session;
}

function logout() {
  // Emit BEFORE clearing session so we capture the actor_id
  const session = getSession();
  emitAuditEvent({
    event_type:   'auth.logout',
    actor_type:   'human',
    actor_id:     session?.email || 'unknown',
    subject_type: 'session',
    subject_id:   session?.email || 'unknown',
    payload:      { name: session?.name },
  });
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  // sendBeacon in emitAuditEvent survives the redirect
  window.location.replace('login.html');
}

// ─────────────────────────────────────────────────────────────────────────────
// State

const state = {
  complaints: [],              // open queue
  vendors: [],                 // v2 schema vendor pool
  assignments: {},             // complaint_id → assignee email (from assignments.json)
  dispatchJournal: [],         // localStorage audit log
  selectedComplaintId: null,
  selectedVendorId: null,
  quoteMode: false,            // competitive-quotes mode: pick N vendors, solicit bids
  quoteVendorIds: new Set(),   // vendors selected to receive a quote request
  activePriority: 'all',       // 'all' | 'high' | 'medium' | 'low'
  activeDistrict: 'all',       // 'all' | 'D1'..'D11'
  agentId: null,
};

// §NRS ESB.7(c) / §NRS ESB.7(L): a competitive quote solicitation needs at least 3 bids.
const MIN_QUOTES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
//
// escapeHtml() and fmt() (alias for fmtInt) are imported from shared/.
// Local helpers below are UI-vocabulary translations that don't make
// sense outside the dispatch console context.

function priorityLabel(p) {
  return p === 'high' ? 'High' : p === 'medium' ? 'Med' : p === 'low' ? 'Low' : p;
}
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log (localStorage-backed; swap to Supabase / Vercel API later)

function loadAuditLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.auditLog);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveAuditLog(entries) {
  try {
    // Cap at 500 most recent entries to stay within localStorage quota (~5MB).
    const trimmed = entries.length > 500 ? entries.slice(-500) : entries;
    localStorage.setItem(STORAGE_KEYS.auditLog, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('Audit log save failed (storage quota?):', e);
    showFooterStatus('⚠ Audit log could not be saved — browser storage full', 'warn');
  }
}
function appendDispatch(record) {
  state.dispatchJournal.push(record);
  saveAuditLog(state.dispatchJournal);
  // The audit log is rendered by public/status.html now (separate page).
  // Cross-page refresh isn't needed; status.html re-reads localStorage on load.
}
function dispatchedTodayCount() {
  const today = isoToday();
  return state.dispatchJournal.filter(d => (d.dispatched_at || '').startsWith(today)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent identity (prompted on first load, then stored in localStorage)

function loadOrPromptAgentId() {
  let id = null;
  try { id = localStorage.getItem(STORAGE_KEYS.agent); } catch {}
  if (!id || !id.trim()) {
    const entered = window.prompt(
      'Enter your DPW agent ID (e.g. your initials or assigned dispatch handle):',
      ''
    );
    if (entered && entered.trim()) {
      id = entered.trim();
      try { localStorage.setItem(STORAGE_KEYS.agent, id); } catch {}
    } else {
      id = 'demo-user';
    }
  }
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Header

function renderHeader() {
  const dateEl  = document.getElementById('headerDate');
  const agentEl = document.getElementById('headerAgent');
  const openCt  = document.getElementById('openCount');
  const dispCt  = document.getElementById('dispatchedTodayCount');

  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  if (agentEl) agentEl.textContent = state.agentId ? `Agent: ${state.agentId}` : 'Agent: —';

  if (openCt) openCt.textContent = myAssignedCount();
  if (dispCt) dispCt.textContent = dispatchedTodayCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Queue sidebar

function filteredComplaints() {
  const session = getSession();
  const myEmail = session?.email || null;

  return state.complaints
    .filter(c => c.status === 'open')
    // Only show complaints assigned to this dispatcher.
    // Falls back to showing all if assignments haven't loaded yet.
    .filter(c => {
      if (!myEmail || Object.keys(state.assignments).length === 0) return true;
      const assignee = state.assignments[c.id];
      // If a complaint has no assignment yet (e.g. ingest ran before assignment agent),
      // show it to everyone rather than hiding it from all dispatchers.
      if (!assignee) return true;
      return assignee === myEmail;
    })
    .filter(c => state.activePriority === 'all' || c.priority === state.activePriority)
    .filter(c => state.activeDistrict === 'all' || c.supervisor_district === state.activeDistrict);
}

function sortedFilteredComplaints() {
  // Sort once at load, then keep stable through this session (per the doc).
  return filteredComplaints().sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
    || (b.days_open || 0) - (a.days_open || 0)
  );
}

function myAssignedCount() {
  const session = getSession();
  const myEmail = session?.email;
  const allOpen = state.complaints.filter(c => c.status === 'open');
  if (!myEmail || Object.keys(state.assignments).length === 0) return allOpen.length;
  const mine = allOpen.filter(c => state.assignments[c.id] === myEmail);
  return mine.length > 0 ? mine.length : allOpen.length;
}

function renderQueueFilters() {
  // Counts only within the user's assigned subset
  const allCt = myAssignedCount();
  const ctByPri = (p) => {
    const session = getSession();
    const myEmail = session?.email;
    const hasAssignments = myEmail && Object.keys(state.assignments).length > 0;
    const base = state.complaints.filter(c => c.status === 'open' && c.priority === p);
    if (!hasAssignments) return base.length;
    const mine = base.filter(c => state.assignments[c.id] === myEmail);
    return mine.length > 0 ? mine.length : base.length;
  };

  document.querySelectorAll('[data-priority]').forEach(btn => {
    const p = btn.dataset.priority;
    const ct = p === 'all' ? allCt : ctByPri(p);
    btn.querySelector('.filter-count').textContent = ct;
    btn.classList.toggle('active', state.activePriority === p);
  });

  const districtFilter = document.getElementById('districtFilter');
  if (districtFilter) districtFilter.value = state.activeDistrict;
}

const QUEUE_PAGE_SIZE = 50;
let _queueObserver = null;

function queueItemHtml(c) {
  const sel = c.id === state.selectedComplaintId ? ' is-selected' : '';
  return `
    <li class="queue-item${sel}" data-complaint-id="${escapeHtml(c.id)}" tabindex="0">
      <div class="queue-item-row1">
        <span class="case-id">${escapeHtml(c.id)}</span>
        <span class="priority-pill priority-${escapeHtml(c.priority)}">${priorityLabel(c.priority)}</span>
      </div>
      <div class="queue-item-row2">${escapeHtml(c.address)}</div>
      <div class="queue-item-row3">
        <span>${escapeHtml(c.defect)}</span>
        <span class="queue-meta">${escapeHtml(c.supervisor_district)} · ${c.days_open}d open</span>
      </div>
    </li>`;
}

function renderQueueList() {
  const list = document.getElementById('queueList');
  if (!list) return;

  // Disconnect any previous infinite-scroll observer
  if (_queueObserver) { _queueObserver.disconnect(); _queueObserver = null; }

  const items = sortedFilteredComplaints();

  if (items.length === 0) {
    list.innerHTML = `<li class="queue-empty">No complaints match the current filter.</li>`;
    return;
  }

  // Render first page immediately
  let rendered = Math.min(QUEUE_PAGE_SIZE, items.length);
  list.innerHTML = items.slice(0, rendered).map(queueItemHtml).join('');

  if (rendered >= items.length) return;  // all items fit — no sentinel needed

  // Append a sentinel <li> that triggers the next page when it scrolls into view
  const sentinel = document.createElement('li');
  sentinel.className = 'queue-sentinel';
  sentinel.style.cssText = 'height:1px;list-style:none;';
  list.appendChild(sentinel);

  _queueObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;
    const nextBatch = items.slice(rendered, rendered + QUEUE_PAGE_SIZE);
    if (!nextBatch.length) { _queueObserver.disconnect(); sentinel.remove(); return; }
    // Insert before sentinel
    nextBatch.forEach(c => sentinel.insertAdjacentHTML('beforebegin', queueItemHtml(c)));
    rendered += nextBatch.length;
    if (rendered >= items.length) { _queueObserver.disconnect(); sentinel.remove(); }
  }, { root: list.closest('.queue-sidebar'), rootMargin: '200px' });

  _queueObserver.observe(sentinel);
}

function renderQueue() {
  renderQueueFilters();
  renderQueueList();
}

// SET_ASIDE_CEILING (POLICY.setAsideCeiling) and CMD freshness threshold
// (POLICY.esbVerifyFreshnessDays) are sourced from shared/constants.js.
// Local aliases below preserve the historical identifier names so the
// existing call sites in this file don't need to be rewritten in this
// pass; Phase 2 will inline them.
const SET_ASIDE_CEILING         = POLICY.setAsideCeiling;
const CMD_VERIFY_FRESHNESS_DAYS = POLICY.esbVerifyFreshnessDays;

// ─────────────────────────────────────────────────────────────────────────────
// Vendor info helpers (replace the old score-bar breakdown)

function vendorDescription(vendor) {
  // Try to extract a clean opening sentence from the original audit note.
  const note = vendor.audit?.original_note || '';
  const sentences = note.split(/(?<=[.])\s+/);
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (/^[⚠!]/.test(trimmed)) continue;
    if (/^(inactive|expired|expir|warning|cmd lookup|cslb #)/i.test(trimmed)) continue;
    if (trimmed.length > 20 && trimmed.length < 240) return trimmed;
  }
  // Fallback: synthesize from structured fields
  const parts = [];
  if (vendor.address?.city) parts.push(`Based in ${vendor.address.city}`);
  if (vendor.lbe?.tier) parts.push(`${vendor.lbe.tier} certified`);
  const specs = vendor.specialties || [];
  if (specs.length) parts.push(`Specializes in ${specs.map(s => s.replace(/_/g, ' ')).join(', ')}`);
  return parts.join(' · ') || 'No description on file.';
}

function formatDistance(miles) {
  if (miles == null || !Number.isFinite(miles)) return '—';
  if (miles < 0.1) return 'Less than 0.1 mi';
  return `${miles.toFixed(1)} mi from complaint`;
}

// Format DPW history from track_record (backfilled from DataSF cqi5-hm2d).
// Distinguishes four states the dispatcher cares about:
//   - Active prime: has won prime contracts (X count, $Y total, last <date>)
//   - Sub-only:     never primed; appears as subcontractor on others' work
//   - Mixed:        both prime and sub history
//   - Overlooked:   zero prime AND zero sub history (the §NRS ESB.7 target)
function formatLastContract(vendor) {
  const tr = vendor.track_record || {};
  const primeValue = tr.prior_dpw_contracts_value || 0;
  const primeCount = tr.prior_dpw_contracts_count || 0;
  const subValue   = tr.prior_dpw_sub_value_upper_bound || 0;
  const subCount   = tr.prior_dpw_sub_contracts_count || 0;
  const lastDate   = tr.last_city_contract_date;

  // Truly overlooked — no prime, no sub
  if (primeValue === 0 && subValue === 0) {
    return 'No prior NDOT prime or sub contracts on record — overlooked vendor';
  }

  const fmtMoney = v => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (v >=     1_000) return `$${Math.round(v / 1000)}K`;
    return `$${v}`;
  };

  const parts = [];
  if (primeCount > 0) {
    parts.push(`${primeCount} NDOT prime award${primeCount === 1 ? '' : 's'} (${fmtMoney(primeValue)})`);
  } else {
    parts.push(`No prime awards`);
  }
  if (subCount > 0) {
    parts.push(`${subCount} subcontract${subCount === 1 ? '' : 's'} (~${fmtMoney(subValue)} upper bound)`);
  }

  let out = parts.join(' · ');
  if (lastDate) {
    const d = new Date(lastDate);
    if (!isNaN(d)) {
      const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30);
      const dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
      if (months < 1)        out += ` · last ${dateStr} (this month)`;
      else if (months < 12)  out += ` · last ${dateStr} (${Math.round(months)} mo ago)`;
      else                   out += ` · last ${dateStr} (${(months / 12).toFixed(1)} yr ago)`;
    }
  }
  return out;
}

function formatContact(vendor) {
  const c = vendor.contact || {};
  const items = [];
  if (c.phone)   items.push(`<a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a>`);
  if (c.email)   items.push(`<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
  if (c.website) {
    const url = c.website.startsWith('http') ? c.website : `https://${c.website}`;
    items.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">website</a>`);
  }
  return items.length ? items.join(' · ') : '—';
}

// ─────────────────────────────────────────────────────────────────────────────
// Certification date helpers
//
// Two fields per certification that the agent needs:
//   - "Registered" — when did this cert first issue. Not on file in our v2
//     schema yet; placeholder for future enrichment via CSLB / CMD APIs.
//   - "Expires"    — when does the cert lapse. Populated from cert_expiry in
//     Mithran's audit data for vendors that have it.

function formatCertDate(dateStr, kind) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function monthsFromNow(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
}

function expirySegment(dateStr) {
  const formatted = formatCertDate(dateStr);
  if (!formatted) return `<span class="vc-info-gap">Expires: not on file</span>`;
  const months = monthsFromNow(dateStr);
  if (months == null) return `<span>Expires ${formatted}</span>`;
  if (months < 0)  return `<span class="vc-info-warn">Expired ${formatted}</span>`;
  if (months < 1)  return `<span class="vc-info-warn">Expires ${formatted} (less than a month)</span>`;
  if (months < 3)  return `<span class="vc-info-warn">Expires ${formatted} (in ${Math.round(months)} mo)</span>`;
  if (months < 12) return `<span>Expires ${formatted} (in ${Math.round(months)} mo)</span>`;
  return `<span>Expires ${formatted}</span>`;
}

function registrationSegment(dateStr) {
  const formatted = formatCertDate(dateStr);
  if (!formatted) return `<span class="vc-info-gap">Registered: not on file</span>`;
  return `<span>Registered ${formatted}</span>`;
}

function verifiedSegment(dateStr) {
  const formatted = formatCertDate(dateStr);
  if (!formatted) return null;
  return `<span>Last verified ${formatted}</span>`;
}

function formatNvLicense(vendor) {
  const lic = vendor.licensing || {};

  // Non-contractor firms have a regime label instead of an NSCB number
  if (lic.nv_license_regime) {
    return `<strong>${escapeHtml(lic.nv_license_regime_label)}</strong> · <span class="vc-info-good">Certified</span><div class="vc-info-sub">License number on file with issuing board</div>`;
  }

  const num = lic.nv_contractor_license || lic.cslb_license || '—';
  const status = (lic.nv_license_status || lic.cslb_status || 'unknown').toLowerCase();
  const statusBadge = status === 'active'
    ? `<span class="vc-info-good">Active</span>`
    : `<span class="vc-info-warn">${escapeHtml(status.charAt(0).toUpperCase() + status.slice(1))}</span>`;
  const classes = lic.nv_license_classifications || lic.classifications || [];
  const codes = classes.join(', ') || '—';
  const expiry = lic.nv_license_expires ? ` · exp ${escapeHtml(lic.nv_license_expires)}` : '';
  return `<strong>NSCB #${escapeHtml(num)}</strong> · ${statusBadge}${expiry}<div class="vc-info-sub">Class${classes.length !== 1 ? 'es' : ''}: ${escapeHtml(codes)} (NAC 624)</div>`;
}

function formatCslbCert(vendor) {
  const lic = vendor.licensing || {};
  const license = lic.cslb_license || '—';
  const cls = lic.cslb_class || '';
  const status = (lic.cslb_status || 'unknown').toLowerCase();
  const statusBadge = status === 'active'
    ? `<span class="vc-info-good">Active</span>`
    : `<span class="vc-info-warn">${escapeHtml(status[0].toUpperCase() + status.slice(1))}</span>`;
  const primaryLine = `<strong>#${escapeHtml(license)}</strong>${cls ? ' · ' + escapeHtml(cls) : ''} · ${statusBadge}`;
  // Registration date not on file in v2 schema yet; expiry sometimes populated.
  const secondaryParts = [
    registrationSegment(lic.cslb_registered_on),
    expirySegment(lic.cslb_expires_on),
  ];
  return `${primaryLine}<div class="vc-info-sub">${secondaryParts.join(' · ')}</div>`;
}

function formatCmdCert(vendor) {
  const lbe = vendor.lbe || {};
  // Nevada uses lbe.esb_number + lbe.certifying_body_key; SF uses lbe.cmd_cert_number + lbe.tier
  const tier  = lbe.tier || null;
  const num   = lbe.cmd_cert_number || lbe.esb_number || null;
  const body  = lbe.certifying_body_key || null;

  if (!lbe.cmd_cert_active && !num) {
    return `<span class="vc-info-gap">No GOED ESB/DBE certification on file</span>`;
  }

  // Build label: NV vendors show certifying body name; SF vendors show LBE tier
  let labelHtml;
  if (tier) {
    labelHtml = `<strong>${escapeHtml(tier)}</strong>`;
  } else if (body === 'goed_esb') {
    labelHtml = `<strong>GOED ESB</strong>`;
  } else if (body === 'usdot_dbe') {
    labelHtml = `<strong>USDOT DBE</strong>`;
  } else {
    labelHtml = `<strong>ESB/DBE Certified</strong>`;
  }

  const numHtml = num ? ` · #${escapeHtml(num)}` : '';
  const statusBadge = lbe.cmd_cert_active
    ? `<span class="vc-info-good">Active</span>`
    : `<span class="vc-info-warn">Not active in our records</span>`;
  const primaryLine = `${labelHtml}${numHtml} · ${statusBadge}`;
  const secondaryParts = [
    registrationSegment(lbe.cmd_cert_registered_on),
    expirySegment(lbe.cmd_cert_expires_on),
    verifiedSegment(lbe.cmd_cert_last_verified),
  ].filter(Boolean);
  if (secondaryParts.length === 0) return primaryLine;
  return `${primaryLine}<div class="vc-info-sub">${secondaryParts.join(' · ')}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Complaint header

// Inline haversine for dispatch.js — scorer.js has its own copy; duplicated
// here to avoid a circular import. Keep in sync if the formula ever changes.
function _haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || !Number.isFinite(v))) return Infinity;
  const R = 3958.8, toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
          * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isSetAsideEligible(complaint, vendors) {
  if ((complaint.estimatedCost ?? 0) > SET_ASIDE_CEILING) return false;
  const cLat = complaint.lat;
  const cLng = complaint.lng;
  const hasLocation = cLat != null && cLng != null
                      && Number.isFinite(Number(cLat))
                      && Number.isFinite(Number(cLng));
  return vendors.some(v => {
    if (!v.lbe?.cmd_cert_active) return false;
    const nvActive  = (v.licensing?.nv_license_status || '').toLowerCase() === 'active';
    const sfActive  = (v.licensing?.cslb_status || '').toLowerCase() === 'active';
    if (!nvActive && !sfActive) return false;
    // Bug fix: must also be within the dispatch radius — not just anywhere in the pool.
    // Without this check the function permanently returns true (19 eligible vendors
    // in the pool), incorrectly badging every complaint as set-aside eligible and
    // recording policy_authority='NRS ESB.7' even when a non-LBE vendor is dispatched.
    if (!hasLocation) return true;  // no complaint location — accept on vendor criteria alone
    const vLat = Number(v.address?.lat ?? v.lat);
    const vLng = Number(v.address?.lng ?? v.lng);
    if (!Number.isFinite(vLat) || !Number.isFinite(vLng)) return false;
    return _haversineMiles(Number(cLat), Number(cLng), vLat, vLng) <= POLICY.radiusMiles;
  });
}

function complaintHeaderHtml(complaint) {
  const setAside = isSetAsideEligible(complaint, state.vendors);
  const overCeiling = (complaint.estimatedCost ?? 0) > SET_ASIDE_CEILING;
  const priorityClass = `priority-${complaint.priority}`;

  let badgesHtml;
  if (setAside) {
    badgesHtml = `
      <span class="ch-badge ch-badge-success">ESB set-aside eligible</span>
      <span class="ch-badge ch-badge-neutral">≤ $600K</span>`;
  } else if (overCeiling) {
    badgesHtml = `
      <span class="ch-badge ch-badge-info">10% bid discount applies</span>
      <span class="ch-badge ch-badge-neutral">LBE preference only</span>`;
  } else {
    badgesHtml = `
      <span class="ch-badge ch-badge-warning">No ESB-certified vendor in pool</span>
      <span class="ch-badge ch-badge-neutral">≤ $600K</span>`;
  }

  return `
    <div class="complaint-header">
      <div class="ch-left">
        <div class="ch-id-row">
          <span class="ch-case-id">${escapeHtml(complaint.id)}</span>
          <span class="ch-priority-pill ${priorityClass}">${priorityLabel(complaint.priority)}</span>
        </div>
        <h2 class="ch-address">${escapeHtml(complaint.address)}</h2>
        <div class="ch-meta">
          <span>${escapeHtml(complaint.defect)}</span>
          <span class="ch-dot">·</span>
          <span>${escapeHtml(complaint.supervisor_district)}</span>
          <span class="ch-dot">·</span>
          <span>${complaint.days_open}d open</span>
          <span class="ch-dot">·</span>
          ${(() => {
            const r = estimateCostRange(complaint);
            const sev = complaint.severity || complaint.priority || 'standard';
            const spec = complaint.specialty_required || 'sidewalk';
            const tip = `Estimate: severity ${sev} + specialty ${spec}. `
                      + `Typical NDOT/NPWD single-WO range (Q1-Q3, NDOT public contract data): $${fmt(r.low)}-$${fmt(r.high)}. `
                      + `See data/ndot-cost-calibration.json.`;
            return `<span title="${escapeHtml(tip)}" style="border-bottom: 1px dotted var(--console-ink-soft); cursor: help;">est $${fmt(complaint.estimatedCost)} <span style="color: var(--console-ink-soft); font-weight: 400;">($${fmt(r.low)}-$${fmt(r.high)} typical)</span></span>`;
          })()}
        </div>
      </div>
      <div class="ch-right">${badgesHtml}</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Vendor cards

function tierBadge(tier) {
  const t = (tier || '').toLowerCase();
  if (t.includes('micro')) return { label: 'ESB', kind: 'tier-micro' };
  if (t.includes('small')) return { label: 'Small-LBE', kind: 'tier-small' };
  if (t.includes('sba'))   return { label: 'SBA-LBE',   kind: 'tier-sba' };
  if (t.includes('lbe'))   return { label: 'LBE',       kind: 'tier-lbe' };
  return null;
}

// Local aliases preserve the historical function names so the rest of
// this file doesn't change. cmdCertStale, vendorIsSetAsideEligible,
// vendorHasZeroCityHistory, vendorIsSubOnly, procurementVehicle, and
// estimateAnnualPotential are all defined in shared/ — see the import
// block at the top of the file. Phase 2 will inline the call sites.
const cmdCertStale              = _isCmdCertStale;
const vendorIsSetAsideEligible  = isVendorSetAsideEligible;
const vendorHasZeroCityHistory  = isOverlookedForPrime;
const vendorIsSubOnly           = isSubOnly;

function vendorBadgesHtml(vendor, complaint) {
  const out = [];
  const tier = tierBadge(vendor.lbe?.tier);
  if (tier) out.push(`<span class="vc-badge vc-badge-${tier.kind}">${tier.label}</span>`);

  const nscbCodes = vendor.licensing?.classifications || [];
  if (nscbCodes.length > 0) {
    out.push(`<span class="vc-badge vc-badge-neutral">NSCB ${escapeHtml(nscbCodes.slice(0,2).join(', '))}</span>`);
  }

  if (vendor.address?.district === complaint.district) {
    out.push(`<span class="vc-badge vc-badge-district">Same region</span>`);
  }

  // Show unverified badge only when cert is explicitly inactive or stale AND
  // there is no cmd_cert_active flag. NV ESB vendors from B2Gnow are treated
  // as current even without a local verification timestamp.
  if (!vendor.lbe?.cmd_cert_active) {
    out.push(`<span class="vc-badge vc-badge-warning" title="GOED ESB certification not active in our records">ESB cert unverified</span>`);
  }

  return out.join('');
}

function vendorCardHtml(pick, vendor, complaint, isTop) {
  const dist = pick.distance_miles != null ? pick.distance_miles.toFixed(1) : '—';
  const score = Math.round(pick.total);
  const isSelected = state.selectedVendorId === pick.vendor_id;
  const selectedCls = isSelected ? ' is-selected' : '';
  const nscbNum = vendor.licensing?.nv_contractor_license || vendor.licensing?.cslb_license || '—';
  const dbeNum  = vendor.certifications?.find(c => c.type === 'dbe' || c.type === 'esb')?.cert_number || vendor.lbe?.cmd_cert_number || '—';

  // "Can do this job?" row removed — capability is now a hard filter,
  // so every surfaced vendor is by definition capable. No need to show.
  const addrParts = [
    vendor.address?.line1,
    vendor.address?.city,
    vendor.address?.state,
    vendor.address?.zip,
  ].filter(Boolean).join(', ');
  const distanceLine = `
    <div>${escapeHtml(formatDistance(pick.distance_miles))}</div>
    ${addrParts ? `<div class="vc-info-sub">${escapeHtml(addrParts)}</div>` : ''}
  `;
  const infoHtml = `
    <div class="vc-info-row">
      <span class="vc-info-label">About</span>
      <span class="vc-info-value">${escapeHtml(vendorDescription(vendor))}</span>
    </div>
    <div class="vc-info-row">
      <span class="vc-info-label">Distance</span>
      <span class="vc-info-value">${distanceLine}</span>
    </div>
    <div class="vc-info-row">
      <span class="vc-info-label">Last NDOT contract</span>
      <span class="vc-info-value">${escapeHtml(formatLastContract(vendor))}</span>
    </div>
    <div class="vc-info-row">
      <span class="vc-info-label">NV license</span>
      <span class="vc-info-value">${formatNvLicense(vendor)}</span>
    </div>
    <div class="vc-info-row">
      <span class="vc-info-label">GOED ESB certification</span>
      <span class="vc-info-value">${formatCmdCert(vendor)}</span>
    </div>
    <div class="vc-info-row">
      <span class="vc-info-label">Contact</span>
      <span class="vc-info-value">${formatContact(vendor)}</span>
    </div>`;

  const detailsOpen = isTop ? ' open' : '';

  // ─── Procurement-vehicle banner ─────────────────────────────────────
  // Surfaces when THIS vendor (not just the pool) is set-aside eligible
  // AND the complaint cost falls inside the §NRS ESB.7 ceiling. Shows the
  // applicable vehicle, the day-count savings vs. a standard competitive
  // bid, and — for zero-City-history ESBs — the "overlooked"
  // ROI prompt so the dispatcher sees the equity story per card.
  let vehicleHtml = '';
  const vehicle = procurementVehicle(complaint.estimatedCost);
  if (vendorIsSetAsideEligible(vendor) && vehicle) {
    const zeroHistory = vendorHasZeroCityHistory(vendor);
    const subOnly     = vendorIsSubOnly(vendor);
    const potential   = (zeroHistory || subOnly) ? estimateAnnualPotential() : null;
    let potHtml = '';
    if (zeroHistory && potential) {
      potHtml = `
        <div class="vc-vehicle-history">
          <span class="vc-vehicle-history-label">Overlooked-but-qualified</span>
          $0 in NDOT prime or sub awards on record.
          Annual potential at current NDOT work-order volume: <strong>$${fmt(Math.round(potential.low/1000)*1000)}–$${fmt(Math.round(potential.high/1000)*1000)}</strong>.
        </div>`;
    } else if (subOnly && potential) {
      const subVal = vendor.track_record?.prior_dpw_sub_value_upper_bound || 0;
      const subCnt = vendor.track_record?.prior_dpw_sub_contracts_count || 0;
      const fmtMoney = v => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(1)}M` : `$${Math.round(v/1000)}K`;
      potHtml = `
        <div class="vc-vehicle-history">
          <span class="vc-vehicle-history-label vc-vehicle-history-label-sub">Sub-only history</span>
          ${subCnt} subcontract${subCnt === 1 ? '' : 's'} (~${fmtMoney(subVal)}) but never primed.
          §NRS 338.0117 ESB set-aside is the prime-award pathway built for this firm.
        </div>`;
    }
    vehicleHtml = `
      <div class="vc-vehicle">
        <div class="vc-vehicle-headline">
          <span class="vc-vehicle-pill">${escapeHtml(vehicle.label)}</span>
          <span class="vc-vehicle-saves"><strong>~${vehicle.daysSaved} days</strong> faster than competitive bid</span>
        </div>
        <div class="vc-vehicle-detail">
          ${escapeHtml(vehicle.cityTimeline)} via ${escapeHtml(vehicle.authority)} · vs. ${escapeHtml(vehicle.standardTimeline)} standard
        </div>
        ${potHtml}
      </div>`;
  }

  return `
    <article class="vendor-card${selectedCls}" data-vendor-id="${escapeHtml(pick.vendor_id)}" tabindex="0">
      <div class="vc-top">
        <div class="vc-rank">${pick.rank}</div>
        <div class="vc-identity">
          <div class="vc-name">${escapeHtml(vendor.name)}</div>
          <div class="vc-meta">NSCB #${escapeHtml(nscbNum)} · DBE/ESB #${escapeHtml(dbeNum)} · ${dist} mi</div>
        </div>
        <div class="vc-score">
          <span class="vc-score-num">${score}</span>
          <span class="vc-score-max">/ 100</span>
        </div>
      </div>
      <div class="vc-tags">${vendorBadgesHtml(vendor, complaint)}</div>
      ${vehicleHtml}
      <details class="vc-breakdown"${detailsOpen}>
        <summary class="vc-why">Why this contractor?</summary>
        <div class="vc-info">${infoHtml}</div>
      </details>
    </article>`;
}

function vendorColumnHtml(complaint) {
  const rankResult = rankTop(complaint, state.vendors, state.dispatchJournal, { topN: 5 });
  state.lastRankResult = rankResult;  // info-column reads pick.total for score display
  const stats = rankResult.poolStats || {};
  const eligibleCount = stats.tier1Eligible || 0;

  let header;
  if (rankResult.poolUsed === 'eligible-only') {
    header = `<span class="vc-col-sub">Scored against <strong>${eligibleCount}</strong> ESB eligible vendor${eligibleCount === 1 ? '' : 's'}</span>`;
  } else if (rankResult.poolUsed === 'eligible-plus-almost') {
    header = `<span class="vc-col-sub vc-col-sub-warn">Only <strong>${eligibleCount}</strong> ESB nearby — expanded to Small-LBE / SBA-LBE</span>`;
  } else {
    header = `<span class="vc-col-sub vc-col-sub-warn">Eligible LBE pool exhausted — showing full C-8 pool</span>`;
  }

  if (!rankResult.picks || rankResult.picks.length === 0) {
    return `
      <div class="vendor-column-header">
        <h3 class="vc-col-title">Top vendors — equity matrix</h3>
        ${header}
      </div>
      <div class="vc-empty">No vendors passed the hard filters for this complaint. Verify the complaint location is within 15 miles of an active C-8 contractor.</div>`;
  }

  const cardsHtml = rankResult.picks.map((pick, idx) => {
    const vendor = state.vendors.find(v => v.id === pick.vendor_id);
    if (!vendor) return '';
    return vendorCardHtml(pick, vendor, complaint, idx === 0);
  }).join('');

  return `
    <div class="vendor-column-header">
      <h3 class="vc-col-title">Top vendors — equity matrix</h3>
      ${header}
    </div>
    <div class="vendor-cards" id="vendorCards">${cardsHtml}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main panel orchestrator

function renderMainPanel() {
  const panel = document.getElementById('dispatchPanel');
  if (!panel) return;

  if (!state.selectedComplaintId) {
    state.selectedVendorId = null;
    panel.innerHTML = `
      <div class="panel-placeholder">
        <h2>Select a complaint from the queue</h2>
        <p>The matrix will rank the top 5 ESB/DBE-certified vendors for the selected complaint's location and work-order size. You will then review the score breakdown, confirm the set-aside-eligibility check, and download the NRS ESB §338.0117 authorization memo.</p>
      </div>`;
    return;
  }

  const complaint = state.complaints.find(x => x.id === state.selectedComplaintId);
  if (!complaint) return;

  // Reset vendor selection when complaint changes
  state.selectedVendorId = null;

  try {
    panel.innerHTML = `
      ${complaintHeaderHtml(complaint)}
      <div class="dispatch-content">
        <div class="vendor-column" id="vendorColumn">
          ${vendorColumnHtml(complaint)}
        </div>
        <aside class="info-column" id="infoColumn">
          ${infoColumnHtml(complaint)}
        </aside>
      </div>
      ${footerHtml()}`;

    wireVendorCardEvents();
    wireFooterEvents();
  } catch (err) {
    console.error('[renderMainPanel] render error:', err);
    panel.innerHTML = `
      <div class="panel-error">
        <h2>Panel render error</h2>
        <p>${escapeHtml(err.message)}</p>
        <pre style="font-size:11px;opacity:0.6;overflow:auto">${escapeHtml(err.stack || '')}</pre>
      </div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Info & memo panel (right column, 280px)

function infoColumnHtml(complaint) {
  const setAside = isSetAsideEligible(complaint, state.vendors);
  const overCeiling = (complaint.estimatedCost ?? 0) > SET_ASIDE_CEILING;

  // 5a — Est. work order
  const costStr = `$${fmt(complaint.estimatedCost)}`;
  let workOrderSub;
  if (setAside)            workOrderSub = 'ESB set-aside eligible';
  else if (overCeiling)    workOrderSub = `Exceeds $${fmt(SET_ASIDE_CEILING)} — bid discount applies`;
  else                     workOrderSub = `No ESB-certified vendor in pool — competitive bid required`;

  // 5b — Policy authority
  let policyTitle, policySub;
  if (setAside) {
    policyTitle = 'Ch. NRS ESB §NRS ESB.7';
    policySub   = 'Direct set-aside · No bid required';
  } else if (overCeiling) {
    policyTitle = '10% LBE bid discount';
    policySub   = 'Competitive bid · 10% discount on LBE-certified bids';
  } else {
    policyTitle = 'Competitive bid';
    policySub   = 'No qualifying ESB in radius — fall back to standard bid';
  }

  // 5c — Selected vendor summary
  const selectedVendor = state.selectedVendorId
    ? state.vendors.find(v => v.id === state.selectedVendorId)
    : null;
  let selectedHtml;
  if (selectedVendor) {
    const pick = state.lastRankResult?.picks?.find(p => p.vendor_id === state.selectedVendorId);
    const score = pick ? Math.round(pick.total) : '—';
    const tier = selectedVendor.lbe?.tier || 'C-8 contractor';
    const district = selectedVendor.address?.supervisor_district || complaint.supervisor_district || '?';
    selectedHtml = `
      <div class="info-block-row">
        <div class="info-stat-card info-stat-card-score">
          <div class="info-stat-num">${score}<span class="info-stat-max">/100</span></div>
          <div class="info-stat-label">${escapeHtml(selectedVendor.name)}</div>
        </div>
        <div class="info-stat-card">
          <div class="info-stat-num">${costStr}</div>
          <div class="info-stat-label">to ${escapeHtml(tier)} firm in ${escapeHtml(district)}</div>
        </div>
      </div>`;
  } else {
    selectedHtml = `<p class="info-placeholder">Select a vendor above to enable dispatch.</p>`;
  }

  // 5d — Docs-ready checklist
  const cmdCertOk = selectedVendor?.lbe?.cmd_cert_active && !cmdCertStale(selectedVendor);
  const cmdCertIcon = selectedVendor
    ? (cmdCertOk ? '✓' : '⚠')
    : '○';
  const cmdCertText = selectedVendor
    ? (cmdCertOk
        ? `Active CMD ${selectedVendor.lbe?.tier || 'LBE'} cert verified`
        : `CMD cert NOT verified — confirm at sfcitypartner.sfgov.org`)
    : 'CMD cert verification pending vendor selection';
  const cmdCertClass = selectedVendor ? (cmdCertOk ? 'ok' : 'warn') : 'pending';

  const amountOk = (complaint.estimatedCost ?? 0) <= SET_ASIDE_CEILING;
  const amountIcon = amountOk ? '✓' : '⚠';
  const amountText = amountOk
    ? `Amount ${costStr} confirmed ≤ $${fmt(SET_ASIDE_CEILING)}`
    : `Amount ${costStr} EXCEEDS $${fmt(SET_ASIDE_CEILING)} — NRS ESB.7 not applicable`;
  const amountClass = amountOk ? 'ok' : 'warn';

  const checklist = [
    { icon: '✓', text: 'Ch. NRS ESB §NRS ESB.7 citation included', cls: 'ok' },
    { icon: cmdCertIcon, text: cmdCertText, cls: cmdCertClass },
    { icon: amountIcon, text: amountText, cls: amountClass },
    { icon: '✓', text: 'Responsibility determination checklist', cls: 'ok' },
    { icon: '○', text: 'Contracting officer signature (pending)', cls: 'pending' },
  ];
  const checklistHtml = checklist.map(item => `
    <li class="docs-item docs-item-${item.cls}">
      <span class="docs-icon">${item.icon}</span>
      <span class="docs-text">${escapeHtml(item.text)}</span>
    </li>`).join('');

  return `
    <div class="info-block">
      <div class="info-block-label">Est. work order</div>
      <div class="info-block-value">${costStr}</div>
      <div class="info-block-sub">${escapeHtml(workOrderSub)}</div>
    </div>
    <div class="info-block">
      <div class="info-block-label">Policy authority</div>
      <div class="info-block-value">${escapeHtml(policyTitle)}</div>
      <div class="info-block-sub">${escapeHtml(policySub)}</div>
    </div>
    <div class="info-block">
      <div class="info-block-label">Selected vendor</div>
      ${selectedHtml}
    </div>
    <div class="info-block">
      <div class="info-block-label">Docs ready</div>
      <ul class="docs-list">${checklistHtml}</ul>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Footer action bar

function footerHtml() {
  const hasVendor = !!state.selectedVendorId;
  if (state.quoteMode) {
    const n = state.quoteVendorIds.size;
    const ready = n >= MIN_QUOTES;
    return `
    <div class="dispatch-footer">
      <div class="footer-actions">
        <button class="btn-dispatch" id="btnSendQuotes" ${ready ? '' : 'disabled'}>
          Send ${n} quote request${n === 1 ? '' : 's'} <span class="arrow">→</span>
        </button>
        <button class="btn-memo" id="btnCancelQuotes">Cancel</button>
        <span class="footer-status" id="footerStatus" aria-live="polite">
          ${ready ? `${n} vendors selected — ready to solicit` : `Select at least ${MIN_QUOTES} vendors (${n}/${MIN_QUOTES})`}
        </span>
      </div>
      <div class="footer-note">
        Competitive §NRS ESB.7(c) solicitation — each selected vendor is emailed a quote link (suppressed until autonomous). Compare bids &amp; record a justification in the dispatched view.
      </div>
    </div>`;
  }
  return `
    <div class="dispatch-footer">
      <div class="footer-actions">
        <button class="btn-dispatch" id="btnDispatch" ${hasVendor ? '' : 'disabled'}>
          Dispatch vendor <span class="arrow">→</span>
        </button>
        <button class="btn-memo" id="btnQuoteMode" title="For contracts requiring competitive quotes: pick ${MIN_QUOTES}+ vendors and solicit bids">
          Request competitive quotes
        </button>
        <span class="footer-status" id="footerStatus" aria-live="polite"></span>
      </div>
      <div class="footer-note">
        Dispatches auto-log to audit_log (localStorage)
        ${(() => {
          const src = state.vendorDataSource;
          if (src === 'api')           return ' · <span title="Postgres live via /api/v2/vendors" style="color:#1f6a37">● Postgres</span>';
          if (src === 'json_fallback') return ' · <span title="API fallback in effect: ' + escapeHtml(state.vendorApiError || '') + '" style="color:#b06000">● JSON fallback</span>';
          return '';
        })()}
      </div>
    </div>`;
}

function wireFooterEvents() {
  const btnDispatch = document.getElementById('btnDispatch');
  if (btnDispatch) btnDispatch.addEventListener('click', handleDispatch);

  const btnQuoteMode  = document.getElementById('btnQuoteMode');
  const btnSendQuotes = document.getElementById('btnSendQuotes');
  const btnCancel     = document.getElementById('btnCancelQuotes');
  if (btnQuoteMode)  btnQuoteMode.addEventListener('click', enterQuoteMode);
  if (btnSendQuotes) btnSendQuotes.addEventListener('click', handleQuoteRequest);
  if (btnCancel)     btnCancel.addEventListener('click', exitQuoteMode);
}

// ─── Competitive-quotes mode ───────────────────────────────────────────────
function enterQuoteMode() {
  state.quoteMode = true;
  state.quoteVendorIds = new Set();
  if (state.selectedVendorId) { state.quoteVendorIds.add(state.selectedVendorId); }
  state.selectedVendorId = null;
  refreshQuoteSelectionUI();
}
function exitQuoteMode() {
  state.quoteMode = false;
  state.quoteVendorIds = new Set();
  refreshQuoteSelectionUI();
}
function refreshQuoteSelectionUI() {
  document.querySelectorAll('.vendor-card').forEach(card => {
    const picked = state.quoteVendorIds.has(card.dataset.vendorId);
    card.classList.toggle('is-selected', picked || (!state.quoteMode && card.dataset.vendorId === state.selectedVendorId));
  });
  const footer = document.querySelector('.dispatch-footer');
  if (footer) { footer.outerHTML = footerHtml(); wireFooterEvents(); }
}

async function handleQuoteRequest() {
  const complaint = state.complaints.find(c => c.id === state.selectedComplaintId);
  if (!complaint) return;
  if (state.quoteVendorIds.size < MIN_QUOTES) return;
  const already = state.dispatchJournal.find(d => d.complaint_id === complaint.id);
  if (already) { showFooterStatus(`Already handled · ${already.vendor_name}`, 'warn'); return; }

  const vendors = [...state.quoteVendorIds].map(id => {
    const v = state.vendors.find(x => x.id === id);
    return v ? { id: v._api_id || v.id, name: v.name, email: v.contact?.email || null } : null;
  }).filter(Boolean);

  const correlationId = newCorrelationId();
  showFooterStatus(`Soliciting ${vendors.length} quotes…`, 'info');
  const btn = document.getElementById('btnSendQuotes');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/quotes-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        complaint_id: complaint.id, complaint_address: complaint.address,
        vendors, min_required: MIN_QUOTES, dispatcher_id: state.agentId, correlation_id: correlationId,
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'solicitation failed');

    // Log it so the complaint moves to the dispatched view, where the bid
    // comparison + justification platform lives (status.html loads /api/quotes).
    appendDispatch({
      complaint_id:        complaint.id,
      complaint_address:   complaint.address,
      complaint_district:  complaint.supervisor_district,
      vendor_id:           null,
      vendor_name:         `Competitive quotes — ${vendors.length} vendors`,
      vendor_lbe_tier:     'ESB',
      work_order_estimate: complaint.estimatedCost,
      score:               null,
      policy_authority:    'NRS ESB.7',
      quote_solicitation:  true,
      quote_vendor_count:  vendors.length,
      agent_id:            state.agentId,
      dispatched_at:       new Date().toISOString(),
      correlation_id:      correlationId,
    });

    emitAuditEvent({
      event_type: 'dispatch.quotes_requested', actor_type: 'human', actor_id: state.agentId,
      subject_type: 'complaint', subject_id: complaint.id, correlation_id: correlationId,
      payload: { vendor_count: vendors.length, vendors: vendors.map(v => v.name), policy_authority: 'NRS ESB.7(c)' },
    }).catch(() => {});

    // Advance the queue past this complaint, like a normal dispatch.
    state.complaints = state.complaints.filter(c => c.id !== complaint.id);
    state.selectedComplaintId = null;
    exitQuoteMode();
    renderQueueList();
    renderMainPanel();
    showFooterStatus(`${d.solicited} quote requests sent`, 'ok', `status.html?id=${encodeURIComponent(complaint.id)}`);
  } catch (e) {
    showFooterStatus(`Quote solicitation failed: ${e.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch action — idempotent, writes to audit log, advances queue

function handleDispatch() {
  if (!state.selectedComplaintId || !state.selectedVendorId) return;
  const complaint = state.complaints.find(c => c.id === state.selectedComplaintId);
  const vendor    = state.vendors.find(v => v.id === state.selectedVendorId);
  if (!complaint || !vendor) return;

  // Idempotency: don't double-log a dispatch for the same complaint
  const already = state.dispatchJournal.find(d => d.complaint_id === complaint.id);
  if (already) {
    showFooterStatus(`Already dispatched · ${already.vendor_name}`, 'warn');
    return;
  }

  const pick = state.lastRankResult?.picks?.find(p => p.vendor_id === vendor.id);

  // Generate a correlation_id that threads this entire dispatch lifecycle:
  // dispatch.initiated (here) -> dispatch.work_order_sent (api/dispatch.js)
  // -> feedback.email_sent (api/feedback.js at +30d) -> feedback.outcome_recorded
  const correlationId = newCorrelationId();

  const record = {
    complaint_id:        complaint.id,
    complaint_address:   complaint.address,
    complaint_district:  complaint.supervisor_district,
    vendor_id:           vendor.id,
    vendor_name:         vendor.name,
    vendor_lbe_tier:     vendor.lbe?.tier || null,
    vendor_cmd_cert:     vendor.lbe?.cmd_cert_number || null,
    work_order_estimate: complaint.estimatedCost,
    score:               pick ? pick.total : null,
    // Bug fix: base policy_authority on the SELECTED vendor's actual eligibility,
    // not a pool-wide check. isSetAsideEligible(pool) was always true, making
    // every audit record claim §NRS ESB.7 regardless of which vendor was dispatched.
    policy_authority:    isVendorSetAsideEligible(vendor) && (complaint.estimatedCost ?? 0) <= SET_ASIDE_CEILING
                           ? 'NRS ESB.7'
                           : (complaint.estimatedCost ?? 0) <= SET_ASIDE_CEILING
                           ? 'lbe_bid_discount'
                           : 'competitive_bid',
    agent_id:            state.agentId,
    dispatched_at:       new Date().toISOString(),
    correlation_id:      correlationId,
    // citizen_email: null  ← DataSF 311 doesn't expose this; when SF provides
    // it via a future intake channel, populate here so api/feedback.js can
    // send 30-day outcome emails. The feedback sweep silently skips records
    // without it rather than permanently blocking all of them.
    citizen_email:       complaint.citizen_email || null,
  };
  appendDispatch(record);

  // Audit: dispatcher clicked Dispatch. This is the first event in the
  // lifecycle correlation chain.
  emitAuditEvent({
    event_type:     'dispatch.initiated',
    actor_type:     'human',
    actor_id:       state.agentId,
    subject_type:   'complaint',
    subject_id:     complaint.id,
    correlation_id: correlationId,
    payload: {
      vendor_id:           vendor.id,
      vendor_name:         vendor.name,
      vendor_lbe_tier:     vendor.lbe?.tier || null,
      vendor_cslb_license: vendor.licensing?.cslb_license || null,
      complaint_address:   complaint.address,
      complaint_district:  complaint.supervisor_district,
      complaint_severity:  complaint.severity || complaint.priority,
      work_order_estimate: complaint.estimatedCost,
      ranking_score:       pick ? pick.total : null,
      ranking_components:  pick ? pick.components : null,
      policy_authority:    record.policy_authority,
      data_source:         state.vendorDataSource || 'unknown',
    },
  });

  // Mark complaint as dispatched in local state (remove from open queue)
  complaint.status = 'dispatched';
  complaint.dispatched_at = record.dispatched_at;

  // The moment a vendor is dispatched, generate BOTH the work order and the
  // Chapter NRS ESB memo as downloadable PDFs (staggered so the browser permits
  // both downloads).
  try {
    prepareDispatchArtifacts(complaint, vendor);
    if (typeof window.downloadWorkOrder === 'function') window.downloadWorkOrder();
    setTimeout(() => {
      if (typeof window.downloadChapter14bMemo === 'function') window.downloadChapter14bMemo('btnDispatch');
    }, 500);
  } catch (e) {
    console.error('Artifact generation failed:', e);
  }

  // Brief success message with link to status page
  showFooterStatus(`✓ Dispatched to ${vendor.name} — ${complaint.id} closed`, 'ok',
    `status.html?id=${encodeURIComponent(complaint.id)}`);

  // Fire the server-side dispatch agent (Agent 5) asynchronously — sends an
  // email to the vendor with the §NRS ESB memo attached. The localStorage write
  // above is the primary record; this is additive. A failed API call does
  // NOT roll back the dispatch.
  fireDispatchAgent(complaint, vendor, record).catch(err => {
    console.error('Dispatch agent failed (record still saved locally):', err);
  });

  // Re-render header counters + queue, then auto-select next
  renderHeader();
  renderQueue();
  state.selectedComplaintId = null;
  state.selectedVendorId = null;
  // Auto-advance after a short pause so the agent sees the success message
  setTimeout(() => {
    const next = sortedFilteredComplaints()[0];
    if (next) selectComplaint(next.id);
    else renderMainPanel();
  }, 1100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Builds the work-order shim (window._workOrder / _selectedVendor) that both
// downloadWorkOrder() and the §NRS ESB memo generator consume. Called on dispatch
// to auto-generate both PDFs.

function prepareDispatchArtifacts(complaint, vendor) {
  if (!complaint || !vendor) return null;

  // Build a work-order shim with the fields 14b-memo.js expects.
  // (NYC's memo was generated by Claude; SF synthesizes directly from
  // the complaint record. The fields below mirror the NYC schema.)
  const addr = complaint.address || '';
  const woEstimate = complaint.estimatedCost;
  // Bug fix: base policy_authority on the selected vendor's eligibility,
  // not a pool-wide check. isSetAsideEligible(pool) returns true whenever
  // any ESB is nearby, causing the memo to claim §NRS ESB.7 even when
  // the selected vendor is Small-LBE. The memo and audit record must agree.
  const memoSetAside = isVendorSetAsideEligible(vendor)
    && (woEstimate ?? 0) <= SET_ASIDE_CEILING;
  // Bug fix: priority → completion days per §NRS ESB priority rules.
  // Hardcoded 7 was wrong for all complaint types.
  const PRIORITY_DAYS = { high: 30, medium: 60, low: 120 };
  const completionDays = PRIORITY_DAYS[complaint.priority] ?? 60;

  window._workOrder = {
    defnum: `DPW-SIRP-${complaint.id}`,
    complaint_type: 'Sidewalk Condition',
    work_order_code: 'SIRP',
    priority_code: (complaint.priority || '').toUpperCase(),
    estimated_days_to_complete: completionDays,
    // Bug fix: 14b-memo.js reads wo.address and wo.supervisor_district.
    // The shim previously used NYC-era field names (onprimname, speclo)
    // which 14b-memo.js never read, leaving address and district blank
    // on every compliance document.
    address: addr,
    supervisor_district: complaint.supervisor_district || '',
    // Keep legacy fields for any other consumers
    onprimname: addr,
    speclo: complaint.supervisor_district || '',
    borough_full: 'San Francisco',
    // Bug fix: populate defect_type from complaint data (was always '—')
    defect_type: complaint.subtype || complaint.defect || 'Sidewalk Condition',
    instructions: complaint.defect || complaint.subtype || '',
    estimatedCost: woEstimate,
    policy_authority: memoSetAside ? 'NRS ESB.7' : 'competitive_bid',
  };
  window._selectedVendor = vendor;
  return window._workOrder;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent 5 — Dispatch Email Agent client wiring.
// Calls /api/dispatch with the work-order shim + base64-encoded §NRS ESB memo PDF.
// The local audit record is already saved by handleDispatch() before this
// runs; if the server-side email fails, we just warn the user.

function buildWorkOrderShim(complaint, vendor) {
  // Bug fixes mirrored from handleMemoDownload:
  //   1. address/supervisor_district (not onprimname/speclo)
  //   2. policy_authority uses vendor-specific eligibility
  //   3. estimated_days_to_complete maps to priority
  //   4. defect_type populated
  const shimSetAside = isVendorSetAsideEligible(vendor)
    && (complaint.estimatedCost ?? 0) <= SET_ASIDE_CEILING;
  const PRIORITY_DAYS = { high: 30, medium: 60, low: 120 };
  return {
    defnum: `DPW-SIRP-${complaint.id}`,
    complaint_type: 'Sidewalk Condition',
    work_order_code: 'SIRP',
    priority_code: (complaint.priority || '').toUpperCase(),
    estimated_days_to_complete: PRIORITY_DAYS[complaint.priority] ?? 60,
    address: complaint.address || '',
    supervisor_district: complaint.supervisor_district || '',
    onprimname: complaint.address || '',
    speclo: complaint.supervisor_district || '',
    borough_full: 'San Francisco',
    defect_type: complaint.subtype || complaint.defect || 'Sidewalk Condition',
    instructions: complaint.defect || complaint.subtype || '',
    estimatedCost: complaint.estimatedCost,
    policy_authority: shimSetAside ? 'NRS ESB.7' : 'competitive_bid',
  };
}

async function fireDispatchAgent(complaint, vendor, localRecord) {
  // Build the memo PDF as base64 for the email attachment.
  // Falls back to no-attachment if 14b-memo.js isn't loaded (defensive).
  let memoPdfBase64 = null;
  if (typeof window.generateChapter14bMemoBase64 === 'function') {
    try {
      const wo = buildWorkOrderShim(complaint, vendor);
      memoPdfBase64 = window.generateChapter14bMemoBase64(wo, vendor);
    } catch (e) {
      console.warn('Memo base64 generation failed; sending email without attachment:', e);
    }
  }

  // Dispatcher email — use agentId if it looks like an email, otherwise
  // synthesize a placeholder so the API doesn't reject the request.
  // Only use agentId as email if it actually looks like one — never synthesize
  // a fake @dpw.sfgov.org address (would bounce to real DPW staff inboxes).
  const dispatcherEmail = /\S+@\S+\.\S+/.test(state.agentId || '')
    ? state.agentId
    : null;

  // Verify CMD/CSLB certs + archive the §NRS ESB memo (and open a DocuSeal signing
  // request) BEFORE issuing the work order. A failed verification blocks the
  // dispatch so an ineligible vendor never receives one.
  if (memoPdfBase64) {
    try {
      const mr = await fetch('/api/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id:    complaint.id,
          vendor:          { id: vendor._api_id || vendor.id, license: vendor.licensing?.cslb_license, name: vendor.name },
          memo_pdf_base64: memoPdfBase64,
          signer:          { email: dispatcherEmail },   // Authorizing Official
          correlation_id:  localRecord.correlation_id,
        }),
      });
      const memoResult = await mr.json().catch(() => ({}));
      if (mr.status === 409 || memoResult.ok === false) {
        showFooterStatus(
          `✗ Dispatch blocked — vendor cert not verifiable: ${(memoResult.reasons || ['cert check failed']).join(', ')}`,
          'error'
        );
        return;  // do NOT send the work order
      }
    } catch (e) {
      console.warn('Memo verify/archive call failed (proceeding to dispatch):', e);
    }
  }

  const payload = {
    complaint_id:        complaint.id,
    vendor_name:         vendor.name,
    vendor_email:        vendor.contact?.email,
    vendor_license:      vendor.licensing?.cslb_license,
    vendor_lbe_tier:        vendor.lbe?.tier,
    vendor_cert_number:     vendor.lbe?.cmd_cert_number,
    vendor_cmd_cert_active: Boolean(vendor.lbe?.cmd_cert_active),  // Bug fix: API needs this to determine mechanism correctly
    complaint_address:   complaint.address,
    complaint_subtype:   complaint.subtype || complaint.defect,
    complaint_severity:  complaint.severity || complaint.priority,
    work_value_estimate: complaint.estimatedCost,
    dispatcher_email:    dispatcherEmail,
    dispatcher_id:       state.agentId,
    score_snapshot:      localRecord.score != null ? { total: localRecord.score } : null,
    memo_pdf_base64:     memoPdfBase64,
    correlation_id:      localRecord.correlation_id,   // thread the audit chain through to api/dispatch.js
  };

  // Guard: no vendor email means we can't send. Show a clear status and bail.
  if (!payload.vendor_email) {
    showFooterStatus(
      `✓ Recorded locally · ⚠ Email skipped (no email on file for ${vendor.name})`,
      'warn'
    );
    emitAuditEvent({
      event_type:     'dispatch.email_skipped',
      actor_type:     'agent',
      actor_id:       'dispatch.js',
      subject_type:   'complaint',
      subject_id:     complaint.id,
      correlation_id: localRecord.correlation_id,
      payload: {
        reason:      'no_vendor_email_on_file',
        vendor_id:   vendor.id,
        vendor_name: vendor.name,
      },
    });
    return;
  }

  try {
    const resp = await fetch('/api/dispatch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.success) {
      // Stamp the server's dispatch_id + feedback_token onto the localStorage
      // audit record so the status.html view can show the email was sent.
      const idx = state.dispatchJournal.findIndex(d => d.complaint_id === complaint.id);
      if (idx >= 0) {
        state.dispatchJournal[idx] = {
          ...state.dispatchJournal[idx],
          server_dispatch_id: result.dispatch_id,
          email_sent: true,
          email_message_id: result.message_id,
          feedback_token: result.feedback_token,
        };
        saveAuditLog(state.dispatchJournal);
      }
      console.log('Dispatch email sent:', result.dispatch_id, result.message_id);
    } else {
      console.warn('Dispatch agent rejected:', result);
      showFooterStatus(
        `✓ Recorded locally · ⚠ Email delivery failed: ${result.error || 'unknown'}`,
        'warn'
      );
      emitAuditEvent({
        event_type:     'dispatch.email_rejected',
        actor_type:     'agent',
        actor_id:       'dispatch.js',
        subject_type:   'complaint',
        subject_id:     complaint.id,
        correlation_id: localRecord.correlation_id,
        payload: { error: result.error || 'unknown', vendor_id: vendor.id },
      });
    }
  } catch (err) {
    console.error('Could not reach dispatch agent:', err);
    showFooterStatus(
      `✓ Recorded locally · ⚠ Could not reach email service`,
      'warn'
    );
    emitAuditEvent({
      event_type:     'dispatch.email_unreachable',
      actor_type:     'agent',
      actor_id:       'dispatch.js',
      subject_type:   'complaint',
      subject_id:     complaint.id,
      correlation_id: localRecord.correlation_id,
      payload: { error: err.message || String(err), vendor_id: vendor.id },
    });
  }
}

function showFooterStatus(text, kind = 'info', statusHref = null) {
  const el = document.getElementById('footerStatus');
  if (!el) return;
  if (statusHref) {
    el.innerHTML = `${escapeHtml(text)} <a href="${escapeHtml(statusHref)}"
      style="margin-left:10px;color:inherit;font-weight:700;text-decoration:underline"
      target="_blank">View status →</a>`;
  } else {
    el.textContent = text;
  }
  el.className = `footer-status footer-status-${kind}`;
  if (kind === 'ok') {
    clearTimeout(showFooterStatus._timer);
    showFooterStatus._timer = setTimeout(() => {
      if (el.innerHTML.startsWith(escapeHtml(text).slice(0, 10)) || el.textContent === text) {
        el.innerHTML = '';
      }
    }, 7000);
  }
}

function wireVendorCardEvents() {
  const container = document.getElementById('vendorCards');
  if (!container) return;
  container.addEventListener('click', e => {
    const card = e.target.closest('.vendor-card');
    if (!card) return;
    // Don't trigger select when clicking inside <details>/<summary>
    if (e.target.closest('summary') || e.target.closest('.vc-breakdown')) {
      // Allow native details toggle
      return;
    }
    selectVendor(card.dataset.vendorId);
  });
  container.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.vendor-card');
    if (!card) return;
    e.preventDefault();
    selectVendor(card.dataset.vendorId);
  });
}

function selectVendor(vendorId) {
  // In competitive-quotes mode, clicks toggle multi-selection instead.
  if (state.quoteMode) {
    if (state.quoteVendorIds.has(vendorId)) state.quoteVendorIds.delete(vendorId);
    else state.quoteVendorIds.add(vendorId);
    refreshQuoteSelectionUI();
    return;
  }
  // Toggle: clicking the already-selected card clears selection.
  if (state.selectedVendorId === vendorId) {
    state.selectedVendorId = null;
  } else {
    state.selectedVendorId = vendorId;
  }
  // Update each card: selected gets accent border + open breakdown.
  document.querySelectorAll('.vendor-card').forEach(card => {
    const isThis = card.dataset.vendorId === state.selectedVendorId;
    card.classList.toggle('is-selected', isThis);
    const details = card.querySelector('.vc-breakdown');
    if (details) details.open = isThis;
  });
  // Re-render the right column + footer button enable state.
  const complaint = state.complaints.find(c => c.id === state.selectedComplaintId);
  if (complaint) {
    const infoCol = document.getElementById('infoColumn');
    if (infoCol) infoCol.innerHTML = infoColumnHtml(complaint);
    const hasVendor = !!state.selectedVendorId;
    document.getElementById('btnDispatch')?.toggleAttribute('disabled', !hasVendor);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection

function selectComplaint(id) {
  if (state.selectedComplaintId === id) return;
  state.selectedComplaintId = id;
  renderQueueList();
  renderMainPanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring

function wireEvents() {
  // Priority pill clicks
  document.querySelectorAll('[data-priority]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activePriority = btn.dataset.priority;
      renderQueue();
    });
  });

  // District dropdown
  const districtFilter = document.getElementById('districtFilter');
  if (districtFilter) {
    districtFilter.addEventListener('change', e => {
      state.activeDistrict = e.target.value;
      renderQueue();
    });
  }

  // Queue item clicks (delegated)
  const list = document.getElementById('queueList');
  if (list) {
    list.addEventListener('click', e => {
      const item = e.target.closest('.queue-item');
      if (item) selectComplaint(item.dataset.complaintId);
    });
    list.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const item = e.target.closest('.queue-item');
        if (item) { e.preventDefault(); selectComplaint(item.dataset.complaintId); }
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap

async function safeFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url.split('?')[0]}`);
  return r.json();
}

// ─────────────────────────────────────────────────────────────────────────
// Postgres-API adapter — converts /api/v2/vendors response shape into the
// legacy baked-vendors-v2.json shape that scorer.js + the render code
// already understand. Lets us swap the data source without rewriting 30
// call sites. Phase 2 of the platform foundation migration will inline
// the new shape and retire this adapter.

function _extractContractCount(title) {
  if (!title) return 0;
  const m = String(title).match(/(\d+)\s+prior\s+DPW/);
  return m ? Number(m[1]) : 0;
}

function adaptApiVendor(apiV, contactSource) {
  // apiV has joined relations: certifications, vendor_addresses,
  // vendor_specialties, vendor_contracts
  const certs = apiV.certifications || [];
  const cslb  = certs.find(c => c.cert_type === 'cslb') || {};
  const cmd   = certs.find(c => c.cert_type === 'cmd_lbe') || {};

  const addrs = apiV.vendor_addresses || [];
  const addr  = addrs.find(a => a.is_primary) || addrs[0] || {};

  const specs = (apiV.vendor_specialties || []).map(s => s.specialty);

  // Aggregate contract rows back to the legacy track_record shape.
  // The migration script wrote one "prime aggregate" and optionally one
  // "sub aggregate" per vendor, with contract_title encoding the count.
  const contracts = apiV.vendor_contracts || [];
  const primeAgg = contracts.find(c => c.role === 'prime') || {};
  const subAgg   = contracts.find(c => c.role === 'sub')   || {};

  return {
    id:   apiV.pool_id || apiV.id,        // pool_id keeps legacy lookups working
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

    // Contacts ship from the JSON merge — the public API redacts PII
    contact: contactSource?.contact || { email: null, phone: null, website: null },

    specialties: specs,

    track_record: {
      prior_dpw_contracts_value:        Number(primeAgg.agreed_amount) || 0,
      prior_dpw_contracts_count:        _extractContractCount(primeAgg.contract_title),
      prior_dpw_sub_value_upper_bound:  Number(subAgg.agreed_amount)   || 0,
      prior_dpw_sub_contracts_count:    _extractContractCount(subAgg.contract_title),
      last_city_contract_date:          primeAgg.awarded_on || subAgg.awarded_on || null,
    },

    // Fields not yet served by the API — pull from contactSource if present
    audit:        contactSource?.audit        || { warnings: [] },
    demographics: contactSource?.demographics || {},

    // Rolling citizen-survey performance — read by scorer.js reliability (learning loop)
    outcome_stats: apiV.outcome_stats || null,

    _api_id:     apiV.id,      // canonical UUID — useful for future audit-event POSTs
    _source:    'api',
  };
}

async function loadVendorsViaApi(jsonFallback) {
  // Build a pool_id -> JSON vendor map so we can merge contacts/audit
  const jsonByPoolId = new Map();
  for (const v of (jsonFallback || [])) jsonByPoolId.set(v.id, v);

  const resp = await safeFetch(VENDORS_API_URL);
  const apiVendors = resp.vendors || [];
  return apiVendors.map(av => adaptApiVendor(av, jsonByPoolId.get(av.pool_id)));
}

async function loadComplaints() {
  // Try the live SeeClickFix proxy first (works on Vercel).
  // Falls back to static JSON for local python dev server.
  try {
    const r = await fetch(COMPLAINTS_API_URL);
    if (!r.ok) throw new Error(`proxy ${r.status}`);
    const d = await r.json();
    if (d.complaints?.length) {
      console.info(`[data] Loaded ${d.complaints.length} live Clark County issues from SeeClickFix`);
      return d.complaints;
    }
    throw new Error('empty response');
  } catch (e) {
    console.warn('[data] SeeClickFix proxy unavailable, falling back to static JSON:', e.message);
    const d = await safeFetch(QUEUE_URL);
    return d.complaints || [];
  }
}

async function loadData() {
  // Complaints: live SeeClickFix or static fallback
  // Vendors + assignments: always from JSON
  const [rawComplaints, jsonVendorsResp, assignResp] = await Promise.all([
    loadComplaints(),
    safeFetch(VENDORS_URL),
    safeFetch(ASSIGNMENTS_URL).catch(() => null),
  ]);
  state.complaints      = rawComplaints.map(normalizeComplaint);
  state.assignments     = assignResp?.assignments || {};
  state.dispatchJournal = loadAuditLog();

  const jsonVendors = jsonVendorsResp.vendors || [];

  // Try the Postgres API first. On any failure, fall back to JSON.
  try {
    state.vendors = await loadVendorsViaApi(jsonVendors);
    state.vendorDataSource = 'api';
    console.info(`[data] Loaded ${state.vendors.length} vendors from /api/v2/vendors`);
  } catch (e) {
    console.warn('[data] API load failed, falling back to JSON:', e.message);
    state.vendors = jsonVendors.map(v => ({ ...v, _source: 'json' }));
    state.vendorDataSource = 'json_fallback';
    state.vendorApiError   = e.message;
  }
}

async function bootstrap() {
  // Auth guard — redirect to login if no valid session
  const session = requireAuth();
  if (!session) return;

  // Use the logged-in user's name as the agent ID (skip the prompt)
  state.agentId = session.name || session.email;
  try { localStorage.setItem('nvesb_dispatch_agent_id', state.agentId); } catch {}

  try {
    await loadData();
  } catch (e) {
    console.error('Dispatch console data load failed:', e);
    emitAuditEvent({
      event_type:   'console.load_failed',
      actor_type:   'agent',
      actor_id:     'dispatch.js',
      payload:      { error: e.message },
    });
    document.getElementById('dispatchPanel').innerHTML = `
      <div class="panel-error">
        <h2>Couldn't load data</h2>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
    return;
  }

  // Audit: session start. Tags the data source + complaint count so
  // any quirky behavior in this session is traceable.
  emitAuditEvent({
    event_type:   'console.opened',
    actor_type:   'human',
    actor_id:     session.email || session.name,
    subject_type: 'session',
    subject_id:   session.email || session.name,
    payload: {
      name:               session.name,
      dispatcher_email:   session.email,
      data_source:        state.vendorDataSource,
      vendor_count:       state.vendors.length,
      complaint_count:    state.complaints.length,
      assignments_loaded: Object.keys(state.assignments || {}).length,
      user_agent:         navigator.userAgent,
    },
  });

  renderHeader();
  renderQueue();
  renderMainPanel();
  wireEvents();
  wireLogout();

  // Expose for debugging from the browser console
  window.SIRP = { state, rankTop, WEIGHTS };
}

function wireLogout() {
  const btn = document.getElementById('btnLogout');
  if (btn) btn.addEventListener('click', logout);
}

document.addEventListener("DOMContentLoaded", bootstrap);
