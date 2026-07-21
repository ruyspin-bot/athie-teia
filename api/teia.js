/**
 * /api/teia
 * ------------------------------------------------------------------
 * Versão Fase 2 — lê Andar e Edifício como Custom Objects de verdade,
 * em vez do texto livre no Deal. Estrutura:
 *   1. Deals ativos.
 *   2. Deal -> Company (Cliente Final, Broker, Gerenciadora, ...) — igual
 *      já era, sem mudança.
 *   3. Deal -> Andar (rótulo "Negócio"/"Andar Negociado").
 *   4. Andar -> Edifício (rótulo "Pertence a").
 *   5. Andar -> Company (rótulo "Dono"/"Proprietário").
 *   6. Monta um array `andares` por deal, cada um com seu próprio dono —
 *      isso é o que resolve "dono variando por andar no mesmo negócio".
 *
 * Se a leitura dos Custom Objects falhar (nome do objeto errado, escopo
 * faltando, ou eles ainda não existirem/populados), cai para o modelo
 * antigo (edifício/andar como texto no Deal) e avisa em meta.aviso —
 * nunca quebra a teia por causa disso.
 *
 * CONFIGURAÇÃO NECESSÁRIA (variáveis de ambiente na Vercel):
 *   HUBSPOT_TOKEN        (obrigatória) — token do Private App, escopos:
 *                         crm.objects.deals.read, crm.objects.companies.read,
 *                         crm.objects.custom.read, crm.schemas.deals.read,
 *                         crm.schemas.companies.read, crm.schemas.custom.read
 *
 * CONFIGURAÇÃO DOS CUSTOM OBJECTS — ver README "Em aberto (Fase 2)".
 * Os defaults abaixo são um PALPITE a partir do portal ID do Blueprint
 * (51253038) + convenção padrão do HubSpot (p<portalId>_<nome plural>).
 * CONFIRME na tela "Detalhes da API" de um registro real antes de confiar.
 *   HUBSPOT_OBJECT_ANDAR         (default: "p51253038_andares")
 *   HUBSPOT_OBJECT_EDIFICIO      (default: "p51253038_edificios")
 *   HUBSPOT_PROP_ANDAR_NOME      (default: "nome_do_andar")
 *   HUBSPOT_PROP_ANDAR_NUMERO    (default: "numero_do_andar")
 *   HUBSPOT_PROP_EDIFICIO_NOME   (default: "name" — display property padrão)
 *   HUBSPOT_PROP_EDIFICIO_CNPJ   (default: "cnpj_do_condominio")
 *
 * CONFIGURAÇÃO ANTIGA, mantida como fallback (ver README):
 *   HUBSPOT_PROP_EDIFICIO   (default: "aw_edificio_id")
 *   HUBSPOT_PROP_ANDAR      (default: "aw_andar_de_interesse")
 *   HUBSPOT_NUCLEO_SOURCE   "pipeline" (default) ou "property"
 *   HUBSPOT_PROP_NUCLEO     nome da propriedade, se HUBSPOT_NUCLEO_SOURCE=property
 * ------------------------------------------------------------------
 */

const {
  makeClient,
  getPipelineNames,
  getStageNames,
  getActiveDeals,
  getAssociations,
  getObjectsById,
  getCompanies,
  listAllObjects,
} = require('../lib/hubspot');
const { isConfigured, isAuthed } = require('../lib/auth');

const HUBSPOT_BASE = 'https://api.hubapi.com';

// ---- Custom Objects da Fase 2 (palpite a confirmar — ver docstring acima) ----
const OBJ_ANDAR = process.env.HUBSPOT_OBJECT_ANDAR || 'p51253038_andares';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';
const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const PROP_ANDAR_NOME = process.env.HUBSPOT_PROP_ANDAR_NOME || 'nome_do_andar';
const PROP_ANDAR_NUMERO = process.env.HUBSPOT_PROP_ANDAR_NUMERO || 'numero_do_andar';
const PROP_EDIFICIO_NOME = process.env.HUBSPOT_PROP_EDIFICIO_NOME || 'nome_do_edificio';
const PROP_EDIFICIO_CNPJ = process.env.HUBSPOT_PROP_EDIFICIO_CNPJ || 'cnpj_do_condominio';

// ---- fallback do modelo antigo (Fase 1), usado só se os Custom Objects falharem ----
const PROP_EDIFICIO = process.env.HUBSPOT_PROP_EDIFICIO || 'aw_edificio_id';
const PROP_ANDAR = process.env.HUBSPOT_PROP_ANDAR || 'aw_andar_de_interesse';
const NUCLEO_SOURCE = process.env.HUBSPOT_NUCLEO_SOURCE || 'pipeline'; // 'pipeline' | 'property'
const PROP_NUCLEO = process.env.HUBSPOT_PROP_NUCLEO || 'nucleo';
const PROP_TIPO = process.env.HUBSPOT_PROP_TIPO || 'aw_tipo_de_negocio'; // "Tipo de Negócio AW"

// ---- mapeia o RÓTULO da associação Deal<->Company para um papel conhecido ----
// Confirmado em 09/07 direto na tela de edição de associação (Deal<->Company)
// do HubSpot da ATIE. Rótulos reais (8, incluindo os pares): Cliente Final,
// Broker, Concorrente, Escritório Parceiro, Gerenciadora, "Edificio avaliado
// em" / "Edificio do Deal", "Indicou em" / "Indicador", "PM do Cliente" /
// "Deal como PM". Rótulos que não baterem em nada caem em "outro" (viram nó
// tipo "escritorio") e são listados em meta.unmatched_labels.
//
// IMPORTANTE — "Dono"/"Incorporador"/"Dona de Prédio" NÃO existem como rótulo
// de associação Deal<->Company (só existem como opção da propriedade "Papéis
// Possíveis" da Company). Ou seja: hoje não tem como a teia mostrar "dono do
// andar" a partir da associação do deal. O campo "Proprietário da empresa" que
// aparece no card da Company é provavelmente uma associação Company<->Company
// separada — ainda não lida por esta função (ver README, seção "Em aberto").
const ROLE_RULES = [
  { role: 'cliente', match: /cliente/i },                       // "Cliente Final"
  { role: 'broker', match: /broker/i },                         // "Broker"
  { role: 'gerenciadora', match: /gerenc/i },                   // "Gerenciadora"
  { role: 'edificio_company', match: /edif[íi]cio/i },          // "Edificio avaliado em" / "Edificio do Deal"
  { role: 'parceiro', match: /parceir/i },                      // "Escritório Parceiro" / "Deal como Parceiro"
  { role: 'concorrente', match: /concorrent/i },                // "Concorrente"
  { role: 'indicador', match: /indic/i },                       // "Indicou em" / "Indicador"
  { role: 'pm', match: /\bpm\b/i },                             // "PM do Cliente" / "Deal como PM"
];

// cache em memória — só ajuda enquanto a função ficar "quente" (mesma instância);
// reduz chamadas em navegações repetidas dentro de poucos minutos.
let cache = { at: 0, payload: null };
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos

module.exports = async (req, res) => {
  try {
    // ---- gate de senha: exige cookie de sessão válido (ver lib/auth.js) ----
    // Enquanto APP_PASSWORD não estiver configurada, mantém aberto pra não
    // derrubar o ambiente antes de a senha ser definida na Vercel.
    if (isConfigured() && !isAuthed(req)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'Não autenticado.', auth_required: true });
      return;
    }

    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      res.status(500).json({ error: 'Faltou configurar HUBSPOT_TOKEN nas variáveis de ambiente da Vercel.' });
      return;
    }

    if (cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(cache.payload);
      return;
    }

    const hs = makeClient(token);

    const [nucleoByPipelineId, stageNamesById] = await Promise.all([
      NUCLEO_SOURCE === 'pipeline' ? getPipelineNames(hs) : Promise.resolve(null),
      getStageNames(hs),
    ]);

    const allDeals = await getActiveDeals(hs, [
      'dealname',
      'pipeline',
      'dealstage',
      'amount',
      PROP_EDIFICIO,
      PROP_ANDAR,
      PROP_NUCLEO,
      PROP_TIPO,
    ]);
    if (!allDeals.length) {
      const payload = { deals: [], meta: { total_deals: 0, deals_incluidos: 0, gerado_em: new Date().toISOString(), fonte: 'hubspot' } };
      res.status(200).json(payload);
      return;
    }

    const allDealIds = allDeals.map((d) => d.id);
    const associationsByDeal = await getAssociations(hs, 'deals', 'companies', allDealIds);

    // Filtro core: só deals com ao menos 1 associação a empresa
    const rawDeals = allDeals.filter((d) => (associationsByDeal[d.id] || []).length > 0);

    const companyIdsFromDeals = [...new Set(Object.values(associationsByDeal).flatMap((arr) => arr.map((a) => a.toId)))];

    let deals_sem_edificio = 0;
    let deals_com_empresa_edificio = 0;
    const unmatchedLabels = new Set();

    // ---- tenta ler a Fase 2 (Custom Objects Andar/Edifício) ----
    let andaresByDeal = {};
    let andaresById = {};
    let edificiosById = {};
    let donoByAndar = {};
    let companyIdsFromAndares = [];
    let fase2Ok = false;
    let fase2Erro = null;

    try {
      const dealAndarAssoc = await getAssociations(hs, 'deals', OBJ_ANDAR, allDealIds);
      const andarIds = [...new Set(Object.values(dealAndarAssoc).flatMap((arr) => arr.map((a) => a.toId)))];

      if (andarIds.length) {
        andaresById = await getObjectsById(hs, OBJ_ANDAR, andarIds, [
          PROP_ANDAR_NOME, PROP_ANDAR_NUMERO,
          'disponibilidade', 'area_locavel_m2', 'area_privativa_m2',
          'preco_locacao_m2', 'aw_id_cretool_unit', 'aw_id_focus',
        ]);

        const andarEdificioAssoc = await getAssociations(hs, OBJ_ANDAR, OBJ_EDIFICIO, andarIds);
        const edificioIds = [...new Set(Object.values(andarEdificioAssoc).flatMap((arr) => arr.map((a) => a.toId)))];
        if (edificioIds.length) {
          edificiosById = await getObjectsById(hs, OBJ_EDIFICIO, edificioIds, [PROP_EDIFICIO_NOME, PROP_EDIFICIO_CNPJ]);
        }

        const andarCompanyAssoc = await getAssociations(hs, OBJ_ANDAR, 'companies', andarIds);
        companyIdsFromAndares = [...new Set(Object.values(andarCompanyAssoc).flatMap((arr) => arr.map((a) => a.toId)))];

        // monta: andarId -> { id, nome, numero, edificio, dono }
        andarIds.forEach((andarId) => {
          const andarObj = andaresById[andarId];
          const edificioAssoc = (andarEdificioAssoc[andarId] || [])[0];
          const edificioObj = edificioAssoc ? edificiosById[edificioAssoc.toId] : null;
          const donoAssoc = (andarCompanyAssoc[andarId] || [])[0];

          donoByAndar[andarId] = {
            andar: andarObj
              ? {
                  id: andarId,
                  nome: andarObj.properties[PROP_ANDAR_NOME] || `Andar ${andarId}`,
                  numero: andarObj.properties[PROP_ANDAR_NUMERO] || null,
                  disp: andarObj.properties.disponibilidade || null,
                  area: andarObj.properties.area_locavel_m2
                    ? parseFloat(andarObj.properties.area_locavel_m2) : null,
                  cretool: andarObj.properties.aw_id_cretool_unit || null,
                  focus: andarObj.properties.aw_id_focus || null,
                }
              : { id: andarId, nome: `Andar ${andarId}`, numero: null, disp: null, area: null },
            edificio: edificioObj
              ? { id: edificioAssoc.toId, nome: edificioObj.properties[PROP_EDIFICIO_NOME] || `Edifício ${edificioAssoc.toId}` }
              : null,
            donoCompanyId: donoAssoc ? donoAssoc.toId : null,
          };
        });

        // deal -> lista de andares (objeto completo, dono resolvido depois que tivermos os nomes das companies)
        Object.entries(dealAndarAssoc).forEach(([dealId, arr]) => {
          andaresByDeal[dealId] = arr.map((a) => donoByAndar[a.toId]).filter(Boolean);
        });

        fase2Ok = true;
      }
    } catch (err) {
      fase2Erro = err.message;
      console.warn('[api/teia] Fase 2 (Andar/Edifício) indisponível, usando fallback de texto:', err.message);
    }

    // companies + contatos em paralelo
    const rawDealIds = rawDeals.map((d) => d.id);
    const allCompanyIds = [...new Set([...companyIdsFromDeals, ...companyIdsFromAndares])];
    const [companiesById, contactAssocByDeal] = await Promise.all([
      getCompanies(hs, allCompanyIds),
      getAssociations(hs, 'deals', 'contacts', rawDealIds),
    ]);
    const allContactIds = [...new Set(Object.values(contactAssocByDeal).flatMap((arr) => arr.map((a) => a.toId)))];
    const contactsById = allContactIds.length
      ? await getObjectsById(hs, 'contacts', allContactIds, ['firstname', 'lastname', 'jobtitle'])
      : {};

    const deals = rawDeals.map((d) => {
      const p = d.properties || {};
      const nucleo =
        NUCLEO_SOURCE === 'pipeline'
          ? nucleoByPipelineId[p.pipeline] || p.pipeline || 'Núcleo não identificado'
          : p[PROP_NUCLEO] || 'Núcleo não identificado';

      const record = {
        id: d.id,
        nome: p.dealname || `Deal ${d.id}`,
        nucleo,
        tipo: p[PROP_TIPO] || null,  // "Tipo de Negócio AW" (ex: "Projeto", "Obra")
        stage: stageNamesById[p.dealstage] || p.dealstage || '—',
        valor: p.amount ? parseFloat(p.amount) : null,
        cliente: null,
        broker: null,
        gerenciadora: null,
        dono: null,
        parceiro: null,
        concorrente: null,
        edificio: null,
        andar: null,
        andares: [], // Fase 2: cada item tem seu próprio dono
        contatos: (contactAssocByDeal[d.id] || []).map((a) => {
          const c = contactsById[a.toId];
          if (!c) return null;
          const cp = c.properties;
          return {
            nome: [cp.firstname, cp.lastname].filter(Boolean).join(' ') || `Contato ${a.toId}`,
            cargo: cp.jobtitle || null,
          };
        }).filter(Boolean),
      };

      // ---- papéis Deal<->Company (Cliente Final, Broker...) — igual antes ----
      const assocs = associationsByDeal[d.id] || [];
      assocs.forEach((a) => {
        const company = companiesById[a.toId];
        const companyName = company ? company.properties.name : `Company ${a.toId}`;
        const rule = ROLE_RULES.find((r) => r.match.test(a.label || ''));
        const role = rule ? rule.role : 'outro';
        if (role === 'edificio_company') {
          deals_com_empresa_edificio++;
          record.edificio_company_legado = companyName;
        } else if (role === 'outro') {
          unmatchedLabels.add(a.label || '(sem rótulo)');
          if (!record.parceiro) record.parceiro = companyName;
        } else if (!record[role]) {
          record[role] = companyName;
        }
      });

      // ---- Fase 2: andares reais, cada um com seu dono ----
      const andaresDoDeal = andaresByDeal[d.id] || [];
      if (fase2Ok && andaresDoDeal.length) {
        record.andares = andaresDoDeal.map((a) => ({
          id: a.andar.id,
          nome: a.andar.nome,
          numero: a.andar.numero,
          disp: a.andar.disp,
          area: a.andar.area,
          cretool: a.andar.cretool,
          focus: a.andar.focus,
          edificio: a.edificio ? a.edificio.nome : 'Sem edifício identificado',
          edificioId: a.edificio ? a.edificio.id : null,
          dono: a.donoCompanyId ? (companiesById[a.donoCompanyId] ? companiesById[a.donoCompanyId].properties.name : `Company ${a.donoCompanyId}`) : null,
        }));
        // campos "resumo" (compat com o grafo atual, que ainda espera 1 valor por deal)
        record.edificio = record.andares[0].edificio;
        record.edificioId = record.andares[0].edificioId || null;
        record.andar = record.andares.map((a) => a.nome).join(', ');
        record.dono = record.andares.find((a) => a.dono) ? record.andares.find((a) => a.dono).dono : null;
      } else {
        // ---- fallback Fase 1: texto livre no Deal ----
        record.edificio = p[PROP_EDIFICIO] || null;
        record.andar = p[PROP_ANDAR] || null;
        if (!record.edificio) {
          deals_sem_edificio++;
          record.edificio = 'Sem edifício identificado';
        }
      }

      return record;
    });

    // ---- inventário de ANDARES por edifício (só dos edifícios com deal → leve) ----
    // Permite a Vista Multi-Prédio mostrar a torre completa: andares ocupados
    // (com deal) + andares vagos (sem negócio) — a "visão de andar + conjunto".
    let floorsByEdificioId = {};
    if (fase2Ok) {
      try {
        const edIds = [...new Set(
          deals.flatMap((d) => (d.andares || []).map((a) => a.edificioId).filter(Boolean))
        )];
        if (edIds.length) {
          const edAndarAssoc = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, edIds);
          const floorIds = [...new Set(Object.values(edAndarAssoc).flatMap((arr) => arr.map((a) => a.toId)))];
          const floorObjs = floorIds.length
            ? await getObjectsById(hs, OBJ_ANDAR, floorIds, [
                PROP_ANDAR_NOME, PROP_ANDAR_NUMERO, 'disponibilidade',
                'area_locavel_m2', 'area_privativa_m2', 'preco_locacao_m2',
                'aw_id_cretool_unit', 'aw_id_focus',
              ])
            : {};

          // conjuntos: Andar → Conjunto
          const floorConjuntoAssoc = floorIds.length
            ? await getAssociations(hs, OBJ_ANDAR, OBJ_CONJUNTO, floorIds)
            : {};
          const conjuntoIds = [...new Set(
            Object.values(floorConjuntoAssoc).flatMap((arr) => arr.map((a) => a.toId))
          )];
          const conjuntosById = conjuntoIds.length
            ? await getObjectsById(hs, OBJ_CONJUNTO, conjuntoIds, [
                'nome_do_conjunto', 'disponibilidade', 'area_m2', 'nome_do_proprietario',
              ])
            : {};

          edIds.forEach((edId) => {
            floorsByEdificioId[edId] = (edAndarAssoc[edId] || [])
              .map((a) => {
                const o = floorObjs[a.toId];
                if (!o) return null;
                const conjuntos = (floorConjuntoAssoc[a.toId] || [])
                  .map((ca) => {
                    const cj = conjuntosById[ca.toId];
                    if (!cj) return null;
                    const cp = cj.properties;
                    return {
                      id: ca.toId,
                      nome: cp.nome_do_conjunto || null,
                      disp: cp.disponibilidade || null,
                      area: cp.area_m2 ? parseFloat(cp.area_m2) : null,
                      proprietario: cp.nome_do_proprietario || null,
                    };
                  })
                  .filter(Boolean);
                return {
                  id: a.toId,
                  numero: o.properties[PROP_ANDAR_NUMERO] || null,
                  nome: o.properties[PROP_ANDAR_NOME] || null,
                  disp: o.properties.disponibilidade || null,
                  area: o.properties.area_locavel_m2
                    ? parseFloat(o.properties.area_locavel_m2)
                    : (o.properties.area_privativa_m2 ? parseFloat(o.properties.area_privativa_m2) : null),
                  preco_m2: o.properties.preco_locacao_m2 ? parseFloat(o.properties.preco_locacao_m2) : null,
                  cretool: o.properties.aw_id_cretool_unit || null,
                  focus: o.properties.aw_id_focus || null,
                  conjuntos,
                };
              })
              .filter(Boolean);
          });
        }
      } catch (err) {
        console.warn('[api/teia] inventário de andares indisponível:', err.message);
      }
    }

    // ---- inventário COMPLETO de edifícios (inclui os sem deal) ----
    // Sem isto a teia só mostra prédios referenciados por algum deal; o cliente
    // quer ver todos os edifícios da base (ex.: Platinum Tower, sem negócio ainda).
    let edificiosInventario = [];
    try {
      const raw = await listAllObjects(hs, OBJ_EDIFICIO, [
        PROP_EDIFICIO_NOME, 'endereco', 'microrregiao', 'regiao', 'classe_edificio',
      ]);
      edificiosInventario = raw
        .map((e) => ({
          id: e.id,
          nome: (e.properties[PROP_EDIFICIO_NOME] || '').trim(),
          endereco: e.properties.endereco || null,
          regiao: e.properties.microrregiao || e.properties.regiao || null,
          classe: e.properties.classe_edificio || null,
        }))
        .filter((e) => e.nome && !/n[ãa]o\s*identificad/i.test(e.nome));
    } catch (err) {
      console.warn('[api/teia] inventário de edifícios indisponível:', err.message);
    }

    const payload = {
      deals,
      edificios: edificiosInventario,
      floors_por_edificio_id: floorsByEdificioId,
      meta: {
        total_deals_no_hubspot: allDeals.length,
        deals_com_associacao: rawDeals.length,
        deals_incluidos: deals.length,
        deals_sem_edificio,
        deals_com_empresa_edificio,
        total_edificios: edificiosInventario.length,
        unmatched_labels: [...unmatchedLabels],
        modelo: fase2Ok ? 'fase2_custom_objects' : 'fase1_texto_legado',
        fase2_erro: fase2Erro,
        gerado_em: new Date().toISOString(),
        fonte: 'hubspot',
      },
    };

    cache = { at: Date.now(), payload };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/teia] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao consultar o HubSpot.' });
  }
};
