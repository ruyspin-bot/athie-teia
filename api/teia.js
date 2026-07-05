const HUBSPOT_BASE = 'https://api.hubapi.com';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_TOKEN não configurado' });

  const h = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Busca deals ativos com propriedades relevantes
    const DEAL_PROPS = [
      'dealname', 'dealstage', 'pipeline',
      'aw_edificio_id', 'aw_andar_de_interesse',
      // fallbacks caso os nomes sejam diferentes
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
    } while (after);

    if (allDeals.length === 0) return res.json({ deals: [], companies: {}, associations: [] });

    // 2. Busca associações deal→company COM rótulos (v4)
    const dealIds = allDeals.map(d => ({ id: d.id }));
    const assocRes = await fetch(
      `${HUBSPOT_BASE}/crm/v4/associations/deals/companies/batch/read`,
      { method: 'POST', headers: h, body: JSON.stringify({ inputs: dealIds }) }
    );
    if (!assocRes.ok) throw new Error(`Associations API error: ${assocRes.status} ${await assocRes.text()}`);
    const assocData = await assocRes.json();

    // Monta mapa dealId → [{ companyId, label }]
    const dealToCompanies = {};
    const companyIdSet = new Set();
    (assocData.results || []).forEach(r => {
      const dealId = r.from.id;
      dealToCompanies[dealId] = [];
      (r.to || []).forEach(t => {
        const label = t.associationTypes?.[0]?.label || null;
        dealToCompanies[dealId].push({ companyId: String(t.toObjectId), label });
        companyIdSet.add(String(t.toObjectId));
      });
    });

    // 3. Busca detalhes das companies
    let companiesMap = {};
    if (companyIdSet.size > 0) {
      const compRes = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/companies/batch/read`,
        {
          method: 'POST', headers: h,
          body: JSON.stringify({
            inputs: [...companyIdSet].map(id => ({ id })),
            properties: ['name', 'domain', 'type'],
          }),
        }
      );
      if (compRes.ok) {
        const compData = await compRes.json();
        (compData.results || []).forEach(c => {
          companiesMap[c.id] = c.properties?.name || `Company ${c.id}`;
        });
      }
    }

    // 4. Monta payload normalizado para o frontend
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
        // debug: todas as associações brutas
        _associacoes: (dealToCompanies[d.id] || []).map(a => ({
          empresa: companiesMap[a.companyId] || a.companyId,
          rotulo: a.label,
        })),
      };
    });

    return res.json({
      total: deals.length,
      deals,
      // inclui mapa de companies para debug
      _companies: companiesMap,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
