/* Onzes iniciais + eventos (golos, cartões, substituições) via API pública
   do site da Liga Portugal (ligaportugal.pt). Não precisa de chave.
   Nota: é a API interna do site — pode mudar sem aviso.
   Uso: /api/lineups?j=1&home=EST&away=FAM (ids do seed.json) */

const LP_BASE = 'https://www.ligaportugal.pt/api';
const COMP = 'ligaportugalbetclic';
const SEASON = '20262027'; // época 2026/27

// tipos de ocorrência confirmados na API da Liga
const OCC = { 1: 'sub', 2: 'amarelo', 3: 'vermelho', 4: 'golo', 5: 'autogolo', 6: 'duplo' };

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
    'Cache-Control': 'public, max-age=60',
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
    if (!fx) return ok({ available: false, events: [], reason: 'Jogo não encontrado na fonte de onzes.' });

    // 2) detalhes + info dinâmica — cache 24h se terminou, 90s durante/antes do jogo
    const miKey = `mi-${j}-${fx.fixtureNumber}`;
    const miHit = hit(miKey);
    if (miHit && fresh(miHit, miHit.v.final ? 24 * 3600e3 : 90e3)) {
      return ok(miHit.v);
    }

    const qs = `competition=${COMP}&season=${SEASON}&round=${j}&fixture=${fx.fixtureNumber}`;
    const [det, dyn] = await Promise.all([
      lp(`/v1/match/details?${qs}`),
      lp(`/v2/match/info/dynamic?${qs}`).catch(() => ({})),
    ]);

    const simp = (parts) => {
      const xi = (parts || [])
        .filter(p => p.intervenientTypeId === 1)
        .map(p => ({ name: p.name, number: p.shirtNumber, captain: !!p.isCaptain }));
      const coach = ((parts || []).find(p => p.isMainCoach) || {}).name || '';
      return { xi, coach };
    };
    const h = simp(det.homeTeamParticipants);
    const a = simp(det.awayTeamParticipants);

    const events = (dyn.occurrences || [])
      .filter(o => OCC[o.occurrenceTypeId])
      .map(o => ({
        t: o.time || `${o.minute}'`,
        type: OCC[o.occurrenceTypeId],
        name: o.playerName || o.name || '',
        home: !!o.isHomeTeam,
      }))
      .reverse(); // API devolve do fim para o início; queremos ordem cronológica

    const payload = {
      events,
      final: !!dyn.hasOfficialResult,
      state: dyn.fixtureStateTypeId ?? null, // 0=por começar, 3=a decorrer, 4=terminado, 5=resultado oficial
      min: dyn.minutes ?? null,
      goals: (dyn.homeTeamGoals != null && dyn.awayTeamGoals != null) ? { h: dyn.homeTeamGoals, a: dyn.awayTeamGoals } : null,
    };
    if (h.xi.length < 11 || a.xi.length < 11) {
      payload.available = false;
      payload.reason = 'Onzes ainda não anunciados (habitualmente ~1 hora antes do jogo).';
    } else {
      payload.available = true;
      payload.home = { team: (det.homeTeam && det.homeTeam.name) || '', formation: '', coach: h.coach, xi: h.xi };
      payload.away = { team: (det.awayTeam && det.awayTeam.name) || '', formation: '', coach: a.coach, xi: a.xi };
    }
    put(miKey, payload);
    return ok(payload);
  } catch (e) {
    return ok({ available: false, events: [], reason: 'Fonte de onzes temporariamente indisponível.' });
  }
};
