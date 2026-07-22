/**
 * scripts/importar-ocupantes.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Cria a propriedade `nome_do_ocupante` no objeto Conjunto (se não existir)
 * 2. Lê o arquivo Excel e atualiza cada Conjunto com o nome do ocupante
 *
 * Matching: (ID HubSpot Edifício) + (número do andar) + (nome do conjunto)
 * → resolve o ID HubSpot do Conjunto via Edifício→Andar→Conjunto
 *
 * Uso:
 *   node --env-file=.env.local scripts/importar-ocupantes.mjs
 *   node --env-file=.env.local scripts/importar-ocupantes.mjs --dry-run
 *   node --env-file=.env.local scripts/importar-ocupantes.mjs --limite 50
 *
 * Flags:
 *   --dry-run      : mostra o que seria feito sem alterar nada
 *   --limite N     : processa só os primeiros N conjuntos com ocupante
 *   --excel PATH   : caminho do arquivo (default abaixo)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createRequire } from 'module';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require   = createRequire(import.meta.url);
const XLSX      = require('xlsx');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configurações ─────────────────────────────────────────────────────────────
const TOKEN       = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  HUBSPOT_TOKEN não encontrado'); process.exit(1); }

const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';

const args    = process.argv.slice(2);
const has     = f => args.includes(f);
const get     = f => { const i=args.indexOf(f); return i>=0?args[i+1]:null; };
const DRY     = has('--dry-run');
const LIMITE  = parseInt(get('--limite') || '999999', 10);
const EXCEL   = get('--excel') || 'C:/Users/Ruy Spinola/Downloads/edificios-por-torre-v4 - Ruy.xlsx';
const PROG    = path.join(__dirname, '.progress-ocupantes.json');
const BASE    = 'https://api.hubapi.com';

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function hs(path, opts = {}, _retry = 0) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers||{}) },
  });
  if (res.status === 429 && _retry < 4) {
    const wait = Math.max(parseInt(res.headers.get('Retry-After')||'2',10)*1000, 2**_retry*600);
    await sleep(wait);
    return hs(path, opts, _retry+1);
  }
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`${opts.method||'GET'} ${path} → ${res.status}: ${t.slice(0,200)}`);
  }
  return res.status===204 ? null : res.json();
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── 1. Garante que a propriedade `nome_do_ocupante` existe ───────────────────
async function garantirPropriedade() {
  try {
    await hs(`/crm/v3/properties/${OBJ_CONJUNTO}/nome_do_ocupante`);
    console.log('✓  Propriedade nome_do_ocupante já existe');
    return;
  } catch (_) { /* não existe, vai criar */ }

  console.log('➕ Criando propriedade nome_do_ocupante...');
  if (!DRY) {
    await hs(`/crm/v3/properties/${OBJ_CONJUNTO}`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'nome_do_ocupante',
        label: 'Ocupante',
        type: 'string',
        fieldType: 'text',
        groupName: 'conjuntos_information',
        description: 'Empresa ou pessoa que ocupa o conjunto (fonte: planilha espelho)',
      }),
    });
    console.log('✅ Propriedade criada');
  } else {
    console.log('   [DRY] criaria nome_do_ocupante');
  }
}

// ── 2. Carrega o mapa Edifício→Andar→Conjunto do HubSpot ─────────────────────
// Estrutura: { edificioId: { andarNum: { nomeConjunto: conjuntoId } } }
async function carregarMapaConjuntos(edificioIds) {
  const mapa = {};
  console.log(`\n📦 Carregando conjuntos para ${edificioIds.size} edifícios...`);

  // batch read: associações Edifício→Andar
  const chunks = [...edificioIds].reduce((acc, id, i) => {
    const chunk = Math.floor(i/100);
    (acc[chunk] = acc[chunk]||[]).push(id);
    return acc;
  }, []);

  const edAndarAssoc = {};
  for (const chunk of chunks) {
    const res = await hs(`/crm/v4/associations/${OBJ_EDIFICIO}/${OBJ_ANDAR}/batch/read`, {
      method: 'POST', body: JSON.stringify({ inputs: chunk.map(id=>({id})) }),
    });
    (res.results||[]).forEach(r => {
      edAndarAssoc[r.from.id] = (r.to||[]).map(t=>t.toObjectId);
    });
    await sleep(80);
  }

  const andarIds = [...new Set(Object.values(edAndarAssoc).flat())];
  if (!andarIds.length) { console.warn('⚠️  Nenhum andar encontrado'); return mapa; }

  // andares: pega numero_do_andar
  const PROP_NUM = 'numero_do_andar';
  const andarChunks = andarIds.reduce((acc,id,i)=>{ const c=Math.floor(i/100);(acc[c]=acc[c]||[]).push(id);return acc; },[]);
  const andaresById = {};
  for (const chunk of andarChunks) {
    const res = await hs(`/crm/v3/objects/${OBJ_ANDAR}/batch/read`, {
      method: 'POST', body: JSON.stringify({ properties:[PROP_NUM], inputs:chunk.map(id=>({id})) }),
    });
    (res.results||[]).forEach(o => { andaresById[o.id] = o.properties[PROP_NUM]; });
    await sleep(80);
  }

  // associações Andar→Conjunto
  const andarConjAssoc = {};
  for (const chunk of andarChunks) {
    const res = await hs(`/crm/v4/associations/${OBJ_ANDAR}/${OBJ_CONJUNTO}/batch/read`, {
      method: 'POST', body: JSON.stringify({ inputs: chunk.map(id=>({id})) }),
    });
    (res.results||[]).forEach(r => {
      andarConjAssoc[r.from.id] = (r.to||[]).map(t=>t.toObjectId);
    });
    await sleep(80);
  }

  const conjIds = [...new Set(Object.values(andarConjAssoc).flat())];
  if (!conjIds.length) { console.warn('⚠️  Nenhum conjunto encontrado'); return mapa; }

  // conjuntos: pega nome_do_conjunto
  const conjChunks = conjIds.reduce((acc,id,i)=>{ const c=Math.floor(i/100);(acc[c]=acc[c]||[]).push(id);return acc; },[]);
  const conjuntosById = {};
  for (const chunk of conjChunks) {
    const res = await hs(`/crm/v3/objects/${OBJ_CONJUNTO}/batch/read`, {
      method: 'POST', body: JSON.stringify({ properties:['nome_do_conjunto'], inputs:chunk.map(id=>({id})) }),
    });
    (res.results||[]).forEach(o => { conjuntosById[o.id] = o.properties.nome_do_conjunto; });
    await sleep(80);
  }

  // monta mapa: edificioId → andarNum → nomeExtraido → conjuntoId
  Object.entries(edAndarAssoc).forEach(([edId, andIds]) => {
    mapa[edId] = mapa[edId] || {};
    andIds.forEach(andarId => {
      const andarNum = parseInt(andaresById[andarId] || '0', 10);
      const conjIds  = andarConjAssoc[andarId] || [];
      conjIds.forEach(cjId => {
        const nomeCj = conjuntosById[cjId] || '';
        // extrai "11" de "Conj. 11 — 1º andar — ..."
        const match  = nomeCj.match(/^Conj\.\s+(.+?)\s+[—–-]/);
        const nome   = match ? match[1].trim() : nomeCj.split('—')[0].replace(/^Conj\./i,'').trim();
        if (!mapa[edId][andarNum]) mapa[edId][andarNum] = {};
        mapa[edId][andarNum][nome.toLowerCase()] = cjId;
      });
    });
  });

  const total = Object.values(mapa).reduce((s,a)=>s+Object.values(a).reduce((s2,c)=>s2+Object.keys(c).length,0),0);
  console.log(`✓  ${total} conjuntos mapeados`);
  return mapa;
}

// ── 3. MAIN ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🏢 Importar Ocupantes — portal ATIE (51253038)`);
  console.log(`   Modo   : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  console.log(`   Excel  : ${EXCEL}\n`);

  // Lê Excel
  if (!existsSync(EXCEL)) { console.error('❌  Arquivo Excel não encontrado:', EXCEL); process.exit(1); }
  const wb   = XLSX.readFile(EXCEL);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
  // header na linha 4 (índice 3); dados a partir da linha 5
  const data = rows.slice(4).filter(r => r[0]); // só linhas com ID de edifício

  // filtra só linhas com ocupante real
  const comOcupante = data.filter(r => {
    const ocp = String(r[6]||'').trim();
    return ocp && ocp !== '-- Vago --' && ocp !== '-- Informação Pendente --';
  });

  console.log(`   Total linhas    : ${data.length}`);
  console.log(`   Com ocupante    : ${comOcupante.length}`);
  const limite = Math.min(LIMITE, comOcupante.length);
  console.log(`   A processar     : ${limite}\n`);

  await garantirPropriedade();

  // IDs únicos de edifícios a consultar
  const edificioIds = new Set(comOcupante.slice(0,limite).map(r=>String(r[0])));
  const mapa = await carregarMapaConjuntos(edificioIds);

  const progresso = existsSync(PROG) ? JSON.parse(readFileSync(PROG,'utf8')) : {};
  const stats = { ok:0, notFound:0, pulados:0, erros:0 };
  const naoEncontrados = [];

  for (let i=0; i<limite; i++) {
    const row    = comOcupante[i];
    const edId   = String(row[0]);
    const andar  = parseInt(row[2]||0,10);
    const nomeXl = String(row[3]||'').trim().toLowerCase();
    const ocp    = String(row[6]||'').trim();
    const key    = `${edId}|${andar}|${nomeXl}`;

    if (progresso[key]?.status === 'ok') { stats.pulados++; continue; }

    // resolve conjuntoId no mapa
    const conjId = mapa[edId]?.[andar]?.[nomeXl];
    if (!conjId) {
      naoEncontrados.push({ edId, andar, nomeXl, ocp });
      stats.notFound++;
      continue;
    }

    if (DRY) {
      if (i<5) console.log(`  📋 ${conjId} → nome_do_ocupante="${ocp}"`);
      stats.ok++;
      continue;
    }

    try {
      await hs(`/crm/v3/objects/${OBJ_CONJUNTO}/${conjId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { nome_do_ocupante: ocp } }),
      });
      progresso[key] = { status:'ok', conjId, rodado_em: new Date().toISOString() };
      if (i%200===0) writeFileSync(PROG, JSON.stringify(progresso,null,2));
      stats.ok++;
      if (i%100===0) console.log(`   ${i}/${limite} processados...`);
      await sleep(60);
    } catch (err) {
      console.error(`  ❌ ${key}: ${err.message}`);
      stats.erros++;
    }
  }

  if (!DRY) writeFileSync(PROG, JSON.stringify(progresso,null,2));

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Atualizados     : ${stats.ok}`);
  console.log(`  ⏭️  Pulados         : ${stats.pulados}`);
  console.log(`  ❓ Não encontrados : ${stats.notFound}`);
  console.log(`  ❌ Erros           : ${stats.erros}`);
  if (naoEncontrados.length) {
    console.log('\n  Primeiros 5 não encontrados:');
    naoEncontrados.slice(0,5).forEach(x=>console.log(`     edId=${x.edId} andar=${x.andar} nome="${x.nomeXl}" → "${x.ocp}"`));
  }
  console.log('\n✓ Concluído.\n');
})();
