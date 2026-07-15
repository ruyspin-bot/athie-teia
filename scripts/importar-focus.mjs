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

  // sharedStrings
  const ssXml = files['xl/sharedStrings.xml'] || '';
  const strings = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t =>
      t[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n))
    );
    strings.push(parts.join(''));
  }

  // sheet1
  const ws = files['xl/worksheets/sheet1.xml'] || '';
  const rows = [];
  for (const rowMatch of ws.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cMatch of rowMatch[1].matchAll(/<c[^>]*>([\s\S]*?)<\/c>/g)) {
      const tAttr = cMatch[0].match(/t="([^"]*)"/)?.[1];
      const vEl   = cMatch[1].match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const rAttr = cMatch[0].match(/r="([A-Z]+)/)?.[1] || '';
      const col   = rAttr ? rAttr.split('').reduce((acc,ch) => acc*26+(ch.charCodeAt(0)-64), 0) - 1 : cells.length;
      // Preencher colunas vazias
      while (cells.length < col) cells.push('');
      if (!vEl) { cells.push(''); continue; }
      if (tAttr === 's') cells.push(strings[parseInt(vEl)] ?? '');
      else if (tAttr === 'b') cells.push(vEl === '1' ? 'true' : 'false');
      else cells.push(vEl);
    }
    rows.push(cells);
  }

  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? '').toString().trim()]))
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

  // Mapeamento de status → stage HubSpot
  // Ajustar conforme stages reais do pipeline 899974520
  const STAGE_MAP = {
    'EPP': 'proposta_apresentada',  // Em Proposta Apresentada
    'EC':  'em_cotacao',
    'EN':  'em_negociacao',
    'EL':  'em_levantamento',
    'G':   'ganho',
    'P':   'perdido',
  };

  // Mapeamento de escopo → enum HubSpot
  const ESCOPO_MAP = {
    '1': 'projeto_only',
    '2': 'obra_only',
    '3': 'projeto_e_obra',
    'Projeto':         'projeto_only',
    'Obra':            'obra_only',
    'Projeto e Obra':  'projeto_e_obra',
    'Projeto + Obra':  'projeto_e_obra',
  };

  // Mapeamento de origem
  const ORIGEM_MAP = {
    'AW': 'outros',  // origem interna
  };

  const props = {
    dealname:              `${row.NumeroProjeto ? row.NumeroProjeto + ' — ' : ''}${row.NomeProjeto || row.GrupoComercial}`,
    pipeline:              '899974520',
    amount:                row.Valor || '0',
    aw_id_interno:         row.IdProjeto,
    aw_id_projeto_pai:     row.IdProjetoPai || '',
    aw_numero_projeto:     row.NumeroProjeto || '',
    aw_area_m2:            row.Area || '',
    aw_valor_m2_projeto:   row.ValorMetro || '',
    aw_id_agrupador:       row.IdAgrupador || '',
    aw_chances_ganhar:     row.ChancesGanhar || '',
    aw_frequencia_comercial: row.FrequenciaComercial || '',
    aw_projeto_top:        row.ProjetoTOP === '1' || row.ProjetoTOP === 'true' ? 'true' : 'false',
    aw_apalavrado_com_cliente: row.Apalavrado === '1' || row.Apalavrado === 'S' ? 'true' : 'false',
    aw_responsabilidade_den:   row.ResponsabilidadeDEN === '1' ? 'true' : 'false',
    aw_substatus:          row.SubStatus || '',
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
    jsonEdificios:  row.JsonEdificios || null,
  };
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
  const nome = row.NomeEdificioPavimento || row.NomePavimento || row.Nome;
  if (!id || !nome) return null;
  return {
    focusId: id,
    properties: {
      nome_do_andar: nome,
      numero_do_andar: row.NumeroPavimento || row.Numero || '',
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

  // Ler Excel
  const rows = lerXlsx(resolve(ARQUIVO));
  console.log(`   📊 ${rows.length} linhas lidas do Excel\n`);

  const stats = { criados: 0, atualizados: 0, jaExistia: 0, pulados: 0, erros: 0 };

  let count = 0;
  for (const row of rows) {
    if (count >= LIMITE) break;

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
  console.log(`  ❌ Erros        : ${stats.erros}`);

  if (stats.erros > 0) {
    console.log(`\n  ⚠️  Registros com erro estão em ${PROG_FILE}`);
    console.log('     Re-rodar o script tentará importar somente os que falharam.');
  }

  console.log('\n✓ Concluído.\n');
})();
