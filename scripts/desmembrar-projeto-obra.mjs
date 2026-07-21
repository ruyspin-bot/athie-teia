/**
 * scripts/desmembrar-projeto-obra.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Para cada deal com aw_tipo_de_negocio = "Projeto e Obra":
 *   1. Atualiza o deal original → tipo "Projeto"  (mantém dealname)
 *   2. Cria um deal novo        → tipo "Obra"      (nome + " — Obra")
 *   3. Copia todas as associações (companies, contacts, andares) para o novo
 *
 * Uso:
 *   node --env-file=.env.local scripts/desmembrar-projeto-obra.mjs
 *   node --env-file=.env.local scripts/desmembrar-projeto-obra.mjs --dry-run
 *   node --env-file=.env.local scripts/desmembrar-projeto-obra.mjs --listar
 *
 * Flags:
 *   --dry-run   : mostra o que seria feito sem alterar nada
 *   --listar    : lista os valores distintos de aw_tipo_de_negocio encontrados
 *   --limite N  : processa só os primeiros N deals
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROG      = path.join(__dirname, '.progress-desmembrar.json');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN'); process.exit(1); }

const args    = process.argv.slice(2);
const get     = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const has     = f => args.includes(f);
const DRY     = has('--dry-run');
const LISTAR  = has('--listar');
const LIMITE  = parseInt(get('--limite') || '99999', 10);
const BASE    = 'https://api.hubapi.com';

const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || '2-65605360';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || '2-65603861';
const PROP_TIPO    = process.env.HUBSPOT_PROP_TIPO        || 'aw_tipo_de_negocio';

// ─── Propriedades a copiar para o deal de Obra ────────────────────────────────
const PROPS_COPIAR = [
  'dealname', 'pipeline', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id',
  'aw_id_interno', 'aw_id_projeto_pai', 'aw_numero_projeto', 'aw_area_m2',
  'aw_valor_m2_projeto', 'aw_natureza_valor', 'aw_budget_declarado_total',
  'aw_fonte_de_origem', 'aw_setor_cliente', 'aw_envolvimento_comercial',
  'aw_responsabilidade_den', 'aw_apalavrado_com_cliente',
  'aw_probabilidade_negocio_existir', 'aw_local', 'aw_substatus',
  'aw_data_previsao_original', 'aw_den_comercial', 'aw_projeto_top',
  'aw_new_business', 'aw_chances_ganhar', 'aw_frequencia_comercial',
  'aw_id_agrupador', 'aw_conta_negocio', 'aw_gerenciadoras_obs',
  'aw_edificio_id', 'aw_andar_de_interesse', 'nucleo',
  PROP_TIPO,
];

// ─── HTTP ────────────────────────────────────────────────────────────────────
async function hs(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Buscar todos os deals com cursor ────────────────────────────────────────
async function buscarDealsProjetoObra(valor) {
  const todos = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: PROP_TIPO, operator: 'EQ', value: valor }] }],
      properties: PROPS_COPIAR,
      limit: 100,
      ...(after ? { after } : {}),
    };
    const res = await hs('/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify(body) });
    todos.push(...(res.results || []));
    after = res.paging?.next?.after;
  } while (after);
  return todos;
}

// ─── Buscar valores distintos de aw_tipo_de_negocio ─────────────────────────
async function listarTipos() {
  const contagens = {};
  let after = undefined;
  do {
    const body = { properties: [PROP_TIPO], limit: 100, ...(after ? { after } : {}) };
    const res = await hs('/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify(body) });
    for (const d of (res.results || [])) {
      const v = d.properties?.[PROP_TIPO] || '(vazio)';
      contagens[v] = (contagens[v] || 0) + 1;
    }
    after = res.paging?.next?.after;
  } while (after);
  return contagens;
}

// ─── Buscar associações de um deal ──────────────────────────────────────────
async function getAssociacoes(dealId, toObject) {
  try {
    const res = await hs(`/crm/v4/objects/deals/${dealId}/associations/${toObject}`);
    return (res.results || []).map(r => ({ toId: r.toObjectId, types: r.associationTypes }));
  } catch (_) { return []; }
}

// ─── Copiar associações para o novo deal ────────────────────────────────────
async function copiarAssociacoes(dealOrigemId, dealDestinoId) {
  const objetos = ['companies', 'contacts', OBJ_ANDAR, OBJ_EDIFICIO];
  let total = 0;
  for (const obj of objetos) {
    const assocs = await getAssociacoes(dealOrigemId, obj);
    for (const a of assocs) {
      const types = a.types.map(t => ({ associationCategory: t.category, associationTypeId: t.typeId }));
      if (!types.length) continue;
      try {
        await hs(`/crm/v4/objects/deals/${dealDestinoId}/associations/${obj}/${a.toId}`,
          { method: 'PUT', body: JSON.stringify(types) });
        total++;
      } catch (_) {}
      await sleep(60);
    }
  }
  return total;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n✂️  Desmembrar "Projeto e Obra" — portal ATIE (51253038)`);
  console.log(`   Modo: ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}\n`);

  // Modo --listar
  if (LISTAR) {
    console.log('📋 Valores distintos de', PROP_TIPO, 'nos deals:\n');
    const tipos = await listarTipos();
    Object.entries(tipos).sort((a,b) => b[1]-a[1]).forEach(([v,n]) =>
      console.log(`   ${n.toString().padStart(4)} deals  →  "${v}"`)
    );
    console.log('\n✓ Use o valor exato acima em --valor se diferente do padrão.\n');
    process.exit(0);
  }

  // Descobrir valor real do enum (pode ser "Projeto e Obra", "projeto_e_obra", etc.)
  console.log('🔍 Procurando deals "Projeto e Obra"...');
  const tipos = await listarTipos();
  const valorPO = Object.keys(tipos).find(v => /projeto.+obra/i.test(v));
  if (!valorPO) {
    console.error('❌  Nenhum deal com "Projeto e Obra" encontrado. Use --listar para ver os valores.');
    process.exit(1);
  }
  const valorProjeto = Object.keys(tipos).find(v => /^projeto$/i.test(v.trim())) || 'Projeto';
  const valorObra    = Object.keys(tipos).find(v => /^obra$/i.test(v.trim()))    || 'Obra';

  console.log(`   Valor encontrado  : "${valorPO}" (${tipos[valorPO]} deals)`);
  console.log(`   Vai virar Projeto : "${valorProjeto}"`);
  console.log(`   Vai criar como    : "${valorObra}"\n`);

  const deals = await buscarDealsProjetoObra(valorPO);
  const limite = Math.min(LIMITE, deals.length);
  console.log(`   Total a processar : ${limite} deals\n`);

  if (!limite) { console.log('✓ Nada a fazer.\n'); process.exit(0); }

  const progresso = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : {};
  const resultados = { atualizados: [], criados: [], pulados: [], erros: [] };

  for (let i = 0; i < limite; i++) {
    const deal = deals[i];
    const id   = deal.id;
    const p    = deal.properties || {};
    const nome = p.dealname || `Deal ${id}`;
    const prefix = `[${i+1}/${limite}] ${id}`;

    if (progresso[id]?.status === 'ok') {
      console.log(`  ⏭️  ${prefix} "${nome}" — já processado`);
      resultados.pulados.push(id);
      continue;
    }

    if (DRY) {
      console.log(`  📋 ${prefix} "${nome}"`);
      console.log(`       original → tipo="${valorProjeto}"`);
      console.log(`       novo     → "${nome} — Obra" tipo="${valorObra}"`);
      resultados.atualizados.push(id);
      continue;
    }

    try {
      // 1. Atualizar original → Projeto
      await hs(`/crm/v3/objects/deals/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { [PROP_TIPO]: valorProjeto } }),
      });
      await sleep(120);

      // 2. Criar deal de Obra com as mesmas propriedades
      const novasProps = {};
      for (const prop of PROPS_COPIAR) {
        if (p[prop] != null && p[prop] !== '') novasProps[prop] = p[prop];
      }
      novasProps[PROP_TIPO]   = valorObra;
      novasProps['dealname']  = `${nome} — Obra`;

      const novoDeal = await hs('/crm/v3/objects/deals', {
        method: 'POST',
        body: JSON.stringify({ properties: novasProps }),
      });
      const novoId = novoDeal.id;
      await sleep(120);

      // 3. Copiar associações
      const assocs = await copiarAssociacoes(id, novoId);

      console.log(`  ✅ ${prefix} "${nome}" → Projeto · Obra criado (${novoId}) · ${assocs} assoc.`);
      progresso[id] = { status: 'ok', novoId, rodado_em: new Date().toISOString() };
      writeFileSync(PROG, JSON.stringify(progresso, null, 2));
      resultados.atualizados.push(id);
      resultados.criados.push(novoId);
      await sleep(200);

    } catch (err) {
      console.error(`  ❌ ${prefix} — ERRO: ${err.message}`);
      resultados.erros.push({ id, erro: err.message });
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Deals atualizados (→ Projeto) : ${resultados.atualizados.length}`);
  console.log(`  🆕 Deals criados    (→ Obra)     : ${resultados.criados.length}`);
  console.log(`  ⏭️  Pulados (já feitos)           : ${resultados.pulados.length}`);
  console.log(`  ❌ Erros                          : ${resultados.erros.length}`);
  if (resultados.erros.length) resultados.erros.forEach(e => console.log(`     • ${e.id}: ${e.erro}`));
  console.log('\n✓ Concluído.\n');
})();
