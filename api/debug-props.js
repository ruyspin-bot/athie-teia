module.exports = async (req, res) => {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'no token' });
  const r = await fetch('https://api.hubapi.com/crm/v3/properties/deals?archived=false', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  const aw = (d.results || []).filter((p) => p.name.startsWith('aw_')).map((p) => ({ name: p.name, label: p.label, type: p.type })).sort((a,b)=>a.name.localeCompare(b.name));
  res.json(aw);
};
