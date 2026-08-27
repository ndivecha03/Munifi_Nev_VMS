/* NYC Street Lights — hand-rolled SVG chart primitives
   Every chart is one function: render(el, data, opts) → injects SVG into `el`.
   Zero dependencies. Brand-palette pinned. Responsive via viewBox.

   Public API:
     Charts.kpiTile(el, {label, value, delta, deltaTone})
     Charts.barChart(el, {bars:[{label, value, color?, highlight?}], unit?, max?})
     Charts.donut(el, {slices:[{label, value, color?}], centerLabel?, centerValue?})
     Charts.sparkline(el, {series:[{name, color, points:[{x,y}]}], yMax?, xLabels?})
     Charts.gauge(el, {value, max, label, color?})
     Charts.histogram(el, {bins:[{label, count}], highlightIdx?, color?})
     Charts.choropleth(el, {boroughs:{Manhattan:n, Brooklyn:n, ...}, format?})
     Charts.rankStrip(el, {items:[{label, value}], highlightIdx, format?})
     Charts.forecastBand(el, {expectedDate, lowDate, highDate, todayDate?})
*/

(function(global){
  const PALETTE = {
    teal:      '#00b4d8',
    tealDeep:  '#0077b6',
    tealLight: '#48bfe3',
    tealSoft:  '#e6f7fb',
    green:     '#2ec4b6',
    amber:     '#ffb703',
    red:       '#e63946',
    coral:     '#ff6b76',
    sky:       '#8ab4f8',
    ink:       '#0a1f3d',
    inkSoft:   '#3a4a63',
    inkMute:   '#6b7a8f',
    line:      '#e6e3da',
    bg:        '#fafaf7',
  };
  const FONT = "Inter, system-ui, sans-serif";

  // ── helpers ──────────────────────────────────────────────────────
  function svg(w, h, attrs){
    attrs = attrs || {};
    const a = Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" ${a}>`;
  }
  function text(x,y,str,opts){
    opts = opts || {};
    const size = opts.size || 12;
    const weight = opts.weight || 500;
    const color = opts.color || PALETTE.inkSoft;
    const anchor = opts.anchor || 'start';
    const baseline = opts.baseline || 'middle';
    return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" dominant-baseline="${baseline}">${str}</text>`;
  }
  function fmtInt(n){ return Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n, dp){ dp = dp==null?0:dp; return n.toFixed(dp)+'%'; }

  // ── 1. KPI tile (not technically a chart, but lives here for consistency)
  function kpiTile(el, d){
    const tone = d.deltaTone || '';
    el.innerHTML = `
      <div class="lbl">${d.label||''}</div>
      <div class="val${(d.value+'').length>6?' small':''}">${d.value||''}</div>
      <div class="delta ${tone}">${d.delta||''}</div>`;
  }

  // ── 2. Bar chart (vertical bars with value labels)
  function barChart(el, d){
    const bars = d.bars || [];
    if(!bars.length){ el.innerHTML = empty('No data'); return; }
    const W=400, H=240, padL=40, padR=20, padT=24, padB=44;
    const max = d.max || Math.max(...bars.map(b=>b.value)) * 1.15;
    const bw = (W - padL - padR) / bars.length * 0.65;
    const gap = (W - padL - padR) / bars.length * 0.35;
    let s = svg(W,H);
    // y-axis baseline
    s += `<line x1="${padL}" y1="${H-padB}" x2="${W-padR}" y2="${H-padB}" stroke="${PALETTE.line}" stroke-width="1"/>`;
    // bars
    bars.forEach((b,i)=>{
      const x = padL + i*((W-padL-padR)/bars.length) + gap/2;
      const h = ((b.value/max) * (H-padT-padB));
      const y = H - padB - h;
      const color = b.color || (b.highlight ? PALETTE.teal : PALETTE.tealLight);
      s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${color}" rx="3"/>`;
      // value label above bar
      s += text(x + bw/2, y - 8, fmtInt(b.value), {size:12, weight:700, color:PALETTE.ink, anchor:'middle', baseline:'auto'});
      // x-label
      s += text(x + bw/2, H-padB+18, b.label, {size:11, color:PALETTE.inkMute, anchor:'middle'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 3. Donut chart
  function donut(el, d){
    const slices = d.slices || [];
    if(!slices.length){ el.innerHTML = empty('No data'); return; }
    const total = slices.reduce((a,s)=>a+s.value,0);
    const W=240, H=240, cx=W/2, cy=H/2, r=90, ir=58;
    const colors = [PALETTE.teal, PALETTE.green, PALETTE.amber, PALETTE.coral, PALETTE.sky, PALETTE.tealDeep];
    let s = svg(W,H);
    let acc = -Math.PI/2;
    slices.forEach((sl,i)=>{
      const frac = sl.value/total;
      const a0 = acc, a1 = acc + frac*Math.PI*2;
      acc = a1;
      const large = frac>0.5 ? 1 : 0;
      const x0=cx+r*Math.cos(a0), y0=cy+r*Math.sin(a0);
      const x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1);
      const xi0=cx+ir*Math.cos(a1), yi0=cy+ir*Math.sin(a1);
      const xi1=cx+ir*Math.cos(a0), yi1=cy+ir*Math.sin(a0);
      const color = sl.color || colors[i%colors.length];
      const path = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${ir} ${ir} 0 ${large} 0 ${xi1} ${yi1} Z`;
      s += `<path d="${path}" fill="${color}"/>`;
    });
    // center labels
    if(d.centerValue){
      s += text(cx, cy-6, d.centerValue, {size:24, weight:700, color:PALETTE.ink, anchor:'middle'});
    }
    if(d.centerLabel){
      s += text(cx, cy+18, d.centerLabel, {size:11, color:PALETTE.inkMute, anchor:'middle'});
    }
    s += '</svg>';
    // legend
    const legend = slices.map((sl,i)=>{
      const color = sl.color || colors[i%colors.length];
      const pct = ((sl.value/total)*100).toFixed(0);
      return `<span><span class="swatch" style="background:${color}"></span>${sl.label} · ${pct}%</span>`;
    }).join('');
    el.innerHTML = s + `<div class="legend">${legend}</div>`;
  }

  // ── 4. Sparkline (multi-series line)
  function sparkline(el, d){
    const series = d.series || [];
    if(!series.length || !series[0].points.length){ el.innerHTML = empty('No data'); return; }
    const W=400, H=200, padL=36, padR=12, padT=16, padB=32;
    const allY = series.flatMap(s=>s.points.map(p=>p.y));
    const yMax = d.yMax || Math.max(...allY) * 1.15;
    const yMin = 0;
    const xs = series[0].points.map(p=>p.x);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const sx = x => padL + ((x-xMin)/(xMax-xMin||1)) * (W-padL-padR);
    const sy = y => H - padB - ((y-yMin)/(yMax-yMin||1)) * (H-padT-padB);
    let s = svg(W,H);
    // y-grid (3 lines)
    for(let i=0;i<=3;i++){
      const y = padT + i*((H-padT-padB)/3);
      const v = yMax - i*(yMax/3);
      s += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="${PALETTE.line}" stroke-width="1" stroke-dasharray="2 4"/>`;
      s += text(padL-6, y, fmtInt(v), {size:10, color:PALETTE.inkMute, anchor:'end'});
    }
    // x-labels (if provided)
    if(d.xLabels){
      // When labelAllPoints is set, show ALL x-labels (no down-sampling)
      const showAll = d.labelAllPoints || d.xLabels.length <= 8;
      d.xLabels.forEach((lbl,i)=>{
        if(!showAll && i%Math.ceil(d.xLabels.length/6)!==0 && i!==d.xLabels.length-1) return;
        const x = sx(xs[i]);
        s += text(x, H-padB+14, lbl, {size:10, color:PALETTE.inkMute, anchor:'middle'});
      });
    }
    series.forEach((ser,si)=>{
      const color = ser.color || [PALETTE.teal, PALETTE.amber, PALETTE.green][si%3];
      const path = ser.points.map((p,i)=>(i?'L':'M')+sx(p.x)+' '+sy(p.y)).join(' ');
      s += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      // When labelAllPoints is set, render a dot + value at every point
      // (with smart positioning to keep labels above/below to avoid overlap).
      if(d.labelAllPoints){
        const lastIdx = ser.points.length - 1;
        ser.points.forEach((p, i) => {
          const cx = sx(p.x), cy = sy(p.y);
          s += `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/>`;
          // Label sits above the line (or below near the top edge to avoid clipping)
          const labelY = (cy - padT < 24) ? cy + 18 : cy - 10;
          // Anchor first/last labels inward so they don't overlap the y-axis numbers
          const anchor = i === 0 ? 'start' : i === lastIdx ? 'end' : 'middle';
          const labelX = i === 0 ? cx + 6 : i === lastIdx ? cx - 6 : cx;
          s += text(labelX, labelY, fmtInt(p.y), {
            size: 11, weight: 700, color: PALETTE.ink, anchor, baseline: 'auto'
          });
        });
      } else {
        // Default: dot only on the last point
        const last = ser.points[ser.points.length-1];
        s += `<circle cx="${sx(last.x)}" cy="${sy(last.y)}" r="4" fill="${color}"/>`;
      }
    });
    s += '</svg>';
    const legend = series.map((ser,si)=>{
      const color = ser.color || [PALETTE.teal, PALETTE.amber, PALETTE.green][si%3];
      return `<span><span class="swatch" style="background:${color}"></span>${ser.name}</span>`;
    }).join('');
    el.innerHTML = s + `<div class="legend">${legend}</div>`;
  }

  // ── 5. Gauge (semicircle with %)
  function gauge(el, d){
    const v = Math.max(0, Math.min(d.value, d.max));
    const frac = v/d.max;
    const W=200, H=130, cx=W/2, cy=104, r=72, sw=12;
    const a = -Math.PI + frac*Math.PI;
    const x0 = cx - r, y0 = cy;
    const x1 = cx + r*Math.cos(a), y1 = cy + r*Math.sin(a);
    const xe = cx + r, ye = cy;
    const color = d.color || (frac>=0.75 ? PALETTE.green : frac>=0.5 ? PALETTE.amber : PALETTE.red);
    let s = svg(W,H);
    // background arc — butt caps, half-circle
    s += `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xe} ${ye}" fill="none" stroke="${PALETTE.line}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    // foreground arc — large flag pinned to 0 (always ≤180°), butt caps
    if(frac > 0.001){
      s += `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    }
    // value
    s += text(cx, cy-14, fmtPct((v/d.max)*100, 0), {size:26, weight:700, color:PALETTE.ink, anchor:'middle'});
    s += text(cx, cy+8, d.label||'', {size:11, color:PALETTE.inkMute, anchor:'middle'});
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 5b. Percentile bar (horizontal benchmark, 0-100)
  // Used for "vs other NYC zips" and similar comparisons.
  function percentileBar(el, d){
    const W=240, H=72, padL=4, padR=4, padT=18, padB=18;
    const v = Math.max(0, Math.min(d.value, 100));
    const trackY = H/2 - 4;
    const trackH = 8;
    const trackW = W - padL - padR;
    const markerX = padL + (v/100) * trackW;
    let s = svg(W,H);
    // track
    s += `<rect x="${padL}" y="${trackY}" width="${trackW}" height="${trackH}" rx="4" fill="${PALETTE.line}"/>`;
    // filled portion (shows percentile fill from left)
    s += `<rect x="${padL}" y="${trackY}" width="${markerX-padL}" height="${trackH}" rx="4" fill="${PALETTE.teal}"/>`;
    // marker
    s += `<circle cx="${markerX}" cy="${trackY+trackH/2}" r="8" fill="${PALETTE.ink}" stroke="#fff" stroke-width="2"/>`;
    // tick labels
    s += text(padL, trackY+trackH+14, '0', {size:10, color:PALETTE.inkMute, anchor:'start'});
    s += text(W-padR, trackY+trackH+14, '100', {size:10, color:PALETTE.inkMute, anchor:'end'});
    s += text(markerX, trackY-8, v.toFixed(0), {size:11, weight:700, color:PALETTE.ink, anchor:'middle', baseline:'auto'});
    s += '</svg>';
    el.innerHTML = `<div style="font-size:13px;font-weight:600;color:${PALETTE.ink};margin-bottom:2px">${d.headline||''}</div>${s}<div style="font-size:11px;color:${PALETTE.inkMute};margin-top:-6px">${d.sub||''}</div>`;
  }

  // ── 6. Histogram (distribution with optional highlighted bin)
  function histogram(el, d){
    const bins = d.bins || [];
    if(!bins.length){ el.innerHTML = empty('No data'); return; }
    const W=400, H=200, padL=32, padR=12, padT=16, padB=36;
    const max = Math.max(...bins.map(b=>b.count));
    const bw = (W-padL-padR)/bins.length;
    let s = svg(W,H);
    s += `<line x1="${padL}" y1="${H-padB}" x2="${W-padR}" y2="${H-padB}" stroke="${PALETTE.line}" stroke-width="1"/>`;
    bins.forEach((b,i)=>{
      const x = padL + i*bw + 1;
      const h = (b.count/max) * (H-padT-padB);
      const y = H - padB - h;
      const w = bw - 2;
      const isHi = i===d.highlightIdx;
      const color = isHi ? PALETTE.red : (d.color || PALETTE.teal);
      s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" rx="2" opacity="${isHi?1:0.85}"/>`;
      if(i%Math.ceil(bins.length/6)===0 || i===bins.length-1){
        s += text(x+w/2, H-padB+14, b.label, {size:10, color:PALETTE.inkMute, anchor:'middle'});
      }
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 7. Choropleth (5-borough simplified SVG)
  // Hand-drawn schematic shapes — not geographic, but recognizable.
  function choropleth(el, d){
    const boroughs = d.boroughs || {};
    const fmt = d.format || (v => fmtPct(v,0));
    const values = Object.values(boroughs);
    const min = Math.min(...values), max = Math.max(...values);
    function color(v){
      const t = (v-min)/(max-min||1);
      // teal soft → teal deep gradient based on closure rate
      const hi = [0,119,182], lo = [230,247,251];
      const c = lo.map((cc,i)=>Math.round(cc + (hi[i]-cc)*t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    // schematic borough shapes (rounded rectangles, positioned to vaguely match NYC)
    const shapes = {
      'Bronx':       {x:230, y:30,  w:150, h:90,  label:'Bronx'},
      'Manhattan':   {x:170, y:90,  w:60,  h:160, label:'Manh.'},
      'Queens':      {x:280, y:130, w:170, h:120, label:'Queens'},
      'Brooklyn':    {x:200, y:240, w:170, h:90,  label:'Brooklyn'},
      'Staten Island':{x:60, y:260, w:120, h:80,  label:'SI'},
    };
    const W=480, H=360;
    let s = svg(W,H);
    Object.entries(shapes).forEach(([name,sh])=>{
      const v = boroughs[name];
      const fill = v==null ? PALETTE.line : color(v);
      s += `<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" rx="14" fill="${fill}" stroke="#fff" stroke-width="3"/>`;
      const tc = v!=null && (v-min)/(max-min||1) > 0.55 ? '#fff' : PALETTE.ink;
      s += text(sh.x+sh.w/2, sh.y+sh.h/2-8, sh.label, {size:13, weight:700, color:tc, anchor:'middle'});
      if(v!=null) s += text(sh.x+sh.w/2, sh.y+sh.h/2+12, fmt(v), {size:14, weight:700, color:tc, anchor:'middle'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 8. Rank strip (5 dots/bars, one highlighted)
  function rankStrip(el, d){
    const items = d.items || [];
    const fmt = d.format || (v=>v);
    const W=400, H=140, padL=20, padR=20, padT=40, padB=40;
    const sorted = [...items].sort((a,b)=>b.value-a.value);
    const max = sorted[0].value, min = sorted[sorted.length-1].value;
    const step = (W-padL-padR)/(items.length-1||1);
    let s = svg(W,H);
    // axis line
    s += `<line x1="${padL}" y1="${H/2}" x2="${W-padR}" y2="${H/2}" stroke="${PALETTE.line}" stroke-width="2"/>`;
    items.forEach((it,i)=>{
      const x = padL + i*step;
      const isHi = i === d.highlightIdx;
      const r = isHi ? 12 : 7;
      const fill = isHi ? PALETTE.red : PALETTE.teal;
      s += `<circle cx="${x}" cy="${H/2}" r="${r}" fill="${fill}"/>`;
      s += text(x, H/2 - r - 8, fmt(it.value), {size:isHi?13:11, weight:700, color:PALETTE.ink, anchor:'middle', baseline:'auto'});
      s += text(x, H/2 + r + 16, it.label, {size:11, weight:isHi?700:500, color:isHi?PALETTE.ink:PALETTE.inkMute, anchor:'middle'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 9. Forecast band (date with confidence interval)
  function forecastBand(el, d){
    const W=400, H=200, padL=20, padR=20, padT=40, padB=60;
    const today = new Date(d.todayDate || Date.now());
    const lo = new Date(d.lowDate);
    const hi = new Date(d.highDate);
    const exp = new Date(d.expectedDate);
    const startMs = today.getTime();
    const endMs = hi.getTime() + (hi.getTime()-lo.getTime())*0.2; // padding
    const sx = ms => padL + ((ms-startMs)/(endMs-startMs||1)) * (W-padL-padR);
    let s = svg(W,H);
    // axis
    s += `<line x1="${padL}" y1="${H/2}" x2="${W-padR}" y2="${H/2}" stroke="${PALETTE.line}" stroke-width="2"/>`;
    // confidence band
    s += `<rect x="${sx(lo.getTime())}" y="${H/2-22}" width="${sx(hi.getTime())-sx(lo.getTime())}" height="44" fill="${PALETTE.tealSoft}" rx="8"/>`;
    // expected marker
    const ex = sx(exp.getTime());
    s += `<line x1="${ex}" y1="${H/2-26}" x2="${ex}" y2="${H/2+26}" stroke="${PALETTE.tealDeep}" stroke-width="3"/>`;
    s += `<circle cx="${ex}" cy="${H/2}" r="7" fill="${PALETTE.tealDeep}"/>`;
    // today marker
    const tx = sx(today.getTime());
    s += `<circle cx="${tx}" cy="${H/2}" r="5" fill="${PALETTE.ink}"/>`;
    // labels
    const fmtDate = dt => dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    s += text(tx, H/2+30, 'today', {size:11, color:PALETTE.inkMute, anchor:'middle', baseline:'auto'});
    s += text(tx, H/2+44, fmtDate(today), {size:10, color:PALETTE.inkMute, anchor:'middle', baseline:'auto'});
    s += text(ex, H/2-32, fmtDate(exp), {size:14, weight:700, color:PALETTE.ink, anchor:'middle', baseline:'auto'});
    s += text(ex, H/2-50, 'expected close', {size:10, color:PALETTE.tealDeep, weight:600, anchor:'middle', baseline:'auto'});
    s += text(sx(lo.getTime()), H/2+44, fmtDate(lo), {size:10, color:PALETTE.inkMute, anchor:'middle', baseline:'auto'});
    s += text(sx(hi.getTime()), H/2+44, fmtDate(hi), {size:10, color:PALETTE.inkMute, anchor:'middle', baseline:'auto'});
    s += '</svg>';
    el.innerHTML = s;
  }

  function empty(msg){
    return `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:${PALETTE.inkMute};font-size:13px">${msg}</div>`;
  }

  // ── 10. Horizontal bar chart (better for ranked lists like boroughs)
  function hBarChart(el, d){
    const bars = d.bars || [];
    if(!bars.length){ el.innerHTML = empty('No data'); return; }
    // Dynamically size padL to fit the longest label and grow the canvas
    // when labels are long (so bars don't get crushed).
    const maxLabelLen = Math.max(...bars.map(b => (b.label || '').length));
    const padL = Math.max(120, maxLabelLen * 8.5 + 22);
    const padR=80, padT=20, padB=20;
    const W = Math.max(560, padL + 280);
    const H = Math.max(220, bars.length*48 + 40);
    const max = d.max || Math.max(...bars.map(b=>b.value));
    const rowH = (H - padT - padB) / bars.length;
    const bh = rowH * 0.62;
    let s = svg(W,H);
    bars.forEach((b,i)=>{
      const y = padT + i*rowH + (rowH-bh)/2;
      const w = (b.value/max) * (W - padL - padR);
      const color = b.color || (b.highlight ? PALETTE.red : PALETTE.teal);
      s += `<rect x="${padL}" y="${y}" width="${w}" height="${bh}" fill="${color}" rx="6"/>`;
      s += text(padL-12, y + bh/2, b.label, {size:14, weight:600, color:PALETTE.ink, anchor:'end'});
      const valTxt = d.format ? d.format(b.value) : fmtInt(b.value);
      s += text(padL + w + 8, y + bh/2, valTxt, {size:13, weight:700, color:PALETTE.ink, anchor:'start'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 11. Revenue range — horizontal stacked bars showing low→high revenue
  // Accepts {onDark:true} to flip label/value colors for use inside a
  // dark-navy panel (e.g. the Why section).
  function revenueRange(el, d){
    const items = d.items || [];
    if(!items.length){ el.innerHTML = empty('No data'); return; }
    const W=720, H=Math.max(260, items.length*56 + 40);
    const padL=140, padR=170, padT=24, padB=24;
    const max = Math.max(...items.map(it=>it.high));
    const rowH = (H - padT - padB) / items.length;
    const bh = rowH * 0.55;
    const onDark = !!d.onDark;
    const labelColor = onDark ? '#ffffff' : PALETTE.ink;
    const valueColor = onDark ? 'rgba(255,255,255,0.78)' : PALETTE.inkSoft;
    // On dark, give the "low" bar a soft teal tint that still pops; on
    // light, keep the original tealSoft.
    const lowFill = onDark ? 'rgba(0,180,216,0.30)' : PALETTE.tealSoft;
    const midFill = PALETTE.teal;
    let s = svg(W,H);
    items.forEach((it,i)=>{
      const y = padT + i*rowH + (rowH-bh)/2;
      const xMid  = padL + (it.mid /max) * (W - padL - padR);
      const xHigh = padL + (it.high/max) * (W - padL - padR);
      const isTotal = it.label === 'NYC Total';
      // Range bar (low → high) — the light tint
      s += `<rect x="${padL}" y="${y}" width="${xHigh-padL}" height="${bh}" fill="${isTotal?PALETTE.tealDeep:lowFill}" rx="6"/>`;
      // Mid marker (most likely value)
      s += `<rect x="${padL}" y="${y}" width="${xMid-padL}" height="${bh}" fill="${isTotal?PALETTE.ink:midFill}" rx="6"/>`;
      // Borough label
      s += text(padL-12, y + bh/2, it.label, {size:isTotal?16:14, weight:isTotal?800:700, color:labelColor, anchor:'end'});
      // Range value to the right
      const fmt = v => '$'+(v/1e6).toFixed(2)+'M';
      s += text(xHigh + 8, y + bh/2, `${fmt(it.low)} – ${fmt(it.high)}`, {size:12, weight:600, color:valueColor, anchor:'start'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 15. Time-comparison chart — two stacked bars showing dramatic
  // before/after time compression. Designed for dark backgrounds.
  // Input: {bars:[{label, time, value, color?}], footer?, onDark?}
  function timeComparison(el, d){
    const bars = d.bars || [];
    if(!bars.length){ el.innerHTML = empty('No data'); return; }
    const W = 640, padL = 170, padR = 130, padT = 18, padB = 56;
    const rowH = 64;
    const trackH = 36;
    const H = padT + bars.length * rowH + padB;
    const trackW = W - padL - padR;
    const max = Math.max(...bars.map(b => b.time));
    const onDark = d.onDark !== false;

    const labelColor = onDark ? '#ffffff' : PALETTE.ink;
    const valueColor = onDark ? '#ffffff' : PALETTE.ink;
    const trackColor = onDark ? 'rgba(255,255,255,0.08)' : PALETTE.line;
    const footerColor = onDark ? 'rgba(255,255,255,0.72)' : PALETTE.inkSoft;

    let s = svg(W, H);
    bars.forEach((b, i) => {
      const y = padT + i * rowH;
      const trackY = y + (rowH - trackH) / 2;
      const w = Math.max(2, (b.time / max) * trackW);
      const color = b.color || PALETTE.teal;

      // Track (background lane)
      s += `<rect x="${padL}" y="${trackY}" width="${trackW}" height="${trackH}" rx="${trackH/2}" fill="${trackColor}"/>`;
      // Filled bar
      s += `<rect x="${padL}" y="${trackY}" width="${w}" height="${trackH}" rx="${trackH/2}" fill="${color}"/>`;
      // Left label
      s += text(padL - 14, trackY + trackH/2, b.label, {
        size:14, weight:700, color:labelColor, anchor:'end',
      });
      // Right value (e.g. "~30 min" or "< 60 sec")
      s += text(padL + w + 12, trackY + trackH/2, b.value, {
        size:14, weight:800, color:valueColor, anchor:'start',
      });
    });

    // Footer — aggregate annual savings line
    if(d.footer){
      s += text(W/2, H - 22, d.footer, {
        size:13, weight:600, color:footerColor, anchor:'middle',
      });
    }
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 12. Gauge cluster — multiple gauges in a row with consistent styling
  function gaugeCluster(el, d){
    const items = d.items || [];
    if(!items.length){ el.innerHTML = empty('No data'); return; }
    const cols = items.length;
    const cellW = 140, cellH = 150;
    const W = cols * cellW, H = cellH + 40;
    let s = svg(W, H);
    items.forEach((it, i) => {
      const cx = i*cellW + cellW/2;
      const cy = 90;
      const r = 50, sw = 9;
      const v = Math.max(0, Math.min(it.value || 0, 100));
      const frac = v/100;
      const a = -Math.PI + frac*Math.PI;
      const x0 = cx - r, y0 = cy;
      const x1 = cx + r*Math.cos(a), y1 = cy + r*Math.sin(a);
      const xe = cx + r;
      // background arc
      s += `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xe} ${cy}" fill="none" stroke="${PALETTE.line}" stroke-width="${sw}" stroke-linecap="butt"/>`;
      // foreground arc — single brand teal, varies by saturation
      const color = it.color || PALETTE.teal;
      if(frac > 0.001){
        s += `<path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="butt"/>`;
      }
      // Value
      s += text(cx, cy-10, fmtPct(v, 1), {size:18, weight:700, color:PALETTE.ink, anchor:'middle'});
      // Label
      s += text(cx, cy+18, it.label, {size:11, color:PALETTE.inkMute, anchor:'middle'});
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 13. Progress bars — N stacked horizontal lanes with %-encoded fill,
  // colored by threshold (red <40%, amber 40-60%, teal >=60%).
  // Used for "% closed within 7/30/90 days".
  function progressBars(el, d){
    const items = d.items || [];
    if(!items.length){ el.innerHTML = empty('No data'); return; }
    const W = 460, padL = 70, padR = 64;
    const rowH = 44;
    // Reserve space at bottom for the threshold legend (rendered inside the
    // SVG so it doesn't collide with the chart-card source link).
    const legendH = 28;
    const H = items.length * rowH + 24 + legendH;
    const trackW = W - padL - padR;
    const trackH = 14;

    let s = svg(W, H);
    items.forEach((it, i) => {
      const v = Math.max(0, Math.min(it.value || 0, 100));
      const cy = 24 + i * rowH;
      const trackY = cy - trackH/2;
      const color = v < 40 ? PALETTE.red
                  : v < 60 ? PALETTE.amber
                  :          PALETTE.teal;
      s += text(padL - 12, cy, it.label, {
        size: 13, weight: 700, color: PALETTE.ink, anchor: 'end'
      });
      s += `<rect x="${padL}" y="${trackY}" width="${trackW}" height="${trackH}" rx="${trackH/2}" fill="${PALETTE.line}"/>`;
      const fillW = (v/100) * trackW;
      s += `<rect x="${padL}" y="${trackY}" width="${fillW}" height="${trackH}" rx="${trackH/2}" fill="${color}"/>`;
      const labelX = fillW > 50 ? padL + fillW - 8 : padL + fillW + 8;
      const labelAnchor = fillW > 50 ? 'end' : 'start';
      const labelColor = fillW > 50 ? '#fff' : color;
      s += text(labelX, cy, v.toFixed(0) + '%', {
        size: 12, weight: 800, color: labelColor, anchor: labelAnchor
      });
    });

    // ── Threshold legend rendered INSIDE the SVG ──
    const legendY = items.length * rowH + 24 + 14;
    const legendItems = [
      { color: PALETTE.red,   label: '<40%' },
      { color: PALETTE.amber, label: '40-60%' },
      { color: PALETTE.teal,  label: '≥60%' },
    ];
    const legendItemW = 90;
    const legendStartX = (W - legendItemW * legendItems.length) / 2;
    legendItems.forEach((li, i) => {
      const x = legendStartX + i * legendItemW;
      s += `<rect x="${x}" y="${legendY - 7}" width="10" height="10" rx="2" fill="${li.color}"/>`;
      s += text(x + 16, legendY, li.label, {
        size: 11, color: PALETTE.inkSoft, anchor: 'start', baseline: 'middle'
      });
    });

    s += '</svg>';
    el.innerHTML = s;
  }

  // ── 14. Box-and-whisker plot — completion-time spread.
  // Layout: prominent "median Xd" above the box; min/Q1/Q3/max value
  // labels below the axis (no overlapping callouts above the box).
  function boxPlot(el, d){
    const W = 460, padL = 32, padR = 32, padT = 68, padB = 56;
    const H = 220;
    const min = d.min || 0;
    const max = d.max || 1;
    const axisLo = Math.max(0, min - (max - min) * 0.05);
    const axisHi = max + (max - min) * 0.05;
    const sx = v => padL + ((v - axisLo) / (axisHi - axisLo || 1)) * (W - padL - padR);
    const cy = padT + (H - padT - padB) / 2;
    const boxH = 36;
    const top = cy - boxH/2, bot = cy + boxH/2;
    const xMin = sx(d.min), xMax = sx(d.max);
    const xQ1  = sx(d.q1),  xQ3  = sx(d.q3);
    const xMed = sx(d.median);

    let s = svg(W, H);

    // Axis line just below the box
    const axisY = bot + 14;
    s += `<line x1="${padL}" y1="${axisY}" x2="${W - padR}" y2="${axisY}" stroke="${PALETTE.line}" stroke-width="1.5"/>`;

    // Whiskers (low + high)
    s += `<line x1="${xMin}" y1="${cy}" x2="${xQ1}" y2="${cy}" stroke="${PALETTE.inkSoft}" stroke-width="2"/>`;
    s += `<line x1="${xMin}" y1="${cy - 9}" x2="${xMin}" y2="${cy + 9}" stroke="${PALETTE.inkSoft}" stroke-width="2"/>`;
    s += `<line x1="${xQ3}" y1="${cy}" x2="${xMax}" y2="${cy}" stroke="${PALETTE.inkSoft}" stroke-width="2"/>`;
    s += `<line x1="${xMax}" y1="${cy - 9}" x2="${xMax}" y2="${cy + 9}" stroke="${PALETTE.inkSoft}" stroke-width="2"/>`;
    // Box
    s += `<rect x="${xQ1}" y="${top}" width="${xQ3 - xQ1}" height="${boxH}" rx="4" fill="${PALETTE.tealSoft}" stroke="${PALETTE.teal}" stroke-width="2"/>`;
    // Median line
    s += `<line x1="${xMed}" y1="${top - 4}" x2="${xMed}" y2="${bot + 4}" stroke="${PALETTE.tealDeep}" stroke-width="3"/>`;

    // ── Above the box: ONE compact callout for the median ─────────
    s += text(xMed, top - 32, 'MEDIAN', {
      size: 10, weight: 700, color: PALETTE.tealDeep, anchor: 'middle', baseline:'auto'
    });
    s += text(xMed, top - 14, Math.round(d.median) + ' days', {
      size: 18, weight: 800, color: PALETTE.ink, anchor: 'middle', baseline:'auto'
    });

    // ── Below the axis: tick labels for min / Q1 / Q3 / max only ─
    // Avoid double-stacking labels at the median (it's already prominently above).
    // If two ticks would overlap (e.g. min and Q1 close together), drop the
    // less-informative one (min/max) and keep Q1/Q3.
    const MIN_SEP = 36;
    const ticks = [
      { x: xMin, lbl: 'min', v: d.min, prio: 1 },
      { x: xQ1,  lbl: 'Q1',  v: d.q1,  prio: 2 },
      { x: xQ3,  lbl: 'Q3',  v: d.q3,  prio: 2 },
      { x: xMax, lbl: 'max', v: d.max, prio: 1 },
    ];
    if(Math.abs(xQ1 - xMin) < MIN_SEP) ticks[0].skip = true;
    if(Math.abs(xMax - xQ3) < MIN_SEP) ticks[3].skip = true;
    ticks.filter(t => !t.skip).forEach(t => {
      s += `<line x1="${t.x}" y1="${axisY}" x2="${t.x}" y2="${axisY + 4}" stroke="${PALETTE.inkMute}" stroke-width="1"/>`;
      s += text(t.x, axisY + 16, Math.round(t.v) + 'd', {
        size: 11, weight: 700, color: PALETTE.ink, anchor: 'middle', baseline:'auto'
      });
      s += text(t.x, axisY + 30, t.lbl, {
        size: 10, color: PALETTE.inkMute, anchor: 'middle', baseline:'auto'
      });
    });

    s += '</svg>';

    // Caption underneath
    el.innerHTML = s + `<div style="font-size:12px;color:var(--ink-soft);margin-top:8px;text-align:center">
      <strong>Half of ${d.label || 'similar'} complaints</strong> close in <strong>${Math.round(d.q1)}–${Math.round(d.q3)} days</strong>.
    </div>`;
  }

  global.Charts = { kpiTile, barChart, hBarChart, donut, sparkline, gauge, gaugeCluster, percentileBar, progressBars, boxPlot, histogram, choropleth, rankStrip, forecastBand, revenueRange, timeComparison, PALETTE };
})(window);
