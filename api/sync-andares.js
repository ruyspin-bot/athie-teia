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

async function getDealsRecentes(hs, fullScan) {
  const deals = [];
  let after = undefined;

  // Sem full scan: só deals modificados nas últimas 2h (garante sobreposição com cron 15min)
  const cutoff = fullScan ? 0 : Date.now() - 2 * 60 * 60 * 1000;

  do {
    const body = {
      limit: 100,
      properties: ['dealname', 'hs_lastmodifieddate'],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      ...(after ? { after } : {}),
    };

    if (!fullScan) {
      body.filterGroups = [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: String(cutoff),
        }],
      }];
    }

    const res = await hs('/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify(body) });
    (res.results || []).forEach(d => deals.push(d.id));
    after = res.paging?.next?.after;
    if (after) await sleep(150);
  } while (after);

  return deals;
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

  const fullScan = req.query?.full === '1';
  console.log(`[sync-andares] iniciando — modo: ${fullScan ? 'FULL' : 'recente (2h)'}`);

  const hs = makeClient(token);

  try {
    const dealIds = await getDealsRecentes(hs, fullScan);
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
