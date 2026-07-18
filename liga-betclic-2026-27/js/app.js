/* Liga Betclic 2026/27 — Caixa Mágica Software */
(() => {
  'use strict';

  const API_BASE = '/api';
  const POLL_LIVE_MS = 60 * 1000;      // atualização durante jogos
  const POLL_IDLE_MS = 10 * 60 * 1000; // atualização fora de jogos
  const TZ = 'Europe/Lisbon';

  const S = {
    teams: new Map(),        // id -> team
    matches: [],             // normalizados
    byKey: new Map(),        // "j|home|away" -> match
    jornadas: {},            // j -> data base (domingo)
    standings: null,
    scorers: [],
    crests: new Map(),        // id -> URL do emblema (football-data)
    crestOverrides: new Set(),// ids com emblema fixado no seed (ganha à API)
    crestsLoaded: false,
    events: new Map(),       // apiId -> {loaded, goals, bookings}
    tvDefaults: {},
    jornada: 1,
    apiOk: false,
    expanded: new Set(),
    club: null,
    deferredInstall: null,
    tvOn: false,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---------- mapeamento equipas API -> ids ---------- */
  const API_NAME_MAP = [
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
  function teamIdFromApi(apiTeam) {
    if (!apiTeam || !apiTeam.name) return null;
    for (const [re, id] of API_NAME_MAP) if (re.test(apiTeam.name)) return id;
    return null;
  }

  /* ---------- datas ---------- */
  const fmtTime = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const fmtDay = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  const fmtDayShort = new Intl.DateTimeFormat('pt-PT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (d) => dayKeyFmt.format(d);

  /* ---------- carregar dados ---------- */
  async function loadJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  function normalizeSeed(seed) {
    seed.teams.forEach(t => {
      S.teams.set(t.id, t);
      if (t.crest) { S.crests.set(t.id, t.crest); S.crestOverrides.add(t.id); }
    });
    S.jornadas = seed.jornadas;
    for (const m of seed.matches) {
      const match = {
        key: `${m.j}|${m.home}|${m.away}`,
        j: m.j, home: m.home, away: m.away,
        apiId: null,
        utcDate: null,          // Date | null (hora oficial)
        baseDate: seed.jornadas[String(m.j)] || null,
        status: 'SCHEDULED',
        scoreH: null, scoreA: null,
        minute: null,
        confirmed: false,
        tv: null, nota: null,
      };
      S.byKey.set(match.key, match);
      S.matches.push(match);
    }
  }

  function upsertFromApi(apiMatches) {
    for (const am of apiMatches) {
      const h = teamIdFromApi(am.homeTeam), a = teamIdFromApi(am.awayTeam);
      if (!h || !a || !am.matchday) continue;
      const key = `${am.matchday}|${h}|${a}`;
      let m = S.byKey.get(key);
      if (!m) {
        m = { key, j: am.matchday, home: h, away: a, apiId: null, utcDate: null,
              baseDate: S.jornadas[String(am.matchday)] || null, status: 'SCHEDULED',
              scoreH: null, scoreA: null, minute: null, confirmed: false, tv: null, nota: null };
        S.byKey.set(key, m);
        S.matches.push(m);
      }
      m.apiId = am.id;
      m.status = am.status || m.status;
      // SCHEDULED traz horas-placeholder na football-data — ignorar.
      // Só TIMED (e estados seguintes) têm hora oficial.
      if (am.utcDate && ['TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'SUSPENDED'].includes(m.status)) {
        m.utcDate = new Date(am.utcDate);
        m.confirmed = true;
      }
      const ft = am.score && am.score.fullTime;
      if (ft && (ft.home !== null || ft.away !== null)) { m.scoreH = ft.home; m.scoreA = ft.away; }
      if (am.minute != null) m.minute = am.minute;
    }
  }

  function applyOverrides(ov) {
    S.tvDefaults = ov.tvDefaults || {};
    for (const o of (ov.matches || [])) {
      const key = `${o.j}|${o.home}|${o.away}`;
      const m = S.byKey.get(key);
      if (!m) continue;
      if (o.date) {
        const time = o.time || '00:00';
        // hora de Lisboa -> Date (aproximação via ISO com offset calculado no render; guardamos como local PT)
        m.utcDate = dateFromLisbon(o.date, o.time || null);
        m.overrideTimeSet = !!o.time;
      }
      if (o.confirmed) m.confirmed = true;
      if (o.tv) m.tv = o.tv;
      if (o.status) m.status = o.status;
      if (o.nota) m.nota = o.nota;
    }
  }

  // converte data/hora de Lisboa para Date UTC correto (lida com DST)
  function dateFromLisbon(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '12:00').split(':').map(Number);
    // tentativa iterativa: começa em UTC e corrige pelo offset observado
    let guess = Date.UTC(y, mo - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
      const gh = +parts.find(p => p.type === 'hour').value;
      const gm = +parts.find(p => p.type === 'minute').value;
      guess += ((hh - gh) * 60 + (mm - gm)) * 60000;
    }
    const dt = new Date(guess);
    dt._noTime = !timeStr;
    return dt;
  }

  function tvFor(m) {
    return m.tv || S.tvDefaults[m.home] || S.tvDefaults['*'] || null;
  }

  /* ---------- API ---------- */
  async function api(path) {
    const r = await fetch(`${API_BASE}/${path}`);
    if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
    return r.json();
  }

  async function refreshFromApi(first = false) {
    try {
      const data = await api('matches');
      if (data && Array.isArray(data.matches)) {
        upsertFromApi(data.matches);
        S.apiOk = true;
      }
    } catch (e) {
      if (first) S.apiOk = false;
    }
    try {
      const st = await api('standings');
      if (st && st.standings) {
        const total = st.standings.find(s => s.type === 'TOTAL');
        if (total) S.standings = total.table;
      }
    } catch (e) { /* fallback calculado */ }
    try {
      const sc = await api('scorers');
      if (sc && sc.scorers) S.scorers = sc.scorers;
    } catch (e) { /* opcional */ }
    if (!S.crestsLoaded) {
      try {
        const tm = await api('teams');
        if (tm && Array.isArray(tm.teams)) {
          for (const t of tm.teams) {
            const tid = teamIdFromApi(t);
            if (tid && t.crest && !S.crestOverrides.has(tid)) S.crests.set(tid, t.crest);
          }
          if (tm.teams.length) S.crestsLoaded = true;
        }
      } catch (e) { /* emblemas são opcionais */ }
    }

    $('devBanner').hidden = S.apiOk;
    if (S.overrides) applyOverrides(S.overrides); // overrides ganham sempre à API
    await refreshLiveEvents();
    renderAll();
  }

  async function refreshLiveEvents() {
    const wanted = S.matches.filter(m =>
      m.apiId && (isLive(m) || (S.expanded.has(m.key) && m.status === 'FINISHED' && !(S.events.get(m.apiId) || {}).loaded))
    );
    await Promise.all(wanted.map(async m => {
      try {
        const d = await api(`match&id=${m.apiId}`);
        const md = d.match || d;
        S.events.set(m.apiId, { loaded: true, goals: md.goals || [], bookings: md.bookings || [] });
        if (md.minute != null) m.minute = md.minute;
      } catch (e) { /* tenta na próxima volta */ }
    }));
  }

  const isLive = (m) => m.status === 'IN_PLAY' || m.status === 'PAUSED';

  /* ---------- jornada atual ---------- */
  function currentJornada() {
    const today = dayKey(new Date());
    const js = Object.keys(S.jornadas).map(Number).sort((a, b) => a - b);
    for (const j of js) {
      // janela: sexta antes até quinta depois da data base
      const base = new Date(S.jornadas[String(j)] + 'T12:00:00Z');
      const start = new Date(base); start.setUTCDate(base.getUTCDate() - 2);
      const end = new Date(base); end.setUTCDate(base.getUTCDate() + 4);
      if (today >= dayKey(start) && today <= dayKey(end)) return j;
      if (today < dayKey(start)) return j;
    }
    return 34;
  }

  /* ---------- render ---------- */
  function crest(t) {
    const url = S.crests.get(t.id);
    if (url) return `<img class="crest crest-img" src="${esc(url)}" alt="${esc(t.name)}" title="${esc(t.name)}" loading="lazy" onerror="this.outerHTML='<span class=&quot;crest&quot; style=&quot;background:${t.color}&quot;>${esc(t.id)}</span>'">`;
    return `<span class="crest" style="background:${t.color}" title="${esc(t.name)}">${esc(t.id)}</span>`;
  }

  function statusLine(m) {
    if (m.status === 'POSTPONED') return `<div class="match-status">ADIADO</div>`;
    if (m.status === 'FINISHED') return `<div class="match-status ft">FINAL</div>`;
    if (isLive(m)) {
      const min = m.status === 'PAUSED' ? 'INTERVALO' : (m.minute != null ? `${m.minute}'` : 'AO VIVO');
      return `<div class="match-status live">● ${min}</div>`;
    }
    if (m.utcDate && !m.utcDate._noTime && (m.confirmed || m.overrideTimeSet)) return `<div class="match-status">${fmtTime.format(m.utcDate)}</div>`;
    return `<div class="match-status">—</div>`;
  }

  function scoreBox(m) {
    const played = isLive(m) || m.status === 'FINISHED';
    const s = played && m.scoreH !== null
      ? `${m.scoreH} – ${m.scoreA}`
      : `<span class="vs">vs</span>`;
    return `<div class="score-box"><div class="score">${s}</div>${statusLine(m)}</div>`;
  }

  function metaLine(m) {
    const bits = [];
    const d = m.utcDate || (m.baseDate ? new Date(m.baseDate + 'T12:00:00Z') : null);
    if (d) bits.push(`<span>📅 ${fmtDayShort.format(d)}</span>`);
    const tv = tvFor(m);
    if (tv) bits.push(`<span class="badge tv">📺 ${esc(tv)}</span>`);
    if (m.status === 'POSTPONED') bits.push(`<span class="badge postponed">Adiado</span>`);
    else if (m.confirmed) bits.push(`<span class="badge confirmed">✓ Data e hora oficiais</span>`);
    else bits.push(`<span class="badge tbc">Data/hora a confirmar</span>`);
    if (m.nota) bits.push(`<span>${esc(m.nota)}</span>`);
    return `<div class="match-meta">${bits.join('')}</div>`;
  }

  function eventsBlock(m) {
    if (!S.expanded.has(m.key)) return '';
    const ev = m.apiId ? S.events.get(m.apiId) : null;
    if (!ev || !ev.loaded) {
      const msg = m.apiId ? 'A carregar eventos…' : 'Sem detalhes disponíveis (API não ligada).';
      return `<div class="match-events"><div class="events-loading">${msg}</div></div>`;
    }
    const rows = [];
    for (const g of ev.goals) {
      const side = teamIdFromApi(g.team) === m.home ? 'home' : 'away';
      const tag = g.type === 'PENALTY' ? ' (g.p.)' : g.type === 'OWN' ? ' (p.b.)' : '';
      rows.push({ min: g.minute, side, html: `⚽ <span class="min">${g.minute}'</span> ${esc(g.scorer ? g.scorer.name : '?')}${tag}` });
    }
    for (const b of (ev.bookings || [])) {
      const side = teamIdFromApi(b.team) === m.home ? 'home' : 'away';
      const card = b.card === 'RED' || b.card === 'YELLOW_RED' ? '🟥' : '🟨';
      rows.push({ min: b.minute, side, html: `${card} <span class="min">${b.minute}'</span> ${esc(b.player ? b.player.name : '?')}` });
    }
    rows.sort((a, b) => (a.min || 0) - (b.min || 0));
    if (!rows.length) return `<div class="match-events"><div class="no-events">Sem golos nem cartões registados.</div></div>`;
    const cells = rows.map(r =>
      r.side === 'home'
        ? `<div class="ev ev-home">${r.html}</div><div></div>`
        : `<div></div><div class="ev">${r.html}</div>`
    ).join('');
    return `<div class="match-events">${cells}</div>`;
  }

  function matchCard(m) {
    const h = S.teams.get(m.home), a = S.teams.get(m.away);
    return `
      <article class="match-card ${isLive(m) ? 'live' : ''}" data-key="${esc(m.key)}">
        <button class="match-main" data-toggle="${esc(m.key)}">
          <span class="team home"><span class="team-name">${esc(h.short)}</span>${crest(h)}</span>
          ${scoreBox(m)}
          <span class="team away">${crest(a)}<span class="team-name">${esc(a.short)}</span></span>
        </button>
        ${metaLine(m)}
        ${eventsBlock(m)}
      </article>`;
  }

  function renderMatchList(el, matches) {
    if (!matches.length) {
      el.innerHTML = `<div class="loading">Jogos desta jornada ainda por anunciar.</div>`;
      return;
    }
    const sorted = [...matches].sort((x, y) => {
      const dx = x.utcDate ? x.utcDate.getTime() : new Date((x.baseDate || '2099-01-01') + 'T23:59:00Z').getTime();
      const dy = y.utcDate ? y.utcDate.getTime() : new Date((y.baseDate || '2099-01-01') + 'T23:59:00Z').getTime();
      return dx - dy;
    });
    let html = '', lastDay = null;
    for (const m of sorted) {
      const d = m.utcDate || (m.baseDate ? new Date(m.baseDate + 'T12:00:00Z') : null);
      const dk = d ? dayKey(d) : 'tbd';
      if (dk !== lastDay) {
        lastDay = dk;
        const label = d ? fmtDay.format(d) + (m.utcDate ? '' : ' (prevista)') : 'Data por definir';
        html += `<div class="day-sep">${esc(label)}</div>`;
      }
      html += matchCard(m);
    }
    el.innerHTML = html;
  }

  function renderJogos() {
    const chips = $('jornadaChips');
    let html = '';
    for (let j = 1; j <= 34; j++) {
      const hasLive = S.matches.some(m => m.j === j && isLive(m));
      html += `<button class="jchip ${j === S.jornada ? 'active' : ''} ${hasLive ? 'live-dot' : ''}" data-j="${j}">J${j}</button>`;
    }
    chips.innerHTML = html;
    const active = chips.querySelector('.jchip.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });

    const base = S.jornadas[String(S.jornada)];
    $('jornadaHeader').textContent =
      `Jornada ${S.jornada} · fim de semana de ${base ? new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(base + 'T12:00:00Z')) : '—'}`;
    renderMatchList($('matchList'), S.matches.filter(m => m.j === S.jornada));
  }

  /* ---------- classificação ---------- */
  function computedStandings() {
    const rows = new Map();
    for (const t of S.teams.values()) rows.set(t.id, { id: t.id, j: 0, v: 0, e: 0, d: 0, gm: 0, gs: 0, p: 0 });
    for (const m of S.matches) {
      if (m.status !== 'FINISHED' || m.scoreH === null) continue;
      const H = rows.get(m.home), A = rows.get(m.away);
      if (!H || !A) continue;
      H.j++; A.j++; H.gm += m.scoreH; H.gs += m.scoreA; A.gm += m.scoreA; A.gs += m.scoreH;
      if (m.scoreH > m.scoreA) { H.v++; A.d++; H.p += 3; }
      else if (m.scoreH < m.scoreA) { A.v++; H.d++; A.p += 3; }
      else { H.e++; A.e++; H.p++; A.p++; }
    }
    return [...rows.values()].sort((a, b) =>
      b.p - a.p || (b.gm - b.gs) - (a.gm - a.gs) || b.gm - a.gm || S.teams.get(a.id).short.localeCompare(S.teams.get(b.id).short)
    );
  }

  function zoneClass(pos) {
    if (pos <= 2) return 'z-ucl';
    if (pos === 3) return 'z-uel';
    if (pos === 4) return 'z-uecl';
    if (pos === 16) return 'z-po';
    if (pos >= 17) return 'z-desc';
    return '';
  }

  function renderClassificacao() {
    const body = $('standingsBody');
    let rows;
    if (S.standings) {
      rows = S.standings.map(r => ({
        id: teamIdFromApi(r.team) || '??',
        j: r.playedGames, v: r.won, e: r.draw, d: r.lost,
        gm: r.goalsFor, gs: r.goalsAgainst, p: r.points,
      }));
    } else {
      rows = computedStandings();
    }
    body.innerHTML = rows.map((r, i) => {
      const t = S.teams.get(r.id) || { id: r.id, short: r.id, color: '#555' };
      return `<tr class="${zoneClass(i + 1)}">
        <td>${i + 1}</td>
        <td class="team-col">${crest(t)} ${esc(t.short)}</td>
        <td class="pts">${r.p}</td><td>${r.j}</td><td>${r.v}</td><td>${r.e}</td><td>${r.d}</td>
        <td class="wide">${r.gm}</td><td class="wide">${r.gs}</td><td>${r.gm - r.gs}</td>
      </tr>`;
    }).join('');

    const sl = $('scorersList');
    if (S.scorers.length) {
      sl.innerHTML = S.scorers.slice(0, 10).map(s =>
        `<li><span>${esc(s.player.name)} <span class="club">${esc(s.team ? s.team.shortName || s.team.name : '')}</span></span><span class="g">${s.goals ?? s.numberOfGoals ?? 0}</span></li>`
      ).join('');
    } else {
      sl.innerHTML = `<li>Disponível após o arranque da época.</li>`;
    }
  }

  /* ---------- clubes ---------- */
  function renderClubes() {
    const grid = $('clubGrid'), detail = $('clubDetail');
    if (S.club) {
      grid.hidden = true; detail.hidden = false;
      const t = S.teams.get(S.club);
      $('clubName').innerHTML = `${crest(t)} ${esc(t.name)}`;
      renderMatchList($('clubMatches'), S.matches.filter(m => m.home === S.club || m.away === S.club));
    } else {
      detail.hidden = true; grid.hidden = false;
      grid.innerHTML = [...S.teams.values()]
        .sort((a, b) => a.short.localeCompare(b.short, 'pt'))
        .map(t => `<button class="club-tile" data-club="${t.id}">${crest(t)}<span>${esc(t.short)}</span></button>`)
        .join('');
    }
  }

  /* ---------- modo TV ---------- */
  function renderTv() {
    if (!S.tvOn) return;
    $('tvClock').textContent = new Intl.DateTimeFormat('pt-PT', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ
    }).format(new Date());

    const now = Date.now();
    const live = S.matches.filter(isLive);
    const todayK = dayKey(new Date());
    const today = S.matches.filter(m => !isLive(m) && m.status !== 'FINISHED' && m.utcDate && dayKey(m.utcDate) === todayK);
    const upcoming = S.matches
      .filter(m => !isLive(m) && m.status !== 'FINISHED' && (m.utcDate ? m.utcDate.getTime() > now : true) && (!m.utcDate || dayKey(m.utcDate) !== todayK))
      .sort((a, b) => {
        const ta = a.utcDate ? a.utcDate.getTime() : new Date((a.baseDate || '2099') + 'T12:00Z').getTime();
        const tb = b.utcDate ? b.utcDate.getTime() : new Date((b.baseDate || '2099') + 'T12:00Z').getTime();
        return ta - tb;
      })
      .slice(0, 6);
    const recent = S.matches.filter(m => m.status === 'FINISHED' && m.utcDate && (now - m.utcDate.getTime()) < 3 * 86400000).slice(-6);

    const row = (m, mode) => {
      const h = S.teams.get(m.home), a = S.teams.get(m.away);
      let mid;
      if (mode === 'live') mid = `${m.scoreH ?? 0} – ${m.scoreA ?? 0}<span class="lv">● ${m.status === 'PAUSED' ? 'INT' : (m.minute != null ? m.minute + "'" : 'AO VIVO')}</span>`;
      else if (mode === 'done') mid = `${m.scoreH} – ${m.scoreA}<span class="tm">final</span>`;
      else {
        const t = m.utcDate && !m.utcDate._noTime ? `${fmtDayShort.format(m.utcDate)} · ${fmtTime.format(m.utcDate)}` : (m.baseDate ? fmtDayShort.format(new Date(m.baseDate + 'T12:00Z')) + ' · hora a confirmar' : 'a confirmar');
        const tv = tvFor(m);
        mid = `<span class="tm">${esc(t)}</span>${tv ? `<span class="tvch">📺 ${esc(tv)}</span>` : ''}`;
      }
      return `<div class="tv-row"><span class="h">${esc(h.short)}</span><span class="s">${mid}</span><span>${esc(a.short)}</span></div>`;
    };

    let html = '';
    if (live.length) html += `<h3>● EM DIRETO</h3>` + live.map(m => row(m, 'live')).join('');
    if (today.length) html += `<h3>HOJE</h3>` + today.map(m => row(m, 'next')).join('');
    if (recent.length) html += `<h3>RESULTADOS RECENTES</h3>` + recent.map(m => row(m, 'done')).join('');
    html += `<h3>PRÓXIMOS JOGOS</h3>` + (upcoming.length ? upcoming.map(m => row(m, 'next')).join('') : '<p>—</p>');
    $('tvContent').innerHTML = html;
  }

  function renderAll() {
    renderJogos();
    renderClassificacao();
    renderClubes();
    renderTv();
  }

  /* ---------- eventos UI ---------- */
  function bindUi() {
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
    }));

    $('jornadaChips').addEventListener('click', e => {
      const c = e.target.closest('.jchip');
      if (c) { S.jornada = +c.dataset.j; renderJogos(); }
    });
    $('jPrev').addEventListener('click', () => { if (S.jornada > 1) { S.jornada--; renderJogos(); } });
    $('jNext').addEventListener('click', () => { if (S.jornada < 34) { S.jornada++; renderJogos(); } });
    $('btnHoje').addEventListener('click', () => {
      S.jornada = currentJornada();
      document.querySelector('.tab[data-tab="jogos"]').click();
      renderJogos();
    });

    document.body.addEventListener('click', e => {
      const t = e.target.closest('[data-toggle]');
      if (t) {
        const key = t.dataset.toggle;
        S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key);
        const m = S.byKey.get(key);
        if (m && S.expanded.has(key) && m.apiId && !(S.events.get(m.apiId) || {}).loaded) {
          refreshLiveEvents().then(renderAll);
        }
        renderJogos(); renderClubes();
      }
      const club = e.target.closest('[data-club]');
      if (club) { S.club = club.dataset.club; renderClubes(); }
    });
    $('clubBack').addEventListener('click', () => { S.club = null; renderClubes(); });

    // Modo TV
    $('btnTv').addEventListener('click', () => {
      S.tvOn = true; $('tvMode').hidden = false;
      document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
      renderTv();
    });
    $('tvClose').addEventListener('click', () => {
      S.tvOn = false; $('tvMode').hidden = true;
      document.fullscreenElement && document.exitFullscreen().catch(() => {});
    });
    setInterval(() => S.tvOn && renderTv(), 1000);

    // Instalar (PWA)
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      S.deferredInstall = e;
      $('btnInstalar').hidden = false;
    });
    $('btnInstalar').addEventListener('click', async () => {
      if (!S.deferredInstall) return;
      S.deferredInstall.prompt();
      await S.deferredInstall.userChoice;
      S.deferredInstall = null;
      $('btnInstalar').hidden = true;
    });
  }

  /* ---------- toast ---------- */
  function toast(msg, actionLabel, action) {
    const t = $('toast');
    t.innerHTML = esc(msg) + (actionLabel ? ` <button id="toastAct">${esc(actionLabel)}</button>` : '');
    t.hidden = false;
    if (actionLabel) $('toastAct').addEventListener('click', action);
    setTimeout(() => { t.hidden = true; }, 8000);
  }

  /* ---------- service worker / auto-update ---------- */
  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(reg => {
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nova versão disponível.', 'Atualizar', () => nw.postMessage({ type: 'SKIP_WAITING' }));
          }
        });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
  }

  /* ---------- polling ---------- */
  function schedulePolling() {
    let timer = null;
    const tick = async () => {
      await refreshFromApi();
      const anyLiveOrToday = S.matches.some(m =>
        isLive(m) || (m.utcDate && dayKey(m.utcDate) === dayKey(new Date()) && m.status !== 'FINISHED')
      );
      timer = setTimeout(tick, anyLiveOrToday ? POLL_LIVE_MS : POLL_IDLE_MS);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { clearTimeout(timer); tick(); }
    });
    timer = setTimeout(tick, POLL_LIVE_MS);
  }

  /* ---------- arranque ---------- */
  async function init() {
    bindUi();
    registerSw();
    try {
      const [seed, ov] = await Promise.all([loadJson('data/seed.json'), loadJson('data/overrides.json')]);
      normalizeSeed(seed);
      S.overrides = ov;
    } catch (e) {
      $('matchList').innerHTML = `<div class="loading">Erro a carregar dados base.</div>`;
      return;
    }
    applyOverrides(S.overrides);
    S.jornada = currentJornada();
    renderAll();
    await refreshFromApi(true);
    schedulePolling();
  }

  init();
})();
