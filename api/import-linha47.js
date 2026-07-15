/**
 * api/import-linha47.js  —  ONE-TIME USE, deletar após execução
 * ──────────────────────────────────────────────────────────────
 * Importa o deal da linha 47 (4703/24 — CLARO Obra) do arquivo
 * DEALS-VIVOS-LuisaZerbini.xlsx para o HubSpot ATIE.
 *
 * Proteção: requer header  x-import-secret: atie-linha47
 *
 * Chamar:
 *   curl -X POST https://athie-teia-aewo.vercel.app/api/import-linha47 \
 *        -H "x-import-secret: atie-linha47"
 *
 * Idempotente: aborta se já existir deal com aw_id_interno = 65968
 * ──────────────────────────────────────────────────────────────
 */

const { makeClient, getAssociations } = require('../lib/hubspot');

// ── Dados da linha 47 (DEALS-VIVOS-LuisaZerbini.xlsx) ─────────
const DEAL = {
  // Standard HubSpot
  dealname:     '4703/24 — CLARO Obra · Quota Corporate',
  pipeline:     '899974520',
  amount:       '40173000',
  closedate:    '2026-08-31',

  // Campos aw_* de migração
  aw_id_interno:                    '65968',
  aw_id_projeto_pai:                '65967',
  aw_numero_projeto:                '4703/24',
  aw_tipo_de_negocio:               'obra_only',          // Focus 'Obra' → HubSpot enum
  aw_area_m2:                       '11478',
  aw_valor_m2_projeto:              '3500',
  aw_natureza_valor:                'Estimado',
  aw_budget_declarado_total:        '0',
  // aw_lucratividade_estimada_pct omitido — propriedade não existe no HubSpot ATIE
  aw_fonte_de_origem:               'outros',             // Focus 'AW' (origem interna) → outros
  aw_setor_cliente:                 'outro',              // Focus 'telecomunicações' → outro
  // aw_envolvimento_comercial omitido — única opção HubSpot é 'A definir', não adequada
  aw_responsabilidade_den:          'false',              // Focus '0' → boolean false
  aw_apalavrado_com_cliente:        'false',
  // aw_probabilidade_negocio_existir omitido — sem opções enum definidas no HubSpot
  // aw_den, aw_gerente_comercial_conta, aw_funcionario_abertura omitidos — campos owner-type
  //   (requerem ID numérico); escopo crm.objects.owners.read ausente → atribuir manualmente
  aw_local:                         'aw_sao_paulo',       // Focus 'Interiores Escritório SP'
  aw_gerenciadoras_obs:             'BINSWANGER',
  // NULL no Focus → omitidos: aw_substatus, aw_data_previsao_original,
  //   aw_den_comercial, aw_concorrentes_no_deal, aw_projeto_top, aw_new_business
};

// Empresas a associar (rótulo exato do HubSpot)
const EMPRESAS = [
  { nome: 'CLARO',      rotulo: 'Cliente Final' },
  { nome: 'BINSWANGER', rotulo: 'Gerenciadora'  },
];

// Edifício (Custom Object) a associar — NomeCondominio do JsonEdificios
const EDIFICIO_NOME = 'Quota Corporate';

const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';
const BASE = 'https://api.hubapi.com';

module.exports = async (req, res) => {
  if (req.headers['x-import-secret'] !== 'atie-linha47') {
    return res.status(403).json({ error: 'Proibido' });
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN ausente' });

  const hs = makeClient(token);
  const log = [];

  try {
    // ── 0. Idempotência: verificar se deal já existe ──────────
    const existing = await hs('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'aw_id_interno', operator: 'EQ', value: '65968' }] }],
        properties: ['dealname', 'aw_id_interno'],
        limit: 1,
      }),
    });
    if (existing.results?.length) {
      const d = existing.results[0];
      return res.status(200).json({
        status: 'já_existe',
        deal_id: d.id,
        deal_url: `https://app.hubspot.com/contacts/51253038/deal/${d.id}`,
        mensagem: `Deal ${d.id} já existe com aw_id_interno=65968`,
      });
    }

    // ── 1. Stage: EPP → Proposta Apresentada (confirmado na 1ª execução)
    const stageId = '1360364554'; // Proposta Apresentada
    const stage = { id: stageId, label: 'Proposta Apresentada' };
    log.push({ etapa: 'stage_mapeado', epp: 'EPP', hubspot_stage: stage.label, id: stageId });

    // ── 2. Owner: sem escopo owners.read no Private App → skip
    const owner = null;
    log.push({ etapa: 'owner', aviso: 'Escopo crm.objects.owners.read ausente — atribuir Luisa Zerbini manualmente' });

    // ── 3a. Verificar enums ANTES de criar ────────────────────
    const ENUM_FIELDS = ['aw_fonte_de_origem','aw_tipo_de_negocio','aw_natureza_valor',
      'aw_probabilidade_negocio_existir','aw_envolvimento_comercial','aw_responsabilidade_den',
      'aw_setor_cliente','aw_local'];
    const enumDefs = {};
    for (const f of ENUM_FIELDS) {
      try {
        const def = await hs(`/crm/v3/properties/deals/${f}`);
        enumDefs[f] = (def.options || []).map(o => o.value);
      } catch { enumDefs[f] = []; }
    }
    log.push({ etapa: 'enum_opcoes', enumDefs });

    // Mapear valores Focus → opções HubSpot
    function mapEnum(field, focusValue) {
      const opts = enumDefs[field] || [];
      if (!opts.length || !focusValue) return null;
      // match exato
      if (opts.includes(focusValue)) return focusValue;
      // match case-insensitive
      const ci = opts.find(o => o.toLowerCase() === focusValue.toLowerCase());
      if (ci) return ci;
      // fallback
      return null;
    }

    const dealProps = {
      ...DEAL,
      dealstage: stageId,
      // substituir enums com valores validados
      aw_fonte_de_origem:               mapEnum('aw_fonte_de_origem', DEAL.aw_fonte_de_origem),
      aw_tipo_de_negocio:               mapEnum('aw_tipo_de_negocio', DEAL.aw_tipo_de_negocio)
                                        || mapEnum('aw_tipo_de_negocio', DEAL.aw_tipo_de_negocio.toLowerCase()),
      aw_natureza_valor:                mapEnum('aw_natureza_valor', DEAL.aw_natureza_valor),
      aw_probabilidade_negocio_existir: mapEnum('aw_probabilidade_negocio_existir', DEAL.aw_probabilidade_negocio_existir),
      aw_envolvimento_comercial:        mapEnum('aw_envolvimento_comercial', DEAL.aw_envolvimento_comercial),
      aw_responsabilidade_den:          mapEnum('aw_responsabilidade_den', DEAL.aw_responsabilidade_den),
      aw_setor_cliente:                 mapEnum('aw_setor_cliente', DEAL.aw_setor_cliente),
      aw_local:                         mapEnum('aw_local', DEAL.aw_local),
    };
    // Remover nulos (campos que não mapearam)
    Object.keys(dealProps).forEach(k => { if (dealProps[k] === null || dealProps[k] === undefined) delete dealProps[k]; });
    log.push({ etapa: 'deal_props_final', props: dealProps });

    if (owner) dealProps.hubspot_owner_id = String(owner.id);

    const deal = await hs('/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({ properties: dealProps }),
    });
    log.push({ etapa: 'deal_criado', id: deal.id });

    // ── 4. Buscar/criar empresas e associar ───────────────────
    for (const emp of EMPRESAS) {
      // buscar
      const search = await hs('/crm/v3/objects/companies/search', {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: emp.nome }] }],
          properties: ['name'],
          limit: 1,
        }),
      });
      let companyId;
      if (search.results?.length) {
        companyId = search.results[0].id;
        log.push({ etapa: 'empresa_encontrada', nome: emp.nome, id: companyId });
      } else {
        const created = await hs('/crm/v3/objects/companies', {
          method: 'POST',
          body: JSON.stringify({ properties: { name: emp.nome } }),
        });
        companyId = created.id;
        log.push({ etapa: 'empresa_criada', nome: emp.nome, id: companyId });
      }

      // Buscar typeId do rótulo
      const labelDefs = await hs('/crm/v4/associations/deals/companies/labels');
      const labelDef = (labelDefs.results || []).find(l =>
        l.label?.toLowerCase() === emp.rotulo.toLowerCase() ||
        l.inverseLabel?.toLowerCase() === emp.rotulo.toLowerCase()
      );
      const assocTypeId = labelDef?.typeId || 3; // fallback: associação padrão

      await hs(`/crm/v4/objects/deals/${deal.id}/associations/companies/${companyId}`, {
        method: 'PUT',
        body: JSON.stringify([{
          associationCategory: labelDef ? 'USER_DEFINED' : 'HUBSPOT_DEFINED',
          associationTypeId: assocTypeId,
        }]),
      });
      log.push({ etapa: 'associacao', deal: deal.id, empresa: emp.nome, rotulo: emp.rotulo, typeId: assocTypeId });
    }

    // ── 5. Associar Edifício Custom Object ────────────────────
    try {
      const edSearch = await hs(`/crm/v3/objects/${OBJ_EDIFICIO}/search`, {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'nome_do_edificio', operator: 'EQ', value: EDIFICIO_NOME }] }],
          properties: ['nome_do_edificio'],
          limit: 1,
        }),
      });
      if (edSearch.results?.length) {
        const edId = edSearch.results[0].id;
        // associar deal → edifício
        const edLabelDefs = await hs(`/crm/v4/associations/deals/${OBJ_EDIFICIO}/labels`).catch(() => ({ results: [] }));
        const edLabelDef = (edLabelDefs.results || [])[0]; // pegar qualquer rótulo disponível
        await hs(`/crm/v4/objects/deals/${deal.id}/associations/${OBJ_EDIFICIO}/${edId}`, {
          method: 'PUT',
          body: JSON.stringify([{
            associationCategory: edLabelDef ? 'USER_DEFINED' : 'HUBSPOT_DEFINED',
            associationTypeId: edLabelDef?.typeId || 2,
          }]),
        });
        log.push({ etapa: 'edificio_associado', edificio: EDIFICIO_NOME, id: edId });
      } else {
        log.push({ etapa: 'edificio_aviso', mensagem: `Edifício "${EDIFICIO_NOME}" não encontrado no HubSpot — criar manualmente e re-associar` });
      }
    } catch (edErr) {
      log.push({ etapa: 'edificio_erro', erro: edErr.message });
    }

    // ── Resposta final ────────────────────────────────────────
    return res.status(200).json({
      status: 'ok',
      deal_id: deal.id,
      deal_url: `https://app.hubspot.com/contacts/51253038/deal/${deal.id}`,
      stage_usado: stage?.label,
      owner: owner ? `${owner.firstName} ${owner.lastName}` : null,
      log,
      pendencias: [
        'Verificar se stage "' + stage?.label + '" é o correto para EPP',
        'aw_lucratividade_estimada_pct = 1406055 (valor absoluto, não %) — confirmar tipo do campo no HubSpot',
        'aw_responsabilidade_den = 0 — confirmar valores válidos do dropdown',
        deal.properties?.hubspot_owner_id ? null : 'Owner Luisa Zerbini não encontrado — atribuir manualmente',
      ].filter(Boolean),
    });

  } catch (err) {
    return res.status(502).json({ error: err.message, log });
  }
};
