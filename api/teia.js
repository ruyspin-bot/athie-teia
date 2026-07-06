const HUBSPOT_BASE = 'https://api.hubapi.com';
const ASSOC_CHUNK = 100; // HubSpot recomenda ≤100 por batch
const COMPANY_CHUNK = 100;
const MAX_DEALS = 500; // limita para deals mais recentes na Fase 1

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

  try {
    // 1. Busca deals ativos (limita aos MAX_DEALS mais recentes)
    const DEAL_PROPS = [
      'dealname', 'dealstage', 'pipeline', 'closedate',
      'aw_edificio_id', 'aw_andar_de_interesse',
      'edificio', 'andar', 'building', 'floor',
      'nucleo', 'nucleos', 'aw_nucleo',
    ].join(',');

    let allDeals = [];
    let after = undefined;
    do {
      const url = `${HUBSPOT_BASE}/crm/v3/objects/deals?limit=100&properties=${DEAL_PROPS}&archived=false${after ? `&after=${after}` : ''}`;
      const r = await fetch(url, { headers: h });
      if (!r.ok) throw new Error(`Deals API error: ${r.status} ${await r.text()}`);
      const data = await r.json();
      allDeals = allDeals.concat(data.results || []);
      after = data.paging?.next?.after;
      if (allDeals.length >= MAX_DEALS) break; // não passa do limite
    } while (after);

    allDeals = allDeals.slice(0, MAX_DEALS);

    if (allDeals.length === 0) return res.json({ deals: [], companies: {} });

    // 2. Associações deal→company em chunks de ASSOC_CHUNK
    const dealIdChunks = chunk(allDeals.map(d => ({ id: d.id })), ASSOC_CHUNK);
    const dealToCompanies = {};
    const companyIdSet = new Set();

    for (const batch of dealIdChunks) {
      const r = await fetch(
        `${HUBSPOT_BASE}/crm/v4/associations/deals/companies/batch/read`,
        { method: 'POST', headers: h, body: JSON.stringify({ inputs: batch }) }
      );
      if (!r.ok) {
        console.error('Associations batch error:', await r.text());
        continue; // ignora chunk com erro, não derruba tudo
      }
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

    // 3. Detalhes das companies em chunks de COMPANY_CHUNK
    const companiesMap = {};
    const companyIds = [...companyIdSet];

    for (const batch of chunk(companyIds, COMPANY_CHUNK)) {
      const r = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/companies/batch/read`,
        {
          method: 'POST', headers: h,
          body: JSON.stringify({
            inputs: batch.map(id => ({ id })),
            properties: ['name', 'domain'],
          }),
        }
      );
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

    return res.json({ total: deals.length, deals });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
