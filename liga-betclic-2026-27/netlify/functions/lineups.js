/* Onzes iniciais via API pública do site da Liga Portugal (ligaportugal.pt).
   Não precisa de chave. Nota: é a API interna do site — pode mudar sem aviso.
   Uso: /api/lineups?j=1&home=EST&away=FAM (ids do seed.json) */

const LP_BASE = 'https://www.ligaportugal.pt/api';
const COMP = 'ligaportugalbetclic';
const SEASON = '20262027'; // época 2026/27

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

async function lp(path) {
  const r = await fetch(`${LP_BASE}${path}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; LigaBetclicPWA/1.0)',
    },
  });
  if (!r.ok) throw new Error(`ligaportugal ${r.status}`);
  return r.json();
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

  const q = event.queryStringParameters || {};
  const { j, home, away } = q;
  if (!j || !home || !away || !/^\d{1,2}$/.test(j)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'faltam parâmetros j/home/away' }) };
  }

  try {
    // 1) jogos da jornada (cache 6h)
    const fxKey = `fx-${j}`;
    let fixtures;
    const fxHit = hit(fxKey);
    if (fresh(fxHit, 6 * 3600e3)) {
      fixtures = fxHit.v;
    } else {
      fixtures = await lp(`/v1/competition/matches?competition=${COMP}&season=${SEASON}&round=${j}`);
      if (!Array.isArray(fixtures)) throw new Error('resposta inesperada');
      put(fxKey, fixtures);
    }

    const fx = fixtures.find(f =>
      teamIdFromName(f.homeTeam && f.homeTeam.name) === home &&
      teamIdFromName(f.awayTeam && f.awayTeam.name) === away
    );
    if (!fx) return ok({ available: false, reason: 'Jogo não encontrado na fonte de onzes.' });

    // 2) detalhes do jogo — cache 24h se já temos onzes, 10 min enquanto não anunciados
    const luKey = `lu-${j}-${fx.fixtureNumber}`;
    const luHit = hit(luKey);
    if (luHit && fresh(luHit, luHit.v.available ? 24 * 3600e3 : 10 * 60e3)) {
      return ok(luHit.v);
    }

    const d = await lp(`/v1/match/details?competition=${COMP}&season=${SEASON}&round=${j}&fixture=${fx.fixtureNumber}`);
    const simp = (parts) => {
      const xi = (parts || [])
        .filter(p => p.intervenientTypeId === 1)
        .map(p => ({ name: p.name, number: p.shirtNumber, captain: !!p.isCaptain }));
      const coach = ((parts || []).find(p => p.isMainCoach) || {}).name || '';
      return { xi, coach };
    };
    const h = simp(d.homeTeamParticipants);
    const a = simp(d.awayTeamParticipants);

    let payload;
    if (h.xi.length < 11 || a.xi.length < 11) {
      payload = { available: false, reason: 'Onzes ainda não anunciados (habitualmente ~1 hora antes do jogo).' };
    } else {
      payload = {
        available: true,
        home: { team: (d.homeTeam && d.homeTeam.name) || '', formation: '', coach: h.coach, xi: h.xi },
        away: { team: (d.awayTeam && d.awayTeam.name) || '', formation: '', coach: a.coach, xi: a.xi },
      };
    }
    put(luKey, payload);
    return ok(payload);
  } catch (e) {
    return ok({ available: false, reason: 'Fonte de onzes temporariamente indisponível.' });
  }
};
