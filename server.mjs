// WhatsApp bridge for the Namaste booking site.
//
// Holds one WhatsApp session, linked by scanning a QR exactly like WhatsApp
// Web, and sends plain-text booking messages for the site. The booking site
// runs on Vercel (serverless), which can't keep a socket open, so this lives
// on an always-on box and the site calls it over HTTPS.
//
// Env:
//   WA_BRIDGE_SECRET  required; the site sends it as "Authorization: Bearer <secret>"
//   PORT              default 8090
//   DATABASE_URL      Postgres (Supabase) to keep the WhatsApp login in, so it
//                     survives restarts on hosts with a throwaway disk (Render free).
//   WA_AUTH_DIR       without DATABASE_URL, the login is kept in this folder (default ./auth)

import http from 'node:http';
import { rm } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import postgres from 'postgres';
import { usePgAuthState } from './pg-auth.mjs';

const PORT = Number(process.env.PORT) || 8090;
const SECRET = process.env.WA_BRIDGE_SECRET || '';
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth';
// prepare:false so it also works through Supabase's transaction pooler (port 6543).
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { prepare: false, max: 3, onnotice: () => {} }) : null;
const GAP_MS = 2500; // pause between sends so the number doesn't look like a spam bot

if (SECRET.length < 16) {
  console.error('WA_BRIDGE_SECRET must be set (16+ characters).');
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || 'warn' });

/** state: starting | scan | connected | reconnecting | logged_out */
let sock = null;
let state = 'starting';
let qrDataUrl = null;
let me = null;
let lastError = null;
// Recent /health hits (the Supabase keep-alive ping), newest first, for /status.
const pings = [];
const bootedAt = new Date();

async function start() {
  const store = sql ? await usePgAuthState(sql) : await useMultiFileAuthState(AUTH_DIR);
  const { state: auth, saveCreds } = store;
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    version,
    auth,
    logger: log,
    browser: Browsers.windows('Namaste Studio'),
    markOnlineOnConnect: false, // don't stop the phone getting notifications
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      state = 'scan';
      qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
    }
    if (u.connection === 'open') {
      state = 'connected';
      qrDataUrl = null;
      lastError = null;
      me = (sock.user?.id || '').split(':')[0].split('@')[0];
      console.log(`[wa] connected as ${me}`);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      lastError = u.lastDisconnect?.error?.message || null;
      me = null;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: wipe the session so a fresh QR appears.
        console.log('[wa] logged out, waiting for a new QR scan');
        state = 'logged_out';
        if (sql) await store.clear();
        else await rm(AUTH_DIR, { recursive: true, force: true });
      } else {
        state = 'reconnecting';
      }
      setTimeout(() => start().catch((e) => console.error('[wa] restart failed', e)), 3000);
    }
  });
}

/* ── sending, one at a time ─────────────────────────────────────────── */

let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.then(() => sleep(GAP_MS), () => sleep(GAP_MS));
  return run;
}

/** Text, or a picture (by https URL) with the text as its caption. */
async function sendMessage(to, text, image) {
  if (state !== 'connected' || !sock) return { ok: false, status: 503, error: `WhatsApp not connected (${state})` };
  const [hit] = await sock.onWhatsApp(to);
  if (!hit?.exists) return { ok: false, status: 404, error: `${to} is not on WhatsApp` };
  await sock.sendMessage(hit.jid, image ? { image: { url: image }, caption: text } : { text });
  return { ok: true };
}

/* ── HTTP ───────────────────────────────────────────────────────────── */

function authed(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      pings.unshift({ at: new Date().toISOString(), from: String(req.headers['user-agent'] || '').slice(0, 60) });
      pings.length = Math.min(pings.length, 6);
      return reply(res, 200, { ok: true });
    }
    if (!authed(req)) return reply(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/status') {
      return reply(res, 200, { state, qr: qrDataUrl, me, error: lastError, store: sql ? 'postgres' : 'files', upSince: bootedAt.toISOString(), pings });
    }
    if (req.method === 'POST' && req.url === '/send') {
      const { to, text, image } = await readJson(req);
      const digits = String(to || '').replace(/\D/g, '');
      if (digits.length < 11 || !text) return reply(res, 400, { error: 'need to (with country code) and text' });
      const img = typeof image === 'string' && /^https?:\/\//.test(image) ? image : undefined;
      const r = await enqueue(() => sendMessage(digits, String(text).slice(0, 4000), img));
      return reply(res, r.ok ? 200 : r.status, r);
    }
    if (req.method === 'POST' && req.url === '/logout') {
      // Unlink this number; the close handler wipes the session and shows a new QR.
      await sock?.logout().catch(() => {});
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[http]', e);
    return reply(res, 500, { error: e instanceof Error ? e.message : 'failed' });
  }
});

server.listen(PORT, () => console.log(`[wa] bridge listening on :${PORT} (login kept in ${sql ? 'Postgres' : AUTH_DIR})`));
start().catch((e) => {
  console.error('[wa] start failed', e);
  process.exit(1);
});
