const HUBSPOT_BASE = 'https://api.hubapi.com';
const ASSOC_CHUNK = 100;
const COMPANY_CHUNK = 100;
const MAX_DEALS = 2000;

// Rótulos reais do HubSpot da ATIE (confirmados 05/07/2026)
function roleFromLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase().trim();
  if (l === 'cliente final' || l === 'cliente') return 'cliente';
  if (l === 'broker' || l.includes('corretor')) return 'broker';
  if (l.includes('edificio avaliado') || l.includes('edifício do deal') || l.includes('edificio do deal')) return 'edificio';
  if (l === 'gerenciadora') return 'gerenciadora';
  if (l === 'escritório parceiro' || l === 'escritorio parceiro' || l.includes('parceiro')) return 'parceiro';
  if (l === 'concorrente') return 'concorrente';
  if (l.includes('indicou') || l === 'indicador') return 'indicador';
  if (l === 'pm do cliente' || l === 'pm') return 'pm';
  if (l.includes('dono') || l.includes('incorporador')) return 'dono';
  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, opts);
    if (r.status === 429) {
      const wait = (i + 1) * 1000;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    return r;
  }
  throw new Error('Rate limit persistente após retries');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado' });

  const h = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const DEAL_PROPS = ['dealname', 'dealstage', 'pipeline', 'hs_lastmodifieddate'];

  try {
    // 1. Busca deals do pipeline Projeto (899974520)
    let allDeals = [];
    let after = undefined;
    let totalHubSpot = null;

    do {
      const body = {
        filterGroups: [{
          filters: [{ propertyName: 'pipeline', operator: 'EQ', value: '899974520' }],
        }],
        properties: DEAL_PROPS,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      };

      const r = await fetchWithRetry(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST', headers: h, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Deals Search error: ${r.status} ${await r.text()}`);
      const data = await r.json();
      if (totalHubSpot === null) totalHubSpot = data.total ?? null;
      allDeals = allDeals.concat(data.results || []);
      after = data.paging?.next?.after;
      if (allDeals.length >= MAX_DEALS) break;
    } while (after);

    allDeals = allDeals.slice(0, MAX_DEALS);

    if (allDeals.length === 0) {
      return res.json({ total: 0, deals: [], _debug: { totalHubSpot, msg: 'Nenhum deal encontrado' } });
    }

    // 2. Associações deal→company em chunks (com rótulos v4)
    const dealToCompanies = {};
    const companyIdSet = new Set();

    for (const batch of chunk(allDeals.map(d => ({ id: d.id })), ASSOC_CHUNK)) {
      const r = await fetchWithRetry(
        `${HUBSPOT_BASE}/crm/v4/associations/deals/companies/batch/read`,
        { method: 'POST', headers: h, body: JSON.stringify({ inputs: batch }) }
      );
      if (!r.ok) { console.error('Assoc error', r.status); continue; }
      const data = await r.json();
      (data.results || []).forEach(item => {
        const dealId = item.from.id;
        dealToCompanies[dealId] = [];
        (item.to || []).forEach(t => {
          const label = t.associationTypes?.[0]?.label || null;
          dealToCompanies[dealId].push({ companyId: String(t.toObjectId), label });
          companyIdSet.add(String(t.toObjectId));
        });
      });
    }

    // 3. Nomes das companies em chunks
    const companiesMap = {};
    for (const batch of chunk([...companyIdSet], COMPANY_CHUNK)) {
      const r = await fetchWithRetry(`${HUBSPOT_BASE}/crm/v3/objects/companies/batch/read`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: batch.map(id => ({ id })), properties: ['name'] }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      (data.results || []).forEach(c => {
        companiesMap[c.id] = c.properties?.name || `Company ${c.id}`;
      });
    }

    // 4. Normaliza para o frontend
    const deals = allDeals.map(d => {
      const p = d.properties || {};
      const actors = {};
      (dealToCompanies[d.id] || []).forEach(({ companyId, label }) => {
        const role = roleFromLabel(label);
        const name = companiesMap[companyId] || companyId;
        if (role && !actors[role]) actors[role] = name; // primeiro ganha
      });

      return {
        id: d.id,
        nome: p.dealname || `Deal ${d.id}`,
        stage: p.dealstage || null,
        nucleo: null, // confirmar propriedade com Lucca
        // edificio vem da associação "Edificio avaliado em"
        edificio: actors.edificio || null,
        andar: null,
        ...actors,
        _associacoes: (dealToCompanies[d.id] || []).map(a => ({
          empresa: companiesMap[a.companyId] || a.companyId,
          rotulo: a.label,
        })),
      };
    });

    const comEdificio  = deals.filter(d => d.edificio).length;
    const comBroker    = deals.filter(d => d.broker).length;
    const comCliente   = deals.filter(d => d.cliente).length;
    const comGerenc    = deals.filter(d => d.gerenciadora).length;

    return res.json({
      total: deals.length,
      deals,
      _debug: {
        totalHubSpot,
        totalBuscados: allDeals.length,
        comEdificio,
        comBroker,
        comCliente,
        comGerenciadora: comGerenc,
        aviso: comEdificio === 0 ? 'Nenhum deal tem o rótulo "Edificio avaliado em" — confirmar com Lucca' : null,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
