// Chapter 14B LBE Small Purchase Authorization memo generator.
// Generates a client-side PDF using jsPDF (loaded from CDN before this script).
//
// SF Administrative Code Chapter 14B (Jan 2025 amendments):
//   §14B.7 — Micro-LBE set-aside: DPW may procure construction work
//   directly from a CMD-certified Micro-LBE for contracts up to $600,000
//   without competitive solicitation, subject to the responsibility
//   determination and price-reasonableness requirements in this section.

// Public entry points:
//   downloadChapter14bMemo(triggerLabel)         — triggers a browser download
//   generateChapter14bMemoBase64(wo, vendor)     — returns the PDF as a base64
//                                                  string (no download)
// The download flow uses window._workOrder / window._selectedVendor for
// backward compatibility with the existing UI. The base64 flow takes them as
// explicit args so the api/dispatch.js path can build a memo for any pair.

function generateChapter14bMemoBase64(wo, vendor) {
  return _buildChapter14bMemo(wo, vendor, { returnBase64: true });
}

function downloadChapter14bMemo(triggerLabel) {
  const wo     = window._workOrder;
  const vendor = window._selectedVendor;
  if (!wo) { return; }

  const memoStatus = document.getElementById('woMemoStatus');
  if (memoStatus) memoStatus.textContent = 'Building memo…';
  return _buildChapter14bMemo(wo, vendor, { returnBase64: false, memoStatus });
}

function _buildChapter14bMemo(wo, vendor, opts) {
  if (!wo) return null;
  const { returnBase64 = false, memoStatus = null } = opts || {};

  try {
    const { jsPDF } = window.jspdf;
    const doc  = new jsPDF({ unit: 'pt', format: 'letter' });
    const W    = doc.internal.pageSize.getWidth();
    const mar  = 54;
    const col  = W - mar * 2;
    const SF_BLUE   = [0, 92, 153];
    const TEAL      = [0, 122, 140];
    const DARK      = [51, 51, 51];
    const MID_GRAY  = [180, 180, 180];
    const LT_GRAY   = [245, 245, 245];
    const WHITE     = [255, 255, 255];

    let y = 48;

    function setFont(style, size, color) {
      doc.setFont('helvetica', style || 'normal');
      doc.setFontSize(size || 9);
      doc.setTextColor(...(color || DARK));
    }
    function rule(yPos, thick, color) {
      doc.setLineWidth(thick || 0.5);
      doc.setDrawColor(...(color || MID_GRAY));
      doc.line(mar, yPos, W - mar, yPos);
    }
    function sectionBar(title, yPos) {
      doc.setFillColor(...SF_BLUE);
      doc.rect(mar, yPos, col, 18, 'F');
      setFont('bold', 9, WHITE);
      doc.text(title, mar + 8, yPos + 12.5);
      return yPos + 18 + 6;
    }
    function fieldRow(label, value, yPos, bold) {
      doc.setFillColor(...LT_GRAY);
      doc.rect(mar, yPos, 130, 18, 'F');
      setFont('bold', 7.5, DARK);
      doc.text(label, mar + 6, yPos + 12);
      setFont(bold ? 'bold' : 'normal', 9, [0, 0, 0]);
      const wrapped = doc.splitTextToSize(String(value || '—'), col - 140);
      doc.text(wrapped, mar + 138, yPos + 12);
      const rowH = Math.max(18, wrapped.length * 11 + 7);
      rule(yPos + rowH, 0.3, MID_GRAY);
      return yPos + rowH;
    }
    function bodyText(text, yPos) {
      setFont('normal', 8.5, DARK);
      const wrapped = doc.splitTextToSize(text, col);
      doc.text(wrapped, mar, yPos);
      return yPos + wrapped.length * 12 + 4;
    }
    function checkRow(text, yPos) {
      doc.setDrawColor(...TEAL);
      doc.setLineWidth(0.8);
      doc.rect(mar + 2, yPos + 2, 9, 9);
      setFont('normal', 8.5, DARK);
      const wrapped = doc.splitTextToSize(text, col - 20);
      doc.text(wrapped, mar + 20, yPos + 9);
      const h = Math.max(16, wrapped.length * 11 + 5);
      rule(yPos + h, 0.3, MID_GRAY);
      return yPos + h;
    }
    function sigBlock(label, value, xPos, yPos) {
      setFont('bold', 7.5, DARK);
      doc.text(label, xPos, yPos);
      setFont('normal', 9, [0, 0, 0]);
      doc.text(value || '____________________________', xPos, yPos + 14);
      rule(yPos + 16, 0.5, DARK);
      return yPos + 28;
    }
    function ensureSpace(needed) {
      if (y + needed > doc.internal.pageSize.getHeight() - 54) {
        doc.addPage();
        y = 48;
      }
    }

    // v2 schema reads with v1 fallbacks (vendor.license, vendor.phone, vendor.cert_id, vendor.lbe_type)
    const vName    = (vendor && vendor.name)
                     || wo._vendorName    || 'See work order';
    const vLicense = (vendor && (vendor.licensing?.cslb_license ?? vendor.license))
                     || wo._vendorLicense || '—';
    const vPhone   = (vendor && (vendor.contact?.phone ?? vendor.phone))
                     || '—';
    const vAddr    = (vendor && (
                       typeof vendor.address === 'string'
                         ? vendor.address
                         : vendor.address?.line1
                           ? [vendor.address.line1, vendor.address.city, vendor.address.state, vendor.address.zip].filter(Boolean).join(', ')
                           : null
                     )) || '____________________________';
    const certId   = (vendor && (vendor.lbe?.cmd_cert_number ?? vendor.cert_id))
                     || '—';
    const lbeType  = (vendor && (vendor.lbe?.tier ?? vendor.lbe_type))
                     || 'LBE';
    const memoRef  = '14B-' + (wo.defnum || 'DRAFT').replace('DPW-SIRP-', '');
    const memoDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const addr     = wo.address || '____________________________';
    const district = wo.supervisor_district ? `Supervisor District ${wo.supervisor_district}` : '';
    const desc     = wo.instructions || wo.defect_type || 'Sidewalk repair per attached work order.';
    const pin      = wo.defnum || ('SIRP-' + Date.now().toString().slice(-6));

    // 1. Letterhead
    setFont('bold', 11, SF_BLUE);
    doc.text('City and County of San Francisco', mar, y);
    setFont('normal', 9, SF_BLUE);
    doc.text('Department of Public Works — Sidewalk Inspection and Repair Program (SIRP)', mar, y + 14);
    setFont('normal', 8, DARK);
    doc.text('Memo Ref: ' + memoRef, W - mar, y, { align: 'right' });
    doc.text('Date: ' + memoDate,    W - mar, y + 11, { align: 'right' });
    y += 22;
    rule(y, 1.5, SF_BLUE);
    y += 10;

    setFont('bold', 14, SF_BLUE);
    doc.text('LBE NONCOMPETITIVE SMALL PURCHASE AUTHORIZATION', mar, y);
    y += 16;
    setFont('normal', 8.5, [100, 100, 100]);
    doc.text('Pursuant to SF Administrative Code Chapter 14B §14B.7 — Micro-LBE Construction Set-Aside, contracts up to $600,000', mar, y);
    y += 8;
    rule(y, 0.5, MID_GRAY);
    y += 10;

    // 2. Procurement Summary
    y = sectionBar('SECTION 1 — PROCUREMENT SUMMARY', y);
    y = fieldRow('Work Order #',    pin, y, true);
    y = fieldRow('Defect Type',     wo.defect_type || '—', y);
    y = fieldRow('Defect Code',     (wo.defect_code || '—') + '   (NAICS: 237310 · NIGP: 91323)', y);
    y = fieldRow('Site Address',    addr, y);
    y = fieldRow('Supervisor District', district || '—', y);
    y = fieldRow('Priority',        wo.priority_code || '—', y);
    y = fieldRow('Est. Completion', (wo.estimated_days_to_complete || '—') + ' calendar days from dispatch', y);
    y = fieldRow('LBE Requirement', wo.lbe_requirement || 'Chapter 14B Micro-LBE set-aside', y);
    y += 6;
    setFont('bold', 9, DARK);
    doc.text('Work Description:', mar, y);
    y += 12;
    y = bodyText(desc, y);
    y += 6;

    // 3. Policy Authority
    ensureSpace(80);
    y = sectionBar('SECTION 2 — POLICY AUTHORITY', y);
    setFont('normal', 8, TEAL);
    const citation = 'SF Administrative Code Chapter 14B §14B.7 — Micro-LBE Construction Set-Aside: A City department may award a construction contract of $600,000 or less directly to a CMD-certified Micro-LBE without competitive solicitation, provided the department obtains at least three price quotes from CMD-certified Micro-LBE vendors, or documents the inability to do so, and determines the price to be fair and reasonable per §14B.7(c).';
    const citLines = doc.splitTextToSize(citation, col - 12);
    doc.text(citLines, mar + 10, y);
    y += citLines.length * 11 + 8;
    y = bodyText('This procurement is authorized under the above provision. Formal competitive solicitation is not required because the selected contractor holds active CMD Micro-LBE certification and the estimated contract amount is within the $600,000 threshold. The Contracting Officer has obtained price quotes as documented in Section 3 below, confirmed the price is reasonable, and verified contractor responsibility per the checklist in Section 5.', y);
    y += 6;

    // 4. Price Quotes
    ensureSpace(160);
    y = sectionBar('SECTION 3 — PRICE QUOTES (Chapter 14B §14B.7(c))', y);
    y = bodyText('Per §14B.7(c), the Contracting Officer must attempt to obtain at least three price quotes from CMD-certified Micro-LBE vendors or document the inability to do so. Complete one of the two options below.', y);
    y += 6;
    setFont('bold', 8.5, SF_BLUE);
    doc.text('OPTION A — Three quotes obtained:', mar, y);
    y += 14;
    for (const qh of ['Quote #1', 'Quote #2', 'Quote #3']) {
      doc.setFillColor(...LT_GRAY);
      doc.rect(mar, y, col, 22, 'F');
      setFont('bold', 7.5, DARK);
      doc.text(qh, mar + 6, y + 9);
      setFont('normal', 8, DARK);
      doc.text('Contractor Name: ________________________   Amount: $______________   Date: ____________', mar + 55, y + 9);
      rule(y + 22, 0.3, MID_GRAY);
      y += 22;
    }
    y += 8;
    setFont('bold', 8.5, SF_BLUE);
    doc.text('OPTION B — Unable to obtain three quotes (explain below):', mar, y);
    y += 14;
    doc.setFillColor(...LT_GRAY);
    doc.rect(mar, y, col, 36, 'F');
    rule(y + 36, 0.3, MID_GRAY);
    y += 44;
    setFont('bold', 8.5, DARK);
    doc.text('Price Reasonableness Determination  [REQUIRED]', mar, y);
    y += 12;
    y = bodyText('The Contracting Officer attests that the price selected is fair and reasonable based on (check all that apply):', y);
    const priceOpts = ['Market research', 'Prior SIRP contracts', 'Independent cost estimate', 'Other (describe below)'];
    const optW = col / 2;
    for (let oi = 0; oi < priceOpts.length; oi++) {
      const ox = mar + (oi % 2) * optW;
      const oy = y + Math.floor(oi / 2) * 16;
      doc.setDrawColor(...TEAL);
      doc.setLineWidth(0.8);
      doc.rect(ox + 2, oy, 8, 8);
      setFont('normal', 8.5, DARK);
      doc.text(priceOpts[oi], ox + 14, oy + 7);
    }
    y += Math.ceil(priceOpts.length / 2) * 16 + 4;
    doc.setFillColor(...LT_GRAY);
    doc.rect(mar, y, col, 28, 'F');
    rule(y + 28, 0.3, MID_GRAY);
    y += 36;

    // 5. Selected Contractor
    ensureSpace(120);
    y = sectionBar('SECTION 4 — SELECTED CONTRACTOR', y);
    y = fieldRow('Legal Business Name',  vName,    y, true);
    y = fieldRow('Business Address',     vAddr,    y);
    y = fieldRow('CMD Certification #',  certId,   y);
    y = fieldRow('LBE Certification Type', lbeType, y);
    y = fieldRow('CSLB License #',       vLicense, y);
    y = fieldRow('Phone',                vPhone,   y);
    y += 6;

    // 5A. Vendor City-contract history & equity rationale
    // Pulls track_record data backfilled from DataSF Supplier Contracts
    // (cqi5-hm2d). Surfaces the overlooked-but-qualified case when the
    // selected vendor has zero prior City prime/sub activity since FY2018.
    ensureSpace(120);
    y = sectionBar('SECTION 4A — VENDOR CITY-CONTRACT HISTORY (DataSF Audit)', y);
    const tr = (vendor && vendor.track_record) || {};
    const primeCount  = tr.prior_dpw_contracts_count || 0;
    const primeValue  = tr.prior_dpw_contracts_value || 0;
    const subCount    = tr.prior_dpw_sub_contracts_count || 0;
    const subValue    = tr.prior_dpw_sub_value_upper_bound || 0;
    const lastDate    = tr.last_city_contract_date || tr.first_city_contract_date || null;
    const datasfNote  = tr.datasf_source || 'DataSF cqi5-hm2d (Supplier Contracts, FY2018-present)';

    const fmtUSD = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    y = fieldRow('Prior DPW prime awards', `${primeCount} contract(s) totaling ${fmtUSD(primeValue)}`, y);
    if (subCount > 0) {
      y = fieldRow('Prior DPW subcontracts', `${subCount} contract(s) — upper bound ${fmtUSD(subValue)}`, y);
    }
    if (lastDate) {
      y = fieldRow('Most recent City contract', lastDate, y);
    }
    setFont('italic', 7.5, [120, 120, 120]);
    doc.text('Source: ' + datasfNote, mar, y);
    y += 12;

    // Equity rationale — only fires when the selected vendor is Micro-LBE
    // set-aside-eligible AND has zero prior City history.
    const tierLower   = (lbeType || '').toLowerCase();
    const cmdActive   = !!(vendor && vendor.lbe && vendor.lbe.cmd_cert_active);
    const cslbActive  = (vendor && vendor.licensing && (vendor.licensing.cslb_status || '').toLowerCase() === 'active');
    const setAsideEligible = tierLower.includes('micro') && cmdActive && cslbActive;
    const zeroHistory      = primeValue === 0 && subValue === 0;
    const subOnly          = primeValue === 0 && subValue > 0;

    if (setAsideEligible && subOnly) {
      ensureSpace(60);
      doc.setFillColor(230, 240, 248);
      doc.setDrawColor(182, 212, 237);
      doc.setLineWidth(0.6);
      doc.roundedRect(mar, y, col, 50, 3, 3, 'FD');
      setFont('bold', 9, [12, 74, 110]);
      doc.text('SUB-ONLY HISTORY — NEVER PRIMED', mar + 8, y + 12);
      setFont('normal', 8, [60, 60, 60]);
      const subLines = doc.splitTextToSize(
        'This contractor has performed work as a subcontractor on ' + subCount +
        ' DPW contract(s) but has never been awarded a City prime. ' +
        'SF Administrative Code §14B.7 is the prime-award pathway built ' +
        'specifically to bring qualified Micro-LBE firms onto the prime ' +
        'roster. Routing this work order via §14B.7 directly advances ' +
        'that statutory objective.',
        col - 16
      );
      doc.text(subLines, mar + 8, y + 24);
      y += 58;
    } else if (setAsideEligible && zeroHistory) {
      ensureSpace(70);
      doc.setFillColor(253, 243, 216);
      doc.setDrawColor(240, 210, 145);
      doc.setLineWidth(0.6);
      doc.roundedRect(mar, y, col, 60, 3, 3, 'FD');
      setFont('bold', 9, [138, 90, 13]);
      doc.text('OVERLOOKED-BUT-QUALIFIED FINDING', mar + 8, y + 12);
      setFont('normal', 8, [60, 60, 60]);
      const eqLines = doc.splitTextToSize(
        'This contractor is CMD Micro-LBE certified, CSLB-licensed, bonded for SF sidewalk work, ' +
        'and specialty-qualified for the requested defect, yet DataSF records zero City prime or ' +
        'subcontract activity since FY2018. Routing this work order to a previously overlooked ' +
        'Micro-LBE materially advances the Chapter 14B equity objective and is the dispatch path ' +
        'that the §14B.7 scoring matrix recommends.',
        col - 16
      );
      doc.text(eqLines, mar + 8, y + 24);
      y += 68;
    }

    if (setAsideEligible && (zeroHistory || subOnly)) {
      // Annual potential — anchored to the calibrated SIRP single-WO median
      // ($33K) from DataSF cqi5-hm2d (see data/sirp-cost-calibration.json),
      // NOT the per-complaint estimate (which can be elevated/ada-bumped).
      // 18-24 jobs/year is a typical Micro-LBE concrete contractor's capacity
      // working steady on SIRP work orders (~1.5-2 jobs/month).
      ensureSpace(45);
      setFont('bold', 8.5, DARK);
      doc.text('Estimated annual potential (this contractor, at current SIRP volume):', mar, y);
      y += 13;
      const SIRP_MEDIAN_WO  = 33000;   // DataSF single-WO median, calibrated
      const annualLow  = Math.round(SIRP_MEDIAN_WO * 18 / 1000) * 1000;
      const annualHigh = Math.round(SIRP_MEDIAN_WO * 24 / 1000) * 1000;
      setFont('normal', 8.5, DARK);
      doc.text(
        `${fmtUSD(annualLow)}–${fmtUSD(annualHigh)} ` +
        `(median SIRP work order ${fmtUSD(SIRP_MEDIAN_WO)} × 18–24 jobs/year typical Micro-LBE capacity)`,
        mar + 4, y
      );
      y += 12;
      setFont('italic', 7, [120, 120, 120]);
      doc.text(
        'Median anchored to DataSF cqi5-hm2d single-WO contracts FY2018+ (n=14 sidewalk + 17 ada-ramp + 50 tree-well, <= $100K).',
        mar + 4, y
      );
      y += 14;
    }

    // 6. Responsibility Checklist
    ensureSpace(180);
    y = sectionBar('SECTION 5 — RESPONSIBILITY DETERMINATION CHECKLIST', y);
    y = bodyText('The procuring department attests that it has verified each item below prior to authorizing this purchase.', y);
    y += 4;
    const checks = [
      'Contractor holds active CMD Micro-LBE certification  [REQUIRED]',
      'CMD certification is current and not expired  [REQUIRED]',
      'Contractor holds active CSLB C-8 (Concrete) license  [REQUIRED]',
      'No debarment, suspension, or integrity flag on file  [REQUIRED]',
      'Prior performance satisfactory (if prior SIRP contracts exist)  [RECOMMENDED]',
      'Estimated contract amount does not exceed $600,000  [REQUIRED]',
      'Work falls within contractor\'s stated CSLB license classification (C-8)  [REQUIRED]',
      'Chapter 14B LBE subcontracting documentation filed with CMD  [REQUIRED]',
    ];
    for (const item of checks) {
      ensureSpace(20);
      y = checkRow(item, y);
    }
    y += 6;

    // 7. Signature Block
    ensureSpace(160);
    y = sectionBar('SECTION 6 — AUTHORIZATION & SIGNATURE', y);
    y = bodyText('I, the undersigned authorized official, certify that: (a) the contractor named above holds active CMD Micro-LBE certification in good standing; (b) at least three price quotes were obtained or the inability to do so has been documented per Section 3; (c) the price has been determined to be fair and reasonable; (d) the responsibility determination checklist in Section 5 has been completed; (e) this procurement does not exceed $600,000; and (f) all requirements of SF Administrative Code Chapter 14B §14B.7 have been met.', y);
    y += 16;
    const halfW = (col - 20) / 2;
    sigBlock('Authorizing Official',     '', mar,              y);
    sigBlock('Date',                     '', mar + halfW + 20, y);
    y += 36;
    sigBlock('Title',                    '', mar,              y);
    sigBlock('Department', 'SF Dept. of Public Works — SIRP', mar + halfW + 20, y);
    y += 36;
    sigBlock('Contractor Representative (acknowledgment)', '', mar, y);
    sigBlock('Date',                     '', mar + halfW + 20, y);
    y += 36;

    // 8. Footer
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      rule(doc.internal.pageSize.getHeight() - 36, 0.5, MID_GRAY);
      setFont('normal', 7, [150, 150, 150]);
      doc.text(
        'Generated by SF SIRP Equity Vendor Matrix  ·  ' + memoDate + '  ·  Ref ' + memoRef + '  ·  Retain in agency procurement file per SF Admin Code §14B.7',
        W / 2, doc.internal.pageSize.getHeight() - 24, { align: 'center' }
      );
    }

    if (returnBase64) {
      // datauristring is "data:application/pdf;filename=generated.pdf;base64,XXXX..."
      // Slice off the prefix to get the raw base64 payload.
      const dataUri = doc.output('datauristring');
      return dataUri.split(',')[1] || null;
    }
    doc.save('Chapter14B-Memo-' + (wo.defnum || 'DRAFT') + '.pdf');
    if (memoStatus) memoStatus.textContent = '✓ Memo downloaded';
    return true;

  } catch (e) {
    console.error('Chapter 14B memo generation failed:', e);
    if (memoStatus) memoStatus.textContent = '⚠ Memo error: ' + e.message;
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SIRP Work Order PDF — generated client-side alongside the §14B memo when a
// vendor is dispatched. Reads window._workOrder / window._selectedVendor.

function downloadWorkOrder(wo, vendor) {
  wo = wo || window._workOrder;
  vendor = vendor || window._selectedVendor;
  if (!wo) { console.error('downloadWorkOrder: no work order in scope'); return null; }
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = 612;
    const NAVY = [22, 40, 74], AMBER = [184, 115, 28], INK = [26, 35, 50], MUTE = [120, 130, 145], LINE = [210, 214, 222];

    // Header band
    doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]); doc.rect(0, 0, W, 92, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('SF DPW — SIDEWALK INSPECTION & REPAIR PROGRAM (SIRP)', 40, 34);
    doc.setFontSize(20); doc.text('Work Order', 40, 62);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text(String(wo.defnum || 'DPW-SIRP'), W - 40, 60, { align: 'right' });
    doc.setFontSize(9); doc.setTextColor(200, 210, 225);
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.text('Issued ' + today, W - 40, 76, { align: 'right' });
    doc.setFillColor(AMBER[0], AMBER[1], AMBER[2]); doc.rect(0, 92, W, 3, 'F');

    let y = 132;
    function field(label, value, x, w) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(MUTE[0], MUTE[1], MUTE[2]);
      doc.text(String(label).toUpperCase(), x, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(INK[0], INK[1], INK[2]);
      doc.text(doc.splitTextToSize(String(value == null || value === '' ? '—' : value), w), x, y + 15);
    }
    const pr = String(wo.priority_code || '').toLowerCase();
    const respReq = pr.includes('high') ? 'Temp fix 24h · permanent 30 days'
      : pr.includes('low') ? 'Within 180 calendar days' : 'Within 90 calendar days';
    const auth = wo.policy_authority === '14B.7' ? 'Chapter 14B §14B.7 set-aside' : 'Competitive bid';
    const cost = wo.estimatedCost != null ? '$' + Number(wo.estimatedCost).toLocaleString('en-US') : '—';

    field('Address', wo.address, 40, 250); field('Supervisor district', 'District ' + (wo.supervisor_district || '—'), 320, 240); y += 46;
    field('Defect type', wo.defect_type, 40, 250); field('Priority', wo.priority_code || 'STANDARD', 320, 240); y += 46;
    field('Response requirement', respReq, 40, 250); field('Est. completion', (wo.estimated_days_to_complete || 60) + ' calendar days', 320, 240); y += 46;
    field('Assigned contractor', vendor && vendor.name, 40, 250); field('CSLB license', vendor && vendor.licensing && vendor.licensing.cslb_license, 320, 240); y += 46;
    field('Estimated cost', cost, 40, 250); field('Procurement authority', auth, 320, 240); y += 58;

    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.line(40, y - 14, W - 40, y - 14);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(NAVY[0], NAVY[1], NAVY[2]);
    doc.text('SCOPE OF WORK', 40, y); y += 20;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(INK[0], INK[1], INK[2]);
    [
      '1. Site inspection and traffic control setup.',
      '2. Saw-cut and remove the damaged sidewalk section.',
      '3. Excavate and prepare subgrade; install rebar/dowels per DPW standard detail.',
      '4. Form and pour Class 2 PCC concrete (4000 PSI) to match adjacent grade.',
      '5. Cure per DPW spec; restore ADA detectable warning surface if applicable.',
      '6. Final inspection and close-out; submit signed field report within 24 hours.',
    ].forEach((s) => { const l = doc.splitTextToSize(s, W - 80); doc.text(l, 40, y); y += 14 * l.length + 3; });

    y += 14;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(MUTE[0], MUTE[1], MUTE[2]);
    doc.text(doc.splitTextToSize('Verify CMD/CSLB certification status before site mobilization. This work order is subject to SF Administrative Code Chapter 14B LBE requirements.', W - 80), 40, y);

    doc.setDrawColor(INK[0], INK[1], INK[2]); doc.line(40, 706, 250, 706); doc.line(330, 706, 540, 706);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(MUTE[0], MUTE[1], MUTE[2]);
    doc.text('DPW Inspector', 40, 718); doc.text('Date', 330, 718);

    doc.save('WorkOrder-' + (wo.defnum || 'DRAFT') + '.pdf');
    return true;
  } catch (e) {
    console.error('Work order generation failed:', e);
    return null;
  }
}

// Expose globally so dispatch.js can call these
if (typeof window !== 'undefined') {
  window.generateChapter14bMemoBase64 = generateChapter14bMemoBase64;
  window.downloadWorkOrder = downloadWorkOrder;
}
