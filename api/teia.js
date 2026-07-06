const HUBSPOT_BASE = 'https://api.hubapi.com';
const ASSOC_CHUNK = 100;
const COMPANY_CHUNK = 100;
const MAX_DEALS = 2000; // teto de segurança — ajustar conforme performance

function roleFromLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes('cliente') || l.includes('client')) return 'cliente';
  if (l.includes('broker') || l.includes('corretor')) return 'broker';
  if (l.includes('gerenciadora') || l.includes('property manager') || l.includes('gestora')) return 'gerenciadora';
  if (l.includes('dono') || l.includes('incorporador') || l.includes('owner') || l.includes('proprietário')) return 'dono';
  if (l.includes('parceiro') || l.includes('partner')) return 'parceiro';
  if (l.includes('concorrente') || l.includes('competitor')) return 'concorrente';
  return label;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado' });

  const h = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const DEAL_PROPS = [
    'dealname', 'dealstage', 'pipeline', 'closedate', 'hs_lastmodifieddate',
    'aw_edificio_id', 'aw_andar_de_interesse',
    'edificio', 'andar', 'building', 'floor',
    'nucleo', 'nucleos', 'aw_nucleo',
  ];

  try {
    // 1. Search API — só deals não fechados, ordenados por modificação recente
    let allDeals = [];
    let after = undefined;
    let totalHubSpot = null;

    do {
      const body = {
        filterGroups: [{
          filters: [{
            propertyName: 'pipeline',
            operator: 'EQ',
            value: '899974520', // pipeline Projeto
          }],
        }],
        properties: DEAL_PROPS,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      };

      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
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
      return res.json({ total: 0, deals: [], _debug: 'Nenhum deal aberto encontrado' });
    }

    // 2. Associações em chunks
    const dealToCompanies = {};
    const companyIdSet = new Set();

    for (const batch of chunk(allDeals.map(d => ({ id: d.id })), ASSOC_CHUNK)) {
      const r = await fetch(
        `${HUBSPOT_BASE}/crm/v4/associations/deals/companies/batch/read`,
        { method: 'POST', headers: h, body: JSON.stringify({ inputs: batch }) }
      );
      if (!r.ok) { console.error('Assoc error', await r.text()); continue; }
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

    // 3. Companies em chunks
    const companiesMap = {};
    for (const batch of chunk([...companyIdSet], COMPANY_CHUNK)) {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/batch/read`, {
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
      const edificio = p.aw_edificio_id || p.edificio || p.building || null;
      const andar    = p.aw_andar_de_interesse || p.andar || p.floor || null;
      const nucleo   = p.aw_nucleo || p.nucleo || p.nucleos || null;

      const actors = {};
      (dealToCompanies[d.id] || []).forEach(({ companyId, label }) => {
        const role = roleFromLabel(label);
        const name = companiesMap[companyId] || companyId;
        if (role) actors[role] = name;
      });

      return {
        id: d.id,
        nome: p.dealname || `Deal ${d.id}`,
        stage: p.dealstage || null,
        edificio,
        andar,
        nucleo,
        ...actors,
        _associacoes: (dealToCompanies[d.id] || []).map(a => ({
          empresa: companiesMap[a.companyId] || a.companyId,
          rotulo: a.label,
        })),
      };
    });

    // debug: mostra quais propriedades de prédio/andar vieram preenchidas
    const comEdificio = deals.filter(d => d.edificio).length;
    const comNucleo   = deals.filter(d => d.nucleo).length;
    const comBroker   = deals.filter(d => d.broker).length;

    return res.json({
      total: deals.length,
      deals,
      _debug: {
        totalHubSpot,
        totalDealsAbertos: allDeals.length,
        comEdificio,
        comNucleo,
        comBroker,
        aviso: comEdificio === 0
          ? 'Nenhum deal tem o campo edificio preenchido — confirmar nome da propriedade no HubSpot'
          : null,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
