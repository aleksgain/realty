'use strict';
// Source adapters: novostavby.com (WordPress REST) and Sreality (/api/v1). Pure fetch, no state.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(cfg, url, qs, { full = false, tries = 3 } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(qs || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) { const e = new Error(`404 ${u.pathname}`); e.notFound = true; throw e; }
      if (!r.ok) throw new Error(`${r.status} ${u.host}${u.pathname}`);
      const body = await r.json();
      return full ? { body, headers: r.headers } : body;
    } catch (e) {
      last = e;
      if (e.notFound) throw e;
      await sleep(1000 * a * a);
    }
  }
  throw last;
}

// ---------- feature detection (shared) ----------
const RX = {
  parking: /garáž|garážov|parkovací (stání|místo|místa)|parkování (v|ve) (domě|garáži|objektu)|podzemní parkování|kryté stání/i,
  outdoor: /balk[oó]n|lodži|lodžie|teras|předzahrád|zahrádk|zahrad[auy]? (k bytu|u bytu)|soukromou zahrad|vlastní zahrad|atrium/i,
  cellar: /sklep|sklepní|komora v suterénu|kóje/i,
  acPrep: /příprav\w* (pro|na) klimatiz|předpříprav\w* (pro|na) klimatiz|příprav\w* (pro|na) chlazení/i,
  ac: /klimatiz|stropní chlazení|chlazení/i,
  ev: /nabíje|nabíjecí|dobíje|dobíjecí|wallbox|elektromobil|e-mobil/i,
};
function detectText(t = '') {
  const acPrep = RX.acPrep.test(t), acAny = RX.ac.test(t);
  return {
    parking: RX.parking.test(t), outdoor: RX.outdoor.test(t), cellar: RX.cellar.test(t),
    ac: acAny && !acPrep ? 'yes' : acPrep ? 'prep' : null, ev: RX.ev.test(t),
  };
}
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---------- novostavby.com ----------
async function fetchNovostavby(cfg) {
  const nv = cfg.novostavby;
  const yearById = Object.fromEntries(Object.entries(nv.years).map(([k, v]) => [v, k]));
  const statusById = { 2719: 'v prodeji', 2718: 'předprodej', 1582: 'v přípravě' };
  const typeById = { 3109: 'byty', 1602: 'rodinné domy' };
  const out = [];
  let page = 1, pages = 1;
  do {
    const { body, headers } = await getJson(cfg, 'https://novostavby.com/wp-json/wp/v2/property', {
      property_location: nv.locationIds.join(','), property_status: nv.statusIds.join(','),
      property_type: nv.typeIds.join(','), property_material: Object.values(nv.years).join(','),
      per_page: 100, page, _fields: 'id,link,title,content,property_material,property_status,property_type,class_list',
    }, { full: true });
    pages = Number(headers.get('x-wp-totalpages') || 1);
    for (const p of body) {
      const moveIn = p.property_material.map((id) => yearById[id]).filter(Boolean).join('/') || '?';
      const status = p.property_status.map((id) => statusById[id] || id).join('/');
      const locs = (p.class_list || []).filter((c) => c.startsWith('property_location-')).map((c) => c.slice(18));
      const pd = locs.find((l) => /^novostavby-praha-\d+$/.test(l));
      const district = pd ? 'Praha ' + pd.split('-').pop()
        : locs.includes('novostavby-praha-zapad') ? 'Praha-západ' : locs.includes('novostavby-praha-vychod') ? 'Praha-východ' : 'Praha';
      const latestYear = Number(cfg.latestCompletion.slice(0, 4));
      out.push({
        id: `nv-${p.id}`, source: 'novostavby', market: 'new',
        title: strip(p.title.rendered), link: p.link, district,
        subarea: locs.filter((l) => !/cela-cr|stredocesky-kraj|^praha$|^novostavby-/.test(l)).join(', '),
        type: p.property_type.map((id) => typeById[id] || id).join('/'), status, moveIn,
        features: detectText(strip(p.content?.rendered)),
        verify: moveIn === String(latestYear) ? `Move-in listed as ${latestYear} only — confirm quarter and kolaudace date` : null,
        key: `${status}|${moveIn}`,
      });
    }
    page++;
  } while (page <= pages);
  return out;
}

// ---------- Sreality ----------
const COND = { 1: 'velmi dobrý', 2: 'dobrý', 4: 've výstavbě', 5: 'projekt', 6: 'novostavba', 9: 'po rekonstrukci' };

async function searchSreality(cfg) {
  const sr = cfg.sreality, F = cfg.filters;
  const cands = new Map();
  for (const [market, conds] of [['new', sr.newConditions], ['secondary', sr.secondaryConditions]]) {
    for (const cond of conds) {
      let offset = 0, total = 0, n = 0;
      do {
        const res = await getJson(cfg, 'https://www.sreality.cz/api/v1/estates/search', {
          category_main_cb: 1, category_type_cb: 1, locality_region_id: sr.regionIds.join(','),
          building_condition: cond, price_to: F.priceTo, usable_area_from: F.areaFrom,
          ownership: F.ownership || undefined, limit: 100, offset,
        });
        total = res.pagination.total;
        for (const e of res.results) if (!cands.has(String(e.hash_id))) cands.set(String(e.hash_id), { e, cond, market });
        offset += 100; n++;
        await sleep(300);
      } while (offset < total && n < sr.maxPages);
    }
  }
  return cands;
}

// Seznam's image CDN only serves whitelisted sizes; these two are the ones sreality.cz itself uses.
const SR_THUMB = '?fl=res,400,300,3|shr,,20|jpg,80';
const SR_FULL = '?fl=res,749,562,3|shr,,20|jpg,90';
const MAX_IMAGES = 8;
function srealityImages(list) {
  return (Array.isArray(list) ? list : []).filter((i) => i && i.url).slice(0, MAX_IMAGES)
    .map((i) => { const u = i.url.startsWith('//') ? 'https:' + i.url : i.url; return { t: u + SR_THUMB, f: u + SR_FULL }; });
}

async function evaluateSreality(cfg, hash, { e, cond, market }) {
  let d;
  try {
    d = (await getJson(cfg, `https://www.sreality.cz/api/v1/estates/${hash}`)).result || {};
  } catch (err) {
    if (err.notFound) return null;   // withdrawn between search and detail
    throw err;
  }
  const t = d.advert_description || '';
  const tf = detectText(t);
  const features = {
    parking: !!(d.garage || d.parking_lots || d.parking) || tf.parking,
    outdoor: !!(d.balcony || d.loggia || d.terrace || d.garden_area) || tf.outdoor,
    cellar: !!d.cellar || tf.cellar,
    ac: tf.ac, ev: tf.ev,
  };
  const cutoff = cfg.latestCompletion, cutoffYear = Number(cutoff.slice(0, 4));
  let verify = null, dateExcluded = null;
  const ready = d.ready_date || null;
  if (cond === 4) {
    if (ready) { if (ready > cutoff) dateExcluded = 'late'; }
    else {
      const years = [...t.matchAll(/\b(20[2-3]\d)\b/g)].map((m) => Number(m[1])).filter((y) => y >= cutoffYear - 1);
      if (years.length && Math.min(...years) > cutoffYear) dateExcluded = 'late';
      else if (years.includes(cutoffYear)) {
        const i = t.search(String(cutoffYear));
        verify = `No ready date; text says “…${t.slice(Math.max(0, i - 60), i + 15).replace(/\s+/g, ' ')}…”`;
      } else if (!years.length) {
        if (!cfg.filters.keepUnknownReadyDate) dateExcluded = 'unknown-date';
        verify = 'Under construction, no completion date — ask';
      }
    }
  }
  const loc = d.locality || e.locality || {};
  const layout = d.category_sub_cb?.name || e.category_sub_cb?.name || '?';
  return {
    id: `sr-${hash}`, source: 'sreality', market, hash,
    title: d.advert_name || e.advert_name,
    link: `https://www.sreality.cz/detail/prodej/byt/${encodeURIComponent(layout)}/x/${hash}`,
    district: loc.district || loc.quarter || 'Praha',
    subarea: [loc.citypart, loc.street].filter(Boolean).join(', '),
    layout, area: d.usable_area || null, price: e.price_czk, pricePerM2: e.price_czk_m2,
    condition: COND[cond] || String(cond), readyDate: ready, floor: d.floor_number ?? null,
    energy: d.energy_efficiency_rating_cb?.name?.slice(0, 1) || null,
    gps: loc.gps_lat ? { lat: loc.gps_lat, lon: loc.gps_lon } : null,
    images: srealityImages(d.advert_images || d.advert_images_all),
    features, verify, dateExcluded, v: 3,
  };
}

// ---------- Flatzone (developer price lists, unit level) ----------
// Prague "obvod" (Praha 1–10, as Sreality reports it) for each městská část Flatzone returns.
const OBVOD = {
  'Praha 4': ['Praha 11', 'Praha 12', 'Praha-Kunratice', 'Praha-Libuš', 'Praha-Šeberov', 'Praha-Újezd'],
  'Praha 5': ['Praha 13', 'Praha 16', 'Praha-Lipence', 'Praha-Lochkov', 'Praha-Řeporyje', 'Praha-Slivenec', 'Praha-Velká Chuchle', 'Praha-Zbraslav', 'Praha-Zličín'],
  'Praha 6': ['Praha 17', 'Praha-Lysolaje', 'Praha-Nebušice', 'Praha-Přední Kopanina', 'Praha-Suchdol'],
  'Praha 7': ['Praha-Troja'],
  'Praha 8': ['Praha-Březiněves', 'Praha-Ďáblice', 'Praha-Dolní Chabry'],
  'Praha 9': ['Praha 14', 'Praha 18', 'Praha 19', 'Praha 20', 'Praha 21', 'Praha-Čakovice', 'Praha-Dolní Počernice', 'Praha-Satalice', 'Praha-Vinoř'],
  'Praha 10': ['Praha 15', 'Praha 22', 'Praha-Benice', 'Praha-Běchovice', 'Praha-Dolní Měcholupy', 'Praha-Dubeč', 'Praha-Klánovice',
    'Praha-Koloděje', 'Praha-Kolovraty', 'Praha-Královice', 'Praha-Křeslice', 'Praha-Nedvězí', 'Praha-Petrovice', 'Praha-Štěrboholy'],
};
const MC_TO_OBVOD = Object.fromEntries(Object.entries(OBVOD).flatMap(([o, mcs]) => mcs.map((m) => [m, o])));
function obvodOf(borough) {
  if (!borough) return 'Praha';
  if (/^Praha (10|[1-9])$/.test(borough)) return borough;
  return MC_TO_OBVOD[borough] || borough;
}

const FZ_URL = 'https://api.flatzone.cz/graphql';
async function fzQuery(cfg, query, variables) {
  let last;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(FZ_URL, {
        method: 'POST', signal: AbortSignal.timeout(45000),
        headers: { 'User-Agent': cfg.userAgent, 'Content-Type': 'application/json', Origin: 'https://www.flatzone.cz', Referer: 'https://www.flatzone.cz/' },
        body: JSON.stringify({ query, variables }),
      });
      if (!r.ok) throw new Error(`${r.status} flatzone`);
      const j = await r.json();
      if (j.errors?.length) throw new Error('flatzone: ' + j.errors[0].message);
      return j.data;
    } catch (e) { last = e; await sleep(1500 * a * a); }
  }
  throw last;
}

const FZ_PAGE = 300;   // the API refuses offset + size beyond 300, so large result sets are split by price band
const FZ_SEARCH = `query($a: StructuredAddressInput!, $f: FiltersInput, $o: Int, $s: Int) {
  searchByAddress(source: "pricelists", address: $a, filters: $f, offset: $o, size: $s) {
    count
    estates { id number projectId project developer locality disposition area price priceType floor ownership condition state
      cellar parking balconyArea loggiaArea terraceArea gardenArea detailUrl imageUrls gps { lat lon } address { borough neighborhood street } }
  } }`;

async function searchFlatzone(cfg) {
  const F = cfg.filters;
  const base = { type: ['FLAT'], offerType: ['SALE'], area: { min: F.areaFrom } };
  if (F.ownership === 1) base.ownership = ['PRIVATE'];
  const addr = { city: cfg.flatzone.city };
  const out = new Map();
  async function band(min, max, depth = 0) {
    const f = { ...base, price: { min, max } };
    const c = (await fzQuery(cfg, FZ_SEARCH, { a: addr, f, o: 0, s: 0 })).searchByAddress.count;
    if (!c) return;
    if (c > FZ_PAGE && max - min > 10000 && depth < 12) {
      const mid = Math.floor((min + max) / 2);
      await band(min, mid, depth + 1); await band(mid + 1, max, depth + 1);
      return;
    }
    const r = (await fzQuery(cfg, FZ_SEARCH, { a: addr, f, o: 0, s: Math.min(c, FZ_PAGE) })).searchByAddress;
    for (const e of r.estates) out.set(e.id, e);
    await sleep(300);
  }
  await band(1, F.priceTo);
  return out;
}

const FZ_PROJECT = `query($id: ID!) { projectDetail(id: $id) {
  projectId project developer description equipment standard cellarAvailable garageAvailable parkingAvailable
  constructionEndDate finalInspectionIssuance moveInDate } }`;
async function fetchFlatzoneProject(cfg, id) {
  const p = (await fzQuery(cfg, FZ_PROJECT, { id })).projectDetail;
  if (!p) return null;
  const day = (s) => (s ? s.slice(0, 10) : null);
  return {
    id, name: p.project, developer: p.developer,
    text: detectText([p.description, ...(p.equipment || [])].join(' ')),
    cellar: !!p.cellarAvailable, parking: !!(p.parkingAvailable || p.garageAvailable),
    constructionEnd: day(p.constructionEndDate), kolaudace: day(p.finalInspectionIssuance), moveIn: day(p.moveInDate),
  };
}

const FZ_COND = { UNDER_CONSTRUCTION: 've výstavbě', NEW: 'novostavba', RENOVATED: 'po rekonstrukci', IN_PREPARATION: 'projekt' };
function flatzoneItem(cfg, e, proj) {
  const outdoor = !!(e.balconyArea || e.loggiaArea || e.terraceArea || e.gardenArea);
  const features = {
    parking: !!e.parking || !!proj?.parking,
    outdoor,
    cellar: !!e.cellar || !!proj?.cellar,
    ac: proj?.text.ac || null, ev: !!proj?.text.ev,
  };
  // Completion: developer handover date first, then kolaudace, then end of construction.
  let dateExcluded = null, verify = null;
  const handover = proj?.moveIn || null, done = proj?.kolaudace || proj?.constructionEnd || null;
  if (handover) { if (handover > cfg.moveInDeadline) dateExcluded = 'late'; }
  else if (done) { if (done > cfg.latestCompletion) dateExcluded = 'late'; }
  else if (e.condition === 'UNDER_CONSTRUCTION' || e.condition === 'IN_PREPARATION') {
    if (!cfg.filters.keepUnknownReadyDate) dateExcluded = 'unknown-date';
    verify = 'Developer gives no completion date — ask';
  }
  if (e.state === 'RESERVED') verify = [verify, 'Currently reserved by another buyer'].filter(Boolean).join('. ');
  const fromProject = [!e.parking && proj?.parking ? 'parking' : null, !e.cellar && proj?.cellar ? 'cellar' : null].filter(Boolean);
  const area = e.area || null;
  return {
    id: `fz-${e.id}`, source: 'flatzone', market: 'new',
    title: `${e.project}${e.number ? ', unit ' + e.number : ''}`, project: e.project, projectId: e.projectId, developer: e.developer,
    link: e.detailUrl || `https://www.flatzone.cz/`,
    district: obvodOf(e.address?.borough), subarea: [e.address?.neighborhood, e.address?.street].filter(Boolean).join(', ') || e.locality,
    layout: (e.disposition || [])[0] || '?', area, price: e.price, pricePerM2: area ? Math.round(e.price / area) : null,
    condition: FZ_COND[e.condition] || (e.condition || '').toLowerCase(), state: e.state,
    readyDate: handover || done, floor: e.floor ?? null, gps: e.gps ? { lat: e.gps.lat, lon: e.gps.lon } : null,
    features, verify, dateExcluded,
    images: (e.imageUrls || []).slice(0, MAX_IMAGES).map((u) => ({
      t: u.replace(/\/images\/([^/.]+)\.\w+$/, '/thumbnails/350x200/$1.webp'), f: u })),
    note: fromProject.length ? `${fromProject.join(' and ')} offered in the project, not listed with this unit` : null,
    key: `${e.state}`, v: 2,
  };
}

module.exports = { fetchNovostavby, searchSreality, evaluateSreality, searchFlatzone, fetchFlatzoneProject, flatzoneItem, sleep };
