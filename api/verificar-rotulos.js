/**
 * /api/verificar-rotulos
 * ------------------------------------------------------------------
 * Dois modos:
 *
 * 1. GET (cron / manual) — verifica TODOS os deals ativos.
 *
 * 2. POST (webhook HubSpot) — dispara quando uma associação de deal
 *    é criada/editada (evento deal.associationChange). Verifica apenas
 *    os deals recebidos no payload, tornando a remoção da tag instantânea
 *    quando o vendedor atribui o rótulo correto.
 *
 * Regra:
 *   - Deal SEM nenhuma Company associada → não mexe.
 *   - Deal com Company associada e QUALQUER uma sem rótulo → tag = true.
 *   - Deal com todas as Companies rotuladas → tag = false.
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  getClosedStageIds,
  getActiveDeals,
  getObjectsById,
  getDealCompanyAssociations,
  batchUpdateDeals,
} = require('../lib/hubspot');

const TAG_PROPERTY = process.env.HUBSPOT_PROP_ROTULO_PENDENTE || 'aw_rotulo_pendente';

async function verificarDeals(hs, deals) {
  if (!deals.length) return { verificados: 0, marcados: 0, desmarcados: 0, sem_mudanca: 0 };

  const dealIds = deals.map((d) => d.id);
  const associationsByDeal = await getDealCompanyAssociations(hs, dealIds);

  let marcados = 0;
  let desmarcados = 0;
  let semMudanca = 0;
  const updates = [];

  for (const d of deals) {
    const assocs = associationsByDeal[d.id] || [];
    const temAssociacao = assocs.length > 0;
    const temRotuloFaltando = assocs.some((a) => !a.label || !a.label.trim());
    const precisaTag = temAssociacao && temRotuloFaltando;

    const valorAtual = String((d.properties || {})[TAG_PROPERTY] || 'false').toLowerCase() === 'true';

    if (valorAtual === precisaTag) { semMudanca++; continue; }

    updates.push({ id: d.id, properties: { [TAG_PROPERTY]: precisaTag ? 'true' : 'false' } });
    if (precisaTag) marcados++;
    else desmarcados++;
  }

  await batchUpdateDeals(hs, updates);
  return { verificados: deals.length, marcados, desmarcados, sem_mudanca: semMudanca };
}

module.exports = async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.method === 'GET') {
      const auth = req.headers['authorization'] || '';
      const provided = auth.replace(/^Bearer\s+/i, '') || req.query.secret;
      if (provided !== secret) { res.status(401).json({ error: 'Não autorizado.' }); return; }
    }

    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { res.status(500).json({ error: 'Faltou configurar HUBSPOT_TOKEN.' }); return; }

    const hs = makeClient(token);

    // ---- modo webhook (POST do HubSpot — deal.associationChange) ----
    if (req.method === 'POST') {
      const eventos = Array.isArray(req.body) ? req.body : [];
      const dealIds = [...new Set(eventos.map((e) => String(e.objectId)).filter(Boolean))];
      if (!dealIds.length) { res.status(200).json({ recebido: true, verificados: 0 }); return; }

      const dealsById = await getObjectsById(hs, 'deals', dealIds, ['dealname', 'dealstage', TAG_PROPERTY]);
      const deals = Object.values(dealsById);
      const resultado = await verificarDeals(hs, deals);
      res.status(200).json({ recebido: true, ...resultado, rodado_em: new Date().toISOString() });
      return;
    }

    // ---- modo cron / GET manual — verifica todos ----
    const closedStageIds = await getClosedStageIds(hs);
    const allDeals = await getActiveDeals(hs, ['dealname', 'dealstage', TAG_PROPERTY]);
    const deals = allDeals.filter((d) => !closedStageIds.has(d.properties?.dealstage));

    const resultado = await verificarDeals(hs, deals);
    res.status(200).json({ ...resultado, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/verificar-rotulos] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao verificar rótulos.' });
  }
};

module.exports.verificarDeals = verificarDeals;
