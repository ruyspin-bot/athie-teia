/**
 * Cria o Custom Object "Conjunto" no HubSpot ATIE
 * e estabelece associações com Andar e Deal.
 *
 * Rodar via: vercel env run -- node scripts/create-conjunto.mjs
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
const ANDAR_TYPE_ID = process.env.HUBSPOT_OBJECT_ANDAR || '2-65605360';
const BASE = 'https://api.hubapi.com';

if (!TOKEN) { console.error('HUBSPOT_TOKEN não encontrado.'); process.exit(1); }

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function hs(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || JSON.stringify(json);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

/* ── 1. Verificar se já existe ─────────────────────────────────────── */
console.log('\n[1] Verificando schemas existentes…');
const schemas = await hs('GET', '/crm/v3/schemas');
const existing = (schemas.results || []).find(
  s => s.name === 'p_conjunto' || s.labels?.singular?.toLowerCase() === 'conjunto'
);

if (existing) {
  console.log(`✅ Conjunto já existe! objectTypeId = ${existing.objectTypeId}`);
  console.log('   name:', existing.name);
  console.log('   props:', existing.properties?.map(p => p.name).join(', '));
  process.exit(0);
}

/* ── 2. Criar o schema ─────────────────────────────────────────────── */
console.log('\n[2] Criando schema Conjunto…');
const schema = await hs('POST', '/crm/v3/schemas', {
  name: 'p_conjunto',
  labels: { singular: 'Conjunto', plural: 'Conjuntos' },
  primaryDisplayProperty: 'nome_do_conjunto',
  searchableProperties: ['nome_do_conjunto', 'numero_do_conjunto'],
  properties: [
    { name: 'nome_do_conjunto',    label: 'Nome do Conjunto',      type: 'string', fieldType: 'text'   },
    { name: 'numero_do_conjunto',  label: 'Número do Conjunto',    type: 'string', fieldType: 'text'   },
    { name: 'area_privativa_m2',   label: 'Área Privativa (m²)',   type: 'number', fieldType: 'number' },
    { name: 'cnpj_proprietario',   label: 'CNPJ do Proprietário',  type: 'string', fieldType: 'text'   },
    { name: 'cnpj_locatario',      label: 'CNPJ do Locatário',     type: 'string', fieldType: 'text'   },
    { name: 'andar_nome',          label: 'Andar (referência)',     type: 'string', fieldType: 'text'   },
  ],
  associatedObjects: ['DEAL'],
});

const CONJUNTO_TYPE_ID = schema.objectTypeId;
console.log(`✅ Conjunto criado! objectTypeId = ${CONJUNTO_TYPE_ID}`);

/* ── 3. Criar associação Conjunto ↔ Andar ──────────────────────────── */
console.log(`\n[3] Criando associação Conjunto ↔ Andar (${ANDAR_TYPE_ID})…`);
try {
  await hs('POST', `/crm/v4/associations/${CONJUNTO_TYPE_ID}/${ANDAR_TYPE_ID}/labels`, {
    label: 'Conjunto de Andar',
    name: 'conjunto_de_andar',
  });
  console.log('✅ Associação Conjunto → Andar criada.');
} catch (e) {
  console.warn('⚠️  Associação Conjunto→Andar:', e.message);
}

try {
  await hs('POST', `/crm/v4/associations/${ANDAR_TYPE_ID}/${CONJUNTO_TYPE_ID}/labels`, {
    label: 'Andares com Conjuntos',
    name: 'andar_com_conjuntos',
  });
  console.log('✅ Associação Andar → Conjunto criada.');
} catch (e) {
  console.warn('⚠️  Associação Andar→Conjunto:', e.message);
}

/* ── 4. Criar associação Conjunto ↔ Company (proprietário) ─────────── */
console.log('\n[4] Criando associação Conjunto ↔ Company…');
try {
  await hs('POST', `/crm/v4/associations/${CONJUNTO_TYPE_ID}/COMPANY/labels`, {
    label: 'Proprietário do Conjunto',
    name: 'proprietario_do_conjunto',
  });
  console.log('✅ Associação Conjunto → Company (Proprietário) criada.');
} catch (e) {
  console.warn('⚠️  Associação Conjunto→Company:', e.message);
}

/* ── 5. Resumo ─────────────────────────────────────────────────────── */
console.log('\n══════════════════════════════════════════');
console.log('RESUMO — salvar no CLAUDE.md / memory:');
console.log(`  Conjunto objectTypeId : ${CONJUNTO_TYPE_ID}`);
console.log(`  HUBSPOT_OBJECT_CONJUNTO=${CONJUNTO_TYPE_ID}`);
console.log('══════════════════════════════════════════\n');
