'use strict';

const MAX_ON_CHART = 8;
const POS_SHORT = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Forward: 'FWD' };
const POS_ORDER = { Goalkeeper: 1, Defender: 2, Midfielder: 3, Forward: 4 };
const DEFAULT_FORM_WEEKS = 5;

let players = new Map();   // id -> player
let fixtures = {};         // team short name -> next few fixtures, each with a 1-5 difficulty
let gameweeks = 0;
let selected = new Map();  // id -> colour slot (1-8); a player keeps their colour while on the chart
let teamPicks = [];
let team = null;           // loaded team details: name, bank, rank...
let league = null;         // loaded mini league: standings + everyone's picks
let rival = null;          // entry ID of one rival to compare against, or null for everyone
let tab = 'all';
let formWeeks = DEFAULT_FORM_WEEKS; // how many recent gameweeks count as "form"; saved per team
let savedTeams = [];       // [{ name, id, formWeeks }] shared by everyone in the house
let view = 'total';        // 'total' = running totals, 'gw' = points per gameweek bars, 'avg' = vs league average (league only)
let sort = { key: 'total', dir: -1 };
let chart;

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fixed = (n, d = 1) => (n == null ? '–' : n.toFixed(d));
const text = (v) => (typeof v === 'function' ? v() : v); // help text can depend on settings

// ---------- Player stats ----------

// Extra numbers worked out from the raw data, once, when it loads.
function addStats(p) {
  const pts = p.points;
  const total = pts.at(-1) ?? 0;
  p.total = total;
  p.form = total - (pts[pts.length - 1 - formWeeks] ?? 0);
  p.value = p.cost ? total / p.cost : 0;
  p.minutes ??= 0;
  p.minsPct = gameweeks ? Math.min(100, (p.minutes / (gameweeks * 90)) * 100) : 0;
  p.xgi90 = p.minutes >= 90 ? (p.xgi / p.minutes) * 90 : null;
  p.unlucky = (p.xgi ?? 0) - ((p.goals ?? 0) + (p.assists ?? 0));
  p.available = !['i', 's', 'u'].includes(p.status);
  p.posOrder = POS_ORDER[p.pos] ?? 9;
  // Defenders and keepers care about goals conceded; everyone else about goals scored.
  const side = p.posOrder <= 2 ? 'def' : 'att';
  p.fixtures = (fixtures[p.team] ?? []).map((f) => ({ ...f, diff: f[side] }));
  p.run = p.fixtures.length ? p.fixtures.reduce((sum, f) => sum + f.diff, 0) / p.fixtures.length : null;
}

const DIFF_WORDS = ['', 'Very easy', 'Easy', 'Medium', 'Hard', 'Very hard'];

// Coloured opponent chips. CAPITALS = home game, small letters = away.
function fixtureChips(p, mini = false) {
  const wrap = el('span', mini ? 'fx-row mini' : 'fx-row');
  for (const f of p.fixtures.slice(0, 5)) {
    const label = f.home ? f.opp : f.opp.toLowerCase();
    const chip = el('span', `fx d${f.diff}`, mini ? '' : label);
    chip.title = `GW${f.gw}: ${f.oppName} (${f.home ? 'home' : 'away'}) · ${DIFF_WORDS[f.diff]}`;
    wrap.append(chip);
  }
  return wrap;
}

// Each column: what it shows, how to sort it, and a plain-English explanation.
const COLUMNS = [
  { key: 'cost',     label: 'Price',  show: (p) => (p.cost ? `£${fixed(p.cost)}` : '–'),
    help: 'What the player costs right now, in millions.' },
  { key: 'total',    label: 'Pts',    show: (p) => p.total, cls: 'num pts',
    help: 'Total points this season.' },
  { key: 'form',     label: 'Form',   show: (p) => p.form,
    help: () => `Points in the last ${formWeeks} gameweeks. Shows who is hot right now. Change this in the My team tab.` },
  { key: 'predNext', label: 'Next',   show: (p) => fixed(p.predNext),
    help: "FPL's own guess at how many points they'll score next gameweek." },
  { key: 'value',    label: 'Value',  show: (p) => fixed(p.value),
    help: 'Points for every £1m of price. Higher means more points for your money.' },
  { key: 'xgi90',    label: 'Threat', show: (p) => fixed(p.xgi90, 2),
    help: 'Expected goals + assists per 90 minutes. How dangerous their chances are, even if they missed them.' },
  { key: 'minsPct',  label: 'Plays',  show: (p) => `${Math.round(p.minsPct)}%`,
    help: 'Share of all possible minutes they have played. Low means they might be on the bench.' },
  { key: 'own',      label: 'Owned',  show: (p) => `${fixed(p.own)}%`,
    help: 'Percentage of all FPL teams that own this player. Low = a "differential" that can help you catch up.' },
  { key: 'run',      label: 'Run',    show: (p) => fixed(p.run), dir: 1,
    help: 'How hard their next 5 games are: 1 = very easy, 5 = very hard. Attackers are judged on goals their team should score, defenders on goals they should let in.' },
  { key: null,       label: 'Next 5 games', show: (p) => fixtureChips(p), cls: 'fx-cell',
    help: 'Upcoming opponents. CAPITALS = home game, small letters = away. Green = easy, red = hard. Hover for details.' },
];

// Small coloured tag for players who are injured, doubtful, suspended or gone.
function statusFlag(p) {
  const tags = {
    d: ['warn', p.chance != null ? `${p.chance}%` : 'Doubt'],
    i: ['bad', 'Injured'],
    s: ['bad', 'Banned'],
    u: ['bad', 'Out'],
  };
  const tag = tags[p.status];
  if (!tag) return null;
  const f = el('span', `flag ${tag[0]}`, tag[1]);
  f.title = p.news || 'Not available';
  return f;
}

// ---------- Chart ----------

// Draws a dashed vertical guide line at the hovered gameweek.
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(c) {
    const active = c.tooltip?.getActiveElements();
    if (view !== 'total' || !active?.length) return;
    const x = active[0].element.x;
    const { top, bottom } = c.chartArea;
    const ctx = c.ctx;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function freeSlot() {
  const used = new Set(selected.values());
  for (let s = 1; s <= MAX_ON_CHART; s++) if (!used.has(s)) return s;
  return null;
}

function buildChart() {
  Chart.defaults.font.family = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 11;
  chart = new Chart($('chart'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    plugins: [crosshair],
    options: {
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, right: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          padding: 12,
          cornerRadius: 10,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 6,
          usePointStyle: true,
          titleFont: { weight: '500', size: 11 },
          bodyFont: { size: 12 },
          titleMarginBottom: 8,
          caretSize: 0,
          callbacks: {
            label: (i) => ` ${i.dataset.label}   ${view === 'avg' && i.parsed.y > 0 ? '+' : ''}${i.parsed.y} pts`,
            labelPointStyle: () => ({ pointStyle: 'rectRounded', rotation: 0 }),
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { maxTicksLimit: 6, padding: 8 } },
      },
    },
  });
  applyTheme();
}

// Colours come from CSS, so light/dark mode only needs defining once in style.css.
function applyTheme() {
  const muted = css('--muted');
  Object.assign(chart.options.scales.x, { border: { color: css('--axis') }, ticks: { color: muted, padding: 6 } });
  chart.options.scales.y.grid = { color: (c) => (view === 'avg' && c.tick?.value === 0 ? css('--axis') : css('--grid')) };
  chart.options.scales.y.border = { display: false };
  chart.options.scales.y.ticks.color = muted;
  Object.assign(chart.options.plugins.tooltip, {
    backgroundColor: css('--surface'),
    borderColor: css('--line'),
    borderWidth: 1,
    titleColor: muted,
    bodyColor: css('--text'),
  });
  drawChart();
}

// Points scored in each gameweek, worked out from the running totals.
const perGameweek = (totals) => totals.map((t, i) => t - (totals[i - 1] ?? 0));

function lineDataset(label, data, colour) {
  return {
    type: 'line',
    label,
    data,
    borderColor: colour,
    backgroundColor: colour,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBorderColor: css('--surface'),
    pointHoverBorderWidth: 2,
    cubicInterpolationMode: 'monotone',
  };
}

function barDataset(label, data, colour) {
  return {
    type: 'bar',
    label,
    data,
    backgroundColor: colour,
    borderColor: css('--surface'),
    borderWidth: { left: 1, right: 1 },
    borderRadius: 4,
    borderSkipped: 'start',
    categoryPercentage: 0.8,
    barPercentage: 1,
  };
}

// On the My league tab the chart shows the league race; everywhere else, the chosen players.
const raceMode = () => tab === 'league';

// Each series: { key, label, totals (season total after each GW), slot (colour), removable }
function playerSeries() {
  return [...selected].map(([id, slot]) => {
    const p = players.get(id);
    return { key: id, label: p.name, totals: p.points, slot, removable: true };
  });
}

function raceWeeks() {
  return Math.max(0, ...(league?.managers ?? []).flatMap((m) => m.history.map((h) => h.gw)));
}

// Season total after each gameweek, 0 before a manager joined.
function managerTotals(m, weeks) {
  const byGw = new Map(m.history.map((h) => [h.gw, h.total]));
  let last = 0;
  return Array.from({ length: weeks }, (_, i) => (last = byGw.get(i + 1) ?? last));
}

// You plus the top of the table, up to 8 lines. You always get the first colour.
function raceSeries() {
  if (!league) return [];
  const weeks = raceWeeks();
  const me = league.managers.find((m) => m.entry === team?.id);
  const racers = [...(me ? [me] : []), ...league.managers.filter((m) => m !== me)].slice(0, MAX_ON_CHART);
  const nameCount = {};
  for (const m of league.managers) nameCount[m.team] = (nameCount[m.team] ?? 0) + 1;
  return racers.map((m, i) => ({
    key: m.entry,
    label: nameCount[m.team] > 1 ? `${m.team} (${m.player.split(' ')[0]})` : m.team,
    totals: managerTotals(m, weeks),
    slot: i + 1,
    isMe: m === me,
  }));
}

// League average total after each gameweek (everyone in the league, not just those on the chart).
function leagueAverage(weeks) {
  const all = league.managers.map((m) => managerTotals(m, weeks));
  return Array.from({ length: weeks }, (_, i) => all.reduce((sum, t) => sum + t[i], 0) / all.length);
}

const TITLES = {
  players: { total: 'Cumulative points', gw: 'Points per gameweek' },
  race: { total: 'League race', gw: 'League points per gameweek', avg: 'League race vs average' },
};
const CAPTIONS = {
  total: 'Total points',
  gw: 'Points scored that gameweek',
  avg: 'Points above (+) or below (−) the league average',
};

function drawChart() {
  const race = raceMode();
  if (!race && view === 'avg') view = 'total';
  for (const t of document.querySelectorAll('.tab[data-view]')) {
    t.hidden = t.dataset.view === 'avg' && !race;
    t.classList.toggle('active', t.dataset.view === view);
    t.setAttribute('aria-selected', t.dataset.view === view);
  }
  $('chart-title').textContent = TITLES[race ? 'race' : 'players'][view];
  $('axis-caption').textContent = CAPTIONS[view];

  const series = race ? raceSeries() : playerSeries();
  const weeks = race ? raceWeeks() : gameweeks;
  let values = (s) => s.totals;
  if (view === 'gw') values = (s) => perGameweek(s.totals);
  if (view === 'avg' && league) {
    const avg = leagueAverage(weeks);
    values = (s) => s.totals.map((t, i) => Math.round((t - avg[i]) * 10) / 10);
  }

  chart.data.labels = Array.from({ length: weeks }, (_, i) => `GW${i + 1}`);
  chart.data.datasets = series.map((s) => (view === 'gw' ? barDataset : lineDataset)(s.label, values(s), css(`--s${s.slot}`)));
  chart.options.scales.x.offset = view === 'gw';
  chart.options.scales.y.beginAtZero = view !== 'avg';
  chart.update();

  const empty = $('chart-empty');
  empty.hidden = series.length > 0;
  if (!series.length) {
    const msg = race
      ? ['No league yet', team ? 'Choose a league on the right.' : 'Choose a team in the My team tab first.']
      : ['No players yet', 'Click any player to add them to the chart (up to 8).'];
    empty.replaceChildren(el('strong', '', msg[0]), el('span', '', msg[1]));
  }
  $('clear-chart').hidden = race || selected.size === 0;
  drawLegend(series);
  drawStats(series, race);
  markSelected();
}

function drawLegend(series) {
  const items = series.map((s) => {
    const li = el('li');
    const swatch = el('span', 'swatch');
    swatch.style.setProperty('--c', `var(--s${s.slot})`);
    li.append(swatch, el('span', s.isMe ? 'me' : '', s.isMe ? `${s.label} (you)` : s.label));
    if (s.removable) {
      const x = el('button', '', '×');
      x.title = 'Remove from chart';
      x.onclick = () => toggle(s.key);
      li.append(x);
    }
    return li;
  });
  $('legend').replaceChildren(...items);
}

function drawStats(series, race) {
  $('stat-gw').textContent = gameweeks ? `GW${gameweeks}` : '–';
  if (race) {
    const leader = league?.managers[0];
    $('stat-count-label').textContent = 'Managers on chart';
    $('stat-count').textContent = league ? `${series.length} of ${league.managers.length}` : '–';
    $('stat-leader-label').textContent = 'League leader';
    $('stat-leader').textContent = leader ? `${leader.team} · ${leader.total}` : '–';
    return;
  }
  $('stat-count-label').textContent = 'On chart';
  $('stat-count').textContent = `${selected.size} / ${MAX_ON_CHART}`;
  $('stat-leader-label').textContent = 'Leader on chart';
  let leader = null;
  for (const id of selected.keys()) {
    const p = players.get(id);
    if (!leader || p.total > leader.total) leader = p;
  }
  $('stat-leader').textContent = leader ? `${leader.name} · ${leader.total}` : '–';
}

function toggle(id) {
  if (selected.has(id)) {
    selected.delete(id);
  } else {
    const slot = freeSlot();
    if (!slot) return alert(`You can compare up to ${MAX_ON_CHART} players. Remove one first.`);
    selected.set(id, slot);
  }
  drawChart();
}

function setView(name) {
  view = name;
  drawChart();
}

// ---------- Filters ----------

function passesFilters(p, withSearch = true) {
  const pos = $('pos').value;
  const maxPrice = Number.parseFloat($('max-price').value);
  if (pos && p.pos !== pos) return false;
  if (maxPrice && p.cost > maxPrice) return false;
  if (!withSearch) return true;
  const q = $('search').value.trim().toLowerCase();
  return !q || p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q);
}

// ---------- Player table ----------

function drawHead(id, sortable) {
  const cells = [el('span'), el('span', '', 'Player')];
  for (const col of COLUMNS) {
    const canSort = sortable && col.key;
    const cell = canSort ? el('button', sort.key === col.key ? 'sorted' : '', col.label) : el('span', '', col.label);
    cell.title = text(col.help);
    if (canSort) {
      if (sort.key === col.key) cell.textContent += sort.dir < 0 ? ' ↓' : ' ↑';
      cell.onclick = () => {
        const dir = sort.key === col.key ? -sort.dir : (col.dir ?? -1);
        sort = { key: col.key, dir };
        drawHead('all-head', true);
        drawAllList();
      };
    }
    cells.push(cell);
  }
  $(id).replaceChildren(...cells);
}

function playerRow(p, pick = {}) {
  const li = el('li');
  li.dataset.id = p.id;
  if (pick.bench) li.classList.add('bench');

  const who = el('span', 'who');
  const name = el('span', 'name', p.name);
  if (pick.captain) name.append(el('span', 'badge', 'C'));
  const flag = statusFlag(p);
  if (flag) name.append(flag);
  who.append(name, el('span', 'team', `${p.team} · ${POS_SHORT[p.pos] ?? p.pos}`));

  li.append(el('span', 'check'), who);
  for (const col of COLUMNS) {
    const value = col.show(p);
    li.append(value instanceof Node ? value : el('span', col.cls ?? 'num', value));
  }
  li.onclick = () => toggle(p.id);
  return li;
}

function drawAllList() {
  const { key, dir } = sort;
  const list = [...players.values()]
    .filter((p) => passesFilters(p))
    .sort((a, b) => {
      if (a[key] == null) return 1;
      if (b[key] == null) return -1;
      return (a[key] - b[key]) * dir || b.total - a.total;
    });
  $('all-list').replaceChildren(...list.map((p) => playerRow(p)));
  markSelected();
}

function drawTeamList() {
  const rows = [];
  teamPicks.forEach((pick, i) => {
    const p = players.get(pick.id);
    if (!p) return;
    if (i === 11) rows.push(el('li', 'divider', 'Bench'));
    rows.push(playerRow(p, pick));
  });
  $('team-list').replaceChildren(...rows);
  markSelected();
}

function drawKey() {
  const items = COLUMNS.flatMap((c) => [el('dt', '', c.label), el('dd', '', text(c.help))]);
  $('key-list').replaceChildren(...items);
}

// ---------- Quick picks ----------

const PICKS = [
  {
    title: 'Hot + easy games',
    help: () => `In form (last ${formWeeks} GWs) with easy games coming up.`,
    keep: (p) => p.run != null,
    rank: (p) => p.form * (3 / p.run),
    show: (p) => `${p.form} pts`,
    sub: (p) => fixtureChips(p, true),
  },
  {
    title: 'Best value',
    help: 'Most points for every £1m. Only players who play most weeks.',
    keep: (p) => p.minsPct >= 50,
    rank: (p) => p.value,
    show: (p) => fixed(p.value),
  },
  {
    title: 'Due a goal',
    help: 'Getting great chances but not scoring yet. Goals often follow.',
    keep: (p) => p.minsPct >= 50 && p.unlucky > 0,
    rank: (p) => p.unlucky,
    show: (p) => `+${fixed(p.unlucky)}`,
  },
  {
    title: 'Hidden gems',
    help: 'In form, but under 10% of teams own them. Great for catching up.',
    keep: (p) => p.own < 10,
    rank: (p) => p.form,
    show: (p) => `${p.form} pts`,
    sub: (p) => `${p.team} · ${fixed(p.own)}%`,
  },
];

// One card of up to 5 clickable players. items: [{ p, name?, sub, value, onClick? }]
function pickCard(title, help, items, empty = 'Nothing to show.') {
  const ol = el('ol');
  for (const it of items) {
    const li = el('li');
    li.dataset.id = it.p.id;
    const nm = el('span', 'nm');
    nm.append(el('b', '', it.name ?? it.p.name), it.sub instanceof Node ? it.sub : el('small', '', it.sub));
    li.append(el('span', 'dot'), nm, el('span', 'v', it.value ?? ''));
    li.onclick = it.onClick ?? (() => toggle(it.p.id));
    ol.append(li);
  }
  if (!items.length) ol.append(el('li', 'none', empty));
  const card = el('div', 'pick');
  card.append(el('h3', '', title), el('p', '', help), ol);
  return card;
}

function drawPicks() {
  const pool = [...players.values()].filter((p) => p.available && passesFilters(p, false));
  const cards = PICKS.map((pick) => {
    const top = pool
      .filter((p) => !pick.keep || pick.keep(p))
      .sort((a, b) => pick.rank(b) - pick.rank(a))
      .slice(0, 5);
    const items = top.map((p) => ({
      p,
      sub: pick.sub ? pick.sub(p) : `${p.team} · £${fixed(p.cost)}m`,
      value: pick.show(p),
    }));
    return pickCard(pick.title, text(pick.help), items);
  });
  $('picks').replaceChildren(...cards);

  const pos = $('pos').selectedOptions[0].textContent;
  const price = $('max-price').value ? ` · ${$('max-price').selectedOptions[0].textContent}` : '';
  $('picks-pos').textContent = `· ${pos}${price}`;
  markSelected();
}

// ---------- Team advice ----------

// "In form with easy games coming up" - used for quick picks and transfer ideas.
const hotEasy = (p) => (p.run ? p.form * (3 / p.run) : p.form);

function squad() {
  return teamPicks.filter((pk) => players.has(pk.id)).map((pk) => ({ ...pk, p: players.get(pk.id) }));
}

function nextGame(p) {
  const f = p.fixtures[0];
  return f ? `${f.home ? 'vs' : 'at'} ${f.opp} · ${DIFF_WORDS[f.diff].toLowerCase()}` : 'no game';
}

// Best captain: FPL's predicted points, nudged up for an easy game and down for a hard one.
function captainCard(mine) {
  const score = (p) => (p.predNext ?? 0) * (1 + (3 - (p.fixtures[0]?.diff ?? 3)) * 0.1);
  const top = mine
    .filter((m) => !m.bench && m.p.available)
    .sort((a, b) => score(b.p) - score(a.p))
    .slice(0, 3);
  const roles = ['Captain', 'Vice', 'Next best'];
  const items = top.map((m, i) => ({
    p: m.p,
    sub: `${roles[i]} · ${nextGame(m.p)}`,
    value: `${fixed(m.p.predNext)} pts`,
  }));
  return pickCard('Captain', 'Who to give the armband. Uses predicted points and how easy the next game is.', items);
}

// A same-price-or-cheaper player (up to £1m less) who has scored at least 1 point a week more.
// Players in the top third of their position for form are left alone - they're doing their job.
function cheaperAndBetter(p) {
  const regular = [...players.values()].filter((q) => q.pos === p.pos && q.available && q.minsPct >= 50);
  if (regular.filter((q) => q.form > p.form).length < regular.length / 3) return null;
  const alt = regular
    .filter((q) => q.id !== p.id && q.cost <= p.cost && q.cost >= p.cost - 1)
    .sort((a, b) => b.form - a.form)[0];
  return alt && alt.form - p.form >= formWeeks ? alt : null;
}

// Players who might cost you points, with the reasons in plain words.
function worries(mine) {
  const list = [];
  for (const m of mine) {
    const p = m.p;
    if (m.bench && p.pos === 'Goalkeeper') continue; // a backup keeper not playing is normal
    const why = [];
    let level = 0;
    if (['i', 's', 'u'].includes(p.status)) { why.push({ i: 'Injured', s: 'Suspended', u: 'Not available' }[p.status]); level += 3; }
    if (p.status === 'd') { why.push(p.chance != null ? `${p.chance}% chance to play` : 'Doubtful'); level += 2; }
    if (p.available && gameweeks >= 3 && p.minsPct < 50) { why.push('Not playing much'); level += 1.5; }
    if (p.available && p.form <= formWeeks * 1.5) { why.push(`Only ${p.form} pts in ${formWeeks} GWs`); level += 1; }
    const alt = p.available ? cheaperAndBetter(p) : null;
    if (alt) { why.push(`${alt.name} scored ${alt.form - p.form} more (£${fixed(alt.cost)}m)`); level += 1; }
    if (p.run >= 3.8) { why.push('Hard games next'); level += 1; }
    if (level) list.push({ ...m, why, alt, level: m.bench ? level / 2 : level });
  }
  return list.sort((a, b) => b.level - a.level);
}

// Clicking a worry compares it with the player named in the reason, or else the suggested swap.
function worriesCard(list) {
  const items = list.slice(0, 5).map((w) => {
    const partner = w.alt ?? w.swap;
    return {
      p: w.p,
      sub: w.why.join(' · '),
      value: w.bench ? 'bench' : '',
      onClick: partner ? () => compare([w.p.id, partner.id]) : undefined,
    };
  });
  return pickCard('Worries', 'Players who might cost you points. Click to compare with a better option.', items, 'No worries. Nice squad!');
}

// For each worry, the best in-form, easy-fixture swap you can afford.
function transfersCard(mine, list) {
  const owned = new Set(mine.map((m) => m.p.id));
  const clubCount = {};
  for (const m of mine) clubCount[m.p.team] = (clubCount[m.p.team] ?? 0) + 1;

  const items = [];
  const used = new Set();
  for (const w of list) {
    if (items.length >= 4) break;
    const out = w.p;
    const budget = out.cost + (team?.bank ?? 0);
    const best = [...players.values()]
      .filter((p) => p.pos === out.pos && p.available && !owned.has(p.id) && !used.has(p.id))
      .filter((p) => p.cost <= budget + 0.001 && p.minsPct >= 50)
      .filter((p) => p.team === out.team || (clubCount[p.team] ?? 0) < 3)
      .sort((a, b) => hotEasy(b) - hotEasy(a))[0];
    if (!best || hotEasy(best) <= hotEasy(out)) continue;
    used.add(best.id);
    w.swap = best; // lets the worries card compare against the same player
    items.push({
      p: best,
      name: `${out.name} → ${best.name}`,
      sub: `${best.team} · £${fixed(best.cost)}m · ${best.form} pts last ${formWeeks} GWs`,
      value: `${best.form} pts`,
      onClick: () => compare([out.id, best.id]),
    });
  }
  return pickCard(
    'Transfer ideas',
    'Swaps for your worries that fit your budget. Click to compare both on the chart.',
    items,
    'No obvious upgrades right now.',
  );
}

// Headline numbers for the loaded team, shown above the team table.
function drawTeamStats() {
  const box = $('team-stats');
  box.hidden = !team;
  if (!team) return;
  const xi = squad().filter((m) => !m.bench);
  const captain = xi.find((m) => m.captain);
  const predicted = xi.reduce((sum, m) => sum + (m.p.predNext ?? 0), 0) + (captain?.p.predNext ?? 0);
  const facts = [
    ['Bank', `£${fixed(team.bank)}m`, 'Money left to spend on transfers.'],
    ['Squad value', `£${fixed(team.value)}m`, 'What your 15 players are worth.'],
    [`GW${team.gw} points`, team.gwPoints ?? '–', 'Points scored in the latest gameweek.'],
    ['Overall rank', team.rank ? team.rank.toLocaleString() : '–', 'Your position among every FPL team in the world.'],
    ['Predicted next', `${fixed(predicted, 0)} pts`, "FPL's predicted points for your starting XI next gameweek (captain counted twice)."],
  ];
  box.replaceChildren(...facts.map(([label, value, help]) => {
    const stat = el('div', 'stat');
    stat.title = help;
    stat.append(el('span', 'label', label), el('span', 'value', value));
    return stat;
  }));
}

function drawAdvice() {
  $('picks-pos').textContent = team ? `· ${team.name}` : '';
  if (!team) {
    const note = el('p', 'msg', 'Choose a team in the My team tab to see advice.');
    $('advice').replaceChildren(note);
    return;
  }
  const mine = squad();
  const list = worries(mine);
  const transfers = transfersCard(mine, list); // first, so each worry knows its suggested swap
  $('advice').replaceChildren(captainCard(mine), worriesCard(list), transfers);
  markSelected();
}

// Show exactly these players on the chart (e.g. a transfer: out vs in).
function compare(ids) {
  selected = new Map(ids.map((id, i) => [id, i + 1]));
  drawChart();
}

// Highlight anything that's on the chart, in every list.
function markSelected() {
  for (const li of document.querySelectorAll('.player-list li[data-id], .pick li[data-id]')) {
    const slot = selected.get(Number(li.dataset.id));
    li.classList.toggle('on', !!slot);
    li.firstChild.style.setProperty('--c', slot ? `var(--s${slot})` : '');
  }
}

function showTab(name) {
  tab = name;
  for (const t of document.querySelectorAll('.tab[data-tab]')) {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  }
  for (const t of ['all', 'team', 'league']) $(`tab-${t}`).hidden = name !== t;
  $('list-filters').hidden = name !== 'all';

  // The panel under the chart follows the tab.
  $('picks').hidden = name !== 'all';
  $('advice').hidden = name !== 'team';
  $('league-advice').hidden = name !== 'league';
  $('picks-title').textContent = { all: 'Quick picks', team: 'Team advice', league: 'League advice' }[name];
  if (name === 'all') drawPicks();
  if (name === 'team') drawAdvice();
  if (name === 'league') {
    if (team && !league) loadLeague();
    else drawLeague();
  }
  drawChart();
}

// ---------- My team ----------

async function loadTeam(id) {
  const msg = $('team-msg');
  msg.className = 'msg';
  msg.textContent = 'Loading…';
  try {
    const res = await fetch(`api/team.php?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load team.');
    teamPicks = data.picks;
    team = { ...data, id: Number(id) };
    formWeeks = savedFormWeeks(id);
    $('form-weeks').value = formWeeks;
    players.forEach(addStats);
    msg.className = 'msg team-name';
    msg.textContent = `${data.name} · GW${data.gw} picks`;
    $('chart-team').hidden = false;
    try { localStorage.setItem('fplTeamId', id); } catch {}
  } catch (e) {
    teamPicks = [];
    team = null;
    msg.textContent = e.message;
    $('chart-team').hidden = true;
  }
  drawTeamList();
  drawTeamStats();
  setFormWeeks(formWeeks);
  league = null;
  rival = null;
  fillLeagues();
  showTab(tab);
}

// ---------- Saved household teams ----------

async function saveTeams(list) {
  const res = await fetch('api/teams.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not save.');
  savedTeams = data;
  drawSavedTeams();
}

function drawSavedTeams() {
  const pick = $('team-pick');
  const current = pick.value;
  const options = savedTeams.map((t) => {
    const o = el('option', '', t.name);
    o.value = t.id;
    return o;
  });
  if (!savedTeams.length) options.push(el('option', '', 'No teams yet'));
  pick.replaceChildren(...options);
  if (savedTeams.some((t) => String(t.id) === current)) pick.value = current;

  const rows = savedTeams.map((t, i) => {
    const li = el('li');
    const x = el('button', '', '×');
    x.title = `Remove ${t.name}`;
    x.onclick = () => saveTeams(savedTeams.filter((_, j) => j !== i)).catch((e) => alert(e.message));
    li.append(el('span', '', t.name), el('span', 'dim', t.id), x);
    return li;
  });
  $('saved-teams').replaceChildren(...rows);
}

async function initSavedTeams() {
  try {
    savedTeams = await (await fetch('api/teams.php')).json();
  } catch {
    savedTeams = [];
  }
  let last = null;
  try { last = localStorage.getItem('fplTeamId'); } catch {}
  drawSavedTeams();
  if (savedTeams.some((t) => String(t.id) === last)) $('team-pick').value = last;
  if (!savedTeams.length) $('team-editor').hidden = false;
  else loadTeam($('team-pick').value);
}

// Change the form window and redraw everything that uses form.
function setFormWeeks(n) {
  formWeeks = n;
  $('form-weeks').value = n;
  players.forEach(addStats);
  $('season-info').textContent = `Season 2026/27 · Data up to GW${gameweeks} · Form = last ${formWeeks} GWs`;
  drawKey();
  drawHead('all-head', true);
  drawHead('team-head', false);
  drawAllList();
  drawTeamList();
  showTab(tab);
}

// The chosen team's saved form window (or the default).
function savedFormWeeks(id) {
  return savedTeams.find((t) => String(t.id) === String(id))?.formWeeks ?? DEFAULT_FORM_WEEKS;
}

// ---------- Mini league ----------

function fillLeagues() {
  const leagues = team?.leagues ?? [];
  const options = leagues.map((l) => {
    const o = el('option', '', `${l.name} (${l.size} teams)`);
    o.value = l.id;
    return o;
  });
  if (!leagues.length) options.push(el('option', '', team ? 'No private leagues' : 'No team chosen'));
  $('league-pick').replaceChildren(...options);
  // Start on the last league used, otherwise the smallest one with rivals in it (likely the family league).
  let last = null;
  try { last = localStorage.getItem('fplLeagueId'); } catch {}
  const smallest = leagues.filter((l) => l.size > 1).sort((a, b) => a.size - b.size)[0];
  if (leagues.some((l) => String(l.id) === last)) $('league-pick').value = last;
  else if (smallest) $('league-pick').value = smallest.id;
  if (!leagues.length) $('league-list').replaceChildren();
  let msg = '';
  if (!team) msg = 'Choose a team in the My team tab first.';
  else if (!leagues.length) msg = 'This team is not in any private leagues.';
  $('league-msg').textContent = msg;
}

async function loadLeague() {
  const id = $('league-pick').value;
  if (!team || !Number(id)) return drawLeague();
  $('league-msg').textContent = 'Loading everyone’s teams…';
  try {
    const res = await fetch(`api/league.php?id=${encodeURIComponent(id)}&gw=${team.gw}`);
    const data = await res.json();
    if ($('league-pick').value !== id) return; // a different league was chosen while this one loaded
    if (!res.ok) throw new Error(data.error || 'Could not load league.');
    league = data;
    rival = null;
    try { localStorage.setItem('fplLeagueId', id); } catch {}
    $('league-msg').textContent = data.more ? 'Big league: showing the top 50 only.' : '';
  } catch (e) {
    league = null;
    $('league-msg').textContent = e.message;
  }
  drawLeague();
}

function drawLeague() {
  drawStandings();
  drawLeagueAdvice();
  if (raceMode()) drawChart();
}

function drawStandings() {
  if (!league) return $('league-list').replaceChildren();
  const me = league.managers.find((m) => m.entry === team?.id);
  const raceSlots = new Map(raceSeries().map((r) => [r.key, r.slot]));
  const rows = league.managers.map((m) => {
    const li = el('li');
    const isMe = m === me;
    li.classList.toggle('me', isMe);
    li.classList.toggle('on', m.entry === rival);

    const moved = m.lastRank ? m.lastRank - m.rank : 0;
    const rank = el('span', 'rank', m.rank);
    if (moved) rank.append(el('small', moved > 0 ? 'up' : 'down', moved > 0 ? '▲' : '▼'));

    const who = el('span', 'who');
    const name = el('span', 'name', m.team);
    const slot = raceSlots.get(m.entry);
    if (slot) {
      const dot = el('span', 'race-dot');
      dot.style.setProperty('--c', `var(--s${slot})`);
      dot.title = 'On the league race chart';
      name.prepend(dot);
    }
    if (isMe) name.append(el('span', 'badge', 'You'));
    if (m.chip) name.append(el('span', 'flag warn', m.chip.replace('3xc', 'triple captain').replace('bboost', 'bench boost')));
    who.append(name, el('span', 'team', m.player));

    const gap = me && !isMe ? m.total - me.total : null;
    let gapText = '–';
    if (gap != null) gapText = gap > 0 ? `+${gap}` : `${gap}`.replace('-', '−');
    li.append(rank, who, el('span', 'num', m.gwPoints), el('span', 'num pts', m.total), el('span', 'num gap', gapText));

    if (!isMe) {
      li.title = 'Click to compare against just this team';
      li.onclick = () => {
        rival = rival === m.entry ? null : m.entry;
        drawLeague();
      };
    }
    return li;
  });
  $('league-list').replaceChildren(...rows);
}

// How many of the rivals have each player playing (not benched), and captained.
function rivalOwnership(rivals) {
  const stats = new Map();
  for (const r of rivals) {
    for (const pk of r.picks) {
      if (!pk.multiplier) continue;
      const s = stats.get(pk.id) ?? { owners: 0, caps: 0, eo: 0 };
      s.owners++;
      s.eo += pk.multiplier;
      if (pk.multiplier >= 2) s.caps++;
      stats.set(pk.id, s);
    }
  }
  return stats;
}

function drawLeagueAdvice() {
  const box = $('league-advice');
  if (!team || !league) {
    $('picks-pos').textContent = '';
    box.replaceChildren(el('p', 'msg', team ? 'Choose a league to compare against your rivals.' : 'Choose a team in the My team tab first.'));
    return;
  }
  const rivals = league.managers.filter((m) => m.entry !== team.id && (!rival || m.entry === rival));
  const n = rivals.length;
  const focus = rival ? rivals[0]?.team : null;
  $('picks-pos').textContent = focus ? `· vs ${focus}` : `· vs ${n} rivals (GW${league.gw} teams)`;
  if (!n) return box.replaceChildren(el('p', 'msg', 'No rivals in this league yet.'));

  const stats = rivalOwnership(rivals);
  const mine = new Map(teamPicks.map((pk) => [pk.id, pk.multiplier ?? (pk.bench ? 0 : 1)]));
  const own = (id) => stats.get(id) ?? { owners: 0, caps: 0, eo: 0 };
  const ownedText = (s) => {
    if (n === 1) return s.owners ? 'they have them' : 'they don’t';
    return `${s.owners}/${n} rivals`;
  };

  // Threats: rivals gain more than you when these players score.
  const threats = [...stats.entries()]
    .filter(([id]) => players.has(id))
    .map(([id, s]) => ({ p: players.get(id), s, swing: s.eo / n - (mine.get(id) ?? 0) }))
    .filter((t) => t.swing > 0)
    .sort((a, b) => b.swing - a.swing || b.p.form - a.p.form)
    .slice(0, 5)
    .map((t) => ({
      p: t.p,
      sub: `${t.p.team} · ${ownedText(t.s)}${t.s.caps ? ` · ${t.s.caps} captained` : ''}`,
      value: n === 1 ? (t.s.caps ? 'C' : '✓') : `${Math.round((t.s.owners / n) * 100)}%`,
    }));

  // Differentials: your playing players that few rivals have.
  const diffs = teamPicks
    .filter((pk) => (mine.get(pk.id) ?? 0) > 0 && players.has(pk.id))
    .map((pk) => ({ p: players.get(pk.id), s: own(pk.id) }))
    .sort((a, b) => a.s.owners - b.s.owners || b.p.form - a.p.form)
    .slice(0, 5)
    .map((d) => ({
      p: d.p,
      sub: `${d.p.team} · ${d.s.owners === 0 ? 'only you' : ownedText(d.s)}`,
      value: n === 1 ? (d.s.owners ? '✓' : '—') : `${Math.round((d.s.owners / n) * 100)}%`,
    }));

  // Captain watch: who the rivals gave the armband to.
  const caps = [...stats.entries()]
    .filter(([id, s]) => s.caps && players.has(id))
    .sort((a, b) => b[1].caps - a[1].caps)
    .slice(0, 5)
    .map(([id, s]) => {
      const m = mine.get(id) ?? 0;
      let yours = 'you don’t have them';
      if (m >= 2) yours = 'your captain too';
      else if (m === 1) yours = 'you have them (not C)';
      return { p: players.get(id), sub: yours, value: n === 1 ? 'C' : `${s.caps} of ${n}` };
    });

  box.replaceChildren(
    pickCard('Threats', 'Players your rivals have and you don’t. If they score, you fall behind.', threats, 'No threats. You have everything they have!'),
    pickCard('Your differentials', 'Your players that few rivals have. When they score, you catch up.', diffs),
    pickCard('Captain watch', 'Who your rivals made captain. Their points count double.', caps),
  );
  markSelected();
}

// Replace the chart with the highest scorers from the starting XI.
function chartTeam() {
  const top = teamPicks
    .filter((pick) => !pick.bench && players.has(pick.id))
    .map((pick) => players.get(pick.id))
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_ON_CHART);
  selected = new Map(top.map((p, i) => [p.id, i + 1]));
  drawChart();
}

// ---------- Start up ----------

async function init() {
  buildChart();

  const [res, fxRes] = await Promise.all([fetch('api/players.php'), fetch('api/fixtures.php')]);
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  const data = await res.json();
  fixtures = fxRes.ok ? (await fxRes.json()).teams : {};
  gameweeks = data.gameweeks;
  players = new Map(data.players.map((p) => [p.id, p]));
  players.forEach(addStats);
  $('season-info').textContent = `Season 2026/27 · Data up to GW${gameweeks} · Form = last ${formWeeks} GWs`;

  drawKey();
  drawHead('all-head', true);
  drawHead('team-head', false);
  drawAllList();
  drawPicks();
  drawChart();

  $('search').addEventListener('input', drawAllList);
  for (const id of ['pos', 'max-price']) {
    $(id).addEventListener('change', () => { drawAllList(); drawPicks(); });
  }
  for (const t of document.querySelectorAll('.tab[data-tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
  for (const t of document.querySelectorAll('.tab[data-view]')) t.addEventListener('click', () => setView(t.dataset.view));
  $('chart-team').addEventListener('click', chartTeam);
  $('clear-chart').addEventListener('click', () => compare([]));
  $('league-pick').addEventListener('change', loadLeague);
  $('form-weeks').addEventListener('change', () => {
    const n = Number($('form-weeks').value);
    setFormWeeks(n);
    const id = $('team-pick').value;
    if (savedTeams.some((t) => String(t.id) === id)) {
      saveTeams(savedTeams.map((t) => (String(t.id) === id ? { ...t, formWeeks: n } : t))).catch((e) => alert(e.message));
    }
  });
  $('team-pick').addEventListener('change', () => loadTeam($('team-pick').value));
  $('edit-teams').addEventListener('click', () => { $('team-editor').hidden = !$('team-editor').hidden; });
  $('add-team').addEventListener('submit', async (e) => {
    e.preventDefault();
    const team = { name: $('new-name').value.trim(), id: Number($('new-id').value) };
    try {
      await saveTeams([...savedTeams, team]);
      e.target.reset();
      $('team-pick').value = team.id;
      loadTeam(team.id);
    } catch (err) {
      alert(err.message);
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  initSavedTeams();
}

init().catch((e) => {
  $('chart-empty').replaceChildren(el('strong', '', 'Could not load player data'), el('span', '', e.message));
});
