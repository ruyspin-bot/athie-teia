/**
 * scripts/importar-focus.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Importa dados do Focus CRM para o HubSpot ATIE a partir de arquivos Excel.
 * Processo idempotente: usa aw_id_focus para não duplicar registros.
 *
 * Uso:
 *   node --env-file=.env.local scripts/importar-focus.mjs --entidade companies --arquivo ~/Downloads/companies-focus.xlsx
 *   node --env-file=.env.local scripts/importar-focus.mjs --entidade deals    --arquivo ~/Downloads/DEALS-VIVOS-LuisaZerbini.xlsx
 *
 * Flags:
 *   --entidade   : companies | deals | edificios | andares  (obrigatório)
 *   --arquivo    : caminho do arquivo Excel                 (obrigatório)
 *   --dry-run    : mostra o que seria feito sem chamar a API
 *   --limite N   : importa só os primeiros N registros (útil para teste)
 *
 * Progresso:
 *   Salvo em scripts/.progress-<entidade>.json
 *   Re-rodar pula registros já processados com sucesso.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import zlib from 'zlib';

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN'); process.exit(1); }

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : null; };
const has  = (flag) => args.includes(flag);

const ENTIDADE = get('--entidade');
const ARQUIVO  = get('--arquivo');
const DRY      = has('--dry-run');
const LIMITE   = parseInt(get('--limite') || '99999', 10);

if (!ENTIDADE || !ARQUIVO) {
  console.error('Uso: node scripts/importar-focus.mjs --entidade <tipo> --arquivo <xlsx>\n');
  console.error('  --entidade : companies | deals | edificios | andares');
  console.error('  --arquivo  : caminho do arquivo Excel');
  console.error('  --dry-run  : modo simulação');
  console.error('  --limite N : importar só N registros (teste)');
  process.exit(1);
}

const PROG_FILE = new URL(`.progress-${ENTIDADE}.json`, import.meta.url).pathname;
const BASE      = 'https://api.hubapi.com';

// ─── Utilitários ──────────────────────────────────────────────────────────────
async function hs(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HubSpot ${opts.method || 'GET'} ${path} → ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function associar(fromType, fromId, toType, toId, typeId) {
  await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, {
    method: 'PUT',
    body: JSON.stringify([{ associationCategory: 'USER_DEFINED', associationTypeId: typeId }]),
  });
}

async function upsertObjeto(objectType, mapped, progresso, progFile) {
  const key = String(mapped.focusId);
  if (progresso[key]?.status === 'ok') return progresso[key].hubspotId;

  const existente = await buscarPorIdFocus(objectType, key);
  let hubspotId;
  if (existente) {
    await hs(`/crm/v3/objects/${objectType}/${existente.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: mapped.properties }),
    });
    hubspotId = existente.id;
  } else {
    const created = await hs(`/crm/v3/objects/${objectType}`, {
      method: 'POST',
      body: JSON.stringify({ properties: mapped.properties }),
    });
    hubspotId = created.id;
  }
  progresso[key] = { status: 'ok', hubspotId, focusId: key };
  writeFileSync(progFile, JSON.stringify(progresso, null, 2));
  await sleep(120);
  return hubspotId;
}

async function buscarPorIdFocus(objectType, idFocus) {
  const propIdFocus = objectType === 'deals' ? 'aw_id_interno' : 'aw_id_focus';
  const result = await hs(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{
        filters: [{ propertyName: propIdFocus, operator: 'EQ', value: String(idFocus) }],
      }],
      properties: [propIdFocus, 'name', 'dealname'],
      limit: 1,
    }),
  });
  return result.results?.[0] || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Leitor de XLSX ───────────────────────────────────────────────────────────
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));
}

function lerXlsx(caminho) {
  const data = readFileSync(caminho);
  const files = {};
  let pos = 0;
  while (pos < data.length - 4) {
    if (data[pos] === 0x50 && data[pos+1] === 0x4B && data[pos+2] === 0x03 && data[pos+3] === 0x04) {
      const comp    = data.readUInt16LE(pos+8);
      const compSz  = data.readUInt32LE(pos+18);
      const fnLen   = data.readUInt16LE(pos+26);
      const exLen   = data.readUInt16LE(pos+28);
      const fname   = data.slice(pos+30, pos+30+fnLen).toString();
      const dStart  = pos+30+fnLen+exLen;
      const cData   = data.slice(dStart, dStart+compSz);
      if (comp === 8) { try { files[fname] = zlib.inflateRawSync(cData).toString('utf8'); } catch(_) {} }
      else if (comp === 0) { files[fname] = cData.toString('utf8'); }
      pos = dStart + compSz;
    } else { pos++; }
  }

  // sharedStrings (nem todo export usa — alguns escrevem inlineStr direto na célula)
  const ssXml = files['xl/sharedStrings.xml'] || '';
  const strings = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXmlEntities(t[1]));
    strings.push(parts.join(''));
  }

  // sheet1
  const ws = files['xl/worksheets/sheet1.xml'] || '';
  const rows = [];
  for (const rowMatch of ws.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cMatch of rowMatch[1].matchAll(/<c[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const full   = cMatch[0];
      const tAttr  = full.match(/ t="([^"]*)"/)?.[1];
      const rAttr  = full.match(/r="([A-Z]+)/)?.[1] || '';
      const col    = rAttr ? rAttr.split('').reduce((acc,ch) => acc*26+(ch.charCodeAt(0)-64), 0) - 1 : cells.length;
      // Preencher colunas vazias
      while (cells.length < col) cells.push('');

      if (tAttr === 'inlineStr') {
        const t = full.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        cells.push(decodeXmlEntities(t));
        continue;
      }
      const vEl = full.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (!vEl) { cells.push(''); continue; }
      if (tAttr === 's') cells.push(strings[parseInt(vEl)] ?? '');
      else if (tAttr === 'b') cells.push(vEl === '1' ? 'true' : 'false');
      else cells.push(decodeXmlEntities(vEl));
    }
    rows.push(cells);
  }

  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => {
      const v = (row[i] ?? '').toString().trim();
      return [h, v === 'NULL' ? '' : v]; // export do Focus usa a string "NULL" para campo vazio
    }))
  );
}

// ─── Mapeamentos por entidade ─────────────────────────────────────────────────

function mapearCompany(row) {
  // Para a exportação de grupos comerciais do Focus
  // Campos esperados: IdGrupoComercial, NomeGrupoComercial, TipoClassificacao (ou similar)
  const id = row.IdGrupoComercial || row.Id || row.ID;
  const nome = row.NomeGrupoComercial || row.Nome || row.name || row.Name;
  if (!id || !nome) return null;
  return {
    focusId: id,
    properties: {
      name:         nome,
      aw_id_focus:  String(id),
    },
  };
}

function mapearDeal(row) {
  if (!row.IdProjeto) return null;

  // Mapeamento de Status (Focus) → stage HubSpot, confirmado por Lucca (AW)
  // via coluna "Etapa HubSpot" da planilha DEALS-VIVOS-LuisaZerbini_com_categoria,
  // cruzado com os stages reais do pipeline 899974520.
  // 'LEAD' não é deal — Lucca marcou como "Fora do pipeline, importar como Lead/Contato".
  if (row.Status === 'LEAD') return null;

  const STAGE_MAP = {
    'LEAD QLF':  '1360364548', // Recebido no Núcleo
    'QLF':       '1366396702', // Diagnóstico / Briefing / Test Fit
    'EVT TSF':   '1360364552', // Estratégia Definida
    'EPP':       '1360364553', // Proposta em Elaboração
    'NEG':       '1360364555', // Em Negociação / Short List
    'LEV':       '1360364557', // Contrato Assinado (deal em execução/entrega)
    'AP':        '1360364557', // Contrato Assinado
    'OBRA':      '1360364557', // Contrato Assinado
    'EX':        '1360364557', // Contrato Assinado
    'AS BUILT':  '1360364557', // Contrato Assinado
    'CHECKLIST': '1360364557', // Contrato Assinado
  };

  // Mapeamento de escopo → enum HubSpot
  const ESCOPO_MAP = {
    '1': 'projeto_only',
    '2': 'obra_only',
    '3': 'projeto_e_obra',
    'projeto':         'projeto_only',
    'obra':            'obra_only',
    'projeto e obra':  'projeto_e_obra',
    'projeto + obra':  'projeto_e_obra',
    'Projeto':         'projeto_only',
    'Obra':            'obra_only',
    'Projeto e Obra':  'projeto_e_obra',
    'Projeto + Obra':  'projeto_e_obra',
  };

  // Mapeamento de origem (Focus → aw_fonte_de_origem: broker, gerenciadora, incorporadora, escritorio_arquitetura, cliente_direto, outros)
  const ORIGEM_MAP = {
    'AW':                  'outros',
    'NB':                  'outros',
    'HUNTING':             'outros',
    'CLIENTE ESPONTANEO':  'cliente_direto',
    'INDICAÇÃO CLIENTE':   'cliente_direto',
    'INCORPORADORA':       'incorporadora',
  };

  // Probabilidade textual (Focus) → escala numérica (HubSpot espera number)
  const PROBABILIDADE_MAP = { 'Baixa': 25, 'Média': 50, 'Alta': 75 };

  // Ramo de atividade (Focus, texto livre) → aw_setor_cliente (enum fixo)
  const SETOR_MAP = {
    'indústria':                      'industria',
    'governo':                        'governo',
    'tecnologia':                     'tech',
    'bancos, financeiras e trading':  'financeiro',
    'saúde':                          'saude',
    'varejo':                         'varejo',
    'serviços de seguro':             'financeiro',
    'serviços financeiros':           'financeiro',
    // ambíguos — sem opção específica no HubSpot, jogados em "outro"
    'telecomunicações':               'outro',
    'transportes e logística':        'outro',
    'serviços especializados':        'outro',
    'entretenimento':                 'outro',
    'alimentação':                    'outro',
    'produção agropecuária':          'outro',
    'bens de consumo':                'outro',
  };

  // Área de atuação (Focus) → aw_local (cidade)
  const LOCAL_MAP = {
    'Interiores Escritório SP': 'aw_sao_paulo',
    'Interiores Escritório RJ': 'aw_rio',
  };

  const props = {
    dealname:              `${row.NumeroProjeto ? row.NumeroProjeto + ' — ' : ''}${row.NomeProjeto || row.GrupoComercial}`,
    pipeline:              '899974520',
    amount:                row.Valor || '', // vazio != zero — não assumir R$0 quando o Focus não informou valor
    aw_id_interno:         row.IdProjeto,
    aw_id_projeto_pai:     row.IdProjetoPai || '',
    aw_numero_projeto:     row.NumeroProjeto || '',
    aw_area_m2:            row.Area || '',
    aw_valor_m2_projeto:   row.ValorMetro || '',
    aw_id_agrupador:       row.IdAgrupador || '',
    aw_chances_ganhar:     row.ChancesGanhar || '',
    aw_frequencia_comercial: row.FrequenciaComercial || '',
    aw_funcionario_abertura: row.FuncionarioAbertura || '',
    aw_gerente_comercial_conta: row.GerenteComercialConta || '',
    aw_projeto_top:        row.ProjetoTOP === '1' || row.ProjetoTOP === 'true' ? 'true' : 'false',
    aw_apalavrado_com_cliente: row.Apalavrado === '1' || row.Apalavrado === 'S' ? 'true' : 'false',
    aw_responsabilidade_den:   row.ResponsabilidadeDEN === '1' ? 'true' : 'false',
    aw_substatus:              row.SubStatus || '',
    aw_probabilidade_negocio_existir: PROBABILIDADE_MAP[row.ProbabilidadeNegocioExistir] ?? '',
    aw_envolvimento_comercial: row.EnvolvimentoComercial || '', // opções cadastradas em aw_envolvimento_comercial já usam o texto bruto do Focus
    aw_natureza_valor:         row.NaturezaValor || '',
    aw_budget_declarado_total: row.BudgetDeclarado || '',
    aw_new_business:           row.NewBusiness ? 'true' : 'false',
    aw_setor_cliente:          SETOR_MAP[row.RamoAtividade] || (row.RamoAtividade ? 'outro' : ''),
    aw_conta_negocio:          row.ContaNegocio || '',
    aw_local:                  LOCAL_MAP[row.AreaAtuacao] || '',
    aw_den_comercial:          row.DENComercial || '',
  };

  // Campos condicionais — só incluir se tiver mapeamento válido
  if (row.DataFechamento) {
    try {
      props.closedate = new Date(row.DataFechamento.split('/').reverse().join('-')).toISOString();
    } catch (_) {}
  }
  if (row.DataFechamentoOriginal) {
    try {
      props.aw_data_previsao_original = new Date(row.DataFechamentoOriginal.split('/').reverse().join('-')).toISOString();
    } catch (_) {}
  }
  if (ESCOPO_MAP[row.Escopo] || ESCOPO_MAP[row.IdEscopo]) {
    props.aw_tipo_de_negocio = ESCOPO_MAP[row.Escopo] || ESCOPO_MAP[row.IdEscopo];
  }
  if (row.Origem && ORIGEM_MAP[row.Origem]) {
    props.aw_fonte_de_origem = ORIGEM_MAP[row.Origem];
  }

  // Stage: tentar mapear pelo Status do Focus
  const stageId = STAGE_MAP[row.IdStatus] || STAGE_MAP[row.Status];
  if (stageId) props.dealstage = stageId;

  // Limpar campos vazios
  Object.keys(props).forEach(k => { if (props[k] === '' || props[k] == null) delete props[k]; });

  return {
    focusId: row.IdProjeto,
    properties: props,
    // Metadados para associações (processados depois)
    gerenciadora: row.Gerenciadora,
    broker:        row.Broker !== 'Não tem' ? row.Broker : null,
    idGerenciadora: row.IdGerenciadora,
    idBroker:       row.IdBrokerLocacoes,
    jsonEdificios:  parseJsonEdificios(row.JsonEdificios),
  };
}

function parseJsonEdificios(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function mapearEdificio(row) {
  const id = row.IdCondominio || row.IdEdificio || row.Id;
  const nome = row.NomeCondominio || row.NomeEdificio || row.Nome;
  if (!id || !nome) return null;
  return {
    focusId: id,
    properties: {
      nome_do_edificio:      nome,
      aw_id_focus:           String(id),
      aw_id_edificio_focus:  row.IdEdificio ? String(row.IdEdificio) : '',
      nome_torre:            row.NomeEdificio || '',
      cnpj_do_condominio:    row.CnpjCondominio || '',
    },
  };
}

function mapearAndar(row) {
  const id = row.IdEdificioPavimento || row.IdPavimento || row.Id;
  const nomeAndar = row.NomeEdificioPavimento || row.NomePavimento || row.Nome;
  if (!id || !nomeAndar) return null;

  // Padronização do nome: "<andar> — <edifício> [/ <torre>]", pra não ficar ambíguo
  // entre prédios diferentes (ex.: "3º Andar" existe em várias construções).
  const numeroExtraido = (nomeAndar.match(/\d+/) || [])[0] || '';
  const nomeEdificio = row.NomeCondominio || '';
  const torre = row.NomeEdificio && row.NomeEdificio !== row.NomeCondominio && row.NomeEdificio !== 'Único' ? row.NomeEdificio : '';
  const edificioLabel = [nomeEdificio, torre].filter(Boolean).join(' / ');

  return {
    focusId: id,
    properties: {
      nome_do_andar: edificioLabel ? `${nomeAndar} — ${edificioLabel}` : nomeAndar,
      numero_do_andar: numeroExtraido || row.NumeroPavimento || row.Numero || '',
      aw_id_focus:    String(id),
    },
  };
}

const MAPPERS = { companies: mapearCompany, deals: mapearDeal, edificios: mapearEdificio, andares: mapearAndar };
const OBJECT_TYPES = {
  companies: 'companies',
  deals:     'deals',
  edificios: 'p51253038_edificios',
  andares:   'p51253038_andares',
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const mapper = MAPPERS[ENTIDADE];
  const objectType = OBJECT_TYPES[ENTIDADE];

  if (!mapper || !objectType) {
    console.error(`❌ Entidade desconhecida: ${ENTIDADE}. Use: companies | deals | edificios | andares`);
    process.exit(1);
  }

  console.log(`\n📥 Importação Focus → HubSpot`);
  console.log(`   Entidade  : ${ENTIDADE} (${objectType})`);
  console.log(`   Arquivo   : ${ARQUIVO}`);
  console.log(`   Modo      : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  console.log(`   Limite    : ${LIMITE < 99999 ? LIMITE : 'sem limite'}\n`);

  // Carregar progresso anterior
  let progresso = {};
  if (existsSync(PROG_FILE)) {
    try { progresso = JSON.parse(readFileSync(PROG_FILE, 'utf8')); }
    catch (_) { progresso = {}; }
    console.log(`   ♻️  Retomando progresso anterior (${Object.keys(progresso).length} já processados)\n`);
  }

  // Progresso de edifícios/andares (side-effect de deals via JsonEdificios)
  const PROG_FILE_EDIFICIOS = new URL('.progress-edificios.json', import.meta.url).pathname;
  const PROG_FILE_ANDARES   = new URL('.progress-andares.json', import.meta.url).pathname;
  let progressoEdificios = {};
  let progressoAndares = {};
  if (ENTIDADE === 'deals') {
    if (existsSync(PROG_FILE_EDIFICIOS)) { try { progressoEdificios = JSON.parse(readFileSync(PROG_FILE_EDIFICIOS, 'utf8')); } catch (_) {} }
    if (existsSync(PROG_FILE_ANDARES))   { try { progressoAndares   = JSON.parse(readFileSync(PROG_FILE_ANDARES, 'utf8')); }   catch (_) {} }
  }
  const edificiosCache = new Map();
  const andaresCache = new Map();
  const andarEdificioAssocDone = new Set();

  // Ler Excel
  const rows = lerXlsx(resolve(ARQUIVO));
  console.log(`   📊 ${rows.length} linhas lidas do Excel\n`);

  const stats = { criados: 0, atualizados: 0, jaExistia: 0, pulados: 0, erros: 0, foraDoPipeline: 0 };

  let count = 0;
  for (const row of rows) {
    if (count >= LIMITE) break;

    if (ENTIDADE === 'deals' && row.Status === 'LEAD') {
      stats.foraDoPipeline++;
      continue; // "Fora do pipeline — importar como Lead/Contato" (fluxo separado, não implementado aqui)
    }

    const mapped = mapper(row);
    if (!mapped) { stats.pulados++; continue; }

    const { focusId, properties, ...meta } = mapped;
    const key = String(focusId);
    count++;

    // Pular se já processado com sucesso
    if (progresso[key]?.status === 'ok') {
      console.log(`  ⏭️  [${count}/${Math.min(rows.length, LIMITE)}] ${key} — já importado (${progresso[key].hubspotId})`);
      stats.jaExistia++;
      continue;
    }

    console.log(`  ${DRY ? '📋' : '⏳'} [${count}/${Math.min(rows.length, LIMITE)}] Focus ID ${key} — ${properties.name || properties.dealname || ''}`);

    if (DRY) {
      console.log(`        → ${JSON.stringify(properties).slice(0, 120)}...`);
      if (meta.jsonEdificios?.length) {
        for (const entry of meta.jsonEdificios) {
          const ed = mapearEdificio(entry);
          const an = mapearAndar(entry);
          console.log(`        🏢 edifício=${ed?.focusId ?? '?'} (${ed?.properties?.nome_do_edificio ?? '?'}) → andar=${an?.focusId ?? '?'} (${an?.properties?.nome_do_andar ?? '?'})`);
        }
      }
      stats.criados++;
      continue;
    }

    try {
      // Verificar se já existe no HubSpot
      let existente = await buscarPorIdFocus(objectType, key);

      let hubspotId;
      if (existente) {
        // Atualizar
        await hs(`/crm/v3/objects/${objectType}/${existente.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties }),
        });
        hubspotId = existente.id;
        stats.atualizados++;
        console.log(`     ↻  Atualizado (${hubspotId})`);
      } else {
        // Criar
        const created = await hs(`/crm/v3/objects/${objectType}`, {
          method: 'POST',
          body: JSON.stringify({ properties }),
        });
        hubspotId = created.id;
        stats.criados++;
        console.log(`     ✅ Criado (${hubspotId})`);
      }

      // Salvar progresso
      progresso[key] = { status: 'ok', hubspotId, focusId: key };
      writeFileSync(PROG_FILE, JSON.stringify(progresso, null, 2));

      // Rate limit gentil: 9 req/s (limite HubSpot = 10/s)
      await sleep(120);

      // Edifício/Andar (decodificados de JsonEdificios) + associações
      if (meta.jsonEdificios?.length) {
        try {
          for (const entry of meta.jsonEdificios) {
            const edMapped = mapearEdificio(entry);
            const anMapped = mapearAndar(entry);

            let edificioId = edMapped ? edificiosCache.get(String(edMapped.focusId)) : null;
            if (edMapped && !edificioId) {
              edificioId = await upsertObjeto('p51253038_edificios', edMapped, progressoEdificios, PROG_FILE_EDIFICIOS);
              edificiosCache.set(String(edMapped.focusId), edificioId);
            }

            let andarId = anMapped ? andaresCache.get(String(anMapped.focusId)) : null;
            if (anMapped && !andarId) {
              andarId = await upsertObjeto('p51253038_andares', anMapped, progressoAndares, PROG_FILE_ANDARES);
              andaresCache.set(String(anMapped.focusId), andarId);
            }

            if (andarId && edificioId && !andarEdificioAssocDone.has(andarId)) {
              await associar('p51253038_andares', andarId, 'p51253038_edificios', edificioId, 95); // "Pertence a"
              andarEdificioAssocDone.add(andarId);
            }
            if (andarId) {
              await associar('deals', hubspotId, 'p51253038_andares', andarId, 92); // "Negócio"
            }
          }
          console.log(`     🏢 ${meta.jsonEdificios.length} vínculo(s) de edifício/andar processado(s)`);
        } catch (errAssoc) {
          console.error(`     ⚠️  Falha ao processar edifício/andar: ${errAssoc.message}`);
        }
      }

    } catch (err) {
      console.error(`     ❌ ERRO: ${err.message}`);
      progresso[key] = { status: 'erro', erro: err.message, focusId: key };
      writeFileSync(PROG_FILE, JSON.stringify(progresso, null, 2));
      stats.erros++;
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Criados      : ${stats.criados}`);
  console.log(`  ↻  Atualizados  : ${stats.atualizados}`);
  console.log(`  ⏭️  Já existiam  : ${stats.jaExistia}`);
  console.log(`  ⏭️  Pulados (sem dados): ${stats.pulados}`);
  if (ENTIDADE === 'deals') {
    console.log(`  📭 Fora do pipeline (LEAD, importar como Lead/Contato — não implementado): ${stats.foraDoPipeline}`);
  }
  console.log(`  ❌ Erros        : ${stats.erros}`);

  if (stats.erros > 0) {
    console.log(`\n  ⚠️  Registros com erro estão em ${PROG_FILE}`);
    console.log('     Re-rodar o script tentará importar somente os que falharam.');
  }

  console.log('\n✓ Concluído.\n');
})();
