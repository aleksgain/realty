// reality — Prague property board: scheduled scraping, shared ratings + comments, live updates.
// Zero npm dependencies: Node 22+ built-ins only (http, fs, fetch, node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./lib/config');
const { parseCron, matches, nextRun } = require('./lib/cron');
const { fetchNovostavby, searchSreality, evaluateSreality, searchFlatzone, fetchFlatzoneProject, flatzoneItem, sleep } = require('./lib/scraper');

const PUBLIC = path.join(__dirname, 'public');
const cron = parseCron(cfg.cron);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- database ----------
fs.mkdirSync(cfg.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(cfg.dataDir, 'reality.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, data TEXT NOT NULL, price INTEGER,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, last_eval TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE INDEX IF NOT EXISTS listings_active ON listings (active, source);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
  CREATE INDEX IF NOT EXISTS events_listing ON events (listing_id);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT, started TEXT NOT NULL, finished TEXT,
    ok INTEGER, stats TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS ratings (
    listing_id TEXT NOT NULL, user TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    updated TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (listing_id, user));
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL, user TEXT NOT NULL,
    text TEXT NOT NULL, created TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS comments_listing ON comments (listing_id);
  CREATE TABLE IF NOT EXISTS fz_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, fetched TEXT NOT NULL);
`);
// A crash mid-run leaves an unfinished row; close it out on boot.
db.prepare(`UPDATE runs SET finished = started, ok = 0, error = 'interrupted (container restarted)' WHERE finished IS NULL`).run();

const q = {
  listing: db.prepare('SELECT * FROM listings WHERE id = ?'),
  insListing: db.prepare('INSERT INTO listings (id, source, data, price, first_seen, last_seen, last_eval, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'),
  updListing: db.prepare('UPDATE listings SET data = ?, price = ?, last_seen = ?, last_eval = COALESCE(?, last_eval), active = 1 WHERE id = ?'),
  touch: db.prepare('UPDATE listings SET last_seen = ?, active = 1 WHERE id = ?'),
  goneList: db.prepare('SELECT id FROM listings WHERE source = ? AND active = 1 AND last_seen <> ?'),
  deactivate: db.prepare('UPDATE listings SET active = 0 WHERE id = ?'),
  activeAll: db.prepare('SELECT * FROM listings WHERE active = 1'),
  event: db.prepare('INSERT INTO events (listing_id, at, kind, detail) VALUES (?, ?, ?, ?)'),
  eventsActive: db.prepare(`SELECT e.listing_id, e.at, e.kind, e.detail FROM events e JOIN listings l ON l.id = e.listing_id
    WHERE l.active = 1 ORDER BY e.id`),
  runStart: db.prepare('INSERT INTO runs (trigger, started) VALUES (?, ?)'),
  runEnd: db.prepare('UPDATE runs SET finished = ?, ok = ?, stats = ?, error = ? WHERE id = ?'),
  lastRun: db.prepare('SELECT * FROM runs WHERE finished IS NOT NULL ORDER BY id DESC LIMIT 1'),
  lastOk: db.prepare('SELECT * FROM runs WHERE ok = 1 ORDER BY id DESC LIMIT 1'),
  recentRuns: db.prepare('SELECT id, trigger, started, finished, ok, stats, error FROM runs ORDER BY id DESC LIMIT 10'),
  ratings: db.prepare('SELECT listing_id, user, stars, updated FROM ratings'),
  comments: db.prepare('SELECT id, listing_id, user, text, created FROM comments ORDER BY id'),
  setRating: db.prepare(`INSERT INTO ratings (listing_id, user, stars) VALUES (?, ?, ?)
    ON CONFLICT (listing_id, user) DO UPDATE SET stars = excluded.stars, updated = datetime('now')`),
  delRating: db.prepare('DELETE FROM ratings WHERE listing_id = ? AND user = ?'),
  addComment: db.prepare('INSERT INTO comments (listing_id, user, text) VALUES (?, ?, ?)'),
  getComment: db.prepare('SELECT user FROM comments WHERE id = ?'),
  fzProject: db.prepare('SELECT * FROM fz_projects WHERE id = ?'),
  fzProjectSet: db.prepare('INSERT INTO fz_projects (id, data, fetched) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, fetched = excluded.fetched'),
  delComment: db.prepare('DELETE FROM comments WHERE id = ?'),
};
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- update run ----------
let running = null;
function status() {
  const last = q.lastRun.get(), ok = q.lastOk.get();
  const shape = (r) => r && { id: r.id, trigger: r.trigger, started: r.started, finished: r.finished, ok: !!r.ok, stats: r.stats ? JSON.parse(r.stats) : null, error: r.error };
  return { running, lastRun: shape(last), lastOk: shape(ok), nextRun: nextRun(cron, cfg.timeZone)?.toISOString() || null, cron: cfg.cron, timeZone: cfg.timeZone };
}

async function runUpdate(trigger) {
  if (running) { const e = new Error('an update is already running'); e.status = 409; throw e; }
  const now = new Date().toISOString();
  const runId = Number(q.runStart.run(trigger, now).lastInsertRowid);
  running = { id: runId, trigger, started: now, phase: 'starting' };
  const phase = (p) => { running.phase = p; broadcast('run', status()); };
  const stats = { new: 0, priceChanges: 0, statusChanges: 0, gone: 0, evaluated: 0, candidates: 0, projects: 0, flatzoneUnits: 0 };
  log(`run ${runId} (${trigger}) started`);
  try {
    // --- novostavby.com ---
    if (cfg.novostavby.enabled) {
      phase('Checking novostavby.com');
      const items = await fetchNovostavby(cfg);
      stats.projects = items.length;
      tx(() => {
        for (const it of items) {
          const row = q.listing.get(it.id);
          if (!row) { q.insListing.run(it.id, 'novostavby', JSON.stringify(it), null, now, now, now); q.event.run(it.id, now, 'new', null); stats.new++; continue; }
          const old = JSON.parse(row.data);
          if (old.key !== it.key) {
            q.event.run(it.id, now, 'status', JSON.stringify({ from: `${old.status}, move-in ${old.moveIn}`, to: `${it.status}, move-in ${it.moveIn}` }));
            stats.statusChanges++;
          }
          if (!row.active) q.event.run(it.id, now, 'back', null);
          q.updListing.run(JSON.stringify(it), null, now, now, it.id);
        }
        for (const { id } of q.goneList.all('novostavby', now)) { q.deactivate.run(id); q.event.run(id, now, 'gone', null); stats.gone++; }
      });
    }

    // --- Sreality search ---
    phase('Searching Sreality');
    const cands = await searchSreality(cfg);
    stats.candidates = cands.size;
    const staleBefore = new Date(Date.now() - cfg.sreality.reevaluateDays * 864e5).toISOString();
    const todo = [];
    let reeval = 0;
    tx(() => {
      for (const [hash, c] of cands) {
        const id = `sr-${hash}`, row = q.listing.get(id);
        const upgrade = row && JSON.parse(row.data).v !== 2;   // older rows lack GPS needed for duplicate matching
        const stale = row && (upgrade || ((!row.last_eval || row.last_eval < staleBefore) && reeval < cfg.sreality.reevaluatePerRun));
        if (row && row.price === c.e.price_czk && !stale) {
          if (!row.active) q.event.run(id, now, 'back', null);
          q.touch.run(now, id);
        } else { if (stale && !upgrade && row.price === c.e.price_czk) reeval++; todo.push([hash, c, row]); }
      }
    });

    // --- Sreality detail for new, repriced and stale listings ---
    const total = todo.length;
    for (let i = 0; i < todo.length; i += cfg.sreality.concurrency) {
      phase(`Reading Sreality listings ${Math.min(i + cfg.sreality.concurrency, total)} of ${total}`);
      const batch = todo.slice(i, i + cfg.sreality.concurrency);
      const results = await Promise.all(batch.map(([hash, c]) => evaluateSreality(cfg, hash, c).catch((e) => ({ error: e }))));
      tx(() => {
        batch.forEach(([hash, , row], k) => {
          const d = results[k], id = `sr-${hash}`;
          if (!d || d.error) { if (row) q.touch.run(now, id); return; }  // keep old data; retry next run
          stats.evaluated++;
          if (!row) { q.insListing.run(id, 'sreality', JSON.stringify(d), d.price, now, now, now); q.event.run(id, now, 'new', null); stats.new++; return; }
          if (row.price !== d.price) { q.event.run(id, now, 'price', JSON.stringify({ from: row.price, to: d.price })); stats.priceChanges++; }
          if (!row.active) q.event.run(id, now, 'back', null);
          q.updListing.run(JSON.stringify(d), d.price, now, now, id);
        });
      });
      await sleep(250);
    }
    tx(() => { for (const { id } of q.goneList.all('sreality', now)) { q.deactivate.run(id); q.event.run(id, now, 'gone', null); stats.gone++; } });

    // --- Flatzone developer price lists ---
    if (cfg.flatzone.enabled) {
      phase('Reading developer price lists (Flatzone)');
      const units = await searchFlatzone(cfg);
      stats.flatzoneUnits = units.size;
      const fresh = new Date(Date.now() - cfg.flatzone.projectRefreshDays * 864e5).toISOString();
      const pids = [...new Set([...units.values()].map((u) => u.projectId))];
      const need = pids.filter((id) => { const r = q.fzProject.get(id); return !r || r.fetched < fresh; });
      for (let i = 0; i < need.length; i += 4) {
        phase(`Reading Flatzone projects ${Math.min(i + 4, need.length)} of ${need.length}`);
        const got = await Promise.all(need.slice(i, i + 4).map((id) => fetchFlatzoneProject(cfg, id).catch(() => null)));
        tx(() => got.forEach((p) => { if (p) q.fzProjectSet.run(p.id, JSON.stringify(p), now); }));
        await sleep(250);
      }
      const projects = new Map(pids.map((id) => { const r = q.fzProject.get(id); return [id, r ? JSON.parse(r.data) : null]; }));
      tx(() => {
        for (const e of units.values()) {
          const it = flatzoneItem(cfg, e, projects.get(e.projectId));
          const row = q.listing.get(it.id);
          if (!row) { q.insListing.run(it.id, 'flatzone', JSON.stringify(it), it.price, now, now, now); q.event.run(it.id, now, 'new', null); stats.new++; continue; }
          const old = JSON.parse(row.data);
          if (row.price !== it.price) { q.event.run(it.id, now, 'price', JSON.stringify({ from: row.price, to: it.price })); stats.priceChanges++; }
          if (old.key !== it.key) { q.event.run(it.id, now, 'status', JSON.stringify({ from: old.state === 'RESERVED' ? 'reserved' : 'available', to: it.state === 'RESERVED' ? 'reserved' : 'available' })); stats.statusChanges++; }
          if (!row.active) q.event.run(it.id, now, 'back', null);
          q.updListing.run(JSON.stringify(it), it.price, now, now, it.id);
        }
        for (const { id } of q.goneList.all('flatzone', now)) { q.deactivate.run(id); q.event.run(id, now, 'gone', null); stats.gone++; }
      });
    }

    q.runEnd.run(new Date().toISOString(), 1, JSON.stringify(stats), null, runId);
    log(`run ${runId} ok`, JSON.stringify(stats));
  } catch (e) {
    // Nothing is marked gone on failure: a broken source must not wipe the board.
    q.runEnd.run(new Date().toISOString(), 0, JSON.stringify(stats), String(e.message || e), runId);
    log(`run ${runId} failed:`, e.message || e);
  } finally {
    running = null;
    feedCache = null;
    broadcast('run', status());
    broadcast('feed', {});
  }
}

// ---------- feed (computed from the database; config changes apply without re-scraping) ----------
let feedCache = null;
function scoreOf(it) {
  const S = cfg.scoring, f = it.features || {};
  return (S.district[it.district] || 0) + (f.ac === 'yes' ? S.ac : f.ac === 'prep' ? S.acPrep : 0) + (f.ev ? S.ev : 0) + (it.market === 'new' ? S.newBuild : 0);
}
const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(rezidence|residence|bydleni|projekt|etapa|faze|i{1,3}|iv|v)\b/g, '').replace(/[^a-z0-9]/g, '');
function metres(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Same flat listed more than once (developer price list + Sreality, or several agencies on Sreality).
// Two developer price-list units are never the same flat: they are distinct units by definition.
function sameFlat(a, b) {
  if (a.source === 'flatzone' && b.source === 'flatzone') return false;
  if (!a.gps || !b.gps || a.layout !== b.layout || !a.area || !b.area) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return false;
  const bothSr = a.source === 'sreality' && b.source === 'sreality';
  const areaTol = bothSr ? 0.5 : cfg.dedupe.areaTolerance;     // agencies copy the same figure; developers vs portals round differently
  const priceTol = bothSr ? 0.01 : 0.05;
  if (Math.abs(a.area - b.area) > areaTol) return false;
  if (!a.price || !b.price || Math.abs(a.price - b.price) / Math.max(a.price, b.price) > priceTol) return false;
  return metres(a.gps, b.gps) <= cfg.dedupe.meters;
}
const SOURCE_RANK = { flatzone: 0, sreality: 1, novostavby: 2 };

function buildFeed() {
  if (feedCache) return feedCache;
  const evs = new Map();
  for (const e of q.eventsActive.all()) {
    if (!evs.has(e.listing_id)) evs.set(e.listing_id, []);
    evs.get(e.listing_id).push({ at: e.at, kind: e.kind, ...(e.detail ? JSON.parse(e.detail) : {}) });
  }
  const units = [], projects = [], fzProjectNames = new Set();
  const counts = { srealityCandidates: 0, srealityMatches: 0, flatzoneUnits: 0, flatzoneMatches: 0, novostavbyProjects: 0 };
  for (const row of q.activeAll.all()) {
    const it = JSON.parse(row.data);
    it.firstSeen = row.first_seen;
    it.history = evs.get(it.id) || [];
    if (it.source === 'novostavby') { projects.push(it); continue; }
    if (it.source === 'flatzone') { counts.flatzoneUnits++; fzProjectNames.add(norm(it.project)); } else counts.srealityCandidates++;
    const missing = cfg.filters.required.filter((r) => !it.features?.[r]);
    if (it.dateExcluded || missing.length) continue;
    if (it.price > cfg.filters.priceTo || (it.area && it.area < cfg.filters.areaFrom)) continue;
    counts[it.source === 'flatzone' ? 'flatzoneMatches' : 'srealityMatches']++;
    units.push(it);
  }

  // Cluster duplicates (union-find, bucketed by layout).
  const parent = units.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const hasFz = units.map((u) => u.source === 'flatzone');
  const byLayout = new Map();
  units.forEach((u, i) => { if (!byLayout.has(u.layout)) byLayout.set(u.layout, []); byLayout.get(u.layout).push(i); });
  for (const idx of byLayout.values())
    for (let x = 0; x < idx.length; x++)
      for (let y = x + 1; y < idx.length; y++)
        if (sameFlat(units[idx[x]], units[idx[y]])) {
          const rx = find(idx[x]), ry = find(idx[y]);
          if (rx === ry || (hasFz[rx] && hasFz[ry])) continue;   // never let a chain join two developer units
          parent[rx] = ry; hasFz[ry] = hasFz[ry] || hasFz[rx];
        }
  const clusters = new Map();
  units.forEach((u, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(u); });

  const items = [];
  let merged = 0;
  for (const group of clusters.values()) {
    // Canonical entry: the one seen first (keeps ratings stable), developer price list wins ties.
    group.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
    const main = group[0];
    if (group.length > 1) merged += group.length - 1;
    const history = group.flatMap((g) => g.history).sort((a, b) => a.at.localeCompare(b.at));
    const prices = history.filter((e) => e.kind === 'price');
    const changes = history.filter((e) => e.kind !== 'gone');
    const features = { ...main.features };
    for (const g of group) for (const k of ['parking', 'outdoor', 'cellar', 'ev']) features[k] = features[k] || g.features[k];
    if (group.some((g) => g.features.ac === 'yes')) features.ac = 'yes';
    else if (group.some((g) => g.features.ac === 'prep')) features.ac = 'prep';
    const out = { ...main, features };
    delete out.dateExcluded; delete out.key; delete out.v; delete out.gps;
    items.push({
      ...out,
      ids: group.map((g) => g.id),
      sources: group.map((g) => ({ id: g.id, source: g.source, link: g.link, price: g.price, developer: g.developer || null })),
      readyDate: group.map((g) => g.readyDate).find(Boolean) || null,
      verify: group.map((g) => g.verify).find(Boolean) || null,
      score: Math.max(...group.map((g) => scoreOf({ ...g, features }))),
      firstSeen: main.firstSeen.slice(0, 10),
      prevPrice: prices.length ? prices[prices.length - 1].from : null,
      changedAt: changes.length ? changes[changes.length - 1].at : main.firstSeen,
      history: history.slice(-6),
    });
  }
  // Developer projects already covered unit-by-unit by Flatzone are dropped.
  for (const p of projects) {
    const n = norm(p.title);
    const covered = n.length >= 5 && [...fzProjectNames].some((f) => f.length >= 5 && (f === n || f.includes(n) || n.includes(f)));
    if (covered) continue;
    counts.novostavbyProjects++;
    const changes = p.history.filter((e) => e.kind !== 'gone');
    delete p.key;
    items.push({ ...p, ids: [p.id], sources: [{ id: p.id, source: 'novostavby', link: p.link }], score: scoreOf(p),
      firstSeen: p.firstSeen.slice(0, 10), changedAt: changes.length ? changes[changes.length - 1].at : p.firstSeen, history: p.history.slice(-6) });
  }
  items.sort((a, b) => b.score - a.score || (a.pricePerM2 || 9e9) - (b.pricePerM2 || 9e9));
  const ok = q.lastOk.get();
  feedCache = {
    updated: ok ? ok.finished : null,
    criteria: { priceTo: cfg.filters.priceTo, areaFrom: cfg.filters.areaFrom, required: cfg.filters.required, latestCompletion: cfg.latestCompletion, moveInDeadline: cfg.moveInDeadline },
    stats: { ...counts, duplicatesMerged: merged },
    items,
  };
  return feedCache;
}

// ---------- scheduler ----------
let lastTick = null;
setInterval(() => {
  const now = new Date(), key = Math.floor(now.getTime() / 60000);
  if (key === lastTick) return;
  lastTick = key;
  if (matches(cron, now, cfg.timeZone) && !running) runUpdate('schedule').catch(() => {});
}, 15000).unref();

// ---------- http helpers ----------
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function whoIs(req) {
  if (cfg.userHeader && req.headers[cfg.userHeader]) return { user: String(req.headers[cfg.userHeader]).slice(0, 60), fromHeader: true };
  const picked = req.headers['x-reality-user'];
  if (picked && (!cfg.users.length || cfg.users.includes(String(picked)))) return { user: String(picked).slice(0, 60), fromHeader: false };
  return { user: null, fromHeader: false };
}
function requireUser(req) {
  const { user } = whoIs(req);
  if (!user) throw Object.assign(new Error('pick a name first'), { status: 401 });
  return user;
}
const validId = (s) => /^[a-z]{2}-[A-Za-z0-9_-]{1,40}$/.test(s);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') { const s = status(); return send(res, 200, { ok: true, running: !!s.running, lastOk: s.lastOk?.finished || null, nextRun: s.nextRun }); }
    if (req.method === 'GET' && p === '/api/feed') return send(res, 200, buildFeed());
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, { ...status(), recent: q.recentRuns.all().map((r) => ({ ...r, ok: !!r.ok, stats: r.stats && JSON.parse(r.stats) })) });
    if (req.method === 'POST' && p === '/api/run') {
      requireUser(req);
      const last = q.lastRun.get();
      if (last && Date.now() - Date.parse(last.started) < cfg.minRunGapMinutes * 60000) return send(res, 429, { error: `last update started less than ${cfg.minRunGapMinutes} minutes ago` });
      if (running) return send(res, 409, { error: 'an update is already running' });
      runUpdate('manual').catch(() => {});
      return send(res, 202, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n');
      res.write(`event: run\ndata: ${JSON.stringify(status())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && p === '/api/me') return send(res, 200, { ...whoIs(req), users: cfg.users, headerAuth: !!cfg.userHeader });
    if (req.method === 'GET' && p === '/api/notes') return send(res, 200, { ratings: q.ratings.all(), comments: q.comments.all() });

    let m;
    if ((m = p.match(/^\/api\/ratings\/([^/]+)$/)) && req.method === 'PUT') {
      const id = decodeURIComponent(m[1]); if (!validId(id)) return send(res, 400, { error: 'bad id' });
      const user = requireUser(req);
      const n = Number((await readJson(req)).stars);
      if (n === 0) q.delRating.run(id, user);
      else if (Number.isInteger(n) && n >= 1 && n <= 5) q.setRating.run(id, user, n);
      else return send(res, 400, { error: 'stars must be 0-5' });
      broadcast('notes', { id });
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/comments\/([^/]+)$/)) && req.method === 'POST') {
      const id = decodeURIComponent(m[1]); if (!validId(id)) return send(res, 400, { error: 'bad id' });
      const user = requireUser(req);
      const text = String((await readJson(req)).text || '').trim().slice(0, 2000);
      if (!text) return send(res, 400, { error: 'empty comment' });
      q.addComment.run(id, user, text);
      broadcast('notes', { id });
      return send(res, 201, { ok: true });
    }
    if ((m = p.match(/^\/api\/comments\/(\d+)$/)) && req.method === 'DELETE') {
      const user = requireUser(req);
      const row = q.getComment.get(Number(m[1]));
      if (!row) return send(res, 404, { error: 'not found' });
      if (row.user !== user) return send(res, 403, { error: 'only the author can delete' });
      q.delComment.run(Number(m[1]));
      broadcast('notes', {});
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'server error' });
  }
});

server.listen(cfg.port, () => {
  log(`reality on :${cfg.port}, data in ${cfg.dataDir}, schedule "${cfg.cron}" (${cfg.timeZone}), next ${status().nextRun}`);
  if (cfg.runOnStart && !q.lastOk.get()) setTimeout(() => runUpdate('first start').catch(() => {}), 2000);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
