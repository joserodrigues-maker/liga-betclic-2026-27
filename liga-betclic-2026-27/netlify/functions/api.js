/* Proxy para a API football-data.org (a chave nunca chega ao browser).
   Env var obrigatória no Netlify: FOOTBALL_DATA_KEY  */

const BASE = 'https://api.football-data.org/v4';
const COMP = 'PPL';       // Primeira Liga
const SEASON = '2026';    // época 2026/27

// cache em memória (persiste entre invocações "quentes" da função)
const cache = new Map();
const TTL = { matches: 60, standings: 300, scorers: 600, match: 45 };

async function fd(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY || '' },
  });
  if (!r.ok) {
    const body = await r.text();
    throw Object.assign(new Error(`football-data ${r.status}`), { status: r.status, body });
  }
  return r.json();
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=30',
  };

  if (!process.env.FOOTBALL_DATA_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'FOOTBALL_DATA_KEY não configurada' }) };
  }

  // aceita /api/matches, /api/standings, /api/scorers, /api/match&id=123 (ou ?path=...&id=...)
  const rawPath = (event.path || '').replace(/^.*\/api\/?/, '') || (event.queryStringParameters || {}).path || '';
  const [resource] = rawPath.split('&');
  const id = (event.queryStringParameters || {}).id || (rawPath.match(/id=(\d+)/) || [])[1];

  let upstream, ttl;
  switch (resource) {
    case 'matches':
      upstream = `/competitions/${COMP}/matches?season=${SEASON}`;
      ttl = TTL.matches;
      break;
    case 'standings':
      upstream = `/competitions/${COMP}/standings?season=${SEASON}`;
      ttl = TTL.standings;
      break;
    case 'scorers':
      upstream = `/competitions/${COMP}/scorers?season=${SEASON}&limit=15`;
      ttl = TTL.scorers;
      break;
    case 'match':
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'falta id' }) };
      upstream = `/matches/${id}`;
      ttl = TTL.match;
      break;
    default:
      return { statusCode: 404, headers, body: JSON.stringify({ error: `recurso desconhecido: ${resource}` }) };
  }

  const hit = cache.get(upstream);
  if (hit && Date.now() - hit.t < ttl * 1000) {
    return { statusCode: 200, headers, body: hit.body };
  }

  try {
    const data = await fd(upstream);
    const body = JSON.stringify(data);
    cache.set(upstream, { t: Date.now(), body });
    return { statusCode: 200, headers, body };
  } catch (e) {
    // se a API falhar mas houver cache antiga, devolve-a
    if (hit) return { statusCode: 200, headers, body: hit.body };
    return { statusCode: e.status || 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
