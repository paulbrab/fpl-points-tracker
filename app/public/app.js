'use strict';

const MAX_ON_CHART = 8;
const POS_SHORT = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Forward: 'FWD' };
const POS_ORDER = { Goalkeeper: 1, Defender: 2, Midfielder: 3, Forward: 4 };
const FORM_WEEKS = 4;

let players = new Map();   // id -> player
let gameweeks = 0;
let selected = new Map();  // id -> colour slot (1-8); a player keeps their colour while on the chart
let teamPicks = [];
let savedTeams = [];       // [{ name, id }] shared by everyone in the house
let view = 'total';        // 'total' = running total line, 'gw' = points per gameweek bars
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

// ---------- Player stats ----------

// Extra numbers worked out from the raw data, once, when it loads.
function addStats(p) {
  const pts = p.points;
  const total = pts.at(-1) ?? 0;
  p.total = total;
  p.form = total - (pts[pts.length - 1 - FORM_WEEKS] ?? 0);
  p.value = p.cost ? total / p.cost : 0;
  p.minutes ??= 0;
  p.minsPct = gameweeks ? Math.min(100, (p.minutes / (gameweeks * 90)) * 100) : 0;
  p.xgi90 = p.minutes >= 90 ? (p.xgi / p.minutes) * 90 : null;
  p.unlucky = (p.xgi ?? 0) - ((p.goals ?? 0) + (p.assists ?? 0));
  p.available = !['i', 's', 'u'].includes(p.status);
  p.posOrder = POS_ORDER[p.pos] ?? 9;
}

// Each column: what it shows, how to sort it, and a plain-English explanation.
const COLUMNS = [
  { key: 'posOrder', label: 'Pos',    show: (p) => POS_SHORT[p.pos] ?? p.pos, cls: 'pos', dir: 1,
    help: 'Position: goalkeeper, defender, midfielder or forward.' },
  { key: 'cost',     label: 'Price',  show: (p) => (p.cost ? `£${fixed(p.cost)}` : '–'),
    help: 'What the player costs right now, in millions.' },
  { key: 'total',    label: 'Pts',    show: (p) => p.total, cls: 'num pts',
    help: 'Total points this season.' },
  { key: 'form',     label: 'Form',   show: (p) => p.form,
    help: `Points in the last ${FORM_WEEKS} gameweeks. Shows who is hot right now.` },
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
            label: (i) => ` ${i.dataset.label}   ${i.parsed.y} pts`,
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
  chart.options.scales.y.grid = { color: css('--grid') };
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

function lineDataset(p, colour) {
  return {
    type: 'line',
    label: p.name,
    data: p.points,
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

function barDataset(p, colour) {
  return {
    type: 'bar',
    label: p.name,
    data: perGameweek(p.points),
    backgroundColor: colour,
    borderColor: css('--surface'),
    borderWidth: { left: 1, right: 1 },
    borderRadius: 4,
    borderSkipped: 'start',
    categoryPercentage: 0.8,
    barPercentage: 1,
  };
}

function drawChart() {
  chart.data.labels = Array.from({ length: gameweeks }, (_, i) => `GW${i + 1}`);
  chart.data.datasets = [...selected].map(([id, slot]) => {
    const make = view === 'total' ? lineDataset : barDataset;
    return make(players.get(id), css(`--s${slot}`));
  });
  chart.options.scales.x.offset = view === 'gw';
  chart.update();
  $('chart-empty').hidden = selected.size > 0;
  drawLegend();
  drawStats();
  markSelected();
}

function drawLegend() {
  const items = [...selected].map(([id, slot]) => {
    const li = el('li');
    const swatch = el('span', 'swatch');
    swatch.style.setProperty('--c', `var(--s${slot})`);
    const x = el('button', '', '×');
    x.title = 'Remove from chart';
    x.onclick = () => toggle(id);
    li.append(swatch, el('span', '', players.get(id).name), x);
    return li;
  });
  $('legend').replaceChildren(...items);
}

function drawStats() {
  $('stat-count').textContent = `${selected.size} / ${MAX_ON_CHART}`;
  $('stat-gw').textContent = gameweeks ? `GW${gameweeks}` : '–';
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
  for (const t of document.querySelectorAll('.tab[data-view]')) {
    t.classList.toggle('active', t.dataset.view === name);
    t.setAttribute('aria-selected', t.dataset.view === name);
  }
  $('chart-title').textContent = name === 'total' ? 'Cumulative points' : 'Points per gameweek';
  $('axis-caption').textContent = name === 'total' ? 'Total points' : 'Points scored that gameweek';
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
    const cell = sortable ? el('button', sort.key === col.key ? 'sorted' : '', col.label) : el('span', '', col.label);
    cell.title = col.help;
    if (sortable) {
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
  who.append(name, el('span', 'team', p.team));

  li.append(el('span', 'check'), who);
  for (const col of COLUMNS) li.append(el('span', col.cls ?? 'num', col.show(p)));
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
  const items = COLUMNS.flatMap((c) => [el('dt', '', c.label), el('dd', '', c.help)]);
  $('key-list').replaceChildren(...items);
}

// ---------- Quick picks ----------

const PICKS = [
  {
    title: 'In form',
    help: `Most points in the last ${FORM_WEEKS} gameweeks.`,
    rank: (p) => p.form,
    show: (p) => `${p.form} pts`,
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

function drawPicks() {
  const pool = [...players.values()].filter((p) => p.available && passesFilters(p, false));
  const cards = PICKS.map((pick) => {
    const top = pool
      .filter((p) => !pick.keep || pick.keep(p))
      .sort((a, b) => pick.rank(b) - pick.rank(a))
      .slice(0, 5);

    const ol = el('ol');
    for (const p of top) {
      const li = el('li');
      li.dataset.id = p.id;
      const nm = el('span', 'nm');
      nm.append(el('b', '', p.name), el('small', '', pick.sub ? pick.sub(p) : `${p.team} · £${fixed(p.cost)}m`));
      li.append(el('span', 'dot'), nm, el('span', 'v', pick.show(p)));
      li.onclick = () => toggle(p.id);
      ol.append(li);
    }
    const card = el('div', 'pick');
    card.append(el('h3', '', pick.title), el('p', '', pick.help), ol);
    return card;
  });
  $('picks').replaceChildren(...cards);

  const pos = $('pos').selectedOptions[0].textContent;
  const price = $('max-price').value ? ` · ${$('max-price').selectedOptions[0].textContent}` : '';
  $('picks-pos').textContent = `· ${pos}${price}`;
  markSelected();
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
  for (const t of document.querySelectorAll('.tab[data-tab]')) {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  }
  $('tab-all').hidden = name !== 'all';
  $('tab-team').hidden = name !== 'team';
  $('list-filters').hidden = name !== 'all';
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
    msg.className = 'msg team-name';
    msg.textContent = `${data.name} · GW${data.gw} picks`;
    $('chart-team').hidden = false;
    try { localStorage.setItem('fplTeamId', id); } catch {}
  } catch (e) {
    teamPicks = [];
    msg.textContent = e.message;
    $('chart-team').hidden = true;
  }
  drawTeamList();
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

  const res = await fetch('api/players.php');
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  const data = await res.json();
  gameweeks = data.gameweeks;
  players = new Map(data.players.map((p) => [p.id, p]));
  players.forEach(addStats);
  $('season-info').textContent = `Season 2026/27 · Data up to GW${gameweeks} · ${players.size} players`;

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
