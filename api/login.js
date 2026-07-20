/**
 * /api/login
 * ------------------------------------------------------------------
 * POST { password } — confere a senha compartilhada (APP_PASSWORD) e,
 * se bater, grava o cookie de sessão. As rotas de dados exigem esse
 * cookie (ver lib/auth.js).
 *
 * GET — só informa se a senha já foi configurada e se o cookie atual
 * é válido, pra o frontend decidir se mostra a tela de senha.
 * ------------------------------------------------------------------
 */
const { isConfigured, isAuthed, passwordMatches, sessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    res.status(200).json({ configured: isConfigured(), authed: isAuthed(req) });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: 'Senha de acesso ainda não configurada (APP_PASSWORD).' });
    return;
  }

  // body pode vir como objeto (Vercel parseia JSON) ou string
  let password = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    password = body.password || '';
  } catch {
    password = '';
  }

  if (!passwordMatches(password)) {
    res.status(401).json({ error: 'Senha incorreta.' });
    return;
  }

  res.setHeader('Set-Cookie', sessionCookie());
  res.status(200).json({ ok: true });
};
