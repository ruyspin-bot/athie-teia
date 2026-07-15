/**
 * scripts/criar-propriedades.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Cria todas as propriedades customizadas faltantes no portal ATIE (51253038).
 * Idempotente: ignora propriedades que já existem.
 *
 * Uso:
 *   HUBSPOT_TOKEN=pat-na1-xxx node scripts/criar-propriedades.mjs
 *   # ou, com .env.local preenchido:
 *   node --env-file=.env.local scripts/criar-propriedades.mjs
 *
 * Flags:
 *   --dry-run   Lista o que seria criado sem chamar a API
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'fs';

const TOKEN = process.env.HUBSPOT_TOKEN;
const DRY   = process.argv.includes('--dry-run');

if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN'); process.exit(1); }

const BASE = 'https://api.hubapi.com';

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
    throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Definição das propriedades a criar ──────────────────────────────────────
//
// Formato: { objectType, name, label, type, fieldType, groupName, description, options? }
//   objectType  : 'deals' | 'companies' | 'contacts' | 'p51253038_edificios' | 'p51253038_andares'
//   type        : 'string' | 'number' | 'date' | 'datetime' | 'bool' | 'enumeration'
//   fieldType   : 'text' | 'number' | 'date' | 'booleancheckbox' | 'select' | 'textarea'
//   groupName   : grupo de propriedades (deve existir no portal)

const PROPRIEDADES = [

  // ── Companies ───────────────────────────────────────────────────────────────
  {
    objectType: 'companies',
    name: 'aw_id_focus',
    label: 'ID Focus',
    type: 'string',
    fieldType: 'text',
    groupName: 'companyinformation',
    description: 'ID interno da empresa no Focus CRM (IdGrupoComercial, IdGerenciadora, etc.). Chave de correlação para sync bidirecional.',
  },

  // ── Deals — campos do Focus ainda não criados ────────────────────────────────
  {
    objectType: 'deals',
    name: 'aw_chances_ganhar',
    label: 'Chances de Ganhar (Focus)',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'ChancesGanhar do Focus. Ex: "70% a 90%".',
  },
  {
    objectType: 'deals',
    name: 'aw_frequencia_comercial',
    label: 'Frequência Comercial',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'FrequenciaComercial do Focus. Ex: "conta 1M (mensal)".',
  },
  {
    objectType: 'deals',
    name: 'aw_id_agrupador',
    label: 'ID Agrupador (Focus)',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'IdAgrupador do Focus — agrupa projetos pai/filho de uma mesma oportunidade.',
  },
  {
    objectType: 'deals',
    name: 'aw_conta_negocio',
    label: 'Conta Negócio (Focus)',
    type: 'string',
    fieldType: 'text',
    groupName: 'dealinformation',
    description: 'ContaNegocio do Focus.',
  },

  // ── Andares — chave de correlação com Focus ──────────────────────────────────
  {
    objectType: 'p51253038_andares',
    name: 'aw_id_focus',
    label: 'ID Focus (Pavimento)',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_andares_information',
    description: 'IdEdificioPavimento do Focus. Chave de correlação para sync.',
  },

  // ── Edifícios — torre específica + CRETool ───────────────────────────────────
  {
    objectType: 'p51253038_edificios',
    name: 'aw_id_edificio_focus',
    label: 'ID Edifício (Torre) Focus',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'IdEdificio do Focus — identifica a torre específica dentro de um condomínio.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'nome_torre',
    label: 'Nome da Torre',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'NomeEdificio do Focus — nome da torre (ex: "Torre Norte"). Complementa nome_do_edificio que guarda o condomínio.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'aw_id_cretool',
    label: 'ID CRETool Buildings',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'building_id da plataforma CRETool Buildings. Chave para sync de dados de mercado.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'classe_edificio',
    label: 'Classe do Edifício',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'Classe do ativo imobiliário (ex: "Classe A", "Classe B"). Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'perfil_edificio',
    label: 'Perfil do Edifício',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'Perfil de uso do edifício (ex: "Corporate", "Mixed-use"). Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'endereco',
    label: 'Endereço',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'Logradouro + número do edifício. Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'cep',
    label: 'CEP',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'CEP do edifício. Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'regiao',
    label: 'Região',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'Região do imóvel (ex: "Berrini", "Faria Lima"). Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'microrregiao',
    label: 'Microrregião',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_edificios_information',
    description: 'Microrregião do imóvel (ex: "Marginal - Brooklin Novo"). Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'latitude',
    label: 'Latitude',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_edificios_information',
    description: 'Coordenada geográfica — latitude. Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_edificios',
    name: 'longitude',
    label: 'Longitude',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_edificios_information',
    description: 'Coordenada geográfica — longitude. Fonte: CRETool.',
  },

  // ── Andares — dados de área e preço (CRETool) ────────────────────────────────
  {
    objectType: 'p51253038_andares',
    name: 'aw_id_cretool_unit',
    label: 'ID CRETool (Unidade)',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_andares_information',
    description: 'unit_id da CRETool Buildings — identifica a unidade andar+conjunto.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'area_locavel_m2',
    label: 'Área Locável (m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Área locável em m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'area_privativa_m2',
    label: 'Área Privativa (m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Área privativa em m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'area_boma_m2',
    label: 'Área BOMA (m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Área BOMA em m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'area_construida_m2',
    label: 'Área Construída (m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Área construída total em m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'possui_terraco',
    label: 'Possui Terraço',
    type: 'bool',
    fieldType: 'booleancheckbox',
    groupName: 'p51253038_andares_information',
    description: 'Indica se o andar/conjunto possui terraço. Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'preco_locacao_m2',
    label: 'Preço Locação (R$/m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Preço pedido de locação por m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'condominio_m2',
    label: 'Condomínio (R$/m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Valor do condomínio por m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'iptu_m2',
    label: 'IPTU (R$/m²)',
    type: 'number',
    fieldType: 'number',
    groupName: 'p51253038_andares_information',
    description: 'Valor do IPTU por m². Fonte: CRETool.',
  },
  {
    objectType: 'p51253038_andares',
    name: 'disponibilidade',
    label: 'Disponibilidade',
    type: 'string',
    fieldType: 'text',
    groupName: 'p51253038_andares_information',
    description: 'Texto de disponibilidade do andar (ex: "7°, 8°, 11° (parte)"). Fonte: CRETool.',
  },
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🏗️  Criar propriedades HubSpot — portal ATIE (51253038)`);
  console.log(`   Modo: ${DRY ? '💡 DRY-RUN (nada será criado)' : '🚀 EXECUÇÃO REAL'}\n`);

  const results = { criadas: [], jaExistiam: [], erros: [] };

  for (const prop of PROPRIEDADES) {
    const { objectType, name, ...body } = prop;
    const label = `[${objectType}] ${name}`;

    if (DRY) {
      console.log(`  📋 ${label}`);
      results.criadas.push(label);
      continue;
    }

    // Verificar se já existe
    try {
      await hs(`/crm/v3/properties/${objectType}/${name}`);
      console.log(`  ✓  ${label} — já existe`);
      results.jaExistiam.push(label);
      continue;
    } catch (_) {
      // 404 = não existe → criar
    }

    // Criar propriedade
    try {
      await hs(`/crm/v3/properties/${objectType}`, {
        method: 'POST',
        body: JSON.stringify({ name, ...body }),
      });
      console.log(`  ✅ ${label} — criada`);
      results.criadas.push(label);
    } catch (err) {
      console.error(`  ❌ ${label} — ERRO: ${err.message}`);
      results.erros.push({ label, erro: err.message });
    }
  }

  console.log('\n─────────────────────────────────────');
  console.log(`  ✅ Criadas    : ${results.criadas.length}`);
  console.log(`  ✓  Já existiam: ${results.jaExistiam.length}`);
  console.log(`  ❌ Erros      : ${results.erros.length}`);

  if (results.erros.length) {
    console.log('\nErros:');
    results.erros.forEach(e => console.log(`  • ${e.label}: ${e.erro}`));
  }

  console.log('\n✓ Concluído.\n');
})();
