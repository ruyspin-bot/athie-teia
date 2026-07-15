/**
 * api/criar-edificio.js  —  ONE-TIME USE, deletar após execução
 * ──────────────────────────────────────────────────────────────
 * Cria o edifício "Quota Corporate" no custom object de Edifícios
 * e o associa ao deal 62656148027 (CLARO Obra).
 *
 * Proteção: requer header  x-import-secret: atie-linha47
 *
 * Chamar:
 *   curl -X POST https://athie-teia-aewo.vercel.app/api/criar-edificio \
 *        -H "x-import-secret: atie-linha47"
 * ──────────────────────────────────────────────────────────────
 */

const { makeClient } = require('../lib/hubspot');

const DEAL_ID      = '62656148027';
const EDIFICIO_NOME = 'Quota Corporate';
const OBJ_EDIFICIO = 'p51253038_edificios';

module.exports = async (req, res) => {
  if (req.headers['x-import-secret'] !== 'atie-linha47') {
    return res.status(403).json({ error: 'Proibido' });
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN ausente' });

  const hs  = makeClient(token);
  const log = [];

  try {
    // ── 1. Descobrir propriedades disponíveis no objeto edificios ─
    let nomeProp = 'nome_do_edificio'; // default
    try {
      const props = await hs(`/crm/v3/properties/${OBJ_EDIFICIO}`);
      const names = (props.results || []).map(p => p.name);
      log.push({ etapa: 'props_edificio', props: names });
      // tentar identificar a prop de nome
      const candidatos = ['nome_do_edificio', 'name', 'nome', 'edificio_nome', 'nome_condominio'];
      const found = candidatos.find(c => names.includes(c));
      if (found) nomeProp = found;
    } catch (e) {
      log.push({ etapa: 'props_aviso', msg: e.message });
    }

    // ── 2. Buscar se já existe ─────────────────────────────────
    let edificioId = null;
    try {
      const search = await hs(`/crm/v3/objects/${OBJ_EDIFICIO}/search`, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: nomeProp, operator: 'EQ', value: EDIFICIO_NOME }] }],
          properties: [nomeProp],
          limit: 1,
        }),
      });
      if (search.results?.length) {
        edificioId = search.results[0].id;
        log.push({ etapa: 'edificio_encontrado', id: edificioId, nomeProp });
      } else {
        log.push({ etapa: 'edificio_nao_encontrado', nomeProp });
      }
    } catch (e) {
      log.push({ etapa: 'busca_erro', msg: e.message });
    }

    // ── 3. Criar se não existe ─────────────────────────────────
    if (!edificioId) {
      const created = await hs(`/crm/v3/objects/${OBJ_EDIFICIO}`, {
        method: 'POST',
        body: JSON.stringify({ properties: { [nomeProp]: EDIFICIO_NOME } }),
      });
      edificioId = created.id;
      log.push({ etapa: 'edificio_criado', id: edificioId });
    }

    // ── 4. Descobrir typeId correto via /crm/v3/associations ───
    let assocTypeId   = null;
    let assocCategory = 'HUBSPOT_DEFINED';
    try {
      // v3: lista TODOS os tipos de associação entre deals e edificios
      const types = await hs(`/crm/v3/associations/deals/${OBJ_EDIFICIO}/types`);
      log.push({ etapa: 'assoc_types_v3', types: types.results || types });
      const first = (types.results || types)?.[0];
      if (first) assocTypeId = first.id ?? first.typeId ?? first;
    } catch (e) {
      log.push({ etapa: 'assoc_types_v3_erro', msg: e.message });
    }

    // fallback: tentar labels v4 (user-defined)
    if (!assocTypeId) {
      try {
        const labelDefs = await hs(`/crm/v4/associations/deals/${OBJ_EDIFICIO}/labels`);
        log.push({ etapa: 'assoc_labels_v4', results: labelDefs.results });
        const first = (labelDefs.results || [])[0];
        if (first) { assocTypeId = first.typeId; assocCategory = 'USER_DEFINED'; }
      } catch (e) {
        log.push({ etapa: 'assoc_labels_v4_erro', msg: e.message });
      }
    }

    if (!assocTypeId) {
      return res.status(502).json({
        error: 'Não foi possível descobrir o typeId de associação deal→edificio. Veja log.',
        edificio_criado: edificioId,
        log,
      });
    }

    // ── 5. Associar deal → edificio ────────────────────────────
    await hs(`/crm/v4/objects/deals/${DEAL_ID}/associations/${OBJ_EDIFICIO}/${edificioId}`, {
      method: 'PUT',
      body: JSON.stringify([{ associationCategory: assocCategory, associationTypeId: assocTypeId }]),
    });
    log.push({ etapa: 'associado', deal: DEAL_ID, edificio: edificioId, typeId: assocTypeId });

    return res.status(200).json({
      status: 'ok',
      edificio_id: edificioId,
      deal_id: DEAL_ID,
      deal_url: `https://app.hubspot.com/contacts/51253038/deal/${DEAL_ID}`,
      edificio_url: `https://app.hubspot.com/contacts/51253038/objects/${OBJ_EDIFICIO}/${edificioId}`,
      log,
    });

  } catch (err) {
    return res.status(502).json({ error: err.message, log });
  }
};
