/**
 * lib/auth.js
 * ------------------------------------------------------------------
 * Gate de senha compartilhada para o A Teia.
 *
 * A senha fica na env var APP_PASSWORD (configurar na Vercel:
 * Project Settings -> Environment Variables). O login (/api/login)
 * valida a senha e grava um cookie HttpOnly assinado; as rotas de
 * dados (ex.: /api/teia) exigem esse cookie. Assim a proteção é
 * feita NO SERVIDOR — não dá pra furar chamando a API direto nem
 * lendo o fonte da página.
 *
 * O valor do cookie é um HMAC-SHA256, então não é forjável sem
 * conhecer o segredo. Usa AUTH_SECRET se existir; senão deriva da
 * própria APP_PASSWORD (basta configurar APP_PASSWORD pra funcionar).
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');

const COOKIE_NAME = 'teia_auth';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 dias — depois disso, pede a senha de novo

function getSecret() {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || '';
}

// Token esperado no cookie. Constante enquanto a senha/segredo não mudarem;
// trocar APP_PASSWORD (ou AUTH_SECRET) invalida todos os cookies existentes.
function expectedToken() {
  const secret = getSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('athie-teia|v1').digest('hex');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// A senha compartilhada foi configurada?
function isConfigured() {
  return !!process.env.APP_PASSWORD;
}

// A requisição traz um cookie de sessão válido?
function isAuthed(req) {
  const expected = expectedToken();
  if (!expected) return false; // sem senha configurada, ninguém passa
  const got = parseCookies(req)[COOKIE_NAME];
  if (!got) return false;
  return timingSafeEqual(got, expected);
}

// Confere a senha enviada no login.
function passwordMatches(password) {
  const real = process.env.APP_PASSWORD || '';
  if (!real) return false;
  return timingSafeEqual(password || '', real);
}

// Header Set-Cookie de sessão (após login bem-sucedido).
function sessionCookie() {
  const token = expectedToken();
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

// Header Set-Cookie que apaga a sessão (logout).
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  isConfigured,
  isAuthed,
  passwordMatches,
  sessionCookie,
  clearCookie,
};
