/**
 * api/associar-andares.js
 * ------------------------------------------------------------------
 * Quando um Deal recebe uma associação a um Conjunto, associa
 * automaticamente o Andar pai desse Conjunto ao Deal.
 *
 * Fluxo:
 *   1. Webhook recebe deal.associationChange
 *   2. Este módulo filtra eventos onde toObjectTypeId = Conjunto
 *   3. Para cada Conjunto, busca o Andar via Conjunto→Andar
 *   4. Cria a associação Deal→Andar com os mesmos tipos de associação
 * ------------------------------------------------------------------
 */

const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';

// typeId numérico do Conjunto no portal ATIE
const CONJUNTO_TYPE_ID = process.env.HUBSPOT_CONJUNTO_TYPE_ID || '2-65811627';

// Tipo correto para Deal→Andar no portal ATIE (USER_DEFINED, label "Negócio")
const DEAL_ANDAR_ASSOC = [{ associationCategory: 'USER_DEFINED', associationTypeId: 92 }];

/**
 * @param {Function} hs - cliente HubSpot (makeClient)
 * @param {Array}    dealAssocEvents - eventos deal.associationChange do webhook
 * @returns {Promise<{conjuntos: number, created: number, erros: string[]}>}
 */
async function syncAndarPorConjunto(hs, dealAssocEvents) {
  // Log para diagnóstico — mostra associationType real de cada evento
  console.log('[associar-andares] tipos recebidos:', dealAssocEvents.map(e => e.associationType).join(', '));

  // Filtra criações de associação com Conjunto.
  // Payload real HubSpot: associationRemoved=false (criação), associationType="DEAL_TO_xxx"
  // associationType para Conjunto tem o typeId numérico do objeto: 2-65811627 → "65811627"
  const CONJUNTO_ASSOC_TYPES = new Set([
    `DEAL_TO_${CONJUNTO_TYPE_ID}`,          // "DEAL_TO_2-65811627"
    `DEAL_TO_${CONJUNTO_TYPE_ID.replace('2-', '')}`, // "DEAL_TO_65811627"
    `DEAL_TO_${OBJ_CONJUNTO}`,              // "DEAL_TO_p51253038_conjuntos"
  ]);

  const evtCriados = dealAssocEvents.filter((e) => {
    const isCriacao = e.associationRemoved === false;
    const isConjunto = CONJUNTO_ASSOC_TYPES.has(String(e.associationType || ''));
    return isCriacao && isConjunto;
  });

  if (!evtCriados.length) return { skipped: true };

  // agrupa: conjuntoId → Set<dealId>
  const porConjunto = {};
  evtCriados.forEach((e) => {
    const cjId  = String(e.toObjectId);
    const dealId = String(e.fromObjectId);
    if (!porConjunto[cjId]) porConjunto[cjId] = new Set();
    porConjunto[cjId].add(dealId);
  });

  let created = 0;
  const erros  = [];

  for (const [conjuntoId, dealIdSet] of Object.entries(porConjunto)) {
    try {
      // Descobre o(s) Andar(es) pai(s) do Conjunto
      const res = await hs(`/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}`);
      const andarAssocs = res.results || [];
      if (!andarAssocs.length) continue;

      for (const andar of andarAssocs) {
        const andarId = andar.toObjectId;
        const body = DEAL_ANDAR_ASSOC;

        for (const dealId of dealIdSet) {
          try {
            await hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_ANDAR}/${andarId}`, {
              method: 'PUT',
              body: JSON.stringify(body),
            });
            created++;
          } catch (err) {
            erros.push(`deal ${dealId} → andar ${andarId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      erros.push(`conjunto ${conjuntoId}: ${err.message}`);
    }
  }

  return { conjuntos: Object.keys(porConjunto).length, created, erros };
}

module.exports = { syncAndarPorConjunto };
