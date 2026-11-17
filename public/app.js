'use strict';

const REGIONS = ['eu', 'na', 'latam', 'br', 'ap', 'kr'];
const STORE_KEY = 'valorant-dashboard';
const COLORS = {
  win: '#3ddc97',
  loss: '#ff4655',
  draw: '#8b97a5',
  unknown: '#8b97a5',
  line: '#5ac8fa',
  text: '#ece8e1',
  grid: 'rgba(236, 232, 225, 0.08)',
};

let els;
const charts = {};
let searchToken = 0;

// ---------- Data mapping (all API field names live here) ----------

function sameText(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// Turns one raw HenrikDev match (v3 shape, with v4 fallbacks) into a flat record
// for the searched player. Returns null if the player isn't in the match.
function normalizeMatch(raw, riotId, puuid) {
  const meta = raw.metadata || {};
  const players = Array.isArray(raw.players) ? raw.players : (raw.players && raw.players.all_players) || [];
  const me = players.find((p) => puuid && p.puuid === puuid)
    || players.find((p) => sameText(p.name, riotId.name) && sameText(p.tag, riotId.tag));
  if (!me) return null;

  const teamId = String(me.team_id || me.team || '').toLowerCase();
  let team = null;
  if (Array.isArray(raw.teams)) {
    const t = raw.teams.find((x) => String(x.team_id || '').toLowerCase() === teamId);
    if (t) team = { won: t.won, roundsWon: t.rounds && t.rounds.won, roundsLost: t.rounds && t.rounds.lost };
  } else if (raw.teams && raw.teams[teamId]) {
    const t = raw.teams[teamId];
    team = { won: t.has_won, roundsWon: t.rounds_won, roundsLost: t.rounds_lost };
  }

  let result = 'unknown';
  if (team && typeof team.won === 'boolean') {
    if (team.won) result = 'win';
    else result = team.roundsWon === team.roundsLost ? 'draw' : 'loss';
  }
  const roundsWon = Number(team && team.roundsWon) || 0;
  const roundsLost = Number(team && team.roundsLost) || 0;

  let rounds = Number(meta.rounds_played) || 0;
  if (!rounds && Array.isArray(raw.rounds)) rounds = raw.rounds.length;
  if (!rounds) rounds = roundsWon + roundsLost;

  const s = me.stats || {};
  const headshots = Number(s.headshots) || 0;
  const shots = headshots + (Number(s.bodyshots) || 0) + (Number(s.legshots) || 0);
  const score = Number(s.score) || 0;

  let date = null;
  if (meta.game_start) date = new Date(meta.game_start * 1000);
  else if (meta.started_at) date = new Date(meta.started_at);

  return {
    id: meta.matchid || meta.match_id || '',
    date,
    map: typeof meta.map === 'string' ? meta.map : (meta.map && meta.map.name) || 'Unknown',
    mode: meta.mode || (meta.queue && meta.queue.name) || 'Unknown',
    agent: me.character || (me.agent && me.agent.name) || 'Unknown',
    result,
    roundsWon,
    roundsLost,
    rounds,
    kills: Number(s.kills) || 0,
    deaths: Number(s.deaths) || 0,
    assists: Number(s.assists) || 0,
    score,
    acs: rounds ? Math.round(score / rounds) : 0,
    headshots,
    shots,
  };
}

function computeStats(matches) {
  const sum = (key) => matches.reduce((total, m) => total + m[key], 0);
  const count = (result) => matches.filter((m) => m.result === result).length;
  const wins = count('win');
  const losses = count('loss');
  const draws = count('draw');
  const decided = wins + losses + draws;
  const kills = sum('kills');
  const deaths = sum('deaths');
  const rounds = sum('rounds');
  const shots = sum('shots');
  return {
    wins,
    losses,
    draws,
    games: matches.length,
    winRate: decided ? wins / decided : null,
    kills,
    deaths,
    assists: sum('assists'),
    kd: deaths ? kills / deaths : kills,
    acs: rounds ? sum('score') / rounds : 0,
    hs: shots ? sum('headshots') / shots : null,
  };
}

function winRateBy(matches, key) {
  const groups = new Map();
  for (const m of matches) {
    if (m.result === 'unknown') continue;
    const g = groups.get(m[key]) || { games: 0, wins: 0 };
    g.games += 1;
    if (m.result === 'win') g.wins += 1;
    groups.set(m[key], g);
  }
  return [...groups]
    .map(([label, g]) => ({ label, games: g.games, rate: g.wins / g.games }))
    .sort((a, b) => b.games - a.games || b.rate - a.rate);
}

// ---------- API ----------

function errorMessage(status, body) {
  if (body && body.error) return body.error;
  const first = body && Array.isArray(body.errors) ? body.errors[0] || {} : {};
  const upstream = first.message;
  if (first.code === 24) {
    return 'HenrikDev has no recent match data for this account yet. Play any game (even a Deathmatch), wait a few minutes, then search again.';
  }
  switch (status) {
    case 401:
    case 403:
      return 'The API key was rejected. Check HENRIK_API_KEY in .env and restart the server.';
    case 404:
      return 'Player not found. Check the name, tag and region.';
    case 429:
      return 'Rate limited by the API. Wait a minute and try again.';
    default:
      return upstream ? `API error: ${upstream}` : `API error (${status}).`;
  }
}

async function api(route, params) {
  let res;
  try {
    res = await fetch(`/api/${route}?${new URLSearchParams(params)}`);
  } catch {
    throw new Error("Can't reach the local server. Start it with \"npm start\" and open http://localhost:3000.");
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON response; handled by status below.
  }
  if (!res.ok) throw new Error(errorMessage(res.status, body));
  return body;
}

// ---------- Game images (valorant-api.com, no key needed) ----------

const ASSET_BASE = 'https://valorant-api.com/v1/';
const assets = { agents: new Map(), maps: new Map(), ranks: new Map() };
let assetsReady = Promise.resolve();

const assetKey = (name) => String(name || '').trim().toLowerCase();

async function fetchAssetList(path) {
  try {
    const res = await fetch(ASSET_BASE + path, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  } catch {
    return []; // Images are optional; the dashboard works without them.
  }
}

async function loadAssets() {
  const [agents, maps, tiers] = await Promise.all([
    fetchAssetList('agents?isPlayableCharacter=true'),
    fetchAssetList('maps'),
    fetchAssetList('competitivetiers'),
  ]);
  for (const a of agents) {
    const url = a.displayIconSmall || a.displayIcon;
    if (url) assets.agents.set(assetKey(a.displayName), url);
  }
  for (const m of maps) {
    if (m.listViewIcon && !assets.maps.has(assetKey(m.displayName))) {
      assets.maps.set(assetKey(m.displayName), m.listViewIcon);
    }
  }
  const latest = tiers[tiers.length - 1]; // Newest rank set
  for (const t of (latest && latest.tiers) || []) {
    const url = t.largeIcon || t.smallIcon;
    if (url) assets.ranks.set(assetKey(t.tierName), url);
  }
}

function iconFor(kind, name) {
  return assets[kind].get(assetKey(name)) || '';
}

function withIcon(url, text, className) {
  const wrap = document.createElement('span');
  wrap.className = `with-icon ${className}`;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  wrap.append(text);
  return wrap;
}

// Chart.js plugin that draws agent portraits to the left of the y-axis labels.
function axisIconsPlugin(urls) {
  const images = urls.map((url) => {
    if (!url) return null;
    const img = new Image();
    img.src = url;
    return img;
  });
  return {
    id: 'axisIcons',
    afterInit(chart) {
      for (const img of images) {
        if (img && !img.complete) img.addEventListener('load', () => chart.canvas && chart.draw(), { once: true });
      }
    },
    afterDraw(chart) {
      const axis = chart.scales.y;
      const size = 20;
      images.forEach((img, i) => {
        if (!img || !img.complete || !img.naturalWidth) return;
        chart.ctx.drawImage(img, axis.left - size - 4, axis.getPixelForTick(i) - size / 2, size, size);
      });
    },
  };
}

// ---------- Helpers ----------

function parseRiotId(text) {
  const match = /^\s*(.+?)\s*#\s*([^#\s]+)\s*$/.exec(text || '');
  if (!match || match[1].length > 32 || match[2].length > 8) return null;
  return { name: match[1], tag: match[2] };
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private window etc.): preferences just won't persist.
  }
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.status.textContent = text || '';
  els.status.hidden = !text;
}

function setBanner(kind, text) {
  els.banner.className = `banner ${kind}`;
  els.banner.textContent = text || '';
  els.banner.hidden = !text;
}

// Display names: the API says "Skirmish A", we show "Çatışma A". Icon lookups keep the original name.
const label = (text) => String(text == null ? '' : text).replace(/skirmish/gi, 'Çatışma');

const pct = (value) => (value == null ? '–' : `${Math.round(value * 100)}%`);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function cell(text, className) {
  const td = document.createElement('td');
  if (text instanceof Node) td.append(text);
  else td.textContent = text;
  if (className) td.className = className;
  return td;
}

// ---------- Rendering ----------

function renderProfile(account, riotId, region, mmr) {
  els.profileName.textContent = `${account.name || riotId.name}#${account.tag || riotId.tag}`;
  const bits = [region.toUpperCase()];
  if (account.account_level) bits.push(`Level ${account.account_level}`);
  els.profileMeta.textContent = bits.join(' · ');

  const current = mmr && mmr.current_data;
  const rank = current && current.currenttierpatched;
  if (rank) {
    els.rankName.textContent = rank;
    const extra = [];
    if (current.ranking_in_tier != null) extra.push(`${current.ranking_in_tier} RR`);
    if (mmr.highest_rank && mmr.highest_rank.patched_tier) extra.push(`Peak ${mmr.highest_rank.patched_tier}`);
    els.rankMeta.textContent = extra.join(' · ');
  } else {
    els.rankName.textContent = 'Unranked';
    els.rankMeta.textContent = mmr ? 'No competitive rank this act' : 'Rank unavailable';
  }
  const icon = (rank && current.images && current.images.small) || iconFor('ranks', rank || 'Unranked');
  els.rankIcon.hidden = !icon;
  if (icon) els.rankIcon.src = icon;
}

function renderTiles(stats) {
  els.tileWinrate.textContent = pct(stats.winRate);
  const record = [`${stats.wins}W`, `${stats.losses}L`];
  if (stats.draws) record.push(`${stats.draws}D`);
  els.tileRecord.textContent = `${record.join(' ')} in ${stats.games} games`;
  els.tileKd.textContent = stats.kd.toFixed(2);
  els.tileKda.textContent = `${stats.kills} / ${stats.deaths} / ${stats.assists}`;
  els.tileAcs.textContent = Math.round(stats.acs);
  els.tileHs.textContent = pct(stats.hs);
}

function renderTable(matches) {
  els.tableBody.replaceChildren(...matches.map((m) => {
    const tr = document.createElement('tr');
    const badge = document.createElement('span');
    badge.className = `badge ${m.result}`;
    badge.textContent = m.result === 'unknown' ? '–' : `${capitalize(m.result)} ${m.roundsWon}–${m.roundsLost}`;
    tr.append(
      cell(m.date ? dateFormat.format(m.date) : '–'),
      cell(withIcon(iconFor('maps', m.map), label(m.map), 'map')),
      cell(withIcon(iconFor('agents', m.agent), m.agent, 'agent')),
      cell(label(m.mode)),
      cell(badge),
      cell(`${m.kills} / ${m.deaths} / ${m.assists}`, 'num'),
      cell((m.deaths ? m.kills / m.deaths : m.kills).toFixed(2), 'num'),
      cell(String(m.acs), 'num'),
      cell(m.shots ? `${Math.round((m.headshots / m.shots) * 100)}%` : '–', 'num'),
    );
    return tr;
  }));
}

function drawChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: { legend: { display: false } },
    ...extra,
  };
}

function rateChart(id, groups, iconKind) {
  const iconUrls = iconKind ? groups.map((g) => iconFor(iconKind, g.label)) : [];
  const showIcons = iconUrls.some(Boolean);
  drawChart(id, {
    plugins: showIcons ? [axisIconsPlugin(iconUrls)] : [],
    type: 'bar',
    data: {
      labels: groups.map((g) => `${label(g.label)} (${g.games})`),
      datasets: [{
        data: groups.map((g) => Math.round(g.rate * 100)),
        backgroundColor: groups.map((g) => (g.rate >= 0.5 ? COLORS.win : COLORS.loss)),
        borderRadius: 4,
        maxBarThickness: 22,
      }],
    },
    options: baseOptions({
      indexAxis: 'y',
      layout: { padding: { left: showIcons ? 26 : 0 } },
      scales: {
        x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` }, grid: { color: COLORS.grid } },
        y: { grid: { display: false }, ticks: { crossAlign: showIcons ? 'far' : 'near' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => `${item.raw}% win rate over ${groups[item.dataIndex].games} games` } },
      },
    }),
  });
}

function renderCharts(matches) {
  if (typeof Chart === 'undefined') {
    els.charts.hidden = true;
    return;
  }
  els.charts.hidden = false;
  Chart.defaults.color = COLORS.text;
  Chart.defaults.borderColor = COLORS.grid;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const ordered = [...matches].reverse();
  const labels = ordered.map((m) => label(m.map));
  const tooltipTitle = (items) => {
    const m = ordered[items[0].dataIndex];
    return `${label(m.map)} · ${m.agent}${m.date ? ` · ${dateFormat.format(m.date)}` : ''}`;
  };

  drawChart('chart-results', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: ordered.map((m) => m.roundsWon - m.roundsLost),
        backgroundColor: ordered.map((m) => COLORS[m.result]),
        borderRadius: 4,
      }],
    },
    options: baseOptions({
      scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: tooltipTitle,
            label: (item) => {
              const m = ordered[item.dataIndex];
              return m.result === 'unknown' ? 'No team result' : `${capitalize(m.result)} ${m.roundsWon}–${m.roundsLost}`;
            },
          },
        },
      },
    }),
  });

  drawChart('chart-acs', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: ordered.map((m) => m.acs),
        borderColor: COLORS.line,
        backgroundColor: 'rgba(90, 200, 250, 0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: ordered.map((m) => COLORS[m.result]),
        pointBorderColor: ordered.map((m) => COLORS[m.result]),
      }],
    },
    options: baseOptions({
      scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: tooltipTitle, label: (item) => `${item.raw} ACS` } },
      },
    }),
  });

  rateChart('chart-agents', winRateBy(matches, 'agent'), 'agents');
  rateChart('chart-maps', winRateBy(matches, 'map'));
}

// ---------- Search flow ----------

async function search(event) {
  if (event) event.preventDefault();
  const riotId = parseRiotId(els.riotId.value);
  if (!riotId) {
    setStatus('error', 'Enter your Riot ID as Name#Tag, for example Player#EUW.');
    return;
  }
  const mode = els.mode.value;
  let region = els.region.value;
  savePrefs({ riotId: els.riotId.value.trim(), region, mode });

  const token = ++searchToken;
  els.button.disabled = true;
  setStatus('loading', `Loading ${riotId.name}#${riotId.tag}…`);

  try {
    const account = (await api('account', riotId)).data || {};
    if (region === 'auto') region = String(account.region || '').toLowerCase();
    if (!REGIONS.includes(region)) {
      throw new Error("Couldn't detect this account's region. Pick it from the Region menu.");
    }

    const [mmrRes, matchesRes] = await Promise.allSettled([
      api('mmr', { ...riotId, region }),
      api('matches', { ...riotId, region, mode }),
    ]);
    if (token !== searchToken) return;
    if (matchesRes.status === 'rejected') throw matchesRes.reason;

    const raw = Array.isArray(matchesRes.value.data) ? matchesRes.value.data : [];
    const matches = raw.map((m) => normalizeMatch(m, riotId, account.puuid)).filter(Boolean);

    await assetsReady; // Usually done already; it loads in parallel with the API calls.
    if (token !== searchToken) return;

    renderProfile(account, riotId, region, mmrRes.status === 'fulfilled' ? mmrRes.value.data : null);
    els.results.hidden = false;

    if (!matches.length) {
      els.stats.hidden = true;
      setStatus('empty', mode ? 'No recent matches in this mode. Try "All modes".' : 'No recent matches found.');
      return;
    }

    els.stats.hidden = false;
    setStatus('', '');
    renderTiles(computeStats(matches));
    renderTable(matches);
    renderCharts(matches);
  } catch (err) {
    if (token !== searchToken) return;
    els.results.hidden = true;
    setStatus('error', err.message);
  } finally {
    if (token === searchToken) els.button.disabled = false;
  }
}

async function checkServer() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    if (status.demo) setBanner('info', 'Demo mode: showing generated sample data. Search any Name#Tag.');
    else if (!status.hasKey) setBanner('warn', 'No API key set. Add HENRIK_API_KEY to the .env file and restart the server, or run "npm run demo".');
    return true;
  } catch {
    setBanner('warn', "Can't reach the local server. Start it with \"npm start\" and open http://localhost:3000.");
    return false;
  }
}

async function init() {
  const $ = (id) => document.getElementById(id);
  els = {
    form: $('search'),
    riotId: $('riot-id'),
    region: $('region'),
    mode: $('mode'),
    button: document.querySelector('#search button'),
    banner: $('banner'),
    status: $('status'),
    results: $('results'),
    stats: $('stats'),
    charts: $('charts'),
    profileName: $('profile-name'),
    profileMeta: $('profile-meta'),
    rankName: $('rank-name'),
    rankMeta: $('rank-meta'),
    rankIcon: $('rank-icon'),
    tileWinrate: $('tile-winrate'),
    tileRecord: $('tile-record'),
    tileKd: $('tile-kd'),
    tileKda: $('tile-kda'),
    tileAcs: $('tile-acs'),
    tileHs: $('tile-hs'),
    tableBody: document.querySelector('#matches tbody'),
  };

  assetsReady = loadAssets();
  els.rankIcon.addEventListener('error', () => { els.rankIcon.hidden = true; });

  const prefs = loadPrefs();
  if (prefs.riotId) els.riotId.value = prefs.riotId;
  if (prefs.region) els.region.value = prefs.region;
  if (prefs.mode != null) els.mode.value = prefs.mode;

  els.form.addEventListener('submit', search);
  els.mode.addEventListener('change', () => { if (parseRiotId(els.riotId.value)) search(); });

  const serverUp = await checkServer();
  if (serverUp && prefs.riotId) search();
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}
