/**
 * /api/criar-andares
 * ------------------------------------------------------------------
 * Aceita dois modos:
 *
 * 1. GET (cron / manual) — limpa duplicados e processa todos os Edifícios.
 *
 * 2. POST (webhook HubSpot) — HubSpot chama este endpoint quando a
 *    propriedade "Andares" de um Edifício é alterada. O payload é um
 *    array de eventos; extraímos os objectId únicos e processamos só
 *    esses Edifícios. Resposta rápida (200 imediato) pra HubSpot não
 *    considerar falha e retentar.
 *
 * Deduplicação:
 *   - Antes de criar, busca pelo nome exato do Andar (search-before-create)
 *     para guardar contra race condition entre webhook e cron.
 *   - O cron/GET também roda limparDuplicados() no início, removendo
 *     qualquer Andar com mesmo numero_do_andar no mesmo Edifício.
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  chunk,
  listAllObjects,
  getObjectsById,
  getAssociations,
  createObject,
  deleteObject,
  findAssociationTypeId,
  createAssociation,
} = require('../lib/hubspot');

const OBJ_ANDAR = process.env.HUBSPOT_OBJECT_ANDAR || '2-65605360';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || '2-65603861';
const PROP_EDIFICIO_ANDARES = process.env.HUBSPOT_PROP_EDIFICIO_ANDARES || 'andares';
const PROP_EDIFICIO_NOME = process.env.HUBSPOT_PROP_EDIFICIO_NOME || 'nome_do_edificio';
const PROP_ANDAR_NOME = process.env.HUBSPOT_PROP_ANDAR_NOME || 'nome_do_andar';
const PROP_ANDAR_NUMERO = process.env.HUBSPOT_PROP_ANDAR_NUMERO || 'numero_do_andar';
const LABEL_PERTENCE_A = process.env.HUBSPOT_LABEL_ANDAR_EDIFICIO || 'pertence a';

// Remove Andares duplicados (mesmo numero_do_andar no mesmo Edifício).
// Mantém o de menor ID (mais antigo), deleta os extras.
async function limparDuplicados(hs, edificios) {
  if (!edificios.length) return { andares_removidos: 0 };

  const edificioIds = edificios.map((e) => e.id);
  const assocByEdificio = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, edificioIds);
  const allAndarIds = [...new Set(Object.values(assocByEdificio).flatMap((arr) => arr.map((a) => a.toId)))];
  if (!allAndarIds.length) return { andares_removidos: 0 };

  const allAndares = await getObjectsById(hs, OBJ_ANDAR, allAndarIds, [PROP_ANDAR_NUMERO, PROP_ANDAR_NOME]);

  let andares_removidos = 0;
  const detalhe_limpeza = {};

  for (const [edificioId, assocs] of Object.entries(assocByEdificio)) {
    const porNumero = {};
    for (const a of assocs) {
      const obj = allAndares[a.toId];
      if (!obj) continue;
      const numero = obj.properties[PROP_ANDAR_NUMERO] || 'sem_numero';
      if (!porNumero[numero]) porNumero[numero] = [];
      porNumero[numero].push({ id: a.toId, nome: obj.properties[PROP_ANDAR_NOME] });
    }

    const removidos = [];
    for (const [numero, lista] of Object.entries(porNumero)) {
      if (lista.length <= 1) continue;
      lista.sort((a, b) => Number(a.id) - Number(b.id));
      for (const dup of lista.slice(1)) {
        await deleteObject(hs, OBJ_ANDAR, dup.id);
        andares_removidos++;
        removidos.push({ id: dup.id, numero, nome: dup.nome });
      }
    }

    if (removidos.length) detalhe_limpeza[edificioId] = removidos;
  }

  return { andares_removidos, detalhe_limpeza };
}

// Corrige o nome dos Andares existentes para o padrão atual.
// Roda no cron/GET para migrar registros criados com padrões antigos.
async function renomearAndares(hs, edificios) {
  if (!edificios.length) return { andares_renomeados: 0 };

  const edificioIds = edificios.map((e) => e.id);
  const assocByEdificio = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, edificioIds);
  const allAndarIds = [...new Set(Object.values(assocByEdificio).flatMap((arr) => arr.map((a) => a.toId)))];
  if (!allAndarIds.length) return { andares_renomeados: 0 };

  const allAndares = await getObjectsById(hs, OBJ_ANDAR, allAndarIds, [PROP_ANDAR_NUMERO, PROP_ANDAR_NOME]);

  const andarToEdificio = {};
  for (const [edificioId, assocs] of Object.entries(assocByEdificio)) {
    const ed = edificios.find((e) => e.id === edificioId);
    const nomeEdificio = ed?.properties?.[PROP_EDIFICIO_NOME] || `Edifício ${edificioId}`;
    for (const a of assocs) andarToEdificio[a.toId] = nomeEdificio;
  }

  const toUpdate = [];
  for (const [andarId, obj] of Object.entries(allAndares)) {
    const numero = obj.properties[PROP_ANDAR_NUMERO];
    const nomeEdificio = andarToEdificio[andarId];
    if (!numero || !nomeEdificio) continue;
    const expectedNome = `Andar ${numero} - Edifício ${nomeEdificio}`;
    if ((obj.properties[PROP_ANDAR_NOME] || '') !== expectedNome) {
      toUpdate.push({ id: andarId, properties: { [PROP_ANDAR_NOME]: expectedNome } });
    }
  }

  if (!toUpdate.length) return { andares_renomeados: 0 };

  for (const batch of chunk(toUpdate, 100)) {
    await hs(`/crm/v3/objects/${OBJ_ANDAR}/batch/update`, {
      method: 'POST',
      body: JSON.stringify({ inputs: batch }),
    });
  }

  return { andares_renomeados: toUpdate.length };
}

async function processarEdificios(hs, edificios) {
  if (!edificios.length) return { edificios_verificados: 0, andares_criados: 0, detalhe: {} };

  const labelInfo = await findAssociationTypeId(hs, OBJ_ANDAR, OBJ_EDIFICIO, new RegExp(LABEL_PERTENCE_A, 'i'));
  if (!labelInfo) {
    throw new Error(`Rótulo "${LABEL_PERTENCE_A}" não encontrado entre ${OBJ_ANDAR} e ${OBJ_EDIFICIO}.`);
  }

  const edificioIds = edificios.map((e) => e.id);
  const existingAssocByEdificio = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, edificioIds);
  const allExistingAndarIds = [...new Set(Object.values(existingAssocByEdificio).flatMap((arr) => arr.map((a) => a.toId)))];
  const existingAndares = allExistingAndarIds.length
    ? await getObjectsById(hs, OBJ_ANDAR, allExistingAndarIds, [PROP_ANDAR_NUMERO])
    : {};

  let andares_criados = 0;
  const detalhe = {};

  for (const ed of edificios) {
    const props = ed.properties || {};
    const desejados = (props[PROP_EDIFICIO_ANDARES] || '')
      .split(';')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!desejados.length) continue;

    const jaExistem = new Set(
      (existingAssocByEdificio[ed.id] || [])
        .map((a) => existingAndares[a.toId])
        .filter(Boolean)
        .map((obj) => obj.properties[PROP_ANDAR_NUMERO])
    );

    const faltando = desejados.filter((v) => !jaExistem.has(v));
    if (!faltando.length) continue;

    // Re-check fresco por edifício antes de criar — associações são imediatamente
    // consistentes (sem lag de índice), então isto detecta andares criados por
    // chamadas concorrentes (webhook + cron) no intervalo desde o batch inicial.
    const freshAssoc = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, [ed.id]);
    const freshAndarIds = (freshAssoc[ed.id] || []).map((a) => a.toId);
    const freshAndares = freshAndarIds.length
      ? await getObjectsById(hs, OBJ_ANDAR, freshAndarIds, [PROP_ANDAR_NUMERO])
      : {};
    const jaExistemFresh = new Set(Object.values(freshAndares).map((o) => o.properties[PROP_ANDAR_NUMERO]));
    const faltandoFinal = faltando.filter((v) => !jaExistemFresh.has(v));
    if (!faltandoFinal.length) continue;

    const nomeEdificio = props[PROP_EDIFICIO_NOME] || `Edifício ${ed.id}`;
    const criadosAqui = [];

    for (const numero of faltandoFinal) {
      const nomeAndar = `Andar ${numero} - Edifício ${nomeEdificio}`;
      const novoAndar = await createObject(hs, OBJ_ANDAR, {
        [PROP_ANDAR_NOME]: nomeAndar,
        [PROP_ANDAR_NUMERO]: numero,
      });
      await createAssociation(hs, OBJ_ANDAR, novoAndar.id, OBJ_EDIFICIO, ed.id, labelInfo.typeId, labelInfo.category);
      andares_criados++;
      criadosAqui.push({ id: novoAndar.id, numero });
    }

    if (criadosAqui.length) detalhe[ed.id] = { edificio: nomeEdificio, criados: criadosAqui };
  }

  return { edificios_verificados: edificios.length, andares_criados, detalhe };
}

async function handleWebhookPost(hs, edificioIds) {
  const edificios = await getObjectsById(hs, OBJ_EDIFICIO, edificioIds, [PROP_EDIFICIO_NOME, PROP_EDIFICIO_ANDARES]);
  return processarEdificios(hs, Object.values(edificios));
}

module.exports = async (req, res) => {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      res.status(500).json({ error: 'Faltou configurar HUBSPOT_TOKEN.' });
      return;
    }

    const hs = makeClient(token);

    // ---- modo webhook (POST do HubSpot) ----
    if (req.method === 'POST') {
      const eventos = Array.isArray(req.body) ? req.body : [];
      const edificioIds = [...new Set(eventos.map((e) => String(e.objectId)).filter(Boolean))];
      if (!edificioIds.length) {
        res.status(200).json({ recebido: true, edificios: 0 });
        return;
      }
      // Processa de forma síncrona antes de responder — Vercel encerra a função
      // logo após o res.json(), então fire-and-forget não é confiável.
      // HubSpot aguarda até 10s; para 1-3 edifícios o processamento fica em ~2-4s.
      const edificios = await getObjectsById(hs, OBJ_EDIFICIO, edificioIds, [PROP_EDIFICIO_NOME, PROP_EDIFICIO_ANDARES]);
      const resultado = await processarEdificios(hs, Object.values(edificios));
      res.status(200).json({ recebido: true, ...resultado });
      return;
    }

    // ---- modo cron / GET manual — proteção por secret opcional ----
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers['authorization'] || '';
      const provided = auth.replace(/^Bearer\s+/i, '') || req.query.secret;
      if (provided !== secret) {
        res.status(401).json({ error: 'Não autorizado.' });
        return;
      }
    }

    const edificios = await listAllObjects(hs, OBJ_EDIFICIO, [PROP_EDIFICIO_NOME, PROP_EDIFICIO_ANDARES]);
    const limpeza = await limparDuplicados(hs, edificios);
    const renomeados = await renomearAndares(hs, edificios);
    const resultado = await processarEdificios(hs, edificios);
    res.status(200).json({ ...resultado, ...limpeza, ...renomeados, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/criar-andares] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao criar andares.' });
  }
};

module.exports.handleWebhookPost = handleWebhookPost;
