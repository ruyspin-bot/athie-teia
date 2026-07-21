/**
 * scripts/arquivar-andares-orfaos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Arquiva os 55 andares órfãos legados (São Paulo Corporate Towers, formato
 * antigo) identificados na auditoria de 21/07/2026.
 *
 * Nenhum desses andares possui conjuntos vinculados — são apenas resíduos
 * da migração inicial que inflam a contagem do objeto.
 *
 * Fonte: audit_andares_orfaos.csv
 *
 * Uso:
 *   node --env-file=.env.local scripts/arquivar-andares-orfaos.mjs --dry-run
 *   node --env-file=.env.local scripts/arquivar-andares-orfaos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  HUBSPOT_TOKEN não encontrado'); process.exit(1); }

const OBJ_ANDAR = process.env.HUBSPOT_OBJECT_ANDAR || 'p51253038_andares';

const args = process.argv.slice(2);
const DRY  = args.includes('--dry-run');
const CSV_PATH = 'C:/Users/Ruy Spinola/Downloads/audit_csvs/audit_andares_orfaos.csv';
const BASE = 'https://api.hubapi.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    await sleep(Math.max(parseInt(res.headers.get('Retry-After') || '2', 10) * 1000, 2000));
    return hs(url, opts, _retry + 1);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${t.slice(0, 250)}`);
  }
  return res.status === 204 ? null : res.json();
}

(async () => {
  console.log('\n🗑️  Arquivar Andares Órfãos — portal ATIE (51253038)');
  console.log(`   Modo: ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}\n`);

  if (!existsSync(CSV_PATH)) { console.error('❌  CSV não encontrado'); process.exit(1); }

  // Lê CSV — colunas: id,area_locavel_m2,...,hs_object_id,...,nome_do_andar,...
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const idxId   = header.indexOf('hs_object_id');
  const idxNome = header.indexOf('nome_do_andar');

  const andares = lines.slice(1).map(l => {
    const parts = l.split(',');
    return { id: parts[idxId], nome: parts[idxNome] };
  }).filter(a => a.id);

  console.log(`   Andares órfãos a arquivar: ${andares.length}`);
  if (DRY) {
    console.log('\n   Exemplos:');
    andares.slice(0, 5).forEach(a => console.log(`     ${a.id} — ${a.nome}`));
  }

  if (DRY) { console.log('\n   [DRY-RUN] Nenhum arquivo alterado.\n'); return; }

  const stats = { ok: 0, erros: 0 };

  for (const andar of andares) {
    try {
      // Verifica que não tem conjuntos antes de arquivar
      const assoc = await hs(`/crm/v4/objects/${OBJ_ANDAR}/${andar.id}/associations/p51253038_conjuntos`);
      if ((assoc.results || []).length > 0) {
        console.warn(`  ⚠️  Andar ${andar.id} tem ${assoc.results.length} conjuntos — pulando!`);
        continue;
      }

      // Arquiva
      await hs(`/crm/v3/objects/${OBJ_ANDAR}/${andar.id}`, { method: 'DELETE' });
      stats.ok++;
      if (stats.ok % 10 === 0) console.log(`   ${stats.ok}/${andares.length} arquivados...`);
      await sleep(100);
    } catch (err) {
      console.error(`  ❌ ${andar.id}: ${err.message}`);
      stats.erros++;
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Arquivados  : ${stats.ok}`);
  console.log(`  ❌ Erros       : ${stats.erros}`);
  console.log('\n✓ Concluído.\n');
})();
