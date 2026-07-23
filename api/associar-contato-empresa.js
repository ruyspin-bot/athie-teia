/**
 * /api/associar-contato-empresa
 * ------------------------------------------------------------------
 * Duas regras de auto-associação de Contatos a Empresas:
 *
 *   A) POR DOMÍNIO (contato criado / e-mail alterado)
 *      Se o núcleo do domínio do e-mail bate com o de UMA empresa,
 *      associa. Tolerante a TLD: paloaltonetworks.com  ==  .com.br
 *      (compara o "core" do domínio, não a string inteira).
 *
 *   B) POR NEGÓCIO (contato adicionado a um Deal — deal.associationChange)
 *      Associa os contatos do Deal à empresa "Cliente Final" (ou primária)
 *      do próprio Deal. Direto, não depende de domínio. É o caso Palo Alto.
 *      Só nesse sentido (deal→empresa); NÃO espalha contatos da empresa
 *      pelos deals (o que causava super-associação).
 *
 * SALVAGUARDAS: ignora domínios genéricos; se >1 empresa casa o core,
 * pula (ambíguo); idempotente.
 *
 * WEBHOOKS (mesmo /api/webhook): Contato·creation, Contato·propertyChange(email),
 * Negócio·associationChange.
 *
 * GET (varredura manual, CRON_SECRET): ?modo=dominio|deals [&limit=N]
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  chunk,
  getObjectsById,
  getAssociations,
  batchCreateAssociations,
  listAllObjects,
} = require('../lib/hubspot');

const TYPE_CONTACT_COMPANY = 1; // HUBSPOT_DEFINED contato → empresa
const LABEL_CLIENTE_FINAL = /cliente\s*final/i;

const DOMINIOS_GENERICOS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'protonmail.com', 'proton.me', 'terra.com.br', 'uol.com.br', 'bol.com.br', 'ig.com.br', 'globo.com',
  'globomail.com', 'zipmail.com.br', 'r7.com',
]);
// Labels de sufixo público a remover para achar o "core" do domínio.
const SUFIXOS = new Set(['com', 'br', 'net', 'org', 'edu', 'gov', 'co', 'io', 'me', 'app', 'live', 'coop', 'biz', 'inc', 'ltda', 'com.br']);

const dominioDeEmail = (email) => {
  const m = String(email || '').trim().toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : null;
};
// "core" do domínio: última label após remover sufixos públicos.
// paloaltonetworks.com.br → paloaltonetworks · its.jnj.com → jnj
const coreDominio = (dom) => {
  if (!dom) return null;
  const labels = String(dom).toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  while (labels.length > 1 && SUFIXOS.has(labels[labels.length - 1])) labels.pop();
  return labels[labels.length - 1] || null;
};

/* ------------------------------------------------------------------
 * Índice de empresas por core de domínio (cacheado ~5min p/ não
 * reconstruir a cada evento). Só ~dezenas de empresas têm domínio.
 * ------------------------------------------------------------------ */
let _idx = null; let _idxTs = 0;
async function indiceEmpresasPorCore(hs) {
  if (_idx && Date.now() - _idxTs < 5 * 60 * 1000) return _idx;
  const idx = {}; // core -> Set(companyId)
  let after;
  do {
    const body = { filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'HAS_PROPERTY' }] }], properties: ['name', 'domain'], limit: 100 };
    if (after) body.after = after;
    const r = await hs('/crm/v3/objects/companies/search', { method: 'POST', body: JSON.stringify(body) });
    (r.results || []).forEach((c) => {
      const core = coreDominio(c.properties.domain);
      if (core) (idx[core] = idx[core] || new Set()).add(c.id);
    });
    after = r.paging?.next?.after;
  } while (after);
  _idx = idx; _idxTs = Date.now();
  return idx;
}

/* ------------------------------------------------------------------
 * REGRA A — por domínio (tolerante a TLD)
 * ------------------------------------------------------------------ */
async function associarPorDominio(hs, contactIds) {
  if (!contactIds.length) return { contatos: 0, associados: 0, ambiguos: 0, sem_match: 0 };
  const [contatos, jaAssoc, idx] = await Promise.all([
    getObjectsById(hs, 'contacts', contactIds, ['email']),
    getAssociations(hs, 'contacts', 'companies', contactIds),
    indiceEmpresasPorCore(hs),
  ]);

  const stats = { contatos: contactIds.length, associados: 0, ambiguos: 0, sem_match: 0 };
  const pares = [];
  for (const id of contactIds) {
    const dom = dominioDeEmail(contatos[id]?.properties?.email);
    if (!dom || DOMINIOS_GENERICOS.has(dom)) { stats.sem_match++; continue; }
    const empresas = idx[coreDominio(dom)];
    if (!empresas || empresas.size === 0) { stats.sem_match++; continue; }
    if (empresas.size > 1) { stats.ambiguos++; continue; } // core batido por várias empresas
    const companyId = [...empresas][0];
    const jaLigado = (jaAssoc[id] || []).some((a) => String(a.toId) === String(companyId));
    if (!jaLigado) pares.push({ fromId: id, toId: companyId });
  }
  if (pares.length) { await batchCreateAssociations(hs, 'contacts', 'companies', pares, TYPE_CONTACT_COMPANY); stats.associados = pares.length; }
  return stats;
}

/* ------------------------------------------------------------------
 * REGRA B — contatos do Deal → empresa Cliente Final (ou primária)
 * ------------------------------------------------------------------ */
async function associarContatosDoDeal(hs, dealIds) {
  if (!dealIds.length) return { deals: 0, associados: 0 };
  const [dealContacts, dealCompanies] = await Promise.all([
    getAssociations(hs, 'deals', 'contacts', dealIds),
    getAssociations(hs, 'deals', 'companies', dealIds),
  ]);
  // contatos já ligados às empresas-alvo (p/ idempotência)
  const alvoPorDeal = {};
  for (const dealId of dealIds) {
    const comps = dealCompanies[dealId] || [];
    const alvo = comps.find((c) => LABEL_CLIENTE_FINAL.test(c.label)) || comps.find((c) => c.isPrimary) || comps[0];
    if (alvo) alvoPorDeal[dealId] = alvo.toId;
  }
  const companyIds = [...new Set(Object.values(alvoPorDeal))];
  const companyContacts = companyIds.length ? await getAssociations(hs, 'companies', 'contacts', companyIds) : {};

  const pares = [];
  for (const dealId of dealIds) {
    const companyId = alvoPorDeal[dealId];
    if (!companyId) continue;
    const jaNaEmpresa = new Set((companyContacts[companyId] || []).map((a) => String(a.toId)));
    for (const ca of (dealContacts[dealId] || [])) {
      if (!jaNaEmpresa.has(String(ca.toId))) { pares.push({ fromId: ca.toId, toId: companyId }); jaNaEmpresa.add(String(ca.toId)); }
    }
  }
  if (pares.length) await batchCreateAssociations(hs, 'contacts', 'companies', pares, TYPE_CONTACT_COMPANY);
  return { deals: dealIds.length, associados: pares.length };
}

/* ------------------------------------------------------------------
 * Handler — POST (webhook) e GET (varredura, CRON_SECRET)
 * ------------------------------------------------------------------ */
module.exports = async (req, res) => {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { res.status(500).json({ error: 'Faltou HUBSPOT_TOKEN.' }); return; }
    const hs = makeClient(token);

    if (req.method === 'POST') {
      const eventos = Array.isArray(req.body) ? req.body : [];
      const tipo = eventos[0]?.subscriptionType || '';
      if (/deal\.associationChange/i.test(tipo)) {
        const dealIds = [...new Set(eventos.map((e) => String(e.objectId || e.fromObjectId)).filter((id) => id && id !== 'undefined'))];
        const r = await associarContatosDoDeal(hs, dealIds);
        res.status(200).json({ recebido: true, ...r, rodado_em: new Date().toISOString() });
        return;
      }
      const contactIds = [...new Set(eventos.map((e) => String(e.objectId)).filter((id) => id && id !== 'undefined'))];
      const r = await associarPorDominio(hs, contactIds);
      res.status(200).json({ recebido: true, ...r, rodado_em: new Date().toISOString() });
      return;
    }

    // GET — varredura
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers['authorization'] || '';
      const provided = auth.replace(/^Bearer\s+/i, '') || req.query.secret;
      if (provided !== secret) { res.status(401).json({ error: 'Não autorizado.' }); return; }
    }
    const modo = req.query.modo || 'dominio';
    const limite = parseInt(req.query.limit || '0', 10);

    if (modo === 'deals') {
      const todos = await listAllObjects(hs, 'deals', ['dealname']);
      let ids = todos.map((d) => d.id); if (limite > 0) ids = ids.slice(0, limite);
      const agg = { deals: 0, associados: 0 };
      for (const lote of chunk(ids, 100)) { const r = await associarContatosDoDeal(hs, lote); agg.deals += r.deals; agg.associados += r.associados; }
      res.status(200).json({ modo, ...agg, rodado_em: new Date().toISOString() });
      return;
    }

    const todos = await listAllObjects(hs, 'contacts', ['email']);
    let ids = todos.map((c) => c.id); if (limite > 0) ids = ids.slice(0, limite);
    const agg = { contatos: 0, associados: 0, ambiguos: 0, sem_match: 0 };
    for (const lote of chunk(ids, 100)) { const r = await associarPorDominio(hs, lote); agg.contatos += r.contatos; agg.associados += r.associados; agg.ambiguos += r.ambiguos; agg.sem_match += r.sem_match; }
    res.status(200).json({ modo: 'dominio', ...agg, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/associar-contato-empresa] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao associar contato/empresa.' });
  }
};

module.exports.associarPorDominio = associarPorDominio;
module.exports.associarContatosDoDeal = associarContatosDoDeal;
module.exports.coreDominio = coreDominio;
module.exports.dominioDeEmail = dominioDeEmail;
