/**
 * /api/andares?edificioId=<id>
 * ------------------------------------------------------------------
 * Inventário de andares de UM edifício, sob demanda. Usado pela Vista
 * Multi-Prédio pra mostrar a torre completa (andares vagos) de prédios
 * que NÃO vêm com floors no payload de /api/teia — ex.: edifícios sem
 * nenhum deal (Platinum Tower etc.).
 *
 * Buscar 1 prédio por vez é barato (~1 chamada de associação + 1 batch),
 * ao contrário de listar os ~10 mil andares do portal inteiro (~60s).
 * ------------------------------------------------------------------
 */
const { makeClient, getAssociations, getObjectsById } = require('../lib/hubspot');
const { isConfigured, isAuthed } = require('../lib/auth');

const OBJ_ANDAR = process.env.HUBSPOT_OBJECT_ANDAR || 'p51253038_andares';
const OBJ_EDIFICIO = process.env.HUBSPOT_OBJECT_EDIFICIO || 'p51253038_edificios';
const PROP_ANDAR_NOME = process.env.HUBSPOT_PROP_ANDAR_NOME || 'nome_do_andar';
const PROP_ANDAR_NUMERO = process.env.HUBSPOT_PROP_ANDAR_NUMERO || 'numero_do_andar';

module.exports = async (req, res) => {
  try {
    if (isConfigured() && !isAuthed(req)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'Não autenticado.', auth_required: true });
      return;
    }
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { res.status(500).json({ error: 'Faltou HUBSPOT_TOKEN.' }); return; }

    const edId = (req.query && req.query.edificioId) ||
      new URL(req.url, 'http://localhost').searchParams.get('edificioId');
    if (!edId) { res.status(400).json({ error: 'Parâmetro edificioId é obrigatório.' }); return; }

    const hs = makeClient(token);
    const assoc = await getAssociations(hs, OBJ_EDIFICIO, OBJ_ANDAR, [String(edId)]);
    const floorIds = (assoc[String(edId)] || []).map((a) => a.toId);
    const objs = floorIds.length
      ? await getObjectsById(hs, OBJ_ANDAR, floorIds, [PROP_ANDAR_NOME, PROP_ANDAR_NUMERO, 'disponibilidade', 'area_privativa_m2'])
      : {};
    const andares = floorIds.map((id) => {
      const o = objs[id];
      if (!o) return null;
      return {
        id,
        numero: o.properties[PROP_ANDAR_NUMERO] || null,
        nome: o.properties[PROP_ANDAR_NOME] || null,
        disp: o.properties.disponibilidade || null,
        area: o.properties.area_privativa_m2 || null,
      };
    }).filter(Boolean);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ edificioId: String(edId), andares });
  } catch (err) {
    console.error('[api/andares] erro:', err);
    res.status(502).json({ error: err.message || 'Erro ao consultar o HubSpot.' });
  }
};
