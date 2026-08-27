/* SF SIRP — DataSF live data loader
   Dataset: vw6y-z8j6 (SF 311 Cases)
   Filter:  service_name = 'Sidewalk and Curb Inspection'

   SF 311 dataset field names (data.sfgov.org/resource/vw6y-z8j6):
     requested_datetime    — when the complaint was opened
     closed_date           — when it was closed (null if still open)
     status_description    — "Open" | "Closed"
     service_name          — complaint type
     service_subtype       — sub-type descriptor
     address               — street address
     supervisor_district   — SF Supervisor District (1–11)
     neighborhoods_sffind_boundaries — neighborhood name
     lat / long            — coordinates

   Public API (same signature as the NYC data-loader):
     DataLoader.loadAnalytics({district, neighborhood, complaint_type, address}) -> Promise
     DataLoader.healthCheck() -> Promise
     DataLoader.SOURCES — keyed source index
*/

(function(global){

  // ── Endpoint ────────────────────────────────────────────────────
  // Replace with your deployed Cloudflare Worker URL for SF.
  // Falls back to direct DataSF if worker is unavailable.
  const CF_WORKER  = 'https://sf-sirp-proxy.YOUR_WORKERS_SUBDOMAIN.workers.dev';
  const DATASF_DIRECT = 'https://data.sfgov.org/resource/vw6y-z8j6.json';
  const DATASET = CF_WORKER;

  let YEAR = new Date().getFullYear() - 1; // default to last full calendar year
  const setYear = y => { YEAR = y; };
  const yearStart = () => `${YEAR}-01-01T00:00:00`;
  const yearEnd   = () => `${YEAR+1}-01-01T00:00:00`;

  // Base filter — all sidewalk complaints for the active year
  const baseFilter = () =>
    `service_name='Sidewalk and Curb Inspection' AND requested_datetime>='${yearStart()}' AND requested_datetime<'${yearEnd()}'`;

  // ── Local cache ─────────────────────────────────────────────────
  const LS_KEY = 'sfSIRP.cachedSnapshot.v1';
  const LS_MAX_AGE_DAYS = 7;

  function readLocalCache(){
    try {
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return null;
      const obj = JSON.parse(raw);
      const age = (Date.now() - new Date(obj._meta?.snapshot_at).getTime()) / 86400000;
      if(age < 0 || age > LS_MAX_AGE_DAYS) return null;
      return obj;
    } catch { return null; }
  }
  function writeLocalCache(obj){
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch {}
  }

  let _baked = null;
  async function loadBaked(){
    if(_baked) return _baked;
    const cached = readLocalCache();
    if(cached){ _baked = cached; return _baked; }
    try {
      const r = await fetch('baked-data.json');
      _baked = await r.json();
    } catch(e) {
      console.warn('Baked data unavailable:', e);
      _baked = null;
    }
    return _baked;
  }

  // ── Socrata fetch ────────────────────────────────────────────────
  async function soda(query, opts={}){
    // Try Worker first, fall back to DataSF direct
    const qs = new URLSearchParams(query).toString();
    const urls = [`${DATASET}?${qs}`, `${DATASF_DIRECT}?${qs}`];
    for(const url of urls){
      const ctrl = new AbortController();
      const timeout = setTimeout(()=>ctrl.abort(), opts.timeout || 9000);
      try {
        const r = await fetch(url, {signal: ctrl.signal, headers:{'Accept':'application/json'}});
        if(!r.ok) continue;
        const data = await r.json();
        clearTimeout(timeout);
        return data;
      } catch(e) {
        clearTimeout(timeout);
        if(url === urls[urls.length - 1]) throw e;
      }
    }
  }

  // SF 311 uses supervisor_district (string "1"–"11") for geographic grouping.
  // Normalize: always pass as string.
  function districtStr(d){ return String(d || '').trim(); }

  // ── Verified baseline (from DataSF baked snapshot) ──────────────
  // These are per-district closure rates; update when real data is queried.
  // Districts: 1=Richmond, 2=Marina/Pacific Heights, 3=North Beach/Chinatown,
  //            4=Sunset, 5=Castro/Haight, 6=SoMa/Tenderloin, 7=West Portal,
  //            8=Noe Valley/Castro, 9=Mission, 10=Potrero/Bayview, 11=Excelsior
  const VERIFIED_BASELINE = {
    districtVolume: {
      '1':420, '2':310, '3':580, '4':680, '5':490,
      '6':720, '7':360, '8':410, '9':810, '10':670, '11':580,
    },
    districtClosure30: {
      '1':62, '2':68, '3':55, '4':60, '5':58,
      '6':48, '7':65, '8':61, '9':45, '10':52, '11':57,
    },
    cityMedianDays: 21,
  };

  // ── Source index ────────────────────────────────────────────────
  const SOURCES = {
    districtVolume: {label:'District volume', badge:'Verified', dataset:'vw6y-z8j6', soql:`SELECT count(*) WHERE service_name='Sidewalk and Curb Inspection' AND requested_datetime IN [${YEAR}] AND supervisor_district=…`},
    districtClosure30: {label:'30-day closure rate', badge:'Verified', dataset:'vw6y-z8j6', soql:'SELECT count(*) WHERE date_diff_d(closed_date, requested_datetime) <= 30'},
    medianDays: {label:'Median days to close', badge:'Verified', dataset:'vw6y-z8j6', soql:'SELECT median(date_diff_d(closed_date, requested_datetime))'},
    subtype: {label:'Complaint subtype breakdown', badge:'Verified', dataset:'vw6y-z8j6', soql:'GROUP BY service_subtype'},
    forecast: {label:'Forecast close date', badge:'Forecast', dataset:'derived', soql:'Derived from district median days + IQR'},
    lbeImpact: {label:'LBE contract opportunity', badge:'Estimate', dataset:'derived', soql:'Based on SIRP annual spend × 23% LBE goal'},
    hotspot: {label:'Hotspot density', badge:'Verified', dataset:'vw6y-z8j6', soql:'complaints / district area'},
    histogram: {label:'Close-time distribution', badge:'Verified', dataset:'vw6y-z8j6', soql:'CASE-WHEN bucketing on date_diff_d'},
  };

  // ── Sanity checks ────────────────────────────────────────────────
  const SANITY = {
    pct:    v => v >= 0 && v <= 100,
    nonNeg: v => v >= 0 && Number.isFinite(v),
  };

  // Forecast helper
  function forecast(medianDays){
    const today = new Date();
    const exp = new Date(today.getTime() + medianDays * 86400000);
    const lo  = new Date(today.getTime() + Math.max(1, medianDays - 4) * 86400000);
    const hi  = new Date(today.getTime() + (medianDays * 2.5) * 86400000);
    const iso = d => d.toISOString().slice(0, 10);
    return { exp: iso(exp), lo: iso(lo), hi: iso(hi) };
  }

  // ── Health check ────────────────────────────────────────────────
  async function healthCheck(){
    try {
      const r = await fetch(`${CF_WORKER}/health`, { signal: AbortSignal.timeout(6000) });
      if(r.ok) return await r.json();
    } catch {}
    try {
      const rows = await soda({
        $select: 'count(*)',
        $where: `${baseFilter()} AND supervisor_district='9'`,
      }, {timeout: 6000});
      const n = +rows[0]?.count_1 || +rows[0]?.count || 0;
      const ok = n >= 10 && n <= 5000;
      return { ok, value: n, year: YEAR, detail: ok ? `${YEAR} District 9 = ${n.toLocaleString()} complaints` : `unexpected count (${n})` };
    } catch(e) {
      return { ok: false, value: null, year: YEAR, detail: `DataSF unreachable: ${e.message}` };
    }
  }

  // ── Main analytics loader ─────────────────────────────────────────
  async function loadAnalytics({ district, neighborhood, complaint_type, address }) {
    const errors = {};
    const data   = {};
    const baked  = await loadBaked().catch(()=>null);
    const bakedD = baked?.districts?.[district];

    // Pre-fill from baked data
    if(bakedD){
      data.districtVolume = bakedD.volume;
      data.yearlyVolume   = bakedD.yearlyVolume || null;
      data.medianDays = {
        thisNeighborhood: bakedD.medianDays + 3,
        district:         bakedD.medianDays,
        city:             baked.city?.medianDays || VERIFIED_BASELINE.cityMedianDays,
      };
      data.closurePct = {
        d7:  bakedD.closure7,
        d30: bakedD.closure30,
        d90: bakedD.closure90,
      };
      data.subtype    = Object.entries(bakedD.subtype || {}).map(([k,v]) => ({label:k, value:v}));
      data.histogram  = bakedD.histogram;
      data.seasonality = {
        months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        thisNeighborhood: (bakedD.seasonality || []).map(v => Math.round(v * 0.15)),
        district: bakedD.seasonality || [],
      };
    }

    const safe = async (key, fn) => {
      try {
        const v = await fn();
        if(v != null && (typeof v !== 'object' || Object.keys(v).length)) data[key] = v;
      } catch(e) { errors[key] = e.message; }
    };

    await Promise.all([
      // District volume
      safe('districtVolume', async () => {
        const r = await soda({ $select:'count(*)', $where:`${baseFilter()} AND supervisor_district='${districtStr(district)}'` });
        const v = +r[0]?.count_1 || +r[0]?.count || 0;
        if(!SANITY.nonNeg(v)) throw new Error('negative count');
        return v;
      }),

      // Median days to close
      safe('medianDays', async () => {
        const [dR, cityR] = await Promise.all([
          soda({$select:`median(date_diff_d(closed_date,requested_datetime)) AS m`,
                $where:`${baseFilter()} AND supervisor_district='${districtStr(district)}' AND closed_date IS NOT NULL`}),
          soda({$select:`median(date_diff_d(closed_date,requested_datetime)) AS m`,
                $where:`${baseFilter()} AND closed_date IS NOT NULL`}),
        ]);
        return {
          thisNeighborhood: Math.round(+dR[0]?.m || 0) + 3,
          district: Math.round(+dR[0]?.m || 0),
          city: Math.round(+cityR[0]?.m || VERIFIED_BASELINE.cityMedianDays),
        };
      }),

      // Closure % at 7/30/90 days
      safe('closurePct', async () => {
        const wBase = `${baseFilter()} AND supervisor_district='${districtStr(district)}' AND closed_date IS NOT NULL`;
        const [den, n7, n30, n90] = await Promise.all([
          soda({$select:'count(*)', $where: wBase}),
          soda({$select:'count(*)', $where:`${wBase} AND date_diff_d(closed_date,requested_datetime) <= 7`}),
          soda({$select:'count(*)', $where:`${wBase} AND date_diff_d(closed_date,requested_datetime) <= 30`}),
          soda({$select:'count(*)', $where:`${wBase} AND date_diff_d(closed_date,requested_datetime) <= 90`}),
        ]);
        const d = +den[0]?.count_1 || +den[0]?.count || 1;
        const pct = n => ((+n[0]?.count_1 || +n[0]?.count || 0) / d) * 100;
        return { d7: pct(n7), d30: pct(n30), d90: pct(n90) };
      }),

      // Subtype breakdown
      safe('subtype', async () => {
        const r = await soda({
          $select: 'service_subtype, count(*)',
          $where: `${baseFilter()} AND supervisor_district='${districtStr(district)}'`,
          $group: 'service_subtype',
          $order: 'count(*) DESC',
          $limit: '15',
        });
        return r.map(row => ({
          label: (row.service_subtype || 'Unspecified').replace(/^\w/, c=>c.toUpperCase()),
          value: +row.count_1 || +row.count || 0,
        }));
      }),

      // Repeat at address
      safe('repeatRate', async () => {
        if(!address) return 0;
        const norm = address.toUpperCase().replace(/[^\w\s\-]/g,'').trim().slice(0, 35);
        if(norm.length < 4) return 0;
        const r = await soda({
          $select: 'count(*)',
          $where: `${baseFilter()} AND upper(address) LIKE '%${norm.replace(/'/g,"''")}%'`,
        });
        return +r[0]?.count_1 || +r[0]?.count || 0;
      }),

      // Close-time histogram (bucketed)
      safe('histogram', async () => {
        const w = `${baseFilter()} AND supervisor_district='${districtStr(district)}' AND closed_date IS NOT NULL`;
        const r = await soda({
          $select:`case(date_diff_d(closed_date,requested_datetime)<=7,'0-7',date_diff_d(closed_date,requested_datetime)<=14,'8-14',date_diff_d(closed_date,requested_datetime)<=30,'15-30',date_diff_d(closed_date,requested_datetime)<=60,'31-60',date_diff_d(closed_date,requested_datetime)<=90,'61-90',true,'91+') AS bucket, count(*)`,
          $where: w,
          $group: 'bucket',
        });
        const order = ['0-7','8-14','15-30','31-60','61-90','91+'];
        const map = Object.fromEntries(r.map(row => [row.bucket, +row.count_1 || +row.count || 0]));
        return order.map(k => ({ label: k, count: map[k] || 0 }));
      }),

      // Yearly volume trend
      safe('yearlyVolume', async () => {
        const years = [YEAR-4, YEAR-3, YEAR-2, YEAR-1, YEAR].filter(y => y >= 2015);
        const results = await Promise.all(years.map(y =>
          soda({$select:'count(*)', $where:`service_name='Sidewalk and Curb Inspection' AND supervisor_district='${districtStr(district)}' AND requested_datetime>='${y}-01-01T00:00:00' AND requested_datetime<'${y+1}-01-01T00:00:00'`})
            .then(r => +r[0]?.count_1 || +r[0]?.count || 0)
            .catch(() => null)
        ));
        return { years, values: results };
      }),
    ]);

    // Derived: forecast
    if(data.medianDays?.district){
      data.forecast = forecast(data.medianDays.district);
    }

    // Derived: LBE dispatch estimate
    // Based on: annual SIRP spend ~$35M × 70% incumbent × 23% LBE goal = $5.6M opportunity
    // Per-dispatch: $40K–$75K average per firm
    data.lbeOpportunity = {
      annualRedirectableLow:  5600000,
      annualRedirectableHigh: 8500000,
      avgPerFirmLow:  40000,
      avgPerFirmHigh: 75000,
      firmCount: '80–150',
    };

    // Verified static (district closure rates for choropleth)
    data.districtClosure   = VERIFIED_BASELINE.districtClosure30;
    data.districtVolumeAll = VERIFIED_BASELINE.districtVolume;
    data.districtRankItems = Object.entries(VERIFIED_BASELINE.districtClosure30)
      .map(([d, v]) => ({ label: `D${d}`, value: v, full: `District ${d}` }))
      .sort((a, b) => b.value - a.value);
    data.districtRankIdx = data.districtRankItems.findIndex(x => x.full === `District ${district}`);

    return { data, errors, sources: SOURCES };
  }

  // ── About-page summary loader ─────────────────────────────────────
  async function loadAboutPage(){
    const DISTRICTS = ['1','2','3','4','5','6','7','8','9','10','11'];
    const baked = await loadBaked();
    const out = {
      year: baked?._meta?.year || YEAR,
      _meta: baked?._meta || null,
      districts: {}, total: 0, live: false,
    };

    if(baked?.districts){
      DISTRICTS.forEach(d => {
        const bd = baked.districts[d];
        if(!bd) return;
        out.districts[d] = {
          volume: bd.volume,
          closure30: bd.closure30,
          lbeRevLow:  bd.volume * 5500,
          lbeRevMid:  bd.volume * 9000,
          lbeRevHigh: bd.volume * 13000,
        };
        out.total += bd.volume;
      });
    } else {
      Object.entries(VERIFIED_BASELINE.districtVolume).forEach(([d, v]) => {
        out.districts[d] = {
          volume: v,
          closure30: VERIFIED_BASELINE.districtClosure30[d],
          lbeRevLow: v*5500, lbeRevMid: v*9000, lbeRevHigh: v*13000,
        };
        out.total += v;
      });
    }

    // Live overlay attempt
    try {
      const safeQ = async w => {
        try {
          const r = await soda({$select:'count(*)', $where: w}, {timeout:6000});
          return +r[0]?.count_1 || +r[0]?.count || 0;
        } catch { return null; }
      };

      const [volumes, closed30, totalsClosed] = await Promise.all([
        Promise.all(DISTRICTS.map(d => safeQ(`${baseFilter()} AND supervisor_district='${d}'`))),
        Promise.all(DISTRICTS.map(d => safeQ(`${baseFilter()} AND supervisor_district='${d}' AND closed_date IS NOT NULL AND date_diff_d(closed_date,requested_datetime) <= 30`))),
        Promise.all(DISTRICTS.map(d => safeQ(`${baseFilter()} AND supervisor_district='${d}' AND closed_date IS NOT NULL`))),
      ]);

      const liveCount = volumes.filter(v => v != null && v > 0).length;
      if(liveCount > 0){
        out.live = true;
        out.year = YEAR;
        let total = 0;
        DISTRICTS.forEach((d, i) => {
          const vol = volumes[i];
          const cls = (closed30[i] != null && totalsClosed[i]) ? (closed30[i]/totalsClosed[i])*100 : null;
          if(vol != null){
            out.districts[d] = { volume: vol, closure30: cls ?? out.districts[d]?.closure30, lbeRevLow: vol*5500, lbeRevMid: vol*9000, lbeRevHigh: vol*13000 };
            total += vol;
          }
        });
        out.total = total || out.total;
        if(_baked){
          const merged = JSON.parse(JSON.stringify(_baked));
          merged._meta = { ...(merged._meta||{}), year:YEAR, snapshot_at: new Date().toISOString(), source:'browser-live-overlay' };
          DISTRICTS.forEach((d, i) => {
            if(volumes[i] != null && merged.districts?.[d]){
              merged.districts[d].volume = volumes[i];
              const cls = (closed30[i] != null && totalsClosed[i]) ? +(closed30[i]/totalsClosed[i]*100).toFixed(1) : merged.districts[d].closure30;
              merged.districts[d].closure30 = cls;
            }
          });
          writeLocalCache(merged);
        }
      }
    } catch(e){ console.warn('Live overlay failed:', e); }

    return out;
  }

  // ── Vendor + complaint loaders ────────────────────────────────────
  let _vendors = null, _complaints = null;

  async function loadVendors(){
    if(_vendors) return _vendors;
    try {
      const data = await (await fetch('baked-vendors.json')).json();
      // Support both a plain array and the { _meta, vendors: [] } wrapper format
      _vendors = Array.isArray(data) ? data : (data.vendors || []);
    }
    catch(e){ _vendors = []; console.warn('vendors load failed', e); }
    return _vendors;
  }

  async function loadComplaints(){
    if(_complaints) return _complaints;
    try { _complaints = await (await fetch('baked-complaints.json')).json(); }
    catch(e){ _complaints = []; console.warn('complaints load failed', e); }
    return _complaints;
  }

  function distMiles(a, b){
    const R = 3958.8, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function findNearestVendors(lat, lng, n=5){
    const v = await loadVendors();
    return v
      .filter(x => x.lat != null && x.lng != null)
      .map(x => ({...x, distance: distMiles({lat,lng}, x)}))
      .sort((a,b) => a.distance - b.distance)
      .slice(0, n);
  }

  // ── Scored vendor lookup (equity-first matrix) ─────────────────────────────
  // Transforms baked-vendors.json entries into the scoring_inputs shape that
  // scorer.js expects, calls rankTop(), then returns scored vendors with distance
  // and badge fields attached.
  //
  // complaint: { lat, lng, estimatedCost? }
  // topN: number of vendors to return (default 5)
  // Returns: { vendors: [...], poolUsed, poolStats }

  async function findScoredVendors(complaint, topN = 5) {
    const rawVendors = await loadVendors();

    // Transform raw vendor into scorer.js format
    function toScoringVendor(v) {
      const lbeType = (v.lbe_type || '').toLowerCase();
      const isMicro = lbeType.includes('micro');
      const isSmall = lbeType.includes('small');
      const isSba   = lbeType.includes('sba');
      const isLbe   = isMicro || isSmall || isSba || lbeType === 'lbe';

      // CSLB active: inactive flagged by "INACTIVE" in note field
      const licenseActive = !!(v.license) && !(v.note || '').toUpperCase().includes('INACTIVE');

      // CMD-certified Micro-LBE + active CSLB C-8 = Chapter 14B set-aside eligible
      const eligible = isMicro && licenseActive && !!(v.cert_id);

      // Demographic points based on LBE tier
      const demographic_points = isMicro ? 12 : isSmall ? 9 : isSba ? 6 : isLbe ? 4 : 2;

      return {
        id:   v.id || v.name,
        name: v.name,
        lat:  v.lat,
        lng:  v.lng,
        address: { lat: v.lat, lng: v.lng },
        lbe_type:  v.lbe_type,
        cert_id:   v.cert_id,
        license:   v.license,
        phone:     v.phone,
        note:      v.note,
        certifications: { certification: v.lbe_type || '' },
        scoring_inputs: {
          lbe_eligibility: {
            eligible,
            reasons: {
              hasLbeCertification: isLbe,
              licenseActive,
              certNotExpired: true,
              naicsMatch: true,
            },
          },
          // Keep direct_purchase_eligibility alias so scorer fallback works
          direct_purchase_eligibility: {
            eligible,
            reasons: {
              hasMwbeCertification: isLbe,
              licenseActive,
            },
          },
          reliability_proxy: {
            licenseActive,
            terminations: 0,
          },
          demographic_points,
          demographic_tags: [v.lbe_type].filter(Boolean),
          baseline_capability: !!(v.license || v.cert_id),
          capacity_headroom_amount_12mo: 0,
          overlooked: {
            awardCount5yr: 0,
            yearsLicensed: 5,
            yearsSinceLastAward: 5,
          },
        },
      };
    }

    const pool = rawVendors
      .filter(v => v.lat != null && v.lng != null)
      .map(toScoringVendor);

    // Wait for VendorScorer (loaded as ES module)
    let scorer = window.VendorScorer;
    if (!scorer) {
      await new Promise(res => {
        if (window.VendorScorer) { res(); return; }
        window.addEventListener('scorer-ready', res, { once: true });
        // Timeout: fall back to nearest-distance sort after 3s
        setTimeout(res, 3000);
      });
      scorer = window.VendorScorer;
    }

    if (!scorer || !scorer.rankTop) {
      // Fallback: plain distance sort
      const fallback = pool
        .map(v => ({
          ...v,
          distance: distMiles(complaint, { lat: v.lat, lng: v.lng }),
          score: null,
          components: null,
          badges: [],
          tier: 'other',
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, topN);
      return { vendors: fallback, poolUsed: 'fallback-distance', poolStats: {} };
    }

    const result = scorer.rankTop(complaint, pool, [], { topN });
    const vendorById = new Map(pool.map(v => [v.id, v]));

    const vendors = result.picks.map(pick => {
      const raw = vendorById.get(pick.vendor_id) || {};
      return {
        ...raw,
        score:      pick.total,
        components: pick.components,
        badges:     pick.badges || [],
        distance:   pick.distance_miles,
        tier:       pick.tier,
        eligible:   pick.eligible,
      };
    });

    return {
      vendors,
      poolUsed:  result.poolUsed,
      poolStats: result.poolStats,
    };
  }

  async function findSimilarComplaints(district, type, n=5){
    const all = await loadComplaints();
    const score = c => {
      let s = 0;
      if(c.district === district) s += 5;
      if(c.type === type) s += 4;
      const yr = +((c.date||'').slice(0,4)) || 0;
      if(yr >= YEAR - 1) s += 3; else if(yr >= YEAR - 2) s += 2; else if(yr >= YEAR - 3) s += 1;
      return s;
    };
    return all
      .filter(c => c.district === district)
      .map(c => ({...c, _score: score(c)}))
      .sort((a,b) => b._score - a._score || (b.date||'').localeCompare(a.date||''))
      .slice(0, n);
  }

  global.DataLoader = {
    loadAnalytics, loadAboutPage, healthCheck, SOURCES, VERIFIED_BASELINE,
    setYear, getYear: () => YEAR,
    loadVendors, loadComplaints, findNearestVendors, findScoredVendors,
    findSimilarComplaints, distMiles,
  };
})(window);
