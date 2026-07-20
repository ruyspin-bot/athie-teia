/**
 * scripts/corrigir-andares-faltando.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Identifica deals que têm JsonEdificios no XLSX mas não têm Andar associado
 * no HubSpot, e cria as associações faltando.
 *
 * Uso:
 *   node --env-file=.env.local scripts/corrigir-andares-faltando.mjs
 *   node --env-file=.env.local scripts/corrigir-andares-faltando.mjs --dry-run
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire }                           from 'module';
import { fileURLToPath }                           from 'url';
import { dirname, resolve }                        from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);
const XLSX      = require(resolve(__dirname, '../node_modules/xlsx'));

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN no .env.local'); process.exit(1); }

const DRY = process.argv.includes('--dry-run');
const BASE = 'https://api.hubapi.com';

const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || '2-65603861';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || '2-65605360';
// Association type IDs (confirmados na sessão 13/07)
const ASSOC_ANDAR_EDIFICIO = 95; // Andar "Pertence a" Edifício
const ASSOC_DEAL_ANDAR     = 92; // Deal "Negócio" → Andar

const XLSX_PATH = resolve(
  process.env.USERPROFILE || process.env.HOME,
  'Downloads/DEALS-VIVOS-2026-07-17_HubSpot_formatado_v8.xlsx'
);

// ─── HubSpot helpers ─────────────────────────────────────────────────────────
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function buscarDealPorIdFocus(idFocus) {
  const r = await hs('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'aw_id_interno', operator: 'EQ', value: String(idFocus) }] }],
      properties: ['dealname', 'aw_id_interno'],
      limit: 1,
    }),
  });
  return r.results?.[0] || null;
}

async function getAndaresDoDeal(dealId) {
  const r = await hs(`/crm/v4/objects/deals/${dealId}/associations/${OBJ_ANDAR}`);
  return r.results || [];
}

async function buscarEdificioPorIdFocus(idFocus) {
  const r = await hs(`/crm/v3/objects/${OBJ_EDIFICIO}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'aw_id_focus', operator: 'EQ', value: String(idFocus) }] }],
      properties: ['nome_do_edificio', 'aw_id_focus'],
      limit: 1,
    }),
  });
  return r.results?.[0] || null;
}

async function buscarAndarPorIdFocus(idFocus) {
  const r = await hs(`/crm/v3/objects/${OBJ_ANDAR}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'aw_id_focus', operator: 'EQ', value: String(idFocus) }] }],
      properties: ['nome_do_andar', 'numero_do_andar', 'aw_id_focus'],
      limit: 1,
    }),
  });
  return r.results?.[0] || null;
}

async function criarEdificio(entry) {
  const nome    = entry.NomeCondominio || entry.NomeEdificio || `Edifício ${entry.IdCondominio}`;
  const torre   = entry.NomeEdificio !== entry.NomeCondominio && entry.NomeEdificio !== 'Único' ? entry.NomeEdificio : '';
  const created = await hs(`/crm/v3/objects/${OBJ_EDIFICIO}`, {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        name:             nome,
        nome_do_edificio: nome,
        nome_torre:       torre,
        aw_id_focus:      String(entry.IdCondominio),
        aw_id_edificio_focus: String(entry.IdEdificio),
      },
    }),
  });
  return created.id;
}

async function criarAndar(entry) {
  const nomeAndar    = entry.NomeEdificioPavimento || `Andar ${entry.IdEdificioPavimento}`;
  const nomeEdificio = entry.NomeCondominio || '';
  const torre        = entry.NomeEdificio && entry.NomeEdificio !== entry.NomeCondominio && entry.NomeEdificio !== 'Único'
    ? entry.NomeEdificio : '';
  const edificioLabel = [nomeEdificio, torre].filter(Boolean).join(' / ');
  const nomeCompleto  = edificioLabel ? `${nomeAndar} — ${edificioLabel}` : nomeAndar;
  const numero        = (nomeAndar.match(/\d+/) || [])[0] || '';

  const created = await hs(`/crm/v3/objects/${OBJ_ANDAR}`, {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        nome_do_andar:   nomeCompleto,
        numero_do_andar: numero,
        aw_id_focus:     String(entry.IdEdificioPavimento),
      },
    }),
  });
  return created.id;
}

async function associar(fromType, fromId, toType, toId, typeId) {
  await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, {
    method: 'PUT',
    body: JSON.stringify([{ associationCategory: 'USER_DEFINED', associationTypeId: typeId }]),
  });
}

// ─── XLSX helpers ─────────────────────────────────────────────────────────────
function lerDeals() {
  const wb   = XLSX.readFile(XLSX_PATH);
  const aba1 = XLSX.utils.sheet_to_json(wb.Sheets['Deals com comercial'],  { defval: '' });
  const aba2 = XLSX.utils.sheet_to_json(wb.Sheets['Sem acompanhamento'],   { defval: '' });
  return [...aba1, ...aba2];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('🔍  Lendo XLSX…');
const todos  = lerDeals();
const comEd  = todos.filter(r => r.JsonEdificios && r.JsonEdificios.trim() !== '' && r.JsonEdificios !== '[]');
console.log(`📋  ${comEd.length} deals com JsonEdificios no XLSX`);
if (DRY) console.log('⚠️   DRY-RUN — nenhuma alteração será feita no HubSpot\n');

const stats = { semAndarHubspot: 0, jaTemAndar: 0, corrigidos: 0, erros: 0 };
const logFile = resolve(__dirname, '.log-corrigir-andares.json');
const log = [];

for (const row of comEd) {
  const idFocus = String(row.IdProjeto);
  const numero  = row.NumeroProjeto;
  const nome    = row.NomeProjeto;

  // 1. Encontra o deal no HubSpot pelo ID Focus
  let deal;
  try {
    deal = await buscarDealPorIdFocus(idFocus);
  } catch (e) {
    console.error(`  ❌ ${numero} — erro ao buscar deal: ${e.message}`);
    stats.erros++;
    continue;
  }

  if (!deal) {
    console.log(`  ⚠️  ${numero} "${nome}" — não encontrado no HubSpot (aw_id_interno=${idFocus})`);
    log.push({ numero, nome, idFocus, status: 'nao_encontrado' });
    stats.erros++;
    continue;
  }

  // 2. Verifica se já tem Andar
  let andaresExistentes;
  try {
    andaresExistentes = await getAndaresDoDeal(deal.id);
  } catch (e) {
    console.error(`  ❌ ${numero} — erro ao buscar andares: ${e.message}`);
    stats.erros++;
    continue;
  }

  if (andaresExistentes.length > 0) {
    console.log(`  ✅ ${numero} "${nome}" — já tem ${andaresExistentes.length} andar(es), pulando`);
    stats.jaTemAndar++;
    continue;
  }

  // 3. Deal sem Andar — processar JsonEdificios
  stats.semAndarHubspot++;
  let entries;
  try {
    entries = JSON.parse(row.JsonEdificios);
  } catch (e) {
    console.error(`  ❌ ${numero} — JsonEdificios inválido: ${e.message}`);
    stats.erros++;
    continue;
  }

  console.log(`\n  🔧 ${numero} "${nome}" — deal ${deal.id}, ${entries.length} andar(es) para vincular`);

  const edificioCache = new Map();
  const andarCache    = new Map();
  let andaresVinculados = 0;

  for (const entry of entries) {
    try {
      const idEd  = String(entry.IdCondominio);
      const idAnd = String(entry.IdEdificioPavimento);

      // Edifício
      let edificioId = edificioCache.get(idEd);
      if (!edificioId) {
        const existente = await buscarEdificioPorIdFocus(idEd);
        if (existente) {
          edificioId = existente.id;
        } else if (!DRY) {
          edificioId = await criarEdificio(entry);
          console.log(`     🏢 Edifício criado: ${entry.NomeCondominio} (id=${edificioId})`);
          await sleep(150);
        } else {
          console.log(`     🏢 [DRY] Criaria edifício: ${entry.NomeCondominio}`);
          edificioId = 'dry-ed-' + idEd;
        }
        edificioCache.set(idEd, edificioId);
      }

      // Andar
      let andarId = andarCache.get(idAnd);
      if (!andarId) {
        const existente = await buscarAndarPorIdFocus(idAnd);
        if (existente) {
          andarId = existente.id;
        } else if (!DRY) {
          andarId = await criarAndar(entry);
          console.log(`     🏬 Andar criado: ${entry.NomeEdificioPavimento} (id=${andarId})`);
          await sleep(150);
        } else {
          console.log(`     🏬 [DRY] Criaria andar: ${entry.NomeEdificioPavimento} — ${entry.NomeCondominio}`);
          andarId = 'dry-an-' + idAnd;
        }
        andarCache.set(idAnd, andarId);
      }

      // Associações
      if (!DRY) {
        await associar(OBJ_ANDAR, andarId, OBJ_EDIFICIO, edificioId, ASSOC_ANDAR_EDIFICIO);
        await associar('deals', deal.id, OBJ_ANDAR, andarId, ASSOC_DEAL_ANDAR);
        await sleep(100);
      } else {
        console.log(`     🔗 [DRY] Associaria: deal ${deal.id} → andar ${andarId} → edifício ${edificioId}`);
      }
      andaresVinculados++;

    } catch (e) {
      console.error(`     ⚠️  Erro no entry ${entry.NomeEdificioPavimento}: ${e.message}`);
    }
  }

  if (andaresVinculados > 0) {
    console.log(`     ✅ ${andaresVinculados} andar(es) vinculado(s)`);
    stats.corrigidos++;
    log.push({ numero, nome, idFocus, dealId: deal.id, andaresVinculados, status: 'corrigido' });
  }

  await sleep(200);
}

console.log('\n─────────────────────────────────────────');
console.log(`  ✅ Já tinham Andar : ${stats.jaTemAndar}`);
console.log(`  🔧 Sem Andar (alvo): ${stats.semAndarHubspot}`);
console.log(`  ✅ Corrigidos      : ${stats.corrigidos}`);
console.log(`  ❌ Erros           : ${stats.erros}`);
if (!DRY) {
  writeFileSync(logFile, JSON.stringify(log, null, 2));
  console.log(`\n  📝 Log salvo em: ${logFile}`);
}
