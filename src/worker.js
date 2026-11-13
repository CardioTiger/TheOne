/* Tagwerk Server: Login mit einem Passwort + ein Datenspeicher (Durable Object mit SQLite).
   Das Passwort steht nur als Secret APP_PASSWORD in Cloudflare, nie im Code. */
import { DurableObject } from 'cloudflare:workers';

const COOKIE = 'tw_session';
const SESSION_DAYS = 180;
const MAX_BODY = 2 * 1024 * 1024;
const enc = new TextEncoder();

/* ---------- Hilfen ---------- */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });

function b64url(buf) {
  let s = '';
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function makeSession(secret) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return exp + '.' + (await hmac(secret, 'tagwerk-session:' + exp));
}

async function validSession(req, secret) {
  const v = readCookie(req, COOKIE);
  const dot = v.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(v.slice(0, dot));
  if (!(exp > Date.now())) return false;
  return safeEqual(v.slice(dot + 1), await hmac(secret, 'tagwerk-session:' + exp));
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/* Anfragen, die Daten ändern, müssen von unserer eigenen Seite kommen. */
function sameOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return true;
  return o === new URL(req.url).origin;
}

/* ---------- Worker ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const store = env.STORE.get(env.STORE.idFromName('main'));

    if (!env.APP_PASSWORD || String(env.APP_PASSWORD).length < 8) {
      return json({ error: 'setup', message: 'Das Passwort ist noch nicht eingerichtet (Secret APP_PASSWORD, mindestens 8 Zeichen).' }, 503);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return json({ error: 'origin' }, 403);
    }

    if (path === '/api/login' && req.method === 'POST') {
      const ip = req.headers.get('cf-connecting-ip') || 'unknown';
      const wait = await store.lockedFor(ip);
      if (wait > 0) return json({ error: 'locked', wait }, 429, { 'retry-after': String(wait) });
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'bad' }, 400); }
      const pw = typeof body.password === 'string' ? body.password : '';
      if (!(await safeEqual(pw, String(env.APP_PASSWORD)))) {
        const w = await store.fail(ip);
        return json({ error: 'wrong', wait: w }, 401);
      }
      await store.clear(ip);
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader(await makeSession(String(env.APP_PASSWORD)), SESSION_DAYS * 86400) });
    }

    if (path === '/api/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
    }

    if (path === '/api/data') {
      if (!(await validSession(req, String(env.APP_PASSWORD)))) return json({ error: 'auth' }, 401);
      if (req.method === 'GET') return json(await store.read());
      if (req.method === 'PUT') {
        const text = await req.text();
        if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
        let body;
        try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad' }, 400); }
        if (!body || typeof body !== 'object' || !Number.isInteger(body.baseRev) ||
            !body.doc || !Array.isArray(body.doc.habits)) return json({ error: 'bad' }, 400);
        const res = await store.write(body.baseRev, JSON.stringify(body.doc));
        return json(res, res.conflict ? 409 : 200);
      }
      return json({ error: 'method' }, 405);
    }

    return json({ error: 'not_found' }, 404);
  }
};

/* ---------- Datenspeicher ---------- */
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS history (rev INTEGER PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS tries (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL, until INTEGER NOT NULL)');
  }

  read() {
    const r = this.ctx.storage.sql.exec('SELECT rev, body FROM doc WHERE id = 1').toArray()[0];
    if (!r) return { rev: 0, doc: { habits: [], dels: {} } };
    return { rev: r.rev, doc: JSON.parse(r.body) };
  }

  write(baseRev, body) {
    const sql = this.ctx.storage.sql;
    const cur = sql.exec('SELECT rev, body FROM doc WHERE id = 1').toArray()[0];
    const rev = cur ? cur.rev : 0;
    if (baseRev !== rev) return { conflict: true, rev, doc: cur ? JSON.parse(cur.body) : { habits: [], dels: {} } };
    const next = rev + 1, now = Date.now();
    /* Vorherigen Stand als Sicherheitskopie behalten (letzte 30 Stände). */
    if (cur) {
      sql.exec('INSERT OR REPLACE INTO history (rev, body, at) VALUES (?, ?, ?)', cur.rev, cur.body, now);
      sql.exec('DELETE FROM history WHERE rev <= ?', cur.rev - 30);
    }
    sql.exec('INSERT OR REPLACE INTO doc (id, rev, body, updated) VALUES (1, ?, ?, ?)', next, body, now);
    return { rev: next };
  }

  /* Bremse gegen Passwort-Raten: 5 Fehlversuche pro Adresse, dann 10 Minuten Sperre. */
  lockedFor(ip) {
    const r = this.ctx.storage.sql.exec('SELECT until FROM tries WHERE ip = ?', ip).toArray()[0];
    if (!r) return 0;
    return Math.max(0, Math.ceil((r.until - Date.now()) / 1000));
  }
  fail(ip) {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec('DELETE FROM tries WHERE until < ? AND first < ?', now, now - 900000);
    const r = sql.exec('SELECT n, first FROM tries WHERE ip = ?', ip).toArray()[0];
    let n = 1, first = now;
    if (r && now - r.first < 900000) { n = r.n + 1; first = r.first; }
    const until = n >= 5 ? now + 600000 : 0;
    sql.exec('INSERT OR REPLACE INTO tries (ip, n, first, until) VALUES (?, ?, ?, ?)', ip, n, first, until);
    return until ? 600 : 0;
  }
  clear(ip) {
    this.ctx.storage.sql.exec('DELETE FROM tries WHERE ip = ?', ip);
  }
}
