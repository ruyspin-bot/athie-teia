/**
 * scripts/corrigir-assoc-conjuntos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Corrige 1.394 conjuntos associados ao andar errado.
 *
 * Fonte: audit_conjuntos_assoc_errada_detalhe.csv
 * Para cada linha:
 *   1. Acha o Andar correto: edifício=edificio_esperado, piso=andar_rotulo
 *   2. Remove a associação errada Conjunto→Andar atual
 *   3. Cria a associação correta Conjunto→Andar esperado
 *
 * Uso:
 *   node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs --dry-run
 *   node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs
 *   node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs --limite 50
 *   node --env-file=.env.local scripts/corrigir-assoc-conjuntos.mjs --csv PATH
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
  'C:/Users/Ruy Spinola/Downloads/audit_csvs/audit_conjuntos_assoc_errada_detalhe.csv';
const PROG = path.join(__dirname, '.progress-corrigir-assoc.json');
const BASE = 'https://api.hubapi.com';

// ── HTTP ──────────────────────────────────────────────────────────────────────
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
    console.log(`   ⏳ Rate limit, aguardando ${Math.round(wait/1000)}s...`);
    await sleep(wait);
    return hs(url, opts, _retry + 1);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${t.slice(0, 250)}`);
  }
  return res.status === 204 ? null : res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Converte rótulo de andar (texto ou número) em inteiro ─────────────────────
function parseAndar(rotulo) {
  const s = String(rotulo).trim();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (s === 'Térreo' || s === 'Terreo') return 0;
  const sub = s.match(/^Subsolo\s+(\d+)$/i);
  if (sub) return -parseInt(sub[1], 10);
  return NaN;
}

// ── Chunk helper ──────────────────────────────────────────────────────────────
function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── 1. Carrega mapa buildingId → floorNum → andarId ──────────────────────────
async function carregarMapaAndares(edificioIds) {
  const ids = [...edificioIds];
  console.log(`\n📦 Carregando andares para ${ids.length} edifícios...`);

  // Edifício → Andares (batch association read)
  const edAndarAssoc = {};
  for (const chunk of chunks(ids, 100)) {
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
  console.log(`   Andares encontrados: ${andarIds.length}`);

  // Andar → numero_do_andar (batch read)
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

  // Monta mapa: edificioId → floorNum → andarId
  const mapa = {};
  for (const [edId, ands] of Object.entries(edAndarAssoc)) {
    mapa[edId] = {};
    for (const andarId of ands) {
      const num = andarNumero[andarId];
      if (num !== undefined) mapa[edId][num] = andarId;
    }
  }

  const totalAndares = Object.values(mapa).reduce((s, m) => s + Object.keys(m).length, 0);
  console.log(`✓  Mapa pronto: ${totalAndares} andares em ${Object.keys(mapa).length} edifícios`);
  return mapa;
}

// ── 2. Busca o andar atual do conjunto (fallback quando não está no mapa) ─────
async function getAndarAtual(conjuntoId) {
  const res = await hs(`/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}`);
  return (res.results || []).map(r => String(r.toObjectId));
}

// ── 3. Remove associação Conjunto→Andar ──────────────────────────────────────
async function removerAssoc(conjuntoId, andarId) {
  try {
    await hs(
      `/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}/${andarId}`,
      { method: 'DELETE' },
    );
  } catch (err) {
    // 404 = associação já foi removida — ok para re-execução idempotente
    if (!err.message.includes('404')) throw err;
  }
}

// ── 4. Cria associação Conjunto→Andar ─────────────────────────────────────────
// Tipo correto descoberto via API: USER_DEFINED, typeId 115 (portal ATIE 51253038)
async function criarAssoc(conjuntoId, andarId) {
  await hs(
    `/crm/v4/objects/${OBJ_CONJUNTO}/${conjuntoId}/associations/${OBJ_ANDAR}/${andarId}`,
    {
      method: 'PUT',
      body: JSON.stringify([{ associationCategory: 'USER_DEFINED', associationTypeId: 115 }]),
    },
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔧 Corrigir Associações Conjunto→Andar — portal ATIE (51253038)');
  console.log(`   Modo  : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  console.log(`   CSV   : ${CSV_PATH}\n`);

  if (!existsSync(CSV_PATH)) {
    console.error('❌  CSV não encontrado:', CSV_PATH);
    process.exit(1);
  }

  // Lê CSV
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const rows = lines.slice(1)
    .filter(l => {
      // inclui TODOS: cross_building=True (edifício errado) E cross_building=False (mesmo edifício, andar errado)
      const parts = l.split(',');
      return parts.length >= 7 && parts[2] !== parts[3]; // andar_rotulo != andar_associado
    })
    .map(l => {
      const p = l.split(',');
      const edificio         = String(p[4]);
      const edificioEsperado = String(p[6]) || edificio; // fallback: mesmo edifício (cross_building=False)
      return {
        conjuntoId:   String(p[0]),
        nome:         p[1],
        andarRotulo:  parseAndar(p[2]),   // andar esperado (do nome — pode ser Térreo/Subsolo)
        andarAssociado: parseAndar(p[3]), // andar atual (floor number)
        edificio,
        edificioEsperado,
      };
    });

  console.log(`   Linhas com andar errado    : ${rows.length} (inclui cross-building e mesmo edifício)`);
  const limite = Math.min(LIMITE, rows.length);
  console.log(`   A processar               : ${limite}\n`);

  // Coleta edificios únicos (ambas colunas)
  const edificiosNecessarios = new Set([
    ...rows.slice(0, limite).map(r => r.edificio),
    ...rows.slice(0, limite).map(r => r.edificioEsperado),
  ]);

  // Carrega mapa andares
  const mapa = await carregarMapaAndares(edificiosNecessarios);

  // Progresso
  const prog = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : {};
  const stats = { ok: 0, pulados: 0, sem_andar_correto: 0, erros: 0 };
  const naoResolvidos = [];

  console.log('\n🔄 Processando reassociações...\n');

  for (let i = 0; i < limite; i++) {
    const row = rows[i];
    const key = row.conjuntoId;

    if (prog[key]?.status === 'ok') { stats.pulados++; continue; }

    // Resolve o andar correto
    const correctAndarId = mapa[row.edificioEsperado]?.[row.andarRotulo];
    if (!correctAndarId) {
      naoResolvidos.push({ ...row, motivo: 'andar_correto_nao_encontrado' });
      stats.sem_andar_correto++;
      if (i < 20 || stats.sem_andar_correto <= 3) {
        console.log(`  ❓ #${i+1} conj=${key} ed_esperado=${row.edificioEsperado} andar=${row.andarRotulo} — não encontrado no mapa`);
      }
      continue;
    }

    // Tenta resolver o andar errado atual pelo mapa
    let wrongAndarId = mapa[row.edificio]?.[row.andarAssociado] || null;

    if (DRY) {
      if (i < 10) {
        console.log(`  📋 #${i+1} ${key} "${row.nome.slice(0,50)}"`);
        console.log(`       ❌ remove andar ${wrongAndarId || '(busca dinâmica)'} (ed=${row.edificio} piso=${row.andarAssociado})`);
        console.log(`       ✅ cria  andar ${correctAndarId} (ed=${row.edificioEsperado} piso=${row.andarRotulo})`);
      }
      stats.ok++;
      continue;
    }

    try {
      // Se não achou no mapa, busca dinamicamente
      if (!wrongAndarId) {
        const atuais = await getAndarAtual(key);
        if (atuais.length === 0) {
          // Nenhum andar associado? Só criar a correta
          wrongAndarId = null;
        } else {
          wrongAndarId = atuais[0]; // remove todos os atuais
          for (const aid of atuais) {
            await removerAssoc(key, aid);
            await sleep(80);
          }
        }
      } else {
        await removerAssoc(key, wrongAndarId);
        await sleep(80);
      }

      // Cria associação correta
      await criarAssoc(key, correctAndarId);

      prog[key] = { status: 'ok', correctAndarId, rodado_em: new Date().toISOString() };
      if (i % 100 === 0) writeFileSync(PROG, JSON.stringify(prog, null, 2));
      stats.ok++;

      if (i % 100 === 0 || i < 5) {
        console.log(`   ${i + 1}/${limite} processados (ok=${stats.ok}, erros=${stats.erros})...`);
      }

      await sleep(80);
    } catch (err) {
      console.error(`  ❌ conjunto ${key}: ${err.message}`);
      stats.erros++;
      prog[key] = { status: 'erro', msg: err.message };
    }
  }

  if (!DRY) writeFileSync(PROG, JSON.stringify(prog, null, 2));

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Corrigidos          : ${stats.ok}`);
  console.log(`  ⏭️  Pulados             : ${stats.pulados}`);
  console.log(`  ❓ Sem andar correto   : ${stats.sem_andar_correto}`);
  console.log(`  ❌ Erros               : ${stats.erros}`);

  if (naoResolvidos.length) {
    console.log(`\n  Primeiros 5 não resolvidos:`);
    naoResolvidos.slice(0, 5).forEach(x =>
      console.log(`     conj=${x.conjuntoId} edEsp=${x.edificioEsperado} piso=${x.andarRotulo} → ${x.motivo}`)
    );
  }

  console.log('\n✓ Concluído.\n');
})();
