'use strict';
/*
  Taxi céges rendelések – szerver
  Node.js / Express + MongoDB (MongoDB Atlas ingyenes csomag)

  Szükséges környezeti változók:
    MONGODB_URI   – MongoDB kapcsolati string (kötelező)
    SESSION_SECRET – hosszú véletlen szöveg (ajánlott, ha nincs, generálódik)
    ADMIN_USER    – admin felhasználónév (alap: admin)
    ADMIN_PASSWORD – az admin jelszava (alap: admin123 – azonnal cseréld!)
    ADMIN_EMAIL   – a jelszó-emlékeztető címzettje (alap: citytaxifehervar@cititaxfehervar.hu)
    BREVO_API_KEY – Brevo API kulcs (ha nincs, a levelek csak naplóba kerülnek)
    MAIL_FROM     – feladó e-mail (Brevo-ban hitelesített cím)
    TRUST_PROXY   – állítsd 1-re, ha proxy mögött fut (Render: 1)
*/
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'taxi_rendelesek';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_IDLE_MIN = Number(process.env.SESSION_IDLE_MIN || 120); // inaktivitás után kijelentkezés
const SESSION_ABS_DAYS = Number(process.env.SESSION_ABS_DAYS || 30);   // "emlékezz rám" felső korlát
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'citytaxifehervar@cititaxfehervar.hu';
const IS_PROD = !!process.env.RENDER || process.env.NODE_ENV === 'production';

if (!URI) { console.error('HIBA: hiányzik a MONGODB_URI környezeti változó.'); process.exit(1); }

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(express.json({ limit: '200kb' }));

// ---------- biztonsági fejlécek ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'");
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// ---------- adatbázis ----------
let db, col;
(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);
  col = db.collection('kartoteka');
  await col.createIndex({ kind: 1, date: 1 });
  await col.createIndex({ kind: 1, time: 1 });
  await db.collection('settings').createIndex({ _id: 1 });
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  const idx = await col.indexes().catch(() => []);
  if (!idx.some(i => i.key && i.key.textIndexVersion)) {
    await col.createIndex(
      { 'fields.from.value': 'text', 'fields.to.value': 'text', 'fields.stops.value': 'text',
        'fields.company.value': 'text', 'fields.orderedBy.value': 'text', 'fields.passengers.value': 'text' },
      { name: 'kereses' }).catch(() => {});
  }
  await seed();
  app.listen(PORT, () => console.log('Taxi rendelések fut, port: ' + PORT));
})().catch(e => { console.error('Indítási hiba:', e.message); process.exit(1); });

async function seed() {
  const users = db.collection('users');
  if (await users.countDocuments() === 0) {
    await users.insertOne({
      username: process.env.ADMIN_USER || 'admin',
      name: process.env.ADMIN_NAME || 'Adminisztrátor',
      email: ADMIN_EMAIL,
      admin: true,
      pw: await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12),
      createdAt: new Date()
    });
    console.log('Admin létrehozva: ' + (process.env.ADMIN_USER || 'admin'));
  }
  const st = db.collection('settings');
  if (!await st.findOne({ _id: 'app' })) {
    await st.insertOne({
      _id: 'app',
      colors: [
        { name: 'Halvány kék', hex: '#dbeafe', label: 'Módosulhat' },
        { name: 'Halvány piros', hex: '#fee2e2', label: 'Hiányzó információ' },
        { name: 'Halvány sárga', hex: '#fef3c7', label: 'Összevont fuvar' },
        { name: 'Halvány szürke', hex: '#e5e7eb', label: 'Dátum módosítás' }
      ],
      sound: 1,
      beepSeconds: 5,
      keepBeeping: false,
      years: [2027]
    });
  }
}

// ---------- session ----------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeToken(user, remember) {
  const sid = crypto.randomBytes(18).toString('hex');
  const exp = Date.now() + (remember ? SESSION_ABS_DAYS * 864e5 : 864e5);
  const p = { u: user, sid, exp: remember ? exp : 0, abs: exp };
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + sign(b);
}
function readToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const [b, s] = decodeURIComponent(m[1]).split('.');
  if (!b || !s || sign(b) !== s) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; }
}
function setCookie(res, val, maxAgeMs) {
  const parts = ['sid=' + encodeURIComponent(val), 'HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (IS_PROD) parts.push('Secure');
  if (maxAgeMs) parts.push('Max-Age=' + Math.floor(maxAgeMs / 1000));
  res.setHeader('Set-Cookie', parts.join('; '));
}
async function auth(req, res, next) {
  const p = readToken(req);
  if (!p || p.abs < Date.now()) return res.status(401).json({ error: 'Bejelentkezés szükséges' });
  const user = await db.collection('users').findOne({ username: p.u });
  if (!user) return res.status(401).json({ error: 'Bejelentkezés szükséges' });
  // csúsztatott lejárat: aktív használatnál nem jár le
  const remaining = p.exp ? Math.max(0, p.exp - Date.now()) : 0;
  if (p.exp && remaining < (SESSION_ABS_DAYS * 864e5) - 60000) {
    p.exp = Math.min(Date.now() + SESSION_ABS_DAYS * 864e5, p.exp + 60000);
    const b = Buffer.from(JSON.stringify(p)).toString('base64url');
    setCookie(res, b + '.' + sign(b), p.exp - Date.now());
  }
  req.user = user;
  next();
}

// ---------- bejelentkezés elleni védelem ----------
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Túl sok próbálkozás. Próbálja újra 30 perc múlva.' }
});
const attempts = new Map(); // kulcs: ip|felhasználó -> {n, blockedUntil}
const MAX_ATTEMPTS = 5, BLOCK_MS = 30 * 60 * 1000;

app.post('/api/login', loginLimiter, async (req, res) => {
  const ip = req.ip || 'ismeretlen';
  const username = String(req.body.username || '').trim();
  const key = ip + '|' + username.toLowerCase();
  const a = attempts.get(key);
  if (a && a.blockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Túl sok hibás próbálkozás. Próbálja újra ' + Math.ceil((a.blockedUntil - Date.now()) / 60000) + ' perc múlva.' });
  }
  const user = await db.collection('users').findOne({ username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
  const ok = user ? await bcrypt.compare(String(req.body.password || ''), user.pw) : await bcrypt.compare(String(req.body.password || ''), '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!ok) {
    const n = (a ? a.n : 0) + 1;
    attempts.set(key, { n, blockedUntil: n >= MAX_ATTEMPTS ? Date.now() + BLOCK_MS : 0 });
    return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó' + (n >= MAX_ATTEMPTS ? '' : ' (' + (MAX_ATTEMPTS - n) + ' próbálkozás maradt)') });
  }
  attempts.delete(key);
  const remember = !!req.body.remember;
  const token = makeToken(user.username, remember);
  setCookie(res, token, remember ? SESSION_ABS_DAYS * 864e5 : 864e5);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });

// ---------- jelszó-emlékeztető ----------
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5 });
async function sendMail(to, subject, text) {
  const key = process.env.BREVO_API_KEY;
  if (!key) { console.log('[MAIL – nincs Brevo kulcs]\nCímzett: ' + to + '\nTárgy: ' + subject + '\n' + text); return; }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM || ADMIN_EMAIL, name: 'Taxi rendelések' },
      to: [{ email: to }], subject, textContent: text
    })
  });
  if (!r.ok) console.error('Brevo hiba:', r.status, await r.text());
}
const tokens = new Map(); // token -> {user, exp}
app.post('/api/forgot', forgotLimiter, async (req, res) => {
  const who = String(req.body.username || '').trim();
  const user = await db.collection('users').findOne({ username: new RegExp('^' + who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
  if (user) {
    const t = crypto.randomBytes(32).toString('hex');
    tokens.set(t, { user: user.username, exp: Date.now() + 60 * 60 * 1000 });
    const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
    await sendMail(user.email || ADMIN_EMAIL, 'Jelszó visszaállítás – Taxi rendelések',
      'Kedves ' + (user.name || user.username) + '!\n\nÚj jelszó beállításához nyissa meg ezt a hivatkozást (1 óráig érvényes):\n' +
      base + '/#reset=' + t + '\n\nHa nem Ön kérte, hagyja figyelmen kívül ezt a levelet.');
  }
  res.json({ ok: true, message: 'Ha létezik ilyen felhasználó, elküldtük a visszaállítási hivatkozást a regisztrált e-mail-címére.' });
});
app.post('/api/reset', async (req, res) => {
  const e = tokens.get(String(req.body.token || ''));
  if (!e || e.exp < Date.now()) return res.status(400).json({ error: 'A hivatkozás lejárt vagy érvénytelen.' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'A jelszó legalább 8 karakter legyen.' });
  await db.collection('users').updateOne({ username: e.user }, { $set: { pw: await bcrypt.hash(String(req.body.password), 12) } });
  tokens.delete(String(req.body.token));
  res.json({ ok: true });
});

// ---------- segédek ----------
const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const huNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Budapest' }).replace(' ', 'T');

// ---------- bejelentkezett felület ----------
const api = express.Router();
api.use((req, res, next) => { next(); });
api.use(auth);

api.get('/me', (req, res) => res.json({
  username: req.user.username, name: req.user.name, admin: !!req.user.admin, now: huNow()
}));
api.post('/heartbeat', (req, res) => res.json({ ok: true, now: huNow() }));

api.get('/settings', async (req, res) => res.json(await db.collection('settings').findOne({ _id: 'app' })));
api.put('/settings', async (req, res) => {
  const b = req.body || {};
  const colors = Array.isArray(b.colors) ? b.colors.slice(0, 40).map(c => ({
    name: str(c.name, 60), hex: /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : '#eeeeee', label: str(c.label, 80)
  })) : undefined;
  const upd = {};
  if (colors) upd.colors = colors;
  if ([1, 2, 3, 4].includes(Number(b.sound))) upd.sound = Number(b.sound);
  if (b.beepSeconds !== undefined) upd.beepSeconds = Math.max(1, Math.min(300, Number(b.beepSeconds) || 5));
  if (b.keepBeeping !== undefined) upd.keepBeeping = !!b.keepBeeping;
  await db.collection('settings').updateOne({ _id: 'app' }, { $set: upd });
  res.json(await db.collection('settings').findOne({ _id: 'app' }));
});

api.get('/years', async (req, res) => {
  const st = await db.collection('settings').findOne({ _id: 'app' });
  const years = (st.years || []).slice().sort((a, b) => a - b);
  const rows = await col.aggregate([
    { $match: { kind: 'order' } },
    { $group: { _id: '$date', n: { $sum: 1 } } }
  ]).toArray();
  const counts = {}, notes = {};
  rows.forEach(r => counts[r._id] = r.n);
  const nrows = await col.aggregate([{ $match: { kind: 'note' } }, { $group: { _id: '$date', n: { $sum: 1 } } }]).toArray();
  nrows.forEach(r => notes[r._id] = r.n);
  res.json({ years, counts, notes });
});
api.post('/years', async (req, res) => {
  const y = parseInt(req.body.year, 10);
  if (!(y >= 2000 && y <= 2100)) return res.status(400).json({ error: 'Érvénytelen év (2000–2100)' });
  await db.collection('settings').updateOne({ _id: 'app' }, { $addToSet: { years: y } });
  res.json({ ok: true });
});

function cleanFields(f) {
  f = f || {};
  const g = (k, max) => ({ value: str(f[k] && f[k].value, max), modified: !!(f[k] && f[k].modified), history: str(f[k] && f[k].history, 1000) });
  return {
    time: g('time', 5), from: g('from'), to: g('to'), stops: g('stops'),
    passengers: g('passengers'), payment: g('payment', 40), note: g('note', 600),
    driver: g('driver', 60), colorId: g('colorId', 60),
    company: g('company', 200), orderedBy: g('orderedBy', 120), orderedOn: g('orderedOn', 10)
  };
}
function cleanOrder(b) {
  const f = cleanFields(b.fields);
  if (!DATE_RE.test(str(b.date))) throw new Error('Hibás dátum');
  if (!TIME_RE.test(f.time.value)) throw new Error('Hibás időpont (óó:pp)');
  if (!f.from.value || !f.to.value) throw new Error('A kiinduló és az érkezési helyszín kötelező');
  const doc = {
    kind: 'order', date: str(b.date, 10), time: f.time.value,
    fields: f,
    checked: !!b.checked, called: !!b.called, bold: !!b.bold,
    notify: b.notify ? { on: !!b.notify.on, hour: str(b.notify.hour, 2), minute: str(b.notify.minute, 2), note: str(b.notify.note, 300) } : { on: false },
    updatedAt: huNow()
  };
  return doc;
}
function cleanNote(b) {
  const f = cleanFields(b.fields);
  if (!DATE_RE.test(str(b.date))) throw new Error('Hibás dátum');
  if (!f.note.value) throw new Error('A megjegyzés nem lehet üres');
  if (f.time.value && !TIME_RE.test(f.time.value)) throw new Error('Hibás időpont (óó:pp)');
  return {
    kind: 'note', date: str(b.date, 10), time: f.time.value,
    fields: f,
    notify: b.notify ? { on: !!b.notify.on, hour: str(b.notify.hour, 2), minute: str(b.notify.minute, 2), note: str(b.notify.note, 300) } : { on: false },
    updatedAt: huNow()
  };
}

api.get('/items', async (req, res) => {
  const date = req.query.date;
  let q;
  if (date) {
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Hibás dátum' });
    q = { date };
  } else if (req.query.from && req.query.to) {
    q = { date: { $gte: str(req.query.from, 10), $lte: str(req.query.to, 10) } };
  } else return res.status(400).json({ error: 'Hiányzó dátum' });
  res.json(await col.find(q).toArray());
});

api.post('/items', async (req, res) => {
  const b = req.body || {};
  const doc = b.kind === 'note' ? cleanNote(b) : cleanOrder(b);
  Object.assign(doc, {
    id: crypto.randomUUID(), createdBy: req.user.name, createdAt: huNow(),
    history: Array.isArray(b.history) ? b.history : []
  });
  await col.insertOne(doc);
  res.json(doc);
});
api.put('/items/:id', async (req, res) => {
  const b = req.body || {};
  const old = await col.findOne({ id: req.params.id });
  if (!old) return res.status(404).json({ error: 'Nem található' });
  const doc = old.kind === 'note' ? cleanNote(b) : cleanOrder(b);
  doc.id = old.id; doc.kind = old.kind;
  doc.createdBy = old.createdBy; doc.createdAt = old.createdAt;
  doc.updatedBy = req.user.name; doc.updatedAt = huNow();
  doc.history = Array.isArray(b.history) ? b.history : (old.history || []);
  await col.replaceOne({ id: old.id }, doc);
  res.json(doc);
});
api.delete('/items/:id', async (req, res) => {
  const r = await col.deleteOne({ id: req.params.id });
  res.json({ ok: r.deletedCount === 1 });
});

// ---------- kereső (az egész évre) ----------
api.get('/search', async (req, res) => {
  const q = str(req.query.q, 120);
  const from = str(req.query.from, 10), to = str(req.query.to, 10);
  const date = {};
  if (from && DATE_RE.test(from)) date.$gte = from;
  if (to && DATE_RE.test(to)) date.$lte = to;
  const f = {};
  if (q) f.$text = { $search: q };
  if (Object.keys(date).length) f.date = date;
  const out = await col.find(f, q ? { score: { $meta: 'textScore' } } : {})
    .sort(q ? { score: { $meta: 'textScore' }, time: 1 } : { time: 1 })
    .limit(300).toArray();
  out.sort((a, b) => a.date === b.date ? String(a.time || '').localeCompare(String(b.time || '')) : a.date.localeCompare(b.date));
  res.json(out);
});

// ---------- infók ----------
api.get('/notes', async (req, res) => {
  const q = str(req.query.q, 120);
  const f = { kind: 'note' };
  if (q) f['fields.note.value'] = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const out = await col.find(f).sort({ date: -1 }).limit(500).toArray();
  out.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  res.json(out);
});

// ---------- kiszolgálás ----------
const { spawn } = require('child_process');
let child = null;
api.post('/restart', (req, res) => { res.json({ ok: true }); child = spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore' }); child.unref(); setTimeout(() => process.exit(0), 400); });

app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use((req, res) => res.status(404).json({ error: 'Ismeretlen kérés' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Szerverhiba' }); });
