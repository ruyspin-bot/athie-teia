/**
 * /api/workflow-andar
 * ------------------------------------------------------------------
 * Chamado por um Workflow HubSpot quando um Conjunto é associado a
 * um Deal. Busca o(s) Andar(es) pai(s) dos Conjuntos do deal e
 * cria a associação Deal→Andar automaticamente.
 *
 * POST body (enviado pelo Workflow):
 *   { "dealId": "12345678" }
 *   — ou qualquer payload que contenha hs_object_id / objectId / dealId
 *
 * URL a configurar no Workflow HubSpot:
 *   https://athie-teia-aewo.vercel.app/api/workflow-andar
 * ------------------------------------------------------------------
 */

const { makeClient } = require('../lib/hubspot');

const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';

// USER_DEFINED typeId 92 ("Negócio") — tipo correto Deal→Andar no portal ATIE
const DEAL_ANDAR_ASSOC = [{ associationCategory: 'USER_DEFINED', associationTypeId: 92 }];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'HUBSPOT_TOKEN missing' }); return; }

  // Extrai o dealId do payload — HubSpot Workflows pode enviar em vários formatos
  const body    = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const dealId  = String(body.dealId || body.hs_object_id || body.objectId || '').trim();

  console.log('[workflow-andar] body recebido:', JSON.stringify(body));

  if (!dealId) {
    res.status(400).json({ error: 'dealId ausente no payload' });
    return;
  }

  const hs = makeClient(token);

  try {
    // 1. Busca Conjuntos associados ao Deal
    const conjRes = await hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_CONJUNTO}`);
    const conjuntos = (conjRes.results || []).map(r => String(r.toObjectId));
    console.log(`[workflow-andar] deal ${dealId} → ${conjuntos.length} conjuntos: ${conjuntos.join(', ')}`);

    if (!conjuntos.length) {
      res.status(200).json({ ok: true, dealId, conjuntos: 0, andares: 0 });
      return;
    }

    // 2. Para cada Conjunto, busca o Andar pai
    let created = 0;
    const erros = [];

    for (const conjuntoId of conjuntos) {
      try {
        const andarRes = await hs(`/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}`);
        const andares  = (andarRes.results || []).map(r => String(r.toObjectId));

        for (const andarId of andares) {
          try {
            await hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_ANDAR}/${andarId}`, {
              method: 'PUT',
              body: JSON.stringify(DEAL_ANDAR_ASSOC),
            });
            created++;
            console.log(`[workflow-andar] ✅ deal ${dealId} → andar ${andarId} (via conjunto ${conjuntoId})`);
          } catch (err) {
            erros.push(`andar ${andarId}: ${err.message}`);
          }
        }
      } catch (err) {
        erros.push(`conjunto ${conjuntoId}: ${err.message}`);
      }
    }

    res.status(200).json({ ok: true, dealId, conjuntos: conjuntos.length, andares: created, erros });
  } catch (err) {
    console.error('[workflow-andar] erro:', err);
    res.status(502).json({ error: err.message });
  }
};
