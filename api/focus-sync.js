/**
 * /api/focus-sync
 * ------------------------------------------------------------------
 * Middleware HubSpot → Focus (criação de projetos).
 *
 * FLUXO:
 *   1. Deal criado/qualificado no HubSpot dispara o webhook (deal.creation
 *      ou deal.propertyChange do campo de controle) → este endpoint.
 *   2. Montamos o payload dos campos OBRIGATÓRIOS já traduzidos (de/para)
 *      e resolvemos os IDs de empresa (Cliente Final / Gerenciadora / Broker)
 *      pelas companies associadas.
 *   3. POST no endpoint do Focus (FOCUS_ENDPOINT_URL).
 *   4. O Focus cria o projeto e responde { prj_id, prj_numero }.
 *   5. Gravamos aw_id_interno + aw_numero_projeto de volta no Deal.
 *
 * SEGURANÇA: o Focus NÃO recebe token do HubSpot. Só expõe 1 endpoint.
 * Quem escreve de volta é este middleware, com o token da Scient.
 *
 * IDEMPOTÊNCIA: deals que já têm aw_id_interno são pulados (já criados).
 *
 * CONFIG (env):
 *   FOCUS_SYNC_ENABLED = "true"   → liga o disparo real (default: false)
 *   FOCUS_ENDPOINT_URL = "https://.../projetos"
 *   FOCUS_API_KEY      = "..."    → enviado como Bearer, se o Focus exigir
 *
 * O de/para de enum (valor HubSpot → ID Focus) fica em DEPARA abaixo.
 * Enquanto a Athié não devolve os IDs, mandamos o próprio valor do HubSpot
 * (o Focus resolve). Basta preencher os mapas para passar a enviar o ID.
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  getObjectsById,
  getAssociations,
  getCompanies,
  batchUpdateDeals,
  getStageNames,
} = require('../lib/hubspot');

const FOCUS_SYNC_ENABLED = (process.env.FOCUS_SYNC_ENABLED || 'false').toLowerCase() === 'true';
const FOCUS_ENDPOINT_URL = process.env.FOCUS_ENDPOINT_URL || '';
const FOCUS_API_KEY = process.env.FOCUS_API_KEY || '';

// Propriedades do Deal necessárias para montar o payload do Focus.
const DEAL_PROPS = [
  'dealname', 'dealstage', 'aw_id_interno', 'aw_numero_projeto', 'aw_id_projeto_pai',
  'aw_area_m2', 'aw_unidade_negocios', 'aw_equipe_principal', 'aw_tipo_de_negocio',
  'aw_area_de_atuacao', 'aw_funcionario_solicitou_abertura', 'aw_local', 'aw_den',
  'aw_modalidade', 'aw_setor_cliente',
];

const LABEL_CLIENTE_FINAL = /cliente\s*final/i;
const LABEL_GERENCIADORA = /gerenciadora/i;
const LABEL_BROKER = /broker/i;

/* ------------------------------------------------------------------
 * DE/PARA valor HubSpot → ID Focus.
 * Preencher conforme a coluna "ID Focus" da doc de integração.
 * Mapa vazio = envia o valor do HubSpot como está (Focus resolve).
 * ------------------------------------------------------------------ */
const DEPARA = {
  aw_local: {},                     // LOC_ID       { aw_sao_paulo: 1, aw_rio: 2, ... }
  aw_equipe_principal: {},          // PJE_ID
  aw_tipo_de_negocio: {},           // PRJ_FL_HERANCA
  aw_area_de_atuacao: {},           // IdObjeto
  aw_funcionario_solicitou_abertura: {}, // FUN_ID_SOLCRIAR
  aw_den: {},                       // LiderEstrategicoId
  aw_unidade_negocios: {},          // CNT_ID
  aw_setor_cliente: {},             // ERA_ID (opcional)
};
// De/para etapa do funil → STS_ID_PRJPRC (status do projeto no Focus).
const DEPARA_STATUS = {
  '1401375324': null, // Radar
  '1366396702': null, // Diagnóstico / Test Fit
  '1360364548': null, // Recebido no Núcleo
  '1360364555': null, // Em Negociação / Short List
};

const depara = (campo, valor) => {
  if (valor == null || valor === '') return null;
  const mapa = DEPARA[campo] || {};
  return Object.prototype.hasOwnProperty.call(mapa, valor) ? mapa[valor] : valor; // fallback: valor cru
};

/* ------------------------------------------------------------------
 * Monta o payload do Focus para um Deal (com companies já resolvidas).
 * ------------------------------------------------------------------ */
function montarPayload(deal, companiesDoDeal) {
  const p = deal.properties || {};
  const acharCompanyId = (regex) => {
    const c = companiesDoDeal.find((x) => regex.test(x.label || ''));
    // ID do Focus da empresa: preferir aw_id_grupo_comercial; cair p/ aw_id_focus
    return c ? (c.aw_id_grupo_comercial || c.aw_id_gerenciadora || c.aw_id_broker || c.aw_id_focus || null) : null;
  };

  const payload = {
    deal_id_hubspot: String(deal.id),
    PRJ_NM_OBRA: p.dealname || null,
    PRJ_ID_PAI: p.aw_id_projeto_pai || null,
    PRJ_MT_ABSOLUTA: p.aw_area_m2 ? Number(p.aw_area_m2) : null,
    IdGrupoComercial: acharCompanyId(LABEL_CLIENTE_FINAL),
    IdGerenciadora: acharCompanyId(LABEL_GERENCIADORA),
    IdBrokerLocacoes: acharCompanyId(LABEL_BROKER),
    CNT_ID: depara('aw_unidade_negocios', p.aw_unidade_negocios),
    PJE_ID: depara('aw_equipe_principal', p.aw_equipe_principal),
    PRJ_FL_HERANCA: depara('aw_tipo_de_negocio', p.aw_tipo_de_negocio),
    IdObjeto: depara('aw_area_de_atuacao', p.aw_area_de_atuacao),
    FUN_ID_SOLCRIAR: depara('aw_funcionario_solicitou_abertura', p.aw_funcionario_solicitou_abertura),
    LOC_ID: depara('aw_local', p.aw_local),
    LiderEstrategicoId: depara('aw_den', p.aw_den),
    ERA_ID: depara('aw_setor_cliente', p.aw_setor_cliente),
    STS_ID_PRJPRC: Object.prototype.hasOwnProperty.call(DEPARA_STATUS, p.dealstage)
      ? DEPARA_STATUS[p.dealstage] : p.dealstage || null,
    DesignBuild: p.aw_modalidade === 'turn_key' ? 1 : 0,
    // Campos ainda a criar no HubSpot (aguardando opções da Athié):
    // PRJ_FL_OXICART, TOX_ID, RegiaoId — enviados quando os campos existirem.
  };
  return payload;
}

/* ------------------------------------------------------------------
 * Envia um conjunto de deals ao Focus e grava o retorno.
 * ------------------------------------------------------------------ */
async function enviarDeals(hs, dealIds, { force = false } = {}) {
  if (!dealIds.length) return { deals: 0, enviados: 0, gravados: 0, pulados: 0, skipped: false };
  if (!FOCUS_SYNC_ENABLED || !FOCUS_ENDPOINT_URL) {
    return { deals: dealIds.length, skipped: true, motivo: 'FOCUS_SYNC_ENABLED/URL não configurado' };
  }

  const dealsById = await getObjectsById(hs, 'deals', dealIds, DEAL_PROPS);
  const deals = Object.values(dealsById);

  // Companies associadas (com rótulo) + dados de ID Focus das companies
  const companyAssoc = await getAssociations(hs, 'deals', 'companies', dealIds);
  const allCompanyIds = [...new Set(Object.values(companyAssoc).flatMap((a) => a.map((x) => x.toId)))];
  const companyProps = allCompanyIds.length
    ? await getCompanies(hs, allCompanyIds, ['name', 'aw_id_grupo_comercial', 'aw_id_gerenciadora', 'aw_id_broker', 'aw_id_focus'])
    : {};

  const stats = { deals: deals.length, enviados: 0, gravados: 0, pulados: 0, erros: [] };
  const writeBack = [];

  for (const deal of deals) {
    // idempotência: já criado no Focus?
    if (!force && deal.properties?.aw_id_interno) { stats.pulados++; continue; }

    const companiesDoDeal = (companyAssoc[deal.id] || []).map((c) => ({
      label: c.label,
      ...(companyProps[c.toId]?.properties || {}),
    }));
    const payload = montarPayload(deal, companiesDoDeal);

    try {
      const resp = await fetch(FOCUS_ENDPOINT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(FOCUS_API_KEY ? { Authorization: `Bearer ${FOCUS_API_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Focus ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
      stats.enviados++;
      const data = await resp.json().catch(() => ({}));
      const prjId = data.prj_id ?? data.PRJ_ID ?? data.prjId;
      const prjNum = data.prj_numero ?? data.PRJ_NUMERO ?? data.prjNumero;
      if (prjId || prjNum) {
        const props = {};
        if (prjId != null) props.aw_id_interno = String(prjId);
        if (prjNum != null) props.aw_numero_projeto = String(prjNum);
        writeBack.push({ id: deal.id, properties: props });
      }
    } catch (e) {
      stats.erros.push({ deal: deal.id, erro: e.message.slice(0, 160) });
    }
  }

  if (writeBack.length) { await batchUpdateDeals(hs, writeBack); stats.gravados = writeBack.length; }
  return stats;
}

/* ------------------------------------------------------------------
 * Handler — POST (webhook) e GET (manual/cron, protegido por CRON_SECRET)
 * ------------------------------------------------------------------ */
module.exports = async (req, res) => {
  try {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { res.status(500).json({ error: 'Faltou HUBSPOT_TOKEN.' }); return; }
    const hs = makeClient(token);

    if (req.method === 'POST') {
      const eventos = Array.isArray(req.body) ? req.body : [];
      // deal.creation → objectId = deal; deal.propertyChange também usa objectId
      const dealIds = [...new Set(eventos.map((e) => String(e.objectId)).filter((id) => id && id !== 'undefined'))];
      const resultado = await enviarDeals(hs, dealIds);
      res.status(200).json({ recebido: true, ...resultado, rodado_em: new Date().toISOString() });
      return;
    }

    // GET manual/cron
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers['authorization'] || '';
      const provided = auth.replace(/^Bearer\s+/i, '') || req.query.secret;
      if (provided !== secret) { res.status(401).json({ error: 'Não autorizado.' }); return; }
    }
    const ids = (req.query.dealId || req.query.dealIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { res.status(400).json({ error: 'Informe ?dealId=<id>[,<id>] (ou configure um sweep).' }); return; }
    const resultado = await enviarDeals(hs, ids, { force: req.query.force === 'true' });
    res.status(200).json({ ...resultado, rodado_em: new Date().toISOString() });
  } catch (err) {
    console.error('[api/focus-sync] erro:', err);
    res.status(502).json({ error: err.message || 'Erro no focus-sync.' });
  }
};

module.exports.enviarDeals = enviarDeals;
module.exports.montarPayload = montarPayload;
