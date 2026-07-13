/**
 * /api/webhook
 * ------------------------------------------------------------------
 * Roteador central — HubSpot aceita apenas UMA URL de destino por
 * Private App. Este endpoint recebe todos os eventos e despacha para
 * a lógica correta com base em subscriptionType.
 *
 * Eventos tratados:
 *   object.propertyChange (andares_ocupados_pelo_cliente)
 *     → criar-andares: cria Andares do Edifício alterado
 *
 *   deal.associationChange
 *     → verificar-rotulos: atualiza tag aw_rotulo_pendente
 *     → associar-contatos: sincroniza contatos das companies com o deal
 *
 *   contact.associationChange
 *     → associar-contatos: associa contato aos deals da empresa Cliente Final
 *
 * URL a configurar no HubSpot (única):
 *   https://athie-teia-aewo.vercel.app/api/webhook
 * ------------------------------------------------------------------
 */

const { makeClient, getObjectsById } = require('../lib/hubspot');
const { handleWebhookPost }                        = require('./criar-andares');
const { verificarDeals, rotularClientesFinal }     = require('./verificar-rotulos');
const { syncPorDeals, syncPorContatos }            = require('./associar-contatos');

const OBJ_EDIFICIO          = process.env.HUBSPOT_OBJECT_EDIFICIO || '2-65603861';
const PROP_EDIFICIO_ANDARES = process.env.HUBSPOT_PROP_EDIFICIO_ANDARES || 'andares_ocupados_pelo_cliente';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'HUBSPOT_TOKEN missing' }); return; }

  const eventos = Array.isArray(req.body) ? req.body : [];
  if (!eventos.length) { res.status(200).json({ recebido: true, eventos: 0 }); return; }

  // Agrupa por tipo
  const porTipo = {};
  for (const e of eventos) {
    const tipo = e.subscriptionType || 'unknown';
    (porTipo[tipo] = porTipo[tipo] || []).push(e);
  }

  const hs = makeClient(token);
  const resultados = {};

  try {
    // ── object.propertyChange → criar-andares ──────────────────────
    const propChanges = (porTipo['object.propertyChange'] || [])
      .filter((e) => e.propertyName === PROP_EDIFICIO_ANDARES);
    if (propChanges.length) {
      const edificioIds = [...new Set(propChanges.map((e) => String(e.objectId)).filter(Boolean))];
      resultados.andares = await handleWebhookPost(hs, edificioIds);
    }

    // ── deal.associationChange → rotular → verificar-rotulos + associar-contatos
    // Nota: para associationChange, o deal está em fromObjectId (não objectId)
    const dealAssoc = porTipo['deal.associationChange'] || [];
    if (dealAssoc.length) {
      const dealIds = [...new Set(dealAssoc.map((e) => String(e.fromObjectId)).filter((id) => id && id !== 'undefined'))];
      if (dealIds.length) {
        // 1. Aplica "Cliente Final" nas empresas primárias (usa isPrimaryAssociation do evento)
        resultados.rotulados = await rotularClientesFinal(hs, dealAssoc);

        // 2. Verifica tags e sincroniza contatos em paralelo
        const dealsById = await getObjectsById(hs, 'deals', dealIds, ['dealname', 'dealstage', 'aw_rotulo_pendente']);
        const deals = Object.values(dealsById);
        const [rotulos, contatos] = await Promise.all([
          verificarDeals(hs, deals),
          syncPorDeals(hs, dealIds),
        ]);
        resultados.rotulos  = rotulos;
        resultados.contatos = contatos;
      }
    }

    // ── contact.associationChange → associar-contatos ───────────────
    // Nota: para associationChange, o contato está em fromObjectId
    const contactAssoc = porTipo['contact.associationChange'] || [];
    if (contactAssoc.length) {
      const contactIds = [...new Set(contactAssoc.map((e) => String(e.fromObjectId)).filter((id) => id && id !== 'undefined'))];
      if (contactIds.length) {
        resultados.contatos_empresa = await syncPorContatos(hs, contactIds);
      }
    }

    res.status(200).json({ recebido: true, ...resultados, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/webhook] erro:', err);
    res.status(502).json({ error: err.message || 'Erro no webhook.' });
  }
};
