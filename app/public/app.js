'use strict';

const MAX_ON_CHART = 8;
const POS_SHORT = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Forward: 'FWD' };

let players = new Map();   // id -> player
let gameweeks = 0;
let selected = new Map();  // id -> colour slot (1-8); a player keeps their colour while on the chart
let teamPicks = [];
let view = 'total';      // 'total' = running total line, 'gw' = points per gameweek bars
let chart;

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

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
    if (!leader || p.points.at(-1) > leader.points.at(-1)) leader = p;
  }
  $('stat-leader').textContent = leader ? `${leader.name} · ${leader.points.at(-1)}` : '–';
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

// ---------- Player lists ----------

function playerRow(p, pick = {}) {
  const li = el('li');
  li.dataset.id = p.id;
  if (pick.bench) li.classList.add('bench');

  const who = el('span', 'who');
  const name = el('span', 'name', p.name);
  if (pick.captain) name.append(el('span', 'badge', 'C'));
  who.append(name, el('span', 'team', p.team));

  li.append(
    el('span', 'check'),
    who,
    el('span', 'pos', POS_SHORT[p.pos] ?? p.pos),
    el('span', 'num', p.cost != null ? `£${p.cost.toFixed(1)}m` : '–'),
    el('span', 'num pts', p.points.at(-1) ?? 0),
  );
  li.onclick = () => toggle(p.id);
  return li;
}

function drawAllList() {
  const q = $('search').value.trim().toLowerCase();
  const pos = $('pos').value;
  const rows = [];
  for (const p of players.values()) {
    if (pos && p.pos !== pos) continue;
    if (q && !p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) continue;
    rows.push(playerRow(p));
  }
  $('all-list').replaceChildren(...rows);
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

// Highlight rows that are on the chart, in both lists.
function markSelected() {
  for (const li of document.querySelectorAll('.player-list li[data-id]')) {
    const slot = selected.get(Number(li.dataset.id));
    li.classList.toggle('on', !!slot);
    li.firstChild.style.setProperty('--c', slot ? `var(--s${slot})` : 'transparent');
  }
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

function showTab(name) {
  for (const t of document.querySelectorAll('.tab[data-tab]')) {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  }
  $('tab-all').hidden = name !== 'all';
  $('tab-team').hidden = name !== 'team';
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

// Replace the chart with the highest scorers from the starting XI.
function chartTeam() {
  const top = teamPicks
    .filter((pick) => !pick.bench && players.has(pick.id))
    .map((pick) => players.get(pick.id))
    .sort((a, b) => b.points.at(-1) - a.points.at(-1))
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
  $('season-info').textContent = `Season 2026/27 · Data up to GW${gameweeks} · ${players.size} players`;
  drawAllList();
  drawChart();

  $('search').addEventListener('input', drawAllList);
  $('pos').addEventListener('change', drawAllList);
  for (const t of document.querySelectorAll('.tab[data-tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
  for (const t of document.querySelectorAll('.tab[data-view]')) t.addEventListener('click', () => setView(t.dataset.view));
  $('chart-team').addEventListener('click', chartTeam);
  $('team-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadTeam($('team-id').value.trim());
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  let saved = null;
  try { saved = localStorage.getItem('fplTeamId'); } catch {}
  if (saved) {
    $('team-id').value = saved;
    loadTeam(saved);
  }
}

init().catch((e) => {
  $('chart-empty').replaceChildren(el('strong', '', 'Could not load player data'), el('span', '', e.message));
});
