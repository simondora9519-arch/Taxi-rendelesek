// Taxi céges rendelések – szerver (nincs külső függőség, Node.js 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 30;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function hash(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verify(pw, stored) {
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
}

let db;
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
else {
  db = {
    years: [2027],
    users: [{ username: 'admin', name: 'Adminisztrátor', admin: true, pw: hash(process.env.ADMIN_PASSWORD || 'admin123') }],
    orders: [],
    sessions: {}
  };
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}
save();

// --- élő frissítés (Server-Sent Events) ---
const clients = new Set();
function broadcast(ev) {
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(msg);
}

function budapestNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Budapest' }).replace(' ', 'T');
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1)); });
  return o;
}
function currentUser(req) {
  const sid = cookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.expires < Date.now()) return null;
  return db.users.find(u => u.username === s.username) || null;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const PAY = ['Készpénz', 'Bankkártya', 'Utalás'];
function cleanOrder(b) {
  const o = {
    date: str(b.date, 10), time: str(b.time, 5), from: str(b.from), to: str(b.to),
    orderedOn: str(b.orderedOn, 10), orderedBy: str(b.orderedBy, 100), company: str(b.company, 150),
    payment: PAY.includes(b.payment) ? b.payment : '', note: str(b.note, 500)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('Hibás dátum');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) throw new Error('Hibás időpont (óó:pp)');
  if (!o.from || !o.to) throw new Error('A kiinduló és érkezési helyszín kötelező');
  if (!o.payment) throw new Error('Válasszon fizetési módot');
  return o;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      let f = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      return fs.createReadStream(f).pipe(res);
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      const u = db.users.find(x => x.username.toLowerCase() === str(b.username).toLowerCase());
      if (!u || !verify(String(b.password || ''), u.pw)) return send(res, 401, { error: 'Hibás felhasználónév vagy jelszó' });
      const sid = crypto.randomBytes(32).toString('hex');
      const days = b.remember ? SESSION_DAYS : 1;
      db.sessions[sid] = { username: u.username, expires: Date.now() + days * 864e5 };
      for (const k in db.sessions) if (db.sessions[k].expires < Date.now()) delete db.sessions[k];
      save();
      const maxAge = b.remember ? `; Max-Age=${days * 86400}` : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/${maxAge}` });
    }
    if (p === '/api/logout') {
      delete db.sessions[cookies(req).sid]; save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }

    const user = currentUser(req);
    if (!user) return send(res, 401, { error: 'Bejelentkezés szükséges' });

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (p === '/api/me') return send(res, 200, { username: user.username, name: user.name, admin: !!user.admin, now: budapestNow() });

    if (p === '/api/years') {
      if (req.method === 'GET') {
        const counts = {};
        db.orders.forEach(o => counts[o.date] = (counts[o.date] || 0) + 1);
        return send(res, 200, { years: db.years.slice().sort(), counts });
      }
      if (req.method === 'POST') {
        const y = parseInt((await body(req)).year, 10);
        if (!(y >= 2000 && y <= 2100)) return send(res, 400, { error: 'Érvénytelen év (2000–2100)' });
        if (!db.years.includes(y)) { db.years.push(y); save(); broadcast({ type: 'years' }); }
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/orders' && req.method === 'GET') {
      const d = url.searchParams.get('date');
      const list = db.orders.filter(o => o.date === d).sort((a, b) => a.time.localeCompare(b.time));
      return send(res, 200, list);
    }
    if (p === '/api/orders' && req.method === 'POST') {
      const o = cleanOrder(await body(req));
      Object.assign(o, { id: crypto.randomUUID(), createdBy: user.name, createdAt: budapestNow() });
      db.orders.push(o); save(); broadcast({ type: 'orders', date: o.date });
      return send(res, 200, o);
    }
    const m = p.match(/^\/api\/orders\/([\w-]+)$/);
    if (m) {
      const i = db.orders.findIndex(o => o.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'Nem található' });
      if (req.method === 'PUT') {
        const old = db.orders[i];
        const o = cleanOrder(await body(req));
        db.orders[i] = { ...old, ...o, updatedBy: user.name, updatedAt: budapestNow() };
        save(); broadcast({ type: 'orders', date: o.date }); broadcast({ type: 'orders', date: old.date });
        return send(res, 200, db.orders[i]);
      }
      if (req.method === 'DELETE') {
        const [o] = db.orders.splice(i, 1); save(); broadcast({ type: 'orders', date: o.date });
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/password' && req.method === 'POST') {
      const b = await body(req);
      if (!verify(String(b.old || ''), user.pw)) return send(res, 400, { error: 'A jelenlegi jelszó hibás' });
      if (String(b.new || '').length < 6) return send(res, 400, { error: 'Az új jelszó legalább 6 karakter legyen' });
      user.pw = hash(String(b.new)); save();
      return send(res, 200, { ok: true });
    }

    // felhasználók kezelése (csak admin)
    if (p.startsWith('/api/users')) {
      if (!user.admin) return send(res, 403, { error: 'Csak adminisztrátor' });
      if (req.method === 'GET') return send(res, 200, db.users.map(u => ({ username: u.username, name: u.name, admin: !!u.admin })));
      if (req.method === 'POST') {
        const b = await body(req);
        const un = str(b.username, 40);
        if (!/^[\w.\-]{3,40}$/.test(un)) return send(res, 400, { error: 'Felhasználónév: 3–40 karakter, ékezet és szóköz nélkül' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'A jelszó legalább 6 karakter' });
        const ex = db.users.find(u => u.username.toLowerCase() === un.toLowerCase());
        if (ex) { ex.pw = hash(String(b.password)); ex.name = str(b.name, 80) || ex.name; ex.admin = !!b.admin; }
        else db.users.push({ username: un, name: str(b.name, 80) || un, admin: !!b.admin, pw: hash(String(b.password)) });
        save(); return send(res, 200, { ok: true });
      }
      const um = p.match(/^\/api\/users\/(.+)$/);
      if (um && req.method === 'DELETE') {
        const un = decodeURIComponent(um[1]);
        if (un === user.username) return send(res, 400, { error: 'Saját magát nem törölheti' });
        db.users = db.users.filter(u => u.username !== un);
        for (const k in db.sessions) if (db.sessions[k].username === un) delete db.sessions[k];
        save(); return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'Ismeretlen kérés' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Hiba' });
  }
}).listen(PORT, () => console.log(`Taxi rendelések fut: http://localhost:${PORT}`));
