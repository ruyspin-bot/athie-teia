/**
 * /api/sync-andares
 * ------------------------------------------------------------------
 * Cron job: roda a cada 15 min e associa automaticamente o Andar ao
 * Deal sempre que um Conjunto estiver vinculado mas o Andar não.
 *
 * Lógica:
 *   1. Busca deals ativos (últimas 24h modificados OU sem andar algum)
 *   2. Para cada deal: compara Conjuntos vs Andares já associados
 *   3. Se falta Andar → busca Andar pai do Conjunto → associa
 *
 * Também chamável manualmente:
 *   POST /api/sync-andares          → roda para deals modificados recentemente
 *   POST /api/sync-andares?full=1   → varre TODOS os deals (lento)
 * ------------------------------------------------------------------
 */

const { makeClient } = require('../lib/hubspot');

const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';
const CRON_SECRET  = process.env.CRON_SECRET || '';

// USER_DEFINED typeId 92 ("Negócio") — tipo correto Deal→Andar no portal ATIE
const DEAL_ANDAR_ASSOC = [{ associationCategory: 'USER_DEFINED', associationTypeId: 92 }];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pagina todos os Deals e retorna só os IDs que têm Conjunto associado
// mas ainda não têm Andar. Deals são muito menos que Conjuntos (~21k).
async function getDealsComConjuntoSemAndar(hs) {
  const pendentes = [];
  let after = undefined;

  do {
    const res = await hs(`/crm/v3/objects/deals?limit=100${after ? `&after=${after}` : ''}`);
    const dealIds = (res.results || []).map(d => d.id);

    if (dealIds.length) {
      // Batch read: Conjunto e Andar de cada deal em paralelo
      const [conjAssoc, andarAssoc] = await Promise.all([
        hs(`/crm/v4/associations/deals/${OBJ_CONJUNTO}/batch/read`, {
          method: 'POST',
          body: JSON.stringify({ inputs: dealIds.map(id => ({ id })) }),
        }),
        hs(`/crm/v4/associations/deals/${OBJ_ANDAR}/batch/read`, {
          method: 'POST',
          body: JSON.stringify({ inputs: dealIds.map(id => ({ id })) }),
        }),
      ]);

      const conjPorDeal  = {};
      const andarPorDeal = {};
      for (const r of (conjAssoc.results  || [])) conjPorDeal[r.from.id]  = (r.to||[]).map(t => String(t.toObjectId));
      for (const r of (andarAssoc.results || [])) andarPorDeal[r.from.id] = (r.to||[]).map(t => String(t.toObjectId));

      for (const dealId of dealIds) {
        const temConjunto = (conjPorDeal[dealId]  || []).length > 0;
        const temAndar    = (andarPorDeal[dealId] || []).length > 0;
        if (temConjunto && !temAndar) pendentes.push(dealId);
      }
    }

    after = res.paging?.next?.after;
    if (after) await sleep(100);
  } while (after);

  return pendentes;
}

async function syncDeal(hs, dealId) {
  // Busca Conjuntos e Andares já associados ao deal em paralelo
  const [conjRes, andarRes] = await Promise.all([
    hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_CONJUNTO}`),
    hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_ANDAR}`),
  ]);

  const conjuntos     = (conjRes.results  || []).map(r => String(r.toObjectId));
  const andaresAtuais = new Set((andarRes.results || []).map(r => String(r.toObjectId)));

  if (!conjuntos.length) return { skipped: true };

  let created = 0;
  const erros = [];

  for (const conjuntoId of conjuntos) {
    try {
      const res    = await hs(`/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}`);
      const andares = (res.results || []).map(r => String(r.toObjectId));

      for (const andarId of andares) {
        if (andaresAtuais.has(andarId)) continue; // já associado

        await hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_ANDAR}/${andarId}`, {
          method: 'PUT',
          body: JSON.stringify(DEAL_ANDAR_ASSOC),
        });
        andaresAtuais.add(andarId);
        created++;
      }
    } catch (err) {
      erros.push(`conj ${conjuntoId}: ${err.message.slice(0, 100)}`);
    }
  }

  return { conjuntos: conjuntos.length, created, erros };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // Verifica autenticação — cron da Vercel envia Authorization: Bearer <CRON_SECRET>
  // chamadas manuais podem omitir se CRON_SECRET não estiver configurado
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'HUBSPOT_TOKEN missing' }); return; }

  // Aceita dealId específico para testes pontuais
  const specificDeal = req.query?.dealId || (req.body && req.body.dealId);
  console.log(`[sync-andares] iniciando — ${specificDeal ? `deal específico: ${specificDeal}` : 'via conjuntos com deal'}`);

  const hs = makeClient(token);

  try {
    const dealIds = specificDeal ? [String(specificDeal)] : await getDealsComConjuntoSemAndar(hs);
    console.log(`[sync-andares] ${dealIds.length} deals para verificar`);

    let totalCreated = 0, totalSkipped = 0, totalErros = 0;

    for (const dealId of dealIds) {
      const r = await syncDeal(hs, dealId);
      if (r.skipped) { totalSkipped++; continue; }
      totalCreated += r.created || 0;
      totalErros   += (r.erros || []).length;
      if (r.created) console.log(`[sync-andares] deal ${dealId}: +${r.created} andares`);
      await sleep(100);
    }

    console.log(`[sync-andares] concluído — ${totalCreated} associações criadas, ${totalSkipped} deals sem conjunto, ${totalErros} erros`);
    res.status(200).json({ ok: true, deals: dealIds.length, created: totalCreated, skipped: totalSkipped, erros: totalErros });
  } catch (err) {
    console.error('[sync-andares] erro:', err);
    res.status(502).json({ error: err.message });
  }
};
