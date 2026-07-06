module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'Token não configurado' });

  const r = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();

  // Retorna só o que interessa: pipeline name + stages com id e label
  const simplified = (data.results || []).map(p => ({
    pipelineId: p.id,
    pipeline: p.label,
    stages: (p.stages || []).map(s => ({
      id: s.id,
      label: s.label,
      displayOrder: s.displayOrder,
    })),
  }));

  return res.json(simplified);
};
