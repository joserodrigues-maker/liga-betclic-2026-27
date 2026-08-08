/* Proxy para a API-FOOTBALL (api-sports.io) — onzes iniciais.
   Env var obrigatória no Netlify: API_FOOTBALL_KEY (plano free chega: ~100 pedidos/dia,
   a cache abaixo garante que ficamos muito abaixo disso).
   Uso: /api/lineups?date=YYYY-MM-DD&home=SCP&away=ALV (ids do seed.json) */

const AF_BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 94;    // Primeira Liga
const SEASON = 2026;  // época 2026/27

// cache em memória (persiste entre invocações "quentes" da função)
const cache = new Map();

/* mesmo mapeamento de nomes usado no front-end */
const NAME_MAP = [
  [/braga/i, 'BRA'],
  [/sporting/i, 'SCP'],
  [/benfica/i, 'SLB'],
  [/porto/i, 'FCP'],
  [/guimar|vit[óo]ria s/i, 'VSC'],
  [/rio ave/i, 'RAV'],
  [/famalic/i, 'FAM'],
  [/arouca/i, 'ARO'],
  [/nacional/i, 'NAC'],
  [/estrela|amadora/i, 'EAM'],
  [/alverca/i, 'ALV'],
  [/casa pia/i, 'CPA'],
  [/moreirense/i, 'MOR'],
  [/estoril/i, 'EST'],
  [/gil vicente/i, 'GVF'],
  [/santa clara/i, 'SCL'],
  [/mar[íi]timo/i, 'MAR'],
  [/viseu|acad[ée]mico/i, 'ACV'],
];
function teamIdFromName(name) {
  if (!name) return null;
  for (const [re, id] of NAME_MAP) if (re.test(name)) return id;
  return null;
}

async function af(path) {
  const r = await fetch(`${AF_BASE}${path}`, {
    headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY || '' },
  });
  if (!r.ok) throw new Error(`api-football ${r.status}`);
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`api-football: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

const hit = (key) => cache.get(key);
const put = (key, v) => cache.set(key, { t: Date.now(), v });
const fresh = (h, ttlMs) => h && Date.now() - h.t < ttlMs;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=120',
  };
  const ok = (payload) => ({ statusCode: 200, headers, body: JSON.stringify(payload) });

  if (!process.env.API_FOOTBALL_KEY) {
    return ok({ available: false, reason: 'Onzes indisponíveis (API_FOOTBALL_KEY não configurada).' });
  }

  const q = event.queryStringParameters || {};
  const { date, home, away } = q;
  if (!date || !home || !away || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'faltam parâmetros date/home/away' }) };
  }

  try {
    // 1) jogos do dia (1 chamada por dia de jornada, cache 3h)
    const fxKey = `fx-${date}`;
    let fixtures;
    const fxHit = hit(fxKey);
    if (fresh(fxHit, 3 * 3600e3)) {
      fixtures = fxHit.v;
    } else {
      const d = await af(`/fixtures?league=${LEAGUE}&season=${SEASON}&date=${date}&timezone=Europe/Lisbon`);
      fixtures = d.response || [];
      put(fxKey, fixtures);
    }

    const fx = fixtures.find(f =>
      f.teams && teamIdFromName(f.teams.home.name) === home && teamIdFromName(f.teams.away.name) === away
    );
    if (!fx) return ok({ available: false, reason: 'Jogo não encontrado na fonte de onzes.' });

    // 2) onzes — cache 24h se já os temos, 10 min enquanto não anunciados
    const luKey = `lu-${fx.fixture.id}`;
    const luHit = hit(luKey);
    if (luHit && fresh(luHit, luHit.v.available ? 24 * 3600e3 : 10 * 60e3)) {
      return ok(luHit.v);
    }

    const d = await af(`/fixtures/lineups?fixture=${fx.fixture.id}`);
    const resp = d.response || [];
    let payload;
    if (resp.length < 2 || !(resp[0].startXI || []).length) {
      payload = { available: false, reason: 'Onzes ainda não anunciados (habitualmente ~40 min antes do jogo).' };
    } else {
      const simp = (r) => ({
        team: (r.team && r.team.name) || '',
        formation: r.formation || '',
        coach: (r.coach && r.coach.name) || '',
        xi: (r.startXI || []).map(x => ({
          name: x.player && x.player.name,
          number: x.player && x.player.number,
          pos: x.player && x.player.pos,
        })),
      });
      const h = resp.find(r => teamIdFromName(r.team && r.team.name) === home) || resp[0];
      const a = resp.find(r => teamIdFromName(r.team && r.team.name) === away) || resp[1];
      payload = { available: true, home: simp(h), away: simp(a) };
    }
    put(luKey, payload);
    return ok(payload);
  } catch (e) {
    return ok({ available: false, reason: 'Fonte de onzes indisponível: ' + ((e && e.message) || 'erro desconhecido') });
  }
};
