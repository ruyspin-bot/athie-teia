/**
 * /api/associar-contatos
 * ------------------------------------------------------------------
 * Mantém contatos sincronizados bidirecionalmente entre Deals e a
 * empresa com rótulo "Cliente Final".
 *
 * REGRAS:
 *   1. Empresa associada ao Deal (deal.associationChange)
 *      → todos os Contatos da empresa são associados ao Deal.
 *
 *   2. Contato associado ao Deal (deal.associationChange)
 *      → o Contato é associado à empresa "Cliente Final" do Deal.
 *
 *   3. Contato associado a uma Empresa (contact.associationChange)
 *      → o Contato é associado a todos os Deals onde essa empresa
 *        tem rótulo "Cliente Final".
 *
 * WEBHOOKS necessários no HubSpot (mesmo endpoint, eventos diferentes):
 *   • Objeto: Negócio  · Evento: associationChange
 *   • Objeto: Contato  · Evento: associationChange
 *
 * MODO GET (manual): percorre todos os deals ativos e aplica as 3
 * regras de forma idempotente.
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  chunk,
  getAssociations,
  getActiveDeals,
  getClosedStageIds,
  batchCreateAssociations,
} = require('../lib/hubspot');

const LABEL_CLIENTE_FINAL = /cliente\s*final/i;

// typeId HUBSPOT_DEFINED para as associações padrão
const TYPE_DEAL_CONTACT    = 3;  // deal → contact
const TYPE_CONTACT_COMPANY = 1;  // contact → company (primary)

/* ------------------------------------------------------------------
 * Sincroniza um conjunto de Deals:
 *  - Contatos das companies → Deal
 *  - Contatos do Deal → empresa Cliente Final
 * ------------------------------------------------------------------ */
async function syncPorDeals(hs, dealIds) {
  if (!dealIds.length) return { deals: 0, associacoes: 0 };

  const [companyAssoc, dealContactAssoc] = await Promise.all([
    getAssociations(hs, 'deals', 'companies', dealIds),
    getAssociations(hs, 'deals', 'contacts', dealIds),
  ]);

  const allCompanyIds = [...new Set(
    Object.values(companyAssoc).flatMap((arr) => arr.map((a) => a.toId))
  )];
  const companyContactAssoc = allCompanyIds.length
    ? await getAssociations(hs, 'companies', 'contacts', allCompanyIds)
    : {};

  const dealToContact = [];   // pares a criar  deal → contact
  const contactToCompany = []; // pares a criar  contact → company

  for (const dealId of dealIds) {
    const companies     = companyAssoc[dealId]     || [];
    const jaNosDeal     = new Set((dealContactAssoc[dealId] || []).map((a) => a.toId));
    const clienteFinal  = companies.find((c) => LABEL_CLIENTE_FINAL.test(c.label));

    // Regra 1 — contatos de todas as companies → deal
    for (const comp of companies) {
      for (const ca of (companyContactAssoc[comp.toId] || [])) {
        if (!jaNosDeal.has(ca.toId)) {
          dealToContact.push({ fromId: dealId, toId: ca.toId });
          jaNosDeal.add(ca.toId); // evita duplicar dentro do mesmo loop
        }
      }
    }

    // Regra 2 — contatos já no deal → empresa Cliente Final
    if (clienteFinal) {
      const jaNaEmpresa = new Set(
        (companyContactAssoc[clienteFinal.toId] || []).map((a) => a.toId)
      );
      for (const ca of (dealContactAssoc[dealId] || [])) {
        if (!jaNaEmpresa.has(ca.toId)) {
          contactToCompany.push({ fromId: ca.toId, toId: clienteFinal.toId });
          jaNaEmpresa.add(ca.toId);
        }
      }
    }
  }

  const criados = dealToContact.length + contactToCompany.length;
  await Promise.all([
    batchCreateAssociations(hs, 'deals', 'contacts', dealToContact, TYPE_DEAL_CONTACT),
    batchCreateAssociations(hs, 'contacts', 'companies', contactToCompany, TYPE_CONTACT_COMPANY),
  ]);

  return { deals: dealIds.length, associacoes: criados };
}

/* ------------------------------------------------------------------
 * Regra 3 — Contato adicionado a uma Empresa:
 * associa o contato a todos os deals onde a empresa é Cliente Final.
 * ------------------------------------------------------------------ */
async function syncPorContatos(hs, contactIds) {
  if (!contactIds.length) return { contatos: 0, associacoes: 0 };

  const contactCompanyAssoc = await getAssociations(hs, 'contacts', 'companies', contactIds);
  const allCompanyIds = [...new Set(
    Object.values(contactCompanyAssoc).flatMap((arr) => arr.map((a) => a.toId))
  )];
  if (!allCompanyIds.length) return { contatos: contactIds.length, associacoes: 0 };

  const companyDealAssoc = await getAssociations(hs, 'companies', 'deals', allCompanyIds);

  // Filtra deals onde a empresa é Cliente Final
  // (a associação company→deal herda o mesmo rótulo de deal→company)
  const dealIds = [...new Set(
    Object.values(companyDealAssoc).flatMap((arr) =>
      arr.filter((a) => LABEL_CLIENTE_FINAL.test(a.label)).map((a) => a.toId)
    )
  )];
  if (!dealIds.length) return { contatos: contactIds.length, associacoes: 0 };

  // Contatos já associados a esses deals
  const dealContactAssoc = await getAssociations(hs, 'deals', 'contacts', dealIds);

  const toCreate = [];
  for (const contactId of contactIds) {
    const empresas = (contactCompanyAssoc[contactId] || []).map((a) => a.toId);
    for (const dealId of dealIds) {
      const jaNosDeal = new Set((dealContactAssoc[dealId] || []).map((a) => a.toId));
      // verifica se alguma empresa do contato é Cliente Final neste deal
      const empresaEhClienteFinalNoDeal = allCompanyIds.some((cId) =>
        empresas.includes(cId) &&
        (companyDealAssoc[cId] || []).some(
          (a) => a.toId === dealId && LABEL_CLIENTE_FINAL.test(a.label)
        )
      );

      if (empresaEhClienteFinalNoDeal && !jaNosDeal.has(contactId)) {
        toCreate.push({ fromId: dealId, toId: contactId });
        jaNosDeal.add(contactId);
      }
    }
  }

  await batchCreateAssociations(hs, 'deals', 'contacts', toCreate, TYPE_DEAL_CONTACT);
  return { contatos: contactIds.length, associacoes: toCreate.length };
}

/* ------------------------------------------------------------------
 * Handler principal
 * ------------------------------------------------------------------ */
module.exports = async (req, res) => {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { res.status(500).json({ error: 'Faltou configurar HUBSPOT_TOKEN.' }); return; }

    const hs = makeClient(token);

    // ---- modo webhook (POST) ----
    if (req.method === 'POST') {
      const eventos = Array.isArray(req.body) ? req.body : [];
      if (!eventos.length) { res.status(200).json({ recebido: true }); return; }

      const tipo = eventos[0]?.subscriptionType || '';

      if (/deal\.associationChange/i.test(tipo)) {
        const dealIds = [...new Set(eventos.map((e) => String(e.objectId)).filter(Boolean))];
        const resultado = await syncPorDeals(hs, dealIds);
        res.status(200).json({ recebido: true, ...resultado, rodado_em: new Date().toISOString() });
        return;
      }

      if (/contact\.associationChange/i.test(tipo)) {
        const contactIds = [...new Set(eventos.map((e) => String(e.objectId)).filter(Boolean))];
        const resultado = await syncPorContatos(hs, contactIds);
        res.status(200).json({ recebido: true, ...resultado, rodado_em: new Date().toISOString() });
        return;
      }

      res.status(200).json({ recebido: true, ignorado: true, tipo });
      return;
    }

    // ---- modo GET manual ----
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers['authorization'] || '';
      const provided = auth.replace(/^Bearer\s+/i, '') || req.query.secret;
      if (provided !== secret) { res.status(401).json({ error: 'Não autorizado.' }); return; }
    }

    const closedStageIds = await getClosedStageIds(hs);
    const allDeals = await getActiveDeals(hs, ['dealname', 'dealstage']);
    const dealIds = allDeals
      .filter((d) => !closedStageIds.has(d.properties?.dealstage))
      .map((d) => d.id);

    const resultado = await syncPorDeals(hs, dealIds);
    res.status(200).json({ ...resultado, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/associar-contatos] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao associar contatos.' });
  }
};

module.exports.syncPorDeals    = syncPorDeals;
module.exports.syncPorContatos = syncPorContatos;
