// Servidor local demonstrativo: HTTP + SQLite nativos do Node.js 24.
// Antes de produção, substitua/avalie esta implementação com segurança profissional.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'clara-saude.sqlite');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_HOURS = 8;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Cria horários fictícios para a primeira demonstração. A equipe pode incluir outros.
if (db.prepare('SELECT COUNT(*) AS n FROM availability_slots').get().n === 0) {
  const addSlot = db.prepare('INSERT OR IGNORE INTO availability_slots (specialty_id, starts_at, duration_minutes) VALUES (?, ?, 30)');
  const specialties = db.prepare('SELECT id FROM specialties WHERE is_active = 1').all();
  const now = new Date();
  for (let offset = 1; offset <= 18; offset++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 12));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (const specialty of specialties) {
      for (const hour of [12, 15, 18]) { // 09h, 12h e 15h no fuso de Brasília/Fortaleza (UTC-3).
        const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour));
        addSlot.run(specialty.id, start.toISOString());
      }
    }
  }
}

// Conta de equipe opcional para demonstração. Nunca mantenha uma senha padrão em produção.
if (process.env.INITIAL_STAFF_EMAIL && process.env.INITIAL_STAFF_PASSWORD) {
  const email = process.env.INITIAL_STAFF_EMAIL.trim().toLowerCase();
  const password = process.env.INITIAL_STAFF_PASSWORD;
  if (password.length >= 12 && !db.prepare("SELECT id FROM users WHERE role = 'staff' LIMIT 1").get()) {
    const { encoded } = hashPassword(password);
    db.prepare("INSERT INTO users (role, full_name, email, phone, password_hash) VALUES ('staff', 'Equipe da clínica', ?, 'não informado', ?)")
      .run(email, encoded);
    console.log(`Conta inicial da equipe criada para ${email}.`);
  } else if (password.length < 12) {
    console.error('INITIAL_STAFF_PASSWORD deve ter ao menos 12 caracteres; conta da equipe não criada.');
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const failures = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return { encoded: `scrypt$${salt.toString('hex')}$${digest.toString('hex')}` };
}
function verifyPassword(password, encoded) {
  const [algorithm, saltHex, digestHex] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || !saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function getCookie(req, key) {
  const pair = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`));
  return pair ? decodeURIComponent(pair.slice(key.length + 1)) : '';
}
function cookieHeader(token, maxAge) {
  return `clara_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function sessionUser(req) {
  const token = getCookie(req, 'clara_session');
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT u.id, u.full_name, u.email, u.phone, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).get(hash);
  return row || null;
}
function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  res.setHeader('Set-Cookie', cookieHeader(token, SESSION_HOURS * 60 * 60));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 32_000) { reject(new Error('Pedido muito grande.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('JSON inválido.')); }
    });
    req.on('error', reject);
  });
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 180; }
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function requireUser(req, res, role) {
  const user = sessionUser(req);
  if (!user) { json(res, 401, { error: 'Entre na sua conta para continuar.' }); return null; }
  if (role && user.role !== role) { json(res, 403, { error: 'Você não tem permissão para esta ação.' }); return null; }
  return user;
}
function parseDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function api(req, res, url) {
  const method = req.method;
  const route = url.pathname;
  if (method !== 'GET' && !originAllowed(req)) return json(res, 403, { error: 'Origem não permitida.' });

  if (method === 'GET' && route === '/api/me') {
    const user = sessionUser(req);
    return user ? json(res, 200, { user }) : json(res, 200, { user: null });
  }
  if (method === 'POST' && route === '/api/register') {
    const body = await readJson(req);
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    const privacyAccepted = body.privacyAccepted === true;
    if (fullName.length < 2 || fullName.length > 100 || !validEmail(email) || phone.length < 8 || phone.length > 24 || password.length < 10 || password.length > 200 || !privacyAccepted) {
      return json(res, 400, { error: 'Confira nome, e-mail, telefone, senha (mínimo de 10 caracteres) e aceite o Aviso de Privacidade.' });
    }
    try {
      const { encoded } = hashPassword(password);
      const result = db.prepare("INSERT INTO users (role, full_name, email, phone, password_hash, privacy_notice_version, privacy_accepted_at) VALUES ('patient', ?, ?, ?, ?, '1.0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
        .run(fullName, email, phone, encoded);
      const userId = Number(result.lastInsertRowid);
      issueSession(userId, res);
      return json(res, 201, { user: db.prepare('SELECT id, full_name, email, phone, role FROM users WHERE id = ?').get(userId) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Este e-mail já tem cadastro. Entre na sua conta.' });
      throw error;
    }
  }
  if (method === 'POST' && route === '/api/login') {
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    const attempts = (failures.get(ip) || []).filter(time => now - time < 10 * 60 * 1000);
    if (attempts.length >= 10) return json(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const account = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (!account || !verifyPassword(password, account.password_hash)) {
      attempts.push(now); failures.set(ip, attempts);
      return json(res, 401, { error: 'E-mail ou senha não conferem.' });
    }
    failures.delete(ip);
    issueSession(account.id, res);
    return json(res, 200, { user: db.prepare('SELECT id, full_name, email, phone, role FROM users WHERE id = ?').get(account.id) });
  }
  if (method === 'POST' && route === '/api/logout') {
    const token = getCookie(req, 'clara_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && route === '/api/specialties') {
    return json(res, 200, { specialties: db.prepare('SELECT id, name FROM specialties WHERE is_active = 1 ORDER BY name').all() });
  }
  if (method === 'GET' && route === '/api/slots') {
    const specialtyId = Number(url.searchParams.get('specialtyId') || 0);
    const slots = db.prepare(`SELECT s.id, s.starts_at, s.duration_minutes, sp.id AS specialty_id, sp.name AS specialty
      FROM availability_slots s JOIN specialties sp ON sp.id = s.specialty_id
      WHERE sp.is_active = 1 AND s.starts_at > ?
        AND (? = 0 OR sp.id = ?)
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ('pending', 'confirmed'))
      ORDER BY s.starts_at LIMIT 250`).all(new Date().toISOString(), specialtyId, specialtyId);
    return json(res, 200, { slots });
  }
  if (method === 'POST' && route === '/api/appointments') {
    const user = requireUser(req, res, 'patient'); if (!user) return;
    const body = await readJson(req); const slotId = Number(body.slotId);
    if (!Number.isInteger(slotId) || slotId < 1) return json(res, 400, { error: 'Escolha um horário disponível.' });
    try {
      const slot = db.prepare('SELECT id FROM availability_slots WHERE id = ? AND starts_at > ?').get(slotId, new Date().toISOString());
      if (!slot) return json(res, 404, { error: 'Esse horário não está mais disponível.' });
      const result = db.prepare("INSERT INTO appointments (patient_id, slot_id, status) VALUES (?, ?, 'pending')").run(user.id, slotId);
      return json(res, 201, { appointmentId: Number(result.lastInsertRowid), message: 'Pedido enviado. A equipe precisa confirmar a consulta.' });
    } catch (error) {
      if (String(error.message).includes('appointments.slot_id')) return json(res, 409, { error: 'Outra pessoa acabou de solicitar esse horário. Escolha outro.' });
      throw error;
    }
  }
  if (method === 'GET' && route === '/api/appointments') {
    const user = requireUser(req, res); if (!user) return;
    const rows = user.role === 'staff'
      ? db.prepare(`SELECT a.id, a.status, a.created_at, u.full_name AS patient_name, u.email AS patient_email,
          u.phone AS patient_phone, sp.name AS specialty, s.starts_at, s.duration_minutes
          FROM appointments a JOIN users u ON u.id = a.patient_id JOIN availability_slots s ON s.id = a.slot_id
          JOIN specialties sp ON sp.id = s.specialty_id ORDER BY s.starts_at LIMIT 500`).all()
      : db.prepare(`SELECT a.id, a.status, a.created_at, sp.name AS specialty, s.starts_at, s.duration_minutes
          FROM appointments a JOIN availability_slots s ON s.id = a.slot_id JOIN specialties sp ON sp.id = s.specialty_id
          WHERE a.patient_id = ? ORDER BY s.starts_at DESC LIMIT 100`).all(user.id);
    return json(res, 200, { appointments: rows });
  }
  if (method === 'POST' && route === '/api/staff/slots') {
    const user = requireUser(req, res, 'staff'); if (!user) return;
    const body = await readJson(req); const specialtyId = Number(body.specialtyId); const startsAt = parseDate(body.startsAt);
    const duration = Number(body.durationMinutes || 30);
    if (!Number.isInteger(specialtyId) || !startsAt || startsAt <= new Date() || startsAt > new Date(Date.now() + 180 * 86400000) || !Number.isInteger(duration) || duration < 10 || duration > 240) {
      return json(res, 400, { error: 'Informe uma especialidade, data futura (até 180 dias) e duração de 10 a 240 minutos.' });
    }
    try {
      const result = db.prepare('INSERT INTO availability_slots (specialty_id, starts_at, duration_minutes, created_by) VALUES (?, ?, ?, ?)')
        .run(specialtyId, startsAt.toISOString(), duration, user.id);
      return json(res, 201, { slotId: Number(result.lastInsertRowid), message: 'Horário disponibilizado.' });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Já existe um horário desta especialidade neste instante.' });
      throw error;
    }
  }
  const confirmMatch = route.match(/^\/api\/staff\/appointments\/(\d+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    const user = requireUser(req, res, 'staff'); if (!user) return;
    const result = db.prepare("UPDATE appointments SET status = 'confirmed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'")
      .run(Number(confirmMatch[1]));
    return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Pedido pendente não encontrado.' });
  }
  return json(res, 404, { error: 'Rota não encontrada.' });
}

function serveStatic(req, res, url) {
  let filename = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (!['index.html', 'portal.html', 'styles.css', 'portal.css', 'script.js', 'portal.js'].includes(filename)) {
    res.writeHead(404); return res.end('Não encontrado');
  }
  const fullPath = path.join(ROOT, filename);
  fs.readFile(fullPath, (error, data) => {
    if (error) { res.writeHead(404); return res.end('Arquivo não encontrado'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fullPath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url);
    else json(res, 405, { error: 'Método não permitido.' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Ocorreu um erro interno. Tente novamente.' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Clara Saúde disponível em http://${HOST}:${PORT}`);
  console.log('Banco local: outputs/data/clara-saude.sqlite');
  if (!process.env.INITIAL_STAFF_EMAIL || !process.env.INITIAL_STAFF_PASSWORD) {
    console.log('Para criar o primeiro acesso da equipe, configure INITIAL_STAFF_EMAIL e INITIAL_STAFF_PASSWORD antes de iniciar.');
  }
});
