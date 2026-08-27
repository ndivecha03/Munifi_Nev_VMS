// public/sandbox.js — SIRP Sandbox Replay dashboard.
//
// Reads the replay artifacts Nish's scripts/sandbox/replay.mjs produced
// (sandbox-run.json, sandbox-audit.json) plus the live vendor pool, and
// renders the 5 panels + scoreboard described in the Task 2 build doc.
// No build step — plain ESM, loaded via <script type="module">.

import { rankCertOnly, CERT_ONLY_MAX } from './sandbox/score-cert-only.mjs';
import { shapeVendors } from './sandbox/shape-vendors.mjs';
import { stripVendorPII, deriveAtRiskFromVendors } from './sandbox/pii.mjs';

// Mirrored into public/sandbox/ by scripts/sandbox/replay.mjs — the
// canonical files live in scripts/sandbox/ (outside the static web root)
// per the build doc's file layout; these are the servable copies.
const RUN_URL    = './sandbox/sandbox-run.json';
const AUDIT_URL  = './sandbox/sandbox-audit.json';
const VENDORS_API_URL  = '/api/v2/vendors?set_aside_only=false';
const VENDORS_JSON_URL = './baked-vendors-v2.json';
const COMPLAINTS_URL   = './data/complaints.json';

const state = {
  run: null,
  audit: null,
  vendors: [],          // shaped, NOT pii-stripped (used for live scoring)
  vendorsPublic: [],     // shaped + pii-stripped (used for panel 2 display)
  complaints: [],
  caseIndexById: new Map(),  // complaint_id -> sandbox-run.json case summary
  selectedComplaintId: null,
};

function $(id) { return document.getElementById(id); }

async function safeFetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
  return r.json();
}

// ───────────────────────────────────────────────────────────────────────────
// Bootstrap

async function loadVendors() {
  // Try the live API first (real prod data, 202/147 once deployed);
  // fall back to the local baked JSON (works in any environment, incl.
  // local dev servers with no serverless functions running).
  let jsonFallback = [];
  try {
    const jsonResp = await safeFetchJSON(VENDORS_JSON_URL);
    jsonFallback = jsonResp.vendors || jsonResp || [];
  } catch (e) {
    console.warn('[sandbox] could not load baked-vendors-v2.json fallback:', e.message);
  }

  try {
    const apiResp = await safeFetchJSON(VENDORS_API_URL);
    const apiVendors = apiResp.vendors || apiResp || [];
    if (apiVendors.length) {
      return { vendors: shapeVendors(apiVendors, jsonFallback), source: 'api' };
    }
  } catch (e) {
    console.warn('[sandbox] /api/v2/vendors unavailable, using local JSON:', e.message);
  }

  return { vendors: shapeVendors(jsonFallback), source: 'json_fallback' };
}

async function bootstrap() {
  const [runResult, auditResult, complaintsResult, vendorsResult] = await Promise.allSettled([
    safeFetchJSON(RUN_URL),
    safeFetchJSON(AUDIT_URL),
    safeFetchJSON(COMPLAINTS_URL),
    loadVendors(),
  ]);

  if (runResult.status === 'fulfilled') {
    state.run = runResult.value;
    for (const c of state.run.cases) state.caseIndexById.set(c.complaint_id, c);
  } else {
    console.error('[sandbox] failed to load sandbox-run.json — run scripts/sandbox/replay.mjs first.', runResult.reason);
  }

  if (auditResult.status === 'fulfilled') {
    state.audit = auditResult.value;
  } else {
    console.error('[sandbox] failed to load sandbox-audit.json.', auditResult.reason);
  }

  if (complaintsResult.status === 'fulfilled') {
    const all = complaintsResult.value.complaints || [];
    // Only show the cases that are actually in this replay batch, in batch order.
    state.complaints = state.run
      ? state.run.cases.map(c => all.find(x => (x.id || x.case_id) === c.complaint_id)).filter(Boolean)
      : all.slice(0, 12);
  }

  if (vendorsResult.status === 'fulfilled') {
    state.vendors = vendorsResult.value.vendors;
    state.vendorsPublic = state.vendors.map(stripVendorPII);
    console.info(`[sandbox] loaded ${state.vendors.length} vendors (source: ${vendorsResult.value.source})`);
  }

  renderHeader();
  renderScoreboard();
  renderQueue();
  renderVendorSummary();
  renderAudit();

  $('certMaxLabel').textContent = String(CERT_ONLY_MAX);
}

// ───────────────────────────────────────────────────────────────────────────
// Header + scoreboard

function renderHeader() {
  if (state.run?.generated_at) {
    $('runGeneratedAt').textContent = `Replay generated: ${new Date(state.run.generated_at).toLocaleString()}`;
  } else {
    $('runGeneratedAt').textContent = 'No replay found — run scripts/sandbox/replay.mjs';
  }
}

function renderScoreboard() {
  const sb = state.run?.scoreboard;
  if (!sb) return;
  $('statAuditCompleteness').textContent = `${sb.audit_completeness_pct}%`;
  $('statViolations').textContent = String(sb.eligibility_violations);
  $('statViolations').classList.add(sb.eligibility_violations === 0 ? 'is-clean' : 'is-violation');
  $('statThroughput').textContent = String(sb.throughput);
  $('statMicroLbe').textContent = `${sb.pct_micro_lbe}%`;
}

// ───────────────────────────────────────────────────────────────────────────
// Panel 1 — Complaint queue

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function daysAgo(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
  return `${days}d`;
}

function renderQueue() {
  const tbody = $('queueTableBody');
  if (!state.complaints.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="sb-loading">No cases in this replay batch.</td></tr>';
    return;
  }

  tbody.innerHTML = state.complaints.map(c => {
    const id = c.id || c.case_id;
    const caseSummary = state.caseIndexById.get(id);
    const priority = caseSummary?.priority_code || c.severity || '—';
    return `
      <tr data-complaint-id="${escapeHtml(id)}">
        <td>${escapeHtml(id)}</td>
        <td>${escapeHtml(c.address)}</td>
        <td>${escapeHtml(c.subtype)}</td>
        <td>${daysAgo(c.reported_at)}</td>
        <td>${escapeHtml(priority)}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-complaint-id]').forEach(row => {
    row.addEventListener('click', () => selectComplaint(row.dataset.complaintId));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Panel 2 — Vendor universe

function renderVendorSummary() {
  const total = state.vendorsPublic.length;
  const eligible = state.vendorsPublic.filter(v => {
    const tier = (v.lbe?.tier || '').toLowerCase();
    const cmdActive = !!v.lbe?.cmd_cert_active;
    const cslbOk = (v.licensing?.cslb_status || '').toLowerCase() === 'active';
    return tier.includes('micro') && cmdActive && cslbOk;
  }).length;

  $('vendorTotalLabel').textContent = String(total);
  $('vendorEligibleLabel').textContent = String(eligible);

  const tierCounts = { micro: 0, small: 0, sba: 0, lbe: 0, other: 0 };
  for (const v of state.vendorsPublic) {
    const t = (v.lbe?.tier || '').toLowerCase();
    if (t.includes('micro')) tierCounts.micro++;
    else if (t.includes('small')) tierCounts.small++;
    else if (t.includes('sba')) tierCounts.sba++;
    else if (t.includes('lbe')) tierCounts.lbe++;
    else tierCounts.other++;
  }

  const atRisk = deriveAtRiskFromVendors(state.vendorsPublic);

  $('vendorSummary').innerHTML = `
    <div class="sb-vendor-bucket"><div class="num">${tierCounts.micro}</div><div class="label">Micro-LBE</div></div>
    <div class="sb-vendor-bucket"><div class="num">${tierCounts.small}</div><div class="label">Small-LBE</div></div>
    <div class="sb-vendor-bucket"><div class="num">${tierCounts.sba}</div><div class="label">SBA-LBE</div></div>
    <div class="sb-vendor-bucket"><div class="num">${tierCounts.lbe}</div><div class="label">Other LBE</div></div>
    <div class="sb-vendor-bucket"><div class="num">${tierCounts.other}</div><div class="label">Uncertified</div></div>
    <div class="sb-vendor-bucket risk"><div class="num">${atRisk.buckets.EXPIRED}</div><div class="label">Cert expired</div></div>
    <div class="sb-vendor-bucket risk"><div class="num">${atRisk.buckets['2WKS']}</div><div class="label">Expires &le;2wk</div></div>
    <div class="sb-vendor-bucket risk"><div class="num">${atRisk.buckets['60D']}</div><div class="label">Expires &le;60d</div></div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Panel 3 — Live dispatch (cert-only ranking)

function renderComponentBars(components, max) {
  return Object.entries(components).map(([key, val]) => {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const pct = max ? Math.min(100, (val / max) * 100) : 0;
    return `
      <div class="sb-component-row">
        <span>${escapeHtml(label)}</span>
        <span class="sb-component-track"><span class="sb-component-fill" style="width:${pct}%"></span></span>
        <span>${val}</span>
      </div>`;
  }).join('');
}

function selectComplaint(complaintId) {
  state.selectedComplaintId = complaintId;

  document.querySelectorAll('#queueTableBody tr').forEach(r => {
    r.classList.toggle('is-selected', r.dataset.complaintId === complaintId);
  });

  const complaint = state.complaints.find(c => (c.id || c.case_id) === complaintId);
  const caseSummary = state.caseIndexById.get(complaintId);
  if (!complaint) return;

  // Re-score live in the browser (not just reading the cached summary) so
  // the ranking shown is provably the real scorer.js + score-cert-only.mjs
  // running right now against the current vendor pool — not a canned value.
  const ranked = rankCertOnly(complaint, state.vendors, [], { topN: 5 });
  const top = ranked.picks[0];

  const dispatchEl = $('dispatchSelected');
  if (!top) {
    dispatchEl.innerHTML = `<p class="sb-empty-hint">No eligible vendor found for this case in the current pool.</p>`;
  } else {
    dispatchEl.innerHTML = `
      <div class="sb-case-header">${escapeHtml(complaint.address)}</div>
      <div class="sb-case-address">${escapeHtml(complaint.subtype)} · Case ${escapeHtml(complaintId)} · Pool used: ${escapeHtml(ranked.poolUsed)}</div>
      <div class="sb-component-bars">${renderComponentBars(top.components, 20)}</div>
      <div class="sb-total-score">Total: ${top.total} / ${ranked.cert_only_max}</div>
      <div class="sb-badge-row">${(top.badges || []).map(b => `<span class="sb-badge">${escapeHtml(b)}</span>`).join('')}</div>
    `;
  }

  $('btnLiveDispatch').disabled = false;
  $('liveOutput').hidden = true;
  $('liveOutput').textContent = '';

  // Panel 4 — artifacts (work order from the cached batch run)
  renderArtifacts(complaintId, top, caseSummary);
}

async function runLiveDispatch() {
  const complaintId = state.selectedComplaintId;
  const complaint = state.complaints.find(c => (c.id || c.case_id) === complaintId);
  if (!complaint) return;

  const ranked = rankCertOnly(complaint, state.vendors, [], { topN: 5 });
  const top = ranked.picks[0];
  const vendor = top ? state.vendors.find(v => (v.id || v.name) === top.vendor_id) : null;

  const out = $('liveOutput');
  out.hidden = false;
  out.textContent = 'Calling /api/generate-work-order…';
  $('btnLiveDispatch').disabled = true;

  try {
    const body = {
      complaint: {
        complaint_id: complaint.id || complaint.case_id,
        complaint_type: complaint.subtype,
        address: complaint.address,
        supervisor_district: complaint.supervisor_district,
        reported_date: complaint.reported_at,
        priority: complaint.severity,
        details: `Specialty required: ${complaint.specialty_required || 'sidewalk'}`,
      },
      vendor: vendor ? { name: vendor.name, license: vendor.licensing?.cslb_license || '' } : undefined,
    };
    const resp = await fetch('/api/generate-work-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      out.textContent = `Live call failed (HTTP ${resp.status}):\n${text}`;
    } else {
      const json = JSON.parse(text);
      out.textContent = JSON.stringify(json, null, 2);
      window._workOrder = json;
      window._selectedVendor = vendor;
      $('workOrderView').textContent = JSON.stringify(json, null, 2);
      $('btnRenderMemo').disabled = false;
    }
  } catch (e) {
    out.textContent = `Live call threw: ${e.message}`;
  } finally {
    $('btnLiveDispatch').disabled = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Panel 4 — Artifacts (cached work order + on-demand memo)

function renderArtifacts(complaintId, topPick, caseSummary) {
  const cacheCase = state.run?.cases.find(c => c.complaint_id === complaintId);
  const vendor = topPick ? state.vendors.find(v => (v.id || v.name) === topPick.vendor_id) : null;

  if (!cacheCase) {
    $('workOrderView').textContent = 'No cached work order for this case.';
    $('btnRenderMemo').disabled = true;
    return;
  }

  $('workOrderView').textContent = JSON.stringify(cacheCase, null, 2);
  $('btnRenderMemo').disabled = false;

  // Build a minimal work-order object compatible with generateChapter14bMemoBase64
  // (defnum/address/defect_type/etc.) from the run summary — the full synthesized
  // object lives in scripts/sandbox/workorder-cache.json; this view uses what
  // sandbox-run.json carries forward per case.
  window._workOrder = {
    defnum: cacheCase.defnum,
    address: cacheCase.address,
    defect_type: cacheCase.defect_type,
    priority_code: cacheCase.priority_code,
    supervisor_district: null,
    instructions: `Dispatch for ${cacheCase.defect_type} at ${cacheCase.address}.`,
    lbe_requirement: 'Chapter 14B LBE subcontracting goal: 23% minimum · CMD certification required',
    estimated_days_to_complete: null,
  };
  window._selectedVendor = vendor;
}

function renderMemo() {
  if (!window._workOrder) return;
  try {
    const base64 = window.generateChapter14bMemoBase64(window._workOrder, window._selectedVendor);
    const wrap = $('memoViewWrap');
    wrap.innerHTML = `<embed src="data:application/pdf;base64,${base64}" type="application/pdf">`;
  } catch (e) {
    $('memoViewWrap').innerHTML = `<p class="sb-empty-hint">Memo render failed: ${escapeHtml(e.message)}</p>`;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Panel 5 — Audit trail

function renderAudit() {
  if (!state.audit) {
    $('auditTableBody').innerHTML = '<tr><td colspan="5" class="sb-loading">No audit trail found — run scripts/sandbox/replay.mjs</td></tr>';
    return;
  }

  $('chainStatus').textContent = state.audit.chain_verified
    ? `✅ verified (${state.audit.event_count} events)`
    : `❌ TAMPERED — chain does not verify`;

  $('auditTableBody').innerHTML = state.audit.events.map(ev => `
    <tr>
      <td>${ev.seq}</td>
      <td class="sb-event-type">${escapeHtml(ev.event_type)}</td>
      <td>${escapeHtml(ev.complaint_id)}</td>
      <td>${escapeHtml(ev.timestamp)}</td>
      <td class="sb-hash" title="${escapeHtml(ev.hash)}">${escapeHtml(ev.hash.slice(0, 12))}…</td>
    </tr>
  `).join('');
}

// ───────────────────────────────────────────────────────────────────────────

$('btnLiveDispatch').addEventListener('click', runLiveDispatch);
$('btnRenderMemo').addEventListener('click', renderMemo);

bootstrap();
