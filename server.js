// reality — tiny listing board: static page, feed ingest, shared ratings + comments, live updates.
// Zero npm dependencies: Node 22+ built-ins only (http, fs, node:sqlite).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || '/data';
const PUBLIC = path.join(__dirname, 'public');
const FEED = path.join(DATA, 'feed.json');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const USER_HEADER = (process.env.USER_HEADER || '').toLowerCase();   // e.g. x-authentik-username
const USERS = (process.env.USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const FEED_POLL_MS = Number(process.env.FEED_POLL_MS || 15000);
const MAX_FEED = 20 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'reality.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS ratings (
    listing_id TEXT NOT NULL, user TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    updated TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (listing_id, user));
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL, user TEXT NOT NULL,
    text TEXT NOT NULL, created TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS comments_listing ON comments (listing_id);
`);
const q = {
  ratings: db.prepare('SELECT listing_id, user, stars, updated FROM ratings'),
  comments: db.prepare('SELECT id, listing_id, user, text, created FROM comments ORDER BY id'),
  setRating: db.prepare(`INSERT INTO ratings (listing_id, user, stars) VALUES (?, ?, ?)
    ON CONFLICT (listing_id, user) DO UPDATE SET stars = excluded.stars, updated = datetime('now')`),
  delRating: db.prepare('DELETE FROM ratings WHERE listing_id = ? AND user = ?'),
  addComment: db.prepare('INSERT INTO comments (listing_id, user, text) VALUES (?, ?, ?)'),
  getComment: db.prepare('SELECT user FROM comments WHERE id = ?'),
  delComment: db.prepare('DELETE FROM comments WHERE id = ?'),
};

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// Feed changes from any source (HTTP ingest, SMB/NFS writes, manual copy) are picked up by polling mtime.
// Polling, not inotify: inotify does not see writes made through network filesystems.
function feedInfo() {
  try { const st = fs.statSync(FEED); return { mtime: st.mtimeMs, size: st.size }; } catch { return null; }
}
const stampOf = (i) => (i ? `${i.mtime}:${i.size}` : null);
let feedStamp = stampOf(feedInfo());
function checkFeed() {
  const info = feedInfo(), stamp = stampOf(info);
  if (stamp !== feedStamp) { feedStamp = stamp; if (info) broadcast('feed', { mtime: info.mtime }); }
}
setInterval(checkFeed, FEED_POLL_MS).unref();

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function whoIs(req) {
  if (USER_HEADER && req.headers[USER_HEADER]) return { user: String(req.headers[USER_HEADER]).slice(0, 60), fromHeader: true };
  const picked = req.headers['x-reality-user'];
  if (picked && (!USERS.length || USERS.includes(String(picked)))) return { user: String(picked).slice(0, 60), fromHeader: false };
  return { user: null, fromHeader: false };
}
function requireUser(req) {
  const { user } = whoIs(req);
  if (!user) throw Object.assign(new Error('pick a name first'), { status: 401 });
  return user;
}
const tokenOk = (req) => {
  const h = String(req.headers.authorization || '');
  const got = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(INGEST_TOKEN);
  return INGEST_TOKEN && got.length === want.length && crypto.timingSafeEqual(got, want);
};
const validId = (s) => /^[a-z]{2}-[A-Za-z0-9_-]{1,40}$/.test(s);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, feed: feedInfo() });

    if (req.method === 'GET' && p === '/feed.json') {
      if (!fs.existsSync(FEED)) return send(res, 404, { error: 'no feed yet' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return fs.createReadStream(FEED).pipe(res);
    }

    if (req.method === 'PUT' && p === '/api/feed') {
      if (!tokenOk(req)) return send(res, 401, { error: 'bad token' });
      const buf = await readBody(req, MAX_FEED);
      let parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      if (!parsed || !Array.isArray(parsed.items)) return send(res, 400, { error: 'expected {items: [...]}' });
      const tmp = FEED + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, FEED);   // atomic: readers never see a half-written file
      checkFeed();
      return send(res, 200, { ok: true, items: parsed.items.length });
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/me') return send(res, 200, { ...whoIs(req), users: USERS, headerAuth: !!USER_HEADER });

    if (req.method === 'GET' && p === '/api/notes') return send(res, 200, { ratings: q.ratings.all(), comments: q.comments.all() });

    let m;
    if ((m = p.match(/^\/api\/ratings\/([^/]+)$/)) && req.method === 'PUT') {
      const id = decodeURIComponent(m[1]); if (!validId(id)) return send(res, 400, { error: 'bad id' });
      const user = requireUser(req);
      const { stars } = await readJson(req);
      const n = Number(stars);
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

    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'server error' });
  }
});
server.listen(PORT, () => console.log(`reality listening on :${PORT}, data in ${DATA}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
