// public/sandbox/synth-workorder.mjs — deterministic SIRP work-order
// generator (no LLM).
//
// The live /api/generate-work-order endpoint caps at 10 calls/hour per
// instance (see api/generate-work-order.py RATE_LIMIT_PER_HOUR) — a batch
// replay of even 12 cases blows through that. This synthesizer fills the
// same DPW/SIRP schema (see api/generate-work-order.py's SYSTEM_PROMPT,
// "SCHEMA" block) deterministically from the complaint's own fields, so
// the sandbox replay can run any batch size with zero API cost and
// byte-identical output across runs. The one **live** Claude call is
// reserved for the dashboard's single "watch it dispatch" panel.

const DEFECT_TABLE = {
  pavement_defect:                  { code: 'SWK-CR-02', label: 'Cracked Concrete Panel',            priority: 2 },
  sidewalk_defect:                  { code: 'SWK-TH-01', label: 'Trip Hazard — Raised/Sunken Panel',  priority: 1 },
  curb_or_curb_ramp_defect:         { code: 'SWK-CB-05',  label: 'Curb Damaged or Missing',           priority: 2 },
  missing_side_sewer_vent_cover:    { code: 'SWK-MS-08',  label: 'Sidewalk Missing/Obstructed',       priority: 1 },
  damaged_side_sewer_vent_cover:    { code: 'SWK-BP-06',  label: 'Concrete Panel Broken/Spalling',    priority: 2 },
  manhole_cover_off:                { code: 'SWK-MS-08',  label: 'Sidewalk Missing/Obstructed',       priority: 1 },
  public_stairway_defect:           { code: 'SWK-BP-06',  label: 'Concrete Panel Broken/Spalling',    priority: 2 },
  utility_excavation:               { code: 'SWK-DR-07',  label: 'Drainage Blocked — Slab Heave',     priority: 3 },
  construction_plate_shifted:       { code: 'SWK-TH-02',  label: 'Trip Hazard — Multiple Panels',     priority: 1 },
  other:                            { code: 'SWK-CR-02',  label: 'Cracked Concrete Panel',            priority: 2 },
};

const PRIORITY_META = {
  1: {
    priority_code: 'PRIORITY 1 — EMERGENCY / ADA',
    response_requirement: 'TEMPORARY FIX REQUIRED: 24 HOURS · PERMANENT REPAIR: 30 CALENDAR DAYS',
    estimated_days_to_complete: 30,
  },
  2: {
    priority_code: 'PRIORITY 2 — STANDARD REPAIR',
    response_requirement: 'PERMANENT REPAIR: 60 CALENDAR DAYS',
    estimated_days_to_complete: 60,
  },
  3: {
    priority_code: 'PRIORITY 3 — ROUTINE MAINTENANCE',
    response_requirement: 'PERMANENT REPAIR: 90 CALENDAR DAYS',
    estimated_days_to_complete: 90,
  },
};

const DISTRICT_NAMES = {
  D1: 'Richmond', D2: 'Marina / Pacific Heights', D3: 'North Beach / Chinatown',
  D4: 'Sunset', D5: 'Haight / Western Addition', D6: 'SOMA / Tenderloin',
  D7: 'West of Twin Peaks', D8: 'Castro / Noe Valley', D9: 'Mission / Bernal',
  D10: 'Bayview / Potrero', D11: 'Excelsior / OMI',
};

/** Deterministic 6-digit serial from a complaint id — stable across runs. */
function serialFromId(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(h % 1_000_000).padStart(6, '0');
}

function defnumFor(complaint) {
  const year = (complaint.reported_at || '').slice(0, 4) || new Date().getFullYear();
  return `DPW-SIRP-${year}-${serialFromId(complaint.id || complaint.case_id)}`;
}

function districtCode(d) {
  if (!d) return null;
  const n = String(d).replace(/^D/i, '');
  return n;
}

/**
 * Deterministically synthesize a SIRP work order for one complaint.
 * Same shape as the live /api/generate-work-order JSON output.
 *
 * @param {Object} complaint   from public/data/complaints.json
 * @param {Object} [vendor]    optional assigned vendor ({name, license})
 */
export function synthesizeWorkOrder(complaint, vendor) {
  const defect = DEFECT_TABLE[complaint.subtype] || DEFECT_TABLE.other;
  const pmeta  = PRIORITY_META[defect.priority];
  const distCode = districtCode(complaint.supervisor_district);
  const permitRequired = defect.priority === 1 || complaint.severity === 'emergency';

  return {
    defnum: defnumFor(complaint),
    assigned_agency: 'SF DPW — Sidewalk Inspection & Repair Program (SIRP)',
    address: complaint.address,
    supervisor_district: distCode,
    district_name: DISTRICT_NAMES[complaint.supervisor_district] || 'San Francisco',
    defect_type: defect.label,
    defect_code: defect.code,
    priority_code: pmeta.priority_code,
    priority_reason: `Synthesized from complaint subtype "${complaint.subtype}" (severity: ${complaint.severity}).`,
    response_requirement: pmeta.response_requirement,
    lbe_requirement: 'Chapter 14B LBE subcontracting goal: 23% minimum · CMD certification required',
    materials_needed: 'Class 2 PCC concrete (4000 PSI), standard sidewalk forms, rebar dowels per DPW std. detail.',
    work_steps: [
      '1. Site inspection and traffic control setup.',
      '2. Saw-cut and remove damaged panel section.',
      '3. Excavate and prepare subgrade.',
      '4. Install rebar/dowels per DPW standard detail.',
      '5. Form and pour Class 2 PCC concrete panel.',
      '6. Cure per DPW spec; restripe ADA detectable warning if applicable.',
      '7. Final inspection and close-out.',
    ],
    instructions: `Dispatch SIRP-prequalified C-8 contractor to repair ${defect.label.toLowerCase()} at ${complaint.address}. Verify CMD/CSLB certification status before site mobilization.`,
    safety_notes: 'Standard PPE (hard hat, safety vest, steel-toe boots). Traffic control per WATCH manual if work encroaches on roadway. Wet-cut only — no dry cutting near pedestrian right-of-way.',
    inspector_approval_required: true,
    permit_required: permitRequired,
    estimated_days_to_complete: pmeta.estimated_days_to_complete,
    status: 'Open',
    chapter_14b_note: 'This work order is subject to SF Administrative Code Chapter 14B LBE requirements.',

    // Sandbox-only metadata (not part of the live-API schema) — keeps the
    // audit trail honest about how this artifact was produced.
    _generated_by: 'synth-workorder.mjs (deterministic, no LLM)',
    _vendor: vendor ? { name: vendor.name, license: vendor.licensing?.cslb_license || null } : null,
  };
}
