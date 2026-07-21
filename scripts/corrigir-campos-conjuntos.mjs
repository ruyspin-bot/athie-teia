/**
 * scripts/corrigir-campos-conjuntos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Corrige 106 campos divergentes nos Conjuntos (42 área, 22 disponibilidade,
 * 42 proprietário) identificados na auditoria de 21/07/2026.
 *
 * Fonte: audit_conjuntos_mismatches.csv
 * Método: localiza o Conjunto pelo caminho edificio→andar→nome, aplica o valor
 * correto da planilha.
 *
 * Uso:
 *   node --env-file=.env.local scripts/corrigir-campos-conjuntos.mjs --dry-run
 *   node --env-file=.env.local scripts/corrigir-campos-conjuntos.mjs
 *   node --env-file=.env.local scripts/corrigir-campos-conjuntos.mjs --limite 50
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  HUBSPOT_TOKEN não encontrado'); process.exit(1); }

const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';

const args   = process.argv.slice(2);
const has    = f => args.includes(f);
const get    = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY    = has('--dry-run');
const LIMITE = parseInt(get('--limite') || '999999', 10);
const CSV_PATH = get('--csv') ||
  'C:/Users/Ruy Spinola/Downloads/audit_csvs/audit_conjuntos_mismatches.csv';
const PROG = path.join(__dirname, '.progress-corrigir-campos.json');
const BASE = 'https://api.hubapi.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function hs(url, opts = {}, _retry = 0) {
  const res = await fetch(BASE + url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 429 && _retry < 5) {
    const wait = Math.max(parseInt(res.headers.get('Retry-After') || '2', 10) * 1000, 2 ** _retry * 800);
    await sleep(wait);
    return hs(url, opts, _retry + 1);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${t.slice(0, 250)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Mapeamento campo → propriedade HubSpot
const CAMPO_MAP = {
  area_m2:        'area_m2',
  disponibilidade:'disponibilidade',
  proprietario:   'nome_do_proprietario',
};

// ── Carrega mapa de IDs: edificioId → andarNum → conjuntoNome → conjuntoId ───
async function carregarMapaConjuntos(edificioIds) {
  console.log(`\n📦 Carregando hierarquia para ${edificioIds.size} edifícios...`);

  // Edifício → Andares
  const edAndarAssoc = {};
  for (const chunk of chunks([...edificioIds], 100)) {
    const res = await hs(`/crm/v4/associations/${OBJ_EDIFICIO}/${OBJ_ANDAR}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }),
    });
    for (const r of (res.results || [])) {
      edAndarAssoc[r.from.id] = (r.to || []).map(t => String(t.toObjectId));
    }
    await sleep(100);
  }

  const andarIds = [...new Set(Object.values(edAndarAssoc).flat())];

  // Andar → numero
  const andarNumero = {};
  for (const chunk of chunks(andarIds, 100)) {
    const res = await hs('/crm/v3/objects/' + OBJ_ANDAR + '/batch/read', {
      method: 'POST',
      body: JSON.stringify({ properties: ['numero_do_andar'], inputs: chunk.map(id => ({ id })) }),
    });
    for (const o of (res.results || [])) {
      andarNumero[o.id] = parseInt(o.properties.numero_do_andar || '0', 10);
    }
    await sleep(100);
  }

  // Andar → Conjuntos
  const andarConjAssoc = {};
  for (const chunk of chunks(andarIds, 100)) {
    const res = await hs(`/crm/v4/associations/${OBJ_ANDAR}/${OBJ_CONJUNTO}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }),
    });
    for (const r of (res.results || [])) {
      andarConjAssoc[r.from.id] = (r.to || []).map(t => String(t.toObjectId));
    }
    await sleep(100);
  }

  const conjIds = [...new Set(Object.values(andarConjAssoc).flat())];

  // Conjunto → nome_do_conjunto
  const conjNome = {};
  for (const chunk of chunks(conjIds, 100)) {
    const res = await hs('/crm/v3/objects/' + OBJ_CONJUNTO + '/batch/read', {
      method: 'POST',
      body: JSON.stringify({ properties: ['nome_do_conjunto'], inputs: chunk.map(id => ({ id })) }),
    });
    for (const o of (res.results || [])) {
      conjNome[o.id] = String(o.properties.nome_do_conjunto || '').trim().toLowerCase();
    }
    await sleep(100);
  }

  // Monta: edificioId → andarNum → conjNome → conjId
  const mapa = {};
  for (const [edId, ands] of Object.entries(edAndarAssoc)) {
    mapa[edId] = {};
    for (const andarId of ands) {
      const num = andarNumero[andarId];
      if (num === undefined) continue;
      mapa[edId][num] = {};
      for (const cjId of (andarConjAssoc[andarId] || [])) {
        const nome = conjNome[cjId] || '';
        mapa[edId][num][nome] = cjId;
      }
    }
  }

  console.log(`✓  Mapa carregado (${conjIds.length} conjuntos)`);
  return mapa;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔧 Corrigir Campos Conjuntos — portal ATIE (51253038)');
  console.log(`   Modo  : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  console.log(`   CSV   : ${CSV_PATH}\n`);

  if (!existsSync(CSV_PATH)) { console.error('❌  CSV não encontrado:', CSV_PATH); process.exit(1); }

  // Lê CSV e filtra só divergências reais
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  // Header: edificio_id,andar,conjunto,campo,planilha,hubspot
  const divergencias = lines.slice(1)
    .map(l => {
      // CSV pode ter vírgulas nos valores — usa split limitado
      const idx = [0,1,2,3].reduce((acc, _) => {
        const next = l.indexOf(',', acc.last + 1);
        acc.positions.push(next);
        acc.last = next;
        return acc;
      }, { positions: [], last: -1 }).positions;
      const edificioId = l.slice(0, idx[0]);
      const andar      = parseInt(l.slice(idx[0]+1, idx[1]), 10);
      const conjunto   = l.slice(idx[1]+1, idx[2]).toLowerCase().trim();
      const campo      = l.slice(idx[2]+1, idx[3]).trim();
      const rest       = l.slice(idx[3]+1);
      // planilha e hubspot podem ter vírgulas; último campo = hubspot
      const lastComma  = rest.lastIndexOf(',');
      const planilha   = rest.slice(0, lastComma).trim().replace(/^"|"$/g, '');
      const hubspot    = rest.slice(lastComma + 1).trim().replace(/^"|"$/g, '');
      return { edificioId, andar, conjunto, campo, planilha, hubspot };
    })
    .filter(r => r.planilha !== r.hubspot && CAMPO_MAP[r.campo]);

  console.log(`   Divergências reais encontradas: ${divergencias.length}`);

  // Agrupa por edificio para carregar o mapa só dos necessários
  const edificioIds = new Set(divergencias.map(r => r.edificioId));
  console.log(`   Edifícios envolvidos: ${edificioIds.size}`);

  const limite = Math.min(LIMITE, divergencias.length);
  const mapa = await carregarMapaConjuntos(edificioIds);

  // Agrupa correções por conjuntoId (um conjunto pode ter vários campos para corrigir)
  const porConjunto = {};
  let naoEncontrados = 0;

  for (const div of divergencias.slice(0, limite)) {
    const andarMap = mapa[div.edificioId]?.[div.andar] || {};
    const conjId = andarMap[div.conjunto] ||
      // fallback: busca por substring
      Object.entries(andarMap).find(([n]) => n.includes(div.conjunto))?.[1];

    if (!conjId) {
      naoEncontrados++;
      if (naoEncontrados <= 5) {
        console.log(`  ❓ Não encontrado: ed=${div.edificioId} an=${div.andar} cj="${div.conjunto}"`);
      }
      continue;
    }

    if (!porConjunto[conjId]) porConjunto[conjId] = {};
    const prop = CAMPO_MAP[div.campo];
    porConjunto[conjId][prop] = div.campo === 'area_m2'
      ? parseFloat(div.planilha)
      : div.planilha;
  }

  const conjuntosACorrigir = Object.entries(porConjunto);
  console.log(`\n   Conjuntos a atualizar: ${conjuntosACorrigir.length}`);
  if (naoEncontrados) console.log(`   Não encontrados no mapa: ${naoEncontrados}`);

  const prog = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : {};
  const stats = { ok: 0, pulados: 0, erros: 0 };

  console.log('\n🔄 Atualizando campos...\n');

  for (const [conjId, props] of conjuntosACorrigir) {
    if (prog[conjId]?.status === 'ok') { stats.pulados++; continue; }

    if (DRY) {
      console.log(`  📋 ${conjId}`, props);
      stats.ok++;
      continue;
    }

    try {
      await hs(`/crm/v3/objects/${OBJ_CONJUNTO}/${conjId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
      prog[conjId] = { status: 'ok', props, rodado_em: new Date().toISOString() };
      stats.ok++;
      await sleep(80);
    } catch (err) {
      console.error(`  ❌ ${conjId}: ${err.message}`);
      stats.erros++;
    }
  }

  if (!DRY) writeFileSync(PROG, JSON.stringify(prog, null, 2));

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Corrigidos  : ${stats.ok}`);
  console.log(`  ⏭️  Pulados    : ${stats.pulados}`);
  console.log(`  ❌ Erros      : ${stats.erros}`);
  console.log('\n✓ Concluído.\n');
})();
