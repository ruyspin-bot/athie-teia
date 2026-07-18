/**
 * import-deal-teste.mjs
 * ─────────────────────────────────────────────────────────────
 * Importa o deal da linha 47 do arquivo DEALS-VIVOS-LuisaZerbini.xlsx
 * como negócio de teste no HubSpot ATIE (portal 51253038).
 *
 * Uso:
 *   HUBSPOT_TOKEN=pat-na1-xxx node scripts/import-deal-teste.mjs
 *
 * O script:
 *   1. Lista os stages do pipeline base (899974520) para você confirmar o mapeamento
 *   2. Busca ou cria as empresas: CLARO (cliente), Binswanger (gerenciadora)
 *   3. Busca o owner "Luisa Zerbini"
 *   4. Cria o deal com todos os campos aw_* de migração
 *   5. Associa as empresas com os rótulos corretos
 *   6. Imprime o link do deal criado
 * ─────────────────────────────────────────────────────────────
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN'); process.exit(1); }

const BASE = 'https://api.hubapi.com';
const PORTAL = '51253038';
const PIPELINE = '899974520';

// ─── Dados do deal (linha 47) ───────────────────────────────
const DEAL_FOCUS = {
  id_projeto:       '65968',
  id_projeto_pai:   '65967',
  numero_projeto:   '4703/24',
  nome:             'CLARO · Quota Corporate — 4703/24',
  status_focus:     'EPP',          // ← confirmar mapeamento para stage HubSpot
  data_fechamento:  '2026-08-31',
  valor:            40173000,
  area:             11478,
  probabilidade:    'Alta',
  chances_ganhar:   '70% a 90%',
  escopo:           'Obra',
  grupo_comercial:  'CLARO',
  gerenciadora:     'BINSWANGER',
  broker:           null,           // "não tem"
  gerenteComercial: 'Luisa Zerbini',
  den:              'Daniel Giannella',
  edificio:         'Quota Corporate',
  frequencia:       'conta 1M (mensal)',
};

async function hs(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HubSpot ${opts.method || 'GET'} ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── 1. Listar stages do pipeline ──────────────────────────
async function listarStages() {
  const data = await hs(`/crm/v3/pipelines/deals/${PIPELINE}`);
  console.log('\n📋 Stages do pipeline base (899974520):');
  (data.stages || []).forEach(s => console.log(`   ${s.id}  →  ${s.label}`));
  console.log('\n⚠️  Mapeamento EPP (Focus) → stage HubSpot:');
  console.log('   EPP = "Em Proposta Apresentada" → provável: "Proposta Apresentada"');
  console.log('   Confirme o ID correto acima e ajuste STAGE_ID no script se necessário.\n');
  // Retorna o ID do primeiro stage que contenha "Proposta" (melhor esforço)
  const match = (data.stages || []).find(s => /proposta.*apres/i.test(s.label));
  return match ? match.id : (data.stages || [])[0]?.id;
}

// ─── 2. Buscar ou criar empresa ─────────────────────────────
async function upsertEmpresa(nome) {
  const search = await hs('/crm/v3/objects/companies/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: nome }] }], properties: ['name'], limit: 1 }),
  });
  if (search.results?.length) {
    console.log(`   ✓ Empresa encontrada: ${nome} (${search.results[0].id})`);
    return search.results[0].id;
  }
  const created = await hs('/crm/v3/objects/companies', {
    method: 'POST',
    body: JSON.stringify({ properties: { name: nome } }),
  });
  console.log(`   ✚ Empresa criada: ${nome} (${created.id})`);
  return created.id;
}

// ─── 3. Buscar owner por nome ───────────────────────────────
async function buscarOwner(nome) {
  const data = await hs('/crm/v3/owners?limit=100');
  const found = (data.results || []).find(o =>
    `${o.firstName} ${o.lastName}`.toLowerCase().includes(nome.toLowerCase())
  );
  if (found) { console.log(`   ✓ Owner encontrado: ${found.firstName} ${found.lastName} (${found.id})`); return found.id; }
  console.log(`   ⚠️  Owner "${nome}" não encontrado — deal ficará sem owner.`);
  return null;
}

// ─── 4. Associar empresa ao deal com rótulo ─────────────────
async function associarEmpresa(dealId, companyId, rotulo) {
  // rótulo de associação deal→company (label type = association label)
  await hs(`/crm/v4/objects/deals/${dealId}/associations/companies/${companyId}`, {
    method: 'PUT',
    body: JSON.stringify([{ associationCategory: 'USER_DEFINED', associationTypeId: 3 }]),
    // Note: associationTypeId 3 = deal_to_company default; rótulos customizados precisam do typeId específico
    // Ajustar conforme IDs de rótulo do portal ATIE (ver /crm/v4/associations/deals/companies/labels)
  });
  console.log(`   ↔  Associado deal ${dealId} → empresa ${companyId} (${rotulo})`);
}

// ─── MAIN ───────────────────────────────────────────────────
(async () => {
  try {
    console.log('🚀 Iniciando importação do deal 4703/24 — Claro Obra\n');

    // 1. Stages
    const stageId = await listarStages();
    console.log(`   → Usando stage ID: ${stageId} (ajuste STAGE_ID se necessário)\n`);

    // 2. Empresas
    console.log('🏢 Empresas:');
    const idClaro      = await upsertEmpresa('CLARO');
    const idBinswanger = await upsertEmpresa('Binswanger');

    // 3. Owner
    console.log('\n👤 Owner:');
    const ownerId = await buscarOwner('Luisa Zerbini');

    // 4. Criar deal
    console.log('\n📄 Criando deal...');
    const dealProps = {
      dealname:       DEAL_FOCUS.nome,
      pipeline:       PIPELINE,
      dealstage:      stageId,
      amount:         String(DEAL_FOCUS.valor),
      closedate:      DEAL_FOCUS.data_fechamento,
      // Campos de migração Focus
      aw_id_interno:           DEAL_FOCUS.id_projeto,
      aw_id_projeto_pai:       DEAL_FOCUS.id_projeto_pai,
      // Campos informativos
      description: `Importação teste • Focus ${DEAL_FOCUS.numero_projeto} • Área: ${DEAL_FOCUS.area}m² • ${DEAL_FOCUS.escopo}`,
    };
    if (ownerId) dealProps.hubspot_owner_id = String(ownerId);

    const deal = await hs('/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({ properties: dealProps }),
    });
    console.log(`   ✅ Deal criado: ${deal.id}`);
    console.log(`   🔗 https://app.hubspot.com/contacts/${PORTAL}/deal/${deal.id}`);

    // 5. Associar empresas
    console.log('\n🔗 Associações:');
    await associarEmpresa(deal.id, idClaro, 'Cliente Final');
    await associarEmpresa(deal.id, idBinswanger, 'Gerenciadora');

    console.log('\n✅ Concluído! Deal de teste criado no HubSpot ATIE.');
    console.log('⚠️  Verifique manualmente os rótulos de associação (Cliente Final / Gerenciadora).');
    console.log('⚠️  O stage foi mapeado automaticamente — confirme se está correto.');

  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    process.exit(1);
  }
})();
