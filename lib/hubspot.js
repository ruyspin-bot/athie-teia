/**
 * lib/hubspot.js
 * ------------------------------------------------------------------
 * Helpers HTTP mínimos pra falar com o HubSpot, compartilhados entre
 * /api/teia.js (a teia) e /api/verificar-rotulos.js (o job de tag).
 * Nada aqui é específico de um endpoint — quem chama decide quais
 * propriedades buscar, quais IDs processar, etc.
 * ------------------------------------------------------------------
 */

const HUBSPOT_BASE = 'https://api.hubapi.com';

function makeClient(token) {
  return async function hs(path, options = {}, _retry = 0) {
    const res = await fetch(HUBSPOT_BASE + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (res.status === 429 && _retry < 4) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
      const delay = Math.max(retryAfter * 1000, (2 ** _retry) * 500);
      await new Promise((r) => setTimeout(r, delay));
      return hs(path, options, _retry + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HubSpot ${options.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    // 204 No Content (comum em updates em lote) não tem corpo JSON
    if (res.status === 204) return null;
    return res.json();
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* Estágios "fechados" (ganho/perdido) de cada pipeline de deals       */
/* ------------------------------------------------------------------ */
async function getClosedStageIds(hs) {
  const data = await hs('/crm/v3/pipelines/deals');
  const closed = new Set();
  (data.results || []).forEach((pipeline) => {
    (pipeline.stages || []).forEach((stage) => {
      if (stage.metadata && (stage.metadata.isClosed === 'true' || stage.metadata.isClosed === true)) {
        closed.add(stage.id);
      }
    });
  });
  return closed;
}

async function getPipelineNames(hs) {
  const data = await hs('/crm/v3/pipelines/deals');
  const map = {};
  (data.results || []).forEach((pipeline) => {
    map[pipeline.id] = pipeline.label;
  });
  return map;
}

async function getStageNames(hs) {
  const data = await hs('/crm/v3/pipelines/deals');
  const map = {};
  (data.results || []).forEach((pipeline) => {
    (pipeline.stages || []).forEach((stage) => {
      map[stage.id] = stage.label;
    });
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* Deals ativos (paginado) — quem chama define quais properties busca  */
/* filters: array de objetos HubSpot filter (propertyName/operator/    */
/* value). Se fornecido, usa Search API (muito mais rápido pra bases   */
/* grandes). Sem filters, usa list API (cobre todos os deals).         */
/* ------------------------------------------------------------------ */
async function getActiveDeals(hs, properties) {
  // List API — retorna todos os deals não arquivados, 100 por página (máximo).
  // Sem filtro de pipeline ou stage — a teia filtra depois por associação.
  const all = [];
  let after;
  do {
    const qs = new URLSearchParams({
      limit: '100',
      properties: properties.join(','),
      archived: 'false',
    });
    if (after) qs.set('after', after);
    const page = await hs(`/crm/v3/objects/deals?${qs.toString()}`);
    all.push(...(page.results || []));
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

/* ------------------------------------------------------------------ */
/* Associações genéricas FROM -> TO, com rótulo (batch read, v4)        */
/* fromType/toType: nome do tipo de objeto na API (ex. "deals",         */
/* "companies", ou o nome técnico de um Custom Object, ex.              */
/* "p51253038_andares")                                                 */
/* ------------------------------------------------------------------ */
async function getAssociations(hs, fromType, toType, fromIds) {
  const byFromId = {};
  const chunks = chunk(fromIds, 100).filter((c) => c.length);
  await Promise.all(
    chunks.map(async (ids) => {
      const body = { inputs: ids.map((id) => ({ id })) };
      const data = await hs(`/crm/v4/associations/${fromType}/${toType}/batch/read`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      (data.results || []).forEach((r) => {
        const fromId = r.from.id;
        byFromId[fromId] = (r.to || []).map((t) => {
          const allTypes = t.associationTypes || [];
          // Prefer the first non-empty label for display
          const labeled = allTypes.find((at) => at.label && at.label.trim());
          const label = labeled ? labeled.label : (allTypes[0] || {}).label || '';
          // Primary company: has HUBSPOT_DEFINED typeId 5 (deal→company standard link)
          // OR HubSpot marks it with label "Primary"/"Principal"
          const isPrimary = allTypes.some(
            (at) =>
              (at.category === 'HUBSPOT_DEFINED' && at.typeId === 5) ||
              /^(primary|principal)$/i.test(at.label || ''),
          );
          // Custom label: any USER_DEFINED type (set by humans, not HubSpot system)
          const hasCustomLabel = allTypes.some((at) => at.category === 'USER_DEFINED');
          return { toId: t.toObjectId, label, isPrimary, hasCustomLabel };
        });
      });
    })
  );
  return byFromId;
}

/* Mantido por compatibilidade — usa getAssociations por baixo */
async function getDealCompanyAssociations(hs, dealIds) {
  const raw = await getAssociations(hs, 'deals', 'companies', dealIds);
  const byDeal = {};
  Object.entries(raw).forEach(([dealId, arr]) => {
    byDeal[dealId] = arr.map((a) => ({ companyId: a.toId, label: a.label }));
  });
  return byDeal;
}

/* ------------------------------------------------------------------ */
/* Leitura genérica de objetos (batch read, v3) — properties variam    */
/* objectType: "companies", ou nome técnico de um Custom Object         */
/* ------------------------------------------------------------------ */
async function getObjectsById(hs, objectType, ids, properties) {
  const byId = {};
  const chunks = chunk(ids, 100).filter((c) => c.length);
  await Promise.all(
    chunks.map(async (batch) => {
      const body = { properties, inputs: batch.map((id) => ({ id })) };
      const data = await hs(`/crm/v3/objects/${objectType}/batch/read`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      (data.results || []).forEach((o) => {
        byId[o.id] = o;
      });
    })
  );
  return byId;
}

/* ------------------------------------------------------------------ */
/* Nome (ou outras properties) das companies envolvidas (batch read)   */
/* ------------------------------------------------------------------ */
async function getCompanies(hs, companyIds, properties = ['name']) {
  return getObjectsById(hs, 'companies', companyIds, properties);
}

/* ------------------------------------------------------------------ */
/* Atualiza propriedades de vários deals em lote (batch update, v3)    */
/* inputs: [{ id, properties: {...} }, ...]                            */
/* ------------------------------------------------------------------ */
async function batchUpdateDeals(hs, inputs) {
  const chunks = chunk(inputs, 100);
  for (const batch of chunks) {
    if (!batch.length) continue;
    await hs('/crm/v3/objects/deals/batch/update', {
      method: 'POST',
      body: JSON.stringify({ inputs: batch }),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Lista TODOS os objetos de um tipo (paginado) — sem filtro de deal   */
/* ------------------------------------------------------------------ */
async function listAllObjects(hs, objectType, properties) {
  const all = [];
  let after;
  do {
    const qs = new URLSearchParams({ limit: '100', properties: properties.join(',') });
    if (after) qs.set('after', after);
    const page = await hs(`/crm/v3/objects/${objectType}?${qs.toString()}`);
    all.push(...(page.results || []));
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

/* ------------------------------------------------------------------ */
/* Cria 1 registro de um objeto (padrão ou Custom Object)              */
/* ------------------------------------------------------------------ */
async function createObject(hs, objectType, properties) {
  return hs(`/crm/v3/objects/${objectType}`, {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });
}

/* ------------------------------------------------------------------ */
/* Deleta 1 registro (move para lixeira / arquiva)                     */
/* ------------------------------------------------------------------ */
async function deleteObject(hs, objectType, id) {
  return hs(`/crm/v3/objects/${objectType}/${id}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ */
/* Busca objetos por filtros (Search API, v3)                          */
/* filters: [{propertyName, operator, value}]                          */
/* ------------------------------------------------------------------ */
async function searchObjects(hs, objectType, filters, properties) {
  return hs(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters }],
      properties,
      limit: 10,
    }),
  });
}

/* ------------------------------------------------------------------ */
/* Rótulos disponíveis para um par de objetos (v4) — usado pra achar   */
/* dinamicamente o typeId de um rótulo pelo texto, sem precisar        */
/* hardcodar o número (que muda de portal pra portal)                  */
/* ------------------------------------------------------------------ */
async function getAssociationLabels(hs, fromType, toType) {
  const data = await hs(`/crm/v4/associations/${fromType}/${toType}/labels`);
  return data.results || [];
}

async function findAssociationTypeId(hs, fromType, toType, labelMatch) {
  const labels = await getAssociationLabels(hs, fromType, toType);
  const found = labels.find((l) => labelMatch.test(l.label || ''));
  return found ? { typeId: found.typeId, category: found.category } : null;
}

/* ------------------------------------------------------------------ */
/* Cria a associação (com rótulo específico) entre 2 registros (v4)    */
/* ------------------------------------------------------------------ */
// typesOrTypeId: array de { associationCategory, associationTypeId } OU um único typeId (legado).
// O PUT do v4 SUBSTITUI todos os tipos existentes — passar um array completo para preservar tipos.
async function createAssociation(hs, fromType, fromId, toType, toId, typesOrTypeId, category) {
  const types = Array.isArray(typesOrTypeId)
    ? typesOrTypeId
    : [{ associationCategory: category, associationTypeId: typesOrTypeId }];
  return hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, {
    method: 'PUT',
    body: JSON.stringify(types),
  });
}

/* ------------------------------------------------------------------ */
/* Cria associações em lote (v4 batch create)                          */
/* pairs: [{ fromId, toId }]                                           */
/* typeId/category: padrão HUBSPOT_DEFINED 3 = deal→contact            */
/* ------------------------------------------------------------------ */
async function batchCreateAssociations(hs, fromType, toType, pairs, typeId = 3, category = 'HUBSPOT_DEFINED') {
  const chunks = chunk(pairs, 100).filter((c) => c.length);
  for (const batch of chunks) {
    await hs(`/crm/v4/associations/${fromType}/${toType}/batch/create`, {
      method: 'POST',
      body: JSON.stringify({
        inputs: batch.map((p) => ({
          from: { id: String(p.fromId) },
          to: { id: String(p.toId) },
          types: [{ associationCategory: category, associationTypeId: typeId }],
        })),
      }),
    });
  }
}

module.exports = {
  HUBSPOT_BASE,
  makeClient,
  chunk,
  getClosedStageIds,
  getPipelineNames,
  getStageNames,
  getActiveDeals,
  getAssociations,
  getDealCompanyAssociations,
  getObjectsById,
  getCompanies,
  batchUpdateDeals,
  listAllObjects,
  createObject,
  deleteObject,
  searchObjects,
  getAssociationLabels,
  findAssociationTypeId,
  createAssociation,
  batchCreateAssociations,
};
