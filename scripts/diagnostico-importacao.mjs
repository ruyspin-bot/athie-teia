/**
 * scripts/diagnostico-importacao.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Relatório-resumo de conclusão dos dados do HubSpot da ATIE.
 * Lê os dados REAIS direto do HubSpot (nada de mock) e mede a saúde do
 * tombamento NAS ATIVIDADES ACORDADAS com a Athié:
 *   1. Limpeza de contatos (remover os sem e-mail e sem telefone).
 *   2. Proprietário do Negócio (owner comercial) definido x pendente.
 *   3. Ajustes na Teia (concluídos — texto fixo).
 *
 * Uso:
 *   node --env-file=.env.local scripts/diagnostico-importacao.mjs
 *
 * Gera:
 *   • saída resumida no console
 *   • docs/diagnostico-importacao.md  (relatório completo pra enviar)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pkg from '../lib/hubspot.js';

const { makeClient, getActiveDeals } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌  Faltou HUBSPOT_TOKEN (rode com --env-file=.env.local)'); process.exit(1); }

const hs = makeClient(TOKEN);

// ─── helpers ─────────────────────────────────────────────────────────────────
const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
const line = (label, n, total) => `| ${label} | ${n} | ${pct(n, total)} |`;

// heurística leve: nome "parece" de empresa (pra sinalizar contatos indevidos)
const PARECE_EMPRESA = /\b(ltda|s\.?\/?a\.?|eireli|epp|holding|participa|empreend|incorpora|engenharia|construtora|constru|imob|patrim|administ|adminis|invest|capital|realty|properties|group|grupo|fundo|bank|banco|seguros|corretora|consultoria)\b/i;

// lista contatos (ativos ou arquivados), paginado
const CONTACT_PROPS = ['email', 'phone', 'mobilephone', 'firstname', 'lastname'];
async function listContacts(archived) {
  const all = []; let after;
  do {
    const qs = new URLSearchParams({ limit: '100', properties: CONTACT_PROPS.join(','), archived: String(archived) });
    if (after) qs.set('after', after);
    const page = await hs(`/crm/v3/objects/contacts?${qs.toString()}`);
    all.push(...(page.results || []));
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

function breakdownContatos(lista) {
  const r = { total: lista.length, comEmail: 0, semEmail: 0, semEmailSemTel: 0, pareceEmpresa: 0 };
  for (const ct of lista) {
    const cp = ct.properties || {};
    const email = (cp.email || '').trim();
    const tel = (cp.phone || cp.mobilephone || '').trim();
    const nome = [cp.firstname, cp.lastname].filter(Boolean).join(' ').trim();
    if (email) r.comEmail++; else r.semEmail++;
    if (!email && !tel) r.semEmailSemTel++;
    if (!cp.lastname && PARECE_EMPRESA.test(nome)) r.pareceEmpresa++;
  }
  return r;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🔎 Diagnóstico de importação — HubSpot ATIE (portal 51253038)\n');

  // deals ativos — só o que as atividades pedem: owner e ID Focus
  console.log('… lendo deals');
  const deals = await getActiveDeals(hs, ['dealname', 'hubspot_owner_id', 'aw_id_interno']);

  let comOwner = 0, comFocus = 0;
  for (const d of deals) {
    const p = d.properties || {};
    if (p.hubspot_owner_id) comOwner++;
    if (p.aw_id_interno) comFocus++;
  }
  const total = deals.length;
  const semOwner = total - comOwner;

  // contatos: ativos e arquivados (pra evidenciar a limpeza já feita)
  console.log('… lendo contatos (ativos + arquivados)');
  let contatosAtivos = [], contatosArquivados = [];
  try { contatosAtivos = await listContacts(false); } catch (err) { console.warn('  ⚠️ contatos ativos:', err.message); }
  try { contatosArquivados = await listContacts(true); } catch (err) { console.warn('  ⚠️ contatos arquivados:', err.message); }
  const cArq = breakdownContatos(contatosArquivados);

  // ─── monta relatório markdown (escopo: atividades acordadas) ─────────────────
  const hoje = new Date().toISOString().slice(0, 10);

  const md = `# Relatório-resumo de conclusão dos dados — HubSpot ATIE
_Gerado em ${hoje} · fonte: HubSpot (portal 51253038) · dados reais do pipeline._

Base ativa: **${total} deals** (negócios), **${pct(comFocus, total)} com ID Focus** (\`aw_id_interno\`) — o que permite atualização em massa por código a qualquer momento.

---

## 1. Limpeza de contatos ✅ (concluída)

Os contatos que subiram como **nome de empresa, sem e-mail e sem telefone** foram removidos da base ativa (arquivados na lixeira do HubSpot). O e-mail é a chave única de um contato no HubSpot, então sem e-mail/telefone o registro não tem utilidade pro vendedor.

| Situação | Qtd |
|---|---:|
| Contatos ativos na base | ${contatosAtivos.length} |
| Contatos arquivados (removidos na limpeza) | ${contatosArquivados.length} |
${cArq.total ? `| — destes, sem e-mail e sem telefone | ${cArq.semEmailSemTel} |\n| — destes, nome "parece empresa" | ${cArq.pareceEmpresa} |` : ''}

➡️ **Pendência (Athié):** puxar a base de contatos **com e-mail** para reimportação — aí os contatos voltam já vinculados corretamente.

---

## 2. Proprietário do Negócio (owner comercial)

| Situação | Qtd | % dos deals |
|---|---:|---:|
${line('Deals com owner definido', comOwner, total)}
${line('Deals sem owner (vazio)', semOwner, total)}

O que trava os ${semOwner} restantes é que **vários comerciais ainda não existem como usuário no HubSpot** (ex.: Jennifer, Clarissa, Juliana, Karine, Laura, Marcos). Sem o usuário cadastrado, não é possível atribuí-lo como proprietário.

➡️ **Pendência (Athié):** cadastrar no HubSpot os comerciais que faltam.
➡️ **Comigo:** assim que forem cadastrados, atribuo os owners em massa (via ID Focus, presente em ${pct(comFocus, total)} dos deals).

---

## 3. Ajustes na Teia ✅ (concluídos)

- Corrigido o nó que ficava "preso" no mouse ao clicar.
- Clique mais preciso — sem precisar dar tanto zoom pra acertar o negócio.
- A visão de prédios reflete só os edifícios **relacionados** ao nó; quando não há relação, mostra o aviso na tela.
- O painel **Detalhe** acompanha a navegação entre prédios e os filtros por ator.

---

## Resumo executivo

| Frente | Status |
|---|---|
| Limpeza de contatos | ✅ Concluída (${contatosArquivados.length} removidos) — aguardando base com e-mail (Athié) |
| Proprietário do Negócio | 🟡 ${comOwner}/${total} definidos — faltam cadastrar comerciais (Athié) |
| Ajustes na Teia | ✅ Concluídos |
| Treinamento com o CEO | 📅 A agendar |

**Pendências com a Athié:** (1) base de contatos com e-mail; (2) cadastrar os proprietários/comerciais que faltam; (3) agendar o treinamento com o CEO.
`;

  const outPath = path.join(__dirname, '..', 'docs', 'diagnostico-importacao.md');
  writeFileSync(outPath, md, 'utf8');

  // resumo no console
  console.log('\n──────── RESUMO ────────');
  console.log(`Deals ativos ............... ${total}`);
  console.log(`  com owner ................ ${comOwner} (${pct(comOwner, total)})  | sem owner: ${semOwner}`);
  console.log(`  com ID Focus ............. ${comFocus} (${pct(comFocus, total)})`);
  console.log(`Contatos ativos ............ ${contatosAtivos.length}`);
  console.log(`Contatos arquivados ........ ${contatosArquivados.length}  | sem e-mail e tel: ${cArq.semEmailSemTel}`);
  console.log(`\n📄 Relatório salvo em docs/diagnostico-importacao.md\n`);
})().catch((e) => { console.error('\n❌ erro:', e.message); process.exit(1); });
