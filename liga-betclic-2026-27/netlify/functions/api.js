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

/* A época 2026/27 pode ainda não existir na API (404). Nesse caso tenta a época
   corrente e só a devolve se já for a 2026/27; senão devolve payload vazio
   para a app continuar com o calendário base sem erro. */
async function fdSeasonFallback(resPath, extraQs) {
  const qs = extraQs ? `&${extraQs}` : '';
  try {
    return await fd(`${resPath}?season=${SEASON}${qs}`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    const data = await fd(`${resPath}${extraQs ? `?${extraQs}` : ''}`);
    const start =
      (data.season && data.season.startDate) ||
      (data.filters && data.filters.season) ||
      (Array.isArray(data.matches) && data.matches[0] && data.matches[0].season && data.matches[0].season.startDate) ||
      '';
    if (String(start).startsWith(SEASON)) return data;
    return { seasonAvailable: false, matches: [], standings: [], scorers: [] };
  }
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

  let ttl, fetcher, cacheKey;
  switch (resource) {
    case 'matches':
      ttl = TTL.matches;
      cacheKey = 'matches';
      fetcher = () => fdSeasonFallback(`/competitions/${COMP}/matches`);
      break;
    case 'standings':
      ttl = TTL.standings;
      cacheKey = 'standings';
      fetcher = () => fdSeasonFallback(`/competitions/${COMP}/standings`);
      break;
    case 'scorers':
      ttl = TTL.scorers;
      cacheKey = 'scorers';
      fetcher = () => fdSeasonFallback(`/competitions/${COMP}/scorers`, 'limit=15');
      break;
    case 'match':
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'falta id' }) };
      ttl = TTL.match;
      cacheKey = `match-${id}`;
      fetcher = () => fd(`/matches/${id}`);
      break;
    default:
      return { statusCode: 404, headers, body: JSON.stringify({ error: `recurso desconhecido: ${resource}` }) };
  }

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < ttl * 1000) {
    return { statusCode: 200, headers, body: hit.body };
  }

  try {
    const data = await fetcher();
    const body = JSON.stringify(data);
    cache.set(cacheKey, { t: Date.now(), body });
    return { statusCode: 200, headers, body };
  } catch (e) {
    // se a API falhar mas houver cache antiga, devolve-a
    if (hit) return { statusCode: 200, headers, body: hit.body };
    return { statusCode: e.status || 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
