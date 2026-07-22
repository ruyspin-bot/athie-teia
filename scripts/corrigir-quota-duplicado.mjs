/**
 * scripts/corrigir-quota-duplicado.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Sana o caso "Quota Corporate duplicado" detectado na auditoria:
 *
 *   - Edifício oficial  : 58797958039
 *   - Edifício duplicado: 58881378138 (criado em 17/07/2026, deve ser arquivado)
 *
 * Passos executados:
 *   1. Move os 10 andares do duplicado → reassocia ao edifício oficial
 *   2. Move os conjuntos desses andares → atualiza associação Andar pai
 *   3. Arquiva os 10 andares do edifício duplicado (após mover conjuntos)
 *   4. Arquiva o edifício duplicado 58881378138
 *
 * NOTA: A associação do condomínio correto ao edifício oficial (58797958039)
 *       precisa ser feita manualmente no HubSpot — o condomínio correto
 *       (Rua Henri Dunant, 792) pode não existir ainda como registro.
 *
 * Uso:
 *   node --env-file=.env.local scripts/corrigir-quota-duplicado.mjs --dry-run
 *   node --env-file=.env.local scripts/corrigir-quota-duplicado.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  HUBSPOT_TOKEN não encontrado'); process.exit(1); }

const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';
const OBJ_ANDAR    = process.env.HUBSPOT_OBJECT_ANDAR    || 'p51253038_andares';
const OBJ_CONJUNTO = process.env.HUBSPOT_OBJECT_CONJUNTO || 'p51253038_conjuntos';

const ED_OFICIAL    = '58797958039';
const ED_DUPLICADO  = '58881378138';

const DRY = process.argv.includes('--dry-run');
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

async function getAssociations(fromType, fromId, toType) {
  const res = await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}`);
  return (res.results || []).map(r => String(r.toObjectId));
}

async function removeAssoc(fromType, fromId, toType, toId) {
  await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, { method: 'DELETE' });
}

// typeId 115 = Conjunto→Andar (USER_DEFINED)
// typeId 95  = Andar→Edifício "Pertence a" (USER_DEFINED)
const ASSOC_TYPE = {
  [`${OBJ_CONJUNTO}|${OBJ_ANDAR}`]: 115,
  [`${OBJ_ANDAR}|${OBJ_EDIFICIO}`]: 95,
};

async function createAssoc(fromType, fromId, toType, toId) {
  const typeId = ASSOC_TYPE[`${fromType}|${toType}`];
  if (!typeId) throw new Error(`Tipo de associação desconhecido: ${fromType} → ${toType}`);
  await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, {
    method: 'PUT',
    body: JSON.stringify([{ associationCategory: 'USER_DEFINED', associationTypeId: typeId }]),
  });
}

(async () => {
  console.log('\n🏢 Corrigir Quota Corporate Duplicado — portal ATIE (51253038)');
  console.log(`   Modo      : ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  console.log(`   Oficial   : ${ED_OFICIAL}`);
  console.log(`   Duplicado : ${ED_DUPLICADO}\n`);

  // Busca andares do edifício duplicado
  const andarsDuplicado = await getAssociations(OBJ_EDIFICIO, ED_DUPLICADO, OBJ_ANDAR);
  console.log(`   Andares no duplicado : ${andarsDuplicado.length}`);

  // Busca andares do edifício oficial (para verificar sobreposição de números)
  const andarsOficial = await getAssociations(OBJ_EDIFICIO, ED_OFICIAL, OBJ_ANDAR);
  console.log(`   Andares no oficial   : ${andarsOficial.length}`);

  // Busca numero_do_andar de todos os andares envolvidos
  const todosAndares = [...new Set([...andarsDuplicado, ...andarsOficial])];
  const andarNumRes = await hs('/crm/v3/objects/' + OBJ_ANDAR + '/batch/read', {
    method: 'POST',
    body: JSON.stringify({ properties: ['numero_do_andar', 'nome_do_andar'], inputs: todosAndares.map(id => ({ id })) }),
  });
  const andarInfo = {};
  for (const o of (andarNumRes.results || [])) {
    andarInfo[o.id] = {
      num: parseInt(o.properties.numero_do_andar || '0', 10),
      nome: o.properties.nome_do_andar || '',
    };
  }

  // Mapa oficial: floorNum → andarId
  const mapaOficial = {};
  for (const aid of andarsOficial) {
    const num = andarInfo[aid]?.num;
    if (num !== undefined) mapaOficial[num] = aid;
  }

  console.log('\n   Andares no edifício duplicado:');
  for (const aid of andarsDuplicado) {
    const info = andarInfo[aid] || {};
    const oficial = mapaOficial[info.num];
    console.log(`     ${aid} — ${info.nome} (piso ${info.num}) → oficial: ${oficial || 'não encontrado'}`);
  }

  if (DRY) {
    console.log('\n   [DRY-RUN] Operações que seriam executadas:');
    for (const andarDupId of andarsDuplicado) {
      const num = andarInfo[andarDupId]?.num;
      const andarOficialId = mapaOficial[num];
      if (!andarOficialId) {
        console.log(`   ⚠️  Piso ${num}: sem correspondência no oficial — precisaria criar`);
        continue;
      }
      console.log(`   📋 Piso ${num}: mover conjuntos de ${andarDupId} → ${andarOficialId}`);
      console.log(`   📋 Arquivar andar duplicado ${andarDupId}`);
    }
    console.log(`   📋 Arquivar edifício duplicado ${ED_DUPLICADO}`);
    console.log('\n   ⚠️  Associar condomínio ao edifício oficial precisa ser feito manualmente.');
    return;
  }

  let totalConjMovidos = 0;
  const stats = { andares: 0, conjuntos: 0, erros: 0 };

  for (const andarDupId of andarsDuplicado) {
    const num = andarInfo[andarDupId]?.num;
    const andarOficialId = mapaOficial[num];

    if (!andarOficialId) {
      console.warn(`  ⚠️  Piso ${num}: sem correspondência no edifício oficial — pulando`);
      stats.erros++;
      continue;
    }

    // Busca conjuntos deste andar duplicado
    const conjuntosIds = await getAssociations(OBJ_ANDAR, andarDupId, OBJ_CONJUNTO);
    console.log(`\n  🔄 Piso ${num}: ${conjuntosIds.length} conjuntos para mover`);

    for (const cjId of conjuntosIds) {
      try {
        // Remove associação com andar duplicado
        await removeAssoc(OBJ_CONJUNTO, cjId, OBJ_ANDAR, andarDupId);
        await sleep(80);
        // Cria associação com andar oficial
        await createAssoc(OBJ_CONJUNTO, cjId, OBJ_ANDAR, andarOficialId);
        await sleep(80);
        stats.conjuntos++;
      } catch (err) {
        console.error(`    ❌ conjunto ${cjId}: ${err.message}`);
        stats.erros++;
      }
    }

    // Remove associação Andar → Edifício duplicado
    try {
      await removeAssoc(OBJ_ANDAR, andarDupId, OBJ_EDIFICIO, ED_DUPLICADO);
      await sleep(80);
      // Associa ao edifício oficial (caso não esteja já)
      await createAssoc(OBJ_ANDAR, andarDupId, OBJ_EDIFICIO, ED_OFICIAL);
      await sleep(80);
      stats.andares++;
      console.log(`  ✅ Andar ${andarDupId} (piso ${num}) movido para o edifício oficial`);
    } catch (err) {
      console.error(`  ❌ mover andar ${andarDupId}: ${err.message}`);
      stats.erros++;
    }
  }

  // Arquiva o edifício duplicado
  try {
    await hs(`/crm/v3/objects/${OBJ_EDIFICIO}/${ED_DUPLICADO}`, { method: 'DELETE' });
    console.log(`\n  🗑️  Edifício duplicado ${ED_DUPLICADO} arquivado`);
  } catch (err) {
    console.error(`  ❌ Arquivar edifício: ${err.message}`);
    stats.erros++;
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  ✅ Andares movidos     : ${stats.andares}`);
  console.log(`  ✅ Conjuntos movidos   : ${stats.conjuntos}`);
  console.log(`  ❌ Erros               : ${stats.erros}`);
  console.log('\n  ⚠️  Lembrete: associar o condomínio correto ao edifício oficial');
  console.log(`     manualmente no HubSpot (edifício ${ED_OFICIAL}).\n`);
})();
