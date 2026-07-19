/**
 * scripts/enriquecer-owners.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Lê o Excel formatado da AW (2 sheets: "Deals com comercial" + "Sem acompanhamento"),
 * busca cada deal no HubSpot por aw_id_interno (= IdProjeto do Focus) e
 * atualiza o "Proprietário do Negócio" (hubspot_owner_id) com base na coluna
 * "Comercial Proprietário" do arquivo.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ANTES DE RODAR: preencha o OWNER_MAP abaixo com os IDs de cada usuário.
 *
 * Como encontrar o ID de cada usuário no HubSpot:
 *   1. Acesse: https://app.hubspot.com/settings/51253038/users
 *   2. Clique em um usuário → a URL fica .../users?user=XXXXXXXX
 *   3. O número após "user=" é o hubspot_owner_id
 *
 * Ou: abra qualquer Deal no HubSpot → campo "Proprietário" → inspecione o HTML
 * do dropdown — cada <option> tem value="XXXXXXXX" correspondente ao ID.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Uso:
 *   node --env-file=.env.local scripts/enriquecer-owners.mjs \
 *     --arquivo "C:/Users/.../DEALS-VIVOS-2026-07-17_HubSpot_formatado_v8.xlsx"
 *
 * Flags:
 *   --arquivo    : caminho do Excel (obrigatório)
 *   --dry-run    : mostra o que seria feito sem chamar a API
 *   --limite N   : processa só os primeiros N registros
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN'); process.exit(1); }

const args  = process.argv.slice(2);
const get   = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const has   = f => args.includes(f);

const ARQUIVO = get('--arquivo');
const DRY     = has('--dry-run');
const LIMITE  = parseInt(get('--limite') || '99999', 10);
const BASE    = 'https://api.hubapi.com';
const PROG    = path.join(__dirname, '.progress-owners.json');

if (!ARQUIVO) {
  console.error('Uso: node scripts/enriquecer-owners.mjs --arquivo <xlsx> [--dry-run] [--limite N]');
  process.exit(1);
}

// ─── Mapa nome → hubspot_owner_id ────────────────────────────────────────────
// Preencha os IDs abaixo. Veja o cabeçalho do arquivo para instruções.
// Deixe '' para pular um owner (deals sem ID não serão atualizados).
const OWNER_MAP = {
  'Jennifer Henriques':   '',          // 103 deals — usuário não encontrado no portal
  'Paloma Nogueira':      '92589513',  // 101 deals
  'Clarissa Correia':     '',          //  90 deals — usuário não encontrado no portal
  'Luisa Zerbini':        '92589477',  //  90 deals
  'Juliana Casagrande':   '',          //  77 deals — usuário não encontrado no portal
  'Karine Nobre':         '',          //  65 deals — usuário não encontrado no portal
  'Laura Mendonça':       '',          //  55 deals — usuário não encontrado no portal
  'Marina Camargo':       '92589501',  //  47 deals
  'Marcos Barino':        '',          //  40 deals — usuário não encontrado no portal
  'Silvio Rosolem':       '91396854',  //  23 deals (Silvio Rosolem Junior)
};

// ─── HTTP ────────────────────────────────────────────────────────────────────
async function hs(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers||{}) },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${opts.method||'GET'} ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── XLSX (central directory — suporta streaming ZIP) ────────────────────────
function lerXlsx(caminho, sheetIndex = 1) {
  const data = readFileSync(caminho);
  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i]===0x50&&data[i+1]===0x4B&&data[i+2]===0x05&&data[i+3]===0x06) { eocd=i; break; }
  }
  if (eocd < 0) throw new Error('EOCD não encontrado — arquivo não é um ZIP válido');

  const cdOffset = data.readUInt32LE(eocd+16), cdSize = data.readUInt32LE(eocd+12);
  const files = {};
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (data[pos]!==0x50||data[pos+1]!==0x4B||data[pos+2]!==0x01||data[pos+3]!==0x02) break;
    const comp=data.readUInt16LE(pos+10), compSz=data.readUInt32LE(pos+20);
    const fnLen=data.readUInt16LE(pos+28), extraLen=data.readUInt16LE(pos+30), commLen=data.readUInt16LE(pos+32);
    const localOff=data.readUInt32LE(pos+42);
    const fname=data.slice(pos+46, pos+46+fnLen).toString('utf8');
    const localFnLen=data.readUInt16LE(localOff+26), localExLen=data.readUInt16LE(localOff+28);
    const dataStart=localOff+30+localFnLen+localExLen;
    const cData=data.slice(dataStart, dataStart+compSz);
    if (comp===8) { try { files[fname]=zlib.inflateRawSync(cData).toString('utf8'); } catch(_) {} }
    else if (comp===0) { files[fname]=cData.toString('utf8'); }
    pos += 46+fnLen+extraLen+commLen;
  }

  const dec = s => s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

  const ssXml = files['xl/sharedStrings.xml'] || '';
  const strings = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => dec(t[1])).join(''));

  const ws = files[`xl/worksheets/sheet${sheetIndex}.xml`] || '';
  const rows = [];
  for (const rm of ws.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c[^>]*>([\s\S]*?)<\/c>/g)) {
      const tA = cm[0].match(/t="([^"]*)"/)?.[1];
      const col = (cm[0].match(/r="([A-Z]+)/)?.[1]||'').split('').reduce((a,c)=>a*26+(c.charCodeAt(0)-64),0)-1;
      while (cells.length < col) cells.push('');
      let val = '';
      if (tA === 'inlineStr') {
        val = dec(cm[1].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '');
      } else if (tA === 's') {
        const v = cm[1].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        val = v != null ? (strings[parseInt(v)] ?? '') : '';
      } else {
        val = cm[1].match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
      }
      cells.push(val);
    }
    rows.push(cells);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map(r =>
    Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').toString().trim()]))
  );
}

// ─── Buscar deal por aw_id_interno ───────────────────────────────────────────
async function buscarDeal(idProjeto) {
  const res = await hs('/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'aw_id_interno', operator: 'EQ', value: String(idProjeto) }] }],
      properties: ['dealname', 'aw_id_interno', 'hubspot_owner_id'],
      limit: 1,
    }),
  });
  return res.results?.[0] || null;
}


// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n👤 Enriquecer owners — portal ATIE (51253038)`);
  console.log(`   Arquivo : ${ARQUIVO}`);
  console.log(`   Modo    : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}\n`);

  // Carregar progresso anterior
  const progresso = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : {};

  // Ler ambas as sheets e combinar
  console.log('📖 Lendo Excel...');
  const sheet2 = lerXlsx(ARQUIVO, 2); // Deals com comercial
  const sheet3 = lerXlsx(ARQUIVO, 3); // Sem acompanhamento
  const todos = [...sheet2, ...sheet3].filter(r => r.IdProjeto);
  console.log(`   ${sheet2.length} deals com comercial + ${sheet3.length} sem acompanhamento = ${todos.length} total\n`);

  // Validar OWNER_MAP
  const faltando = Object.entries(OWNER_MAP).filter(([, id]) => !id).map(([nome]) => nome);
  const preenchidos = Object.entries(OWNER_MAP).filter(([, id]) => !!id).length;
  console.log('👤 Mapa de owners:');
  Object.entries(OWNER_MAP).forEach(([nome, id]) =>
    console.log(`   ${id ? '✅' : '⚠️ '} "${nome}" → ${id || 'ID NÃO PREENCHIDO'}`),
  );
  if (faltando.length && !DRY) {
    console.log(`\n⚠️  ${faltando.length} owners sem ID — deals desses comerciais serão pulados.`);
    console.log('   Preencha o OWNER_MAP no topo do script e rode novamente.\n');
  }
  if (preenchidos === 0 && !DRY) {
    console.error('\n❌ Nenhum owner preenchido. Preencha o OWNER_MAP e rode novamente.');
    process.exit(1);
  }
  const ownerMap = Object.fromEntries(
    Object.entries(OWNER_MAP).map(([nome, id]) => [nome.toLowerCase(), id]),
  );
  console.log('');

  // Processar
  const resultados = { atualizados: [], semOwner: [], naoEncontrado: [], erros: [], pulados: [] };
  const limite = Math.min(LIMITE, todos.length);

  for (let i = 0; i < limite; i++) {
    const row = todos[i];
    const idProjeto = row.IdProjeto;
    const nomeOwner = row['Comercial Proprietário'] || '';
    const prefix = `[${i+1}/${limite}] ID ${idProjeto}`;

    // Pular já processados
    if (progresso[idProjeto]?.status === 'ok') {
      process.stdout.write(`  ⏭️  ${prefix} — já processado\n`);
      resultados.pulados.push(idProjeto);
      continue;
    }

    // Sem owner no arquivo
    if (!nomeOwner || nomeOwner === 'Sem acompanhamento') {
      process.stdout.write(`  ➖ ${prefix} — sem owner no arquivo\n`);
      resultados.semOwner.push(idProjeto);
      continue;
    }

    if (DRY) {
      const ownerId = ownerMap[nomeOwner.toLowerCase()] || '(ID NÃO PREENCHIDO)';
      console.log(`  📋 ${prefix} — "${nomeOwner}" → owner_id: ${ownerId}`);
      resultados.atualizados.push(idProjeto);
      continue;
    }

    try {
      // Buscar deal no HubSpot
      const deal = await buscarDeal(idProjeto);
      if (!deal) {
        console.log(`  ⚠️  ${prefix} — deal não encontrado no HubSpot`);
        resultados.naoEncontrado.push(idProjeto);
        continue;
      }

      // Resolver owner ID
      const ownerId = ownerMap[nomeOwner.toLowerCase()];
      if (!ownerId) {
        console.log(`  ⚠️  ${prefix} — owner "${nomeOwner}" não encontrado no HubSpot`);
        resultados.naoEncontrado.push(idProjeto);
        continue;
      }

      // Já tem o owner correto?
      if (deal.properties?.hubspot_owner_id === String(ownerId)) {
        resultados.pulados.push(idProjeto);
        continue;
      }

      // PATCH
      await hs(`/crm/v3/objects/deals/${deal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { hubspot_owner_id: String(ownerId) } }),
      });

      console.log(`  ✅ ${prefix} — "${nomeOwner}" (${ownerId}) → ${deal.properties.dealname}`);
      progresso[idProjeto] = { status: 'ok', ownerId, ownerNome: nomeOwner };
      writeFileSync(PROG, JSON.stringify(progresso, null, 2));
      resultados.atualizados.push(idProjeto);
      await sleep(120);

    } catch (err) {
      console.error(`  ❌ ${prefix} — ERRO: ${err.message}`);
      resultados.erros.push({ idProjeto, erro: err.message });
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Atualizados   : ${resultados.atualizados.length}`);
  console.log(`  ⏭️  Pulados        : ${resultados.pulados.length}`);
  console.log(`  ➖ Sem owner      : ${resultados.semOwner.length}`);
  console.log(`  ⚠️  Não encontrado : ${resultados.naoEncontrado.length}`);
  console.log(`  ❌ Erros          : ${resultados.erros.length}`);
  if (resultados.erros.length) resultados.erros.forEach(e => console.log(`     • ${e.idProjeto}: ${e.erro}`));
  console.log('\n✓ Concluído.\n');
})();
