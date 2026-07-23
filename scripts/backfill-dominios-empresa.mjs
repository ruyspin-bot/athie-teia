/**
 * scripts/backfill-dominios-empresa.mjs
 * ------------------------------------------------------------------
 * Preenche o campo `domain` das empresas (Company) que estão sem ele,
 * a partir do domínio PREDOMINANTE dos e-mails dos contatos associados
 * (fallback: domínio extraído do `website`). Habilita a auto-associação
 * contato→empresa por domínio (api/associar-contato-empresa.js).
 *
 * - Só preenche empresas com `domain` vazio (não sobrescreve).
 * - Ignora domínios genéricos (gmail, outlook, etc.).
 * - Idempotente. Rode com --dry-run primeiro.
 *
 * Uso: node --env-file=.env.local scripts/backfill-dominios-empresa.mjs [--dry-run]
 * ------------------------------------------------------------------
 */
const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) { console.error('❌ Faltou HUBSPOT_TOKEN'); process.exit(1); }
const DRY = process.argv.includes('--dry-run');
const BASE = 'https://api.hubapi.com';

async function hs(p, o = {}, _r = 0) {
  const r = await fetch(BASE + p, { ...o, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(o.headers || {}) } });
  if (r.status === 429 && _r < 6) { await sleep(2 ** _r * 500); return hs(p, o, _r + 1); }
  if (!r.ok) throw new Error(`${o.method || 'GET'} ${p} -> ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return r.status === 204 ? null : r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const GENERICOS = new Set(['gmail.com','googlemail.com','hotmail.com','hotmail.com.br','outlook.com','outlook.com.br','live.com','msn.com','yahoo.com','yahoo.com.br','icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me','terra.com.br','uol.com.br','bol.com.br','ig.com.br','globo.com','globomail.com','zipmail.com.br','r7.com']);
const domDeEmail = (e) => { const m = String(e || '').toLowerCase().match(/@([^@\s]+)$/); return m ? m[1] : null; };
const domDeSite = (w) => { if (!w) return null; const m = String(w).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').match(/^([^\/\s?#]+)/); return m ? m[1] : null; };

// Guarda anti-contaminação: contatos de broker/gerenciadora poluem o domínio
// (ex.: contato da CBRE associado ao "Bank of America"). Só aceita o domínio
// se ele se relacionar ao NOME da empresa (token do nome aparece no domínio).
const STOP = new Set(['de','da','do','das','dos','e','the','of','and','group','grupo','brasil','brazil','sa','ltda','inc','corp','co','holding','holdings','participacoes','part','company','bank','banco','servicos','services','tech','group']);
const tokens = (nome) => String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
const nomeCasaDominio = (nome, dominio) => {
  const d = String(dominio || '').toLowerCase();
  return tokens(nome).some((t) => d.includes(t));
};

async function listAll(objectType, props) {
  const all = []; let after;
  do { const qs = new URLSearchParams({ limit: '100', properties: props.join(',') }); if (after) qs.set('after', after);
    const pg = await hs(`/crm/v3/objects/${objectType}?${qs}`); all.push(...pg.results); after = pg.paging?.next?.after; } while (after);
  return all;
}
async function assoc(from, to, ids) {
  const out = {}; for (const b of chunk(ids, 100)) { if (!b.length) continue;
    const d = await hs(`/crm/v4/associations/${from}/${to}/batch/read`, { method: 'POST', body: JSON.stringify({ inputs: b.map((id) => ({ id })) }) });
    (d.results || []).forEach((r) => { out[r.from.id] = (r.to || []).map((t) => String(t.toObjectId)); }); }
  return out;
}

(async () => {
  console.log(`\n🌐 Backfill de domínios — ${DRY ? '💡 DRY-RUN' : '🚀 EXECUÇÃO REAL'}`);
  const companies = await listAll('companies', ['name', 'domain', 'website']);
  const semDominio = companies.filter((c) => !c.properties.domain);
  console.log(`   empresas: ${companies.length} | sem domain: ${semDominio.length}`);

  // contatos por empresa (só das sem domínio)
  const compContacts = await assoc('companies', 'contacts', semDominio.map((c) => c.id));
  const allContactIds = [...new Set(Object.values(compContacts).flat())];
  console.log(`   contatos associados a essas empresas: ${allContactIds.length}`);

  // e-mails dos contatos
  const emailById = {};
  for (const b of chunk(allContactIds, 100)) {
    if (!b.length) continue;
    const d = await hs('/crm/v3/objects/contacts/batch/read', { method: 'POST', body: JSON.stringify({ properties: ['email'], inputs: b.map((id) => ({ id })) }) });
    (d.results || []).forEach((o) => { emailById[o.id] = o.properties.email; });
  }

  const updates = []; const relatorio = [];
  for (const c of semDominio) {
    // 1. domínio predominante dos contatos (não-genérico)
    const cont = { };
    for (const cid of (compContacts[c.id] || [])) { const d = domDeEmail(emailById[cid]); if (d && !GENERICOS.has(d)) cont[d] = (cont[d] || 0) + 1; }
    let escolhido = Object.entries(cont).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    let origem = escolhido ? 'contatos' : null;
    // guarda: domínio de contato só vale se casar com o nome da empresa
    if (escolhido && !nomeCasaDominio(c.properties.name, escolhido)) { escolhido = null; origem = null; }
    // 2. fallback: website (fonte própria da empresa, confiável)
    if (!escolhido) { const d = domDeSite(c.properties.website); if (d && !GENERICOS.has(d)) { escolhido = d; origem = 'website'; } }
    if (!escolhido) continue;
    updates.push({ id: c.id, properties: { domain: escolhido } });
    relatorio.push(`${c.properties.name} → ${escolhido} (${origem})`);
  }

  console.log(`\n   domínios a preencher: ${updates.length}`);
  relatorio.slice(0, 40).forEach((l) => console.log('   • ' + l));
  if (relatorio.length > 40) console.log(`   … +${relatorio.length - 40}`);

  if (DRY) { console.log('\n(dry-run) nada gravado.'); return; }
  let done = 0;
  for (const b of chunk(updates, 100)) {
    if (!b.length) continue;
    await hs('/crm/v3/objects/companies/batch/update', { method: 'POST', body: JSON.stringify({ inputs: b }) });
    done += b.length; console.log(`   ✅ atualizadas ${done}/${updates.length}`); await sleep(200);
  }
  console.log('\n✓ Concluído.');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
