// app.js - the dashboard: watch every generation of a run (live or saved), set up new runs with
// custom goals and paths, and open any generation in the real TagPro client.
(function () {
const $ = (id) => document.getElementById(id);
const I = globalThis.GLTPInputs;
const TILE_PX = 40;

const S = {
  maps: null,          // /api/maps
  runs: [], live: null,
  run: null,           // { meta, summaries, map, live }
  gen: null, genData: null, bestKeys: null,
  tick: 0, playing: true, speed: 1, show: 'all', follow: true,
  mode: 'run',         // 'run' | 'setup' | 'empty'
  setup: null,         // { map, plan: { steps, timeFrom }, insertAt, algo }
};

const mapView = new MapView($('map'));
const network = new NetworkView($('net'));
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtTime = (ticks) => {
  if (ticks == null) return '–';
  const s = ticks / 60;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, opts) {
  const r = await fetch(url, opts && opts.body ? { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- charts ----------
const chartProgress = new Charts.Chart($('chart-progress'), { onSelect: (g) => selectGen(g, true), format: (v) => `${Math.round(v * 100)}%`, rightFormat: (v) => (v / 60).toFixed(1) + 's' });
const chartSecond = new Charts.Chart($('chart-second'), { onSelect: (g) => selectGen(g, true), format: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v))) });

function drawCharts() {
  const sums = S.run ? S.run.summaries : [];
  const n = sums.length;
  const markers = [];
  sums.forEach((s, i) => { if (s.time != null && (i === 0 || sums[i - 1].time !== s.time)) markers.push({ x: i, y: 1, color: '#ffd60a' }); });
  chartProgress.set({
    n, selected: S.gen, yMax: 1,
    series: [
      { name: 'best', values: sums.map((s) => s.progress), color: '#9be15d', fill: 'rgba(155,225,93,.12)', width: 2.2 },
      { name: 'mean', values: sums.map((s) => s.mean != null && S.run.meta.algo === 'explore' ? s.mean : s.meanProgress), color: '#6c7590', width: 1.4 },
    ].concat(sums.some((s) => s.time != null) ? [{ name: 'finish time', values: sums.map((s) => s.time), color: '#ffd60a', axis: 'right', step: true, width: 2 }] : []),
    markers,
  });
  if (S.run && S.run.meta.algo === 'neat') {
    $('chart2-title').textContent = 'Species';
    const ids = new Map();
    sums.forEach((s, i) => (s.species || []).forEach((sp) => { if (!ids.has(sp.id)) ids.set(sp.id, new Array(n).fill(0)); ids.get(sp.id)[i] = sp.size; }));
    const stacks = [...ids.entries()].map(([id, values]) => ({ color: `hsla(${Charts.hue(id)}, 65%, 55%, .85)`, values }));
    chartSecond.set({ n, selected: S.gen, series: [], stacks });
    const last = sums[n - 1];
    $('chart2-hint').textContent = last ? `${last.species.length} species · ${S.run.meta.config.population} genomes` : '';
  } else {
    $('chart2-title').textContent = 'Archive';
    chartSecond.set({ n, selected: S.gen, series: [
      { name: 'cells', values: sums.map((s) => s.cells), color: '#4dabf7', fill: 'rgba(77,171,247,.15)' },
      { name: 'new', values: sums.map((s) => s.added), color: '#9be15d', width: 1.2 },
    ] });
    const last = sums[n - 1];
    $('chart2-hint').textContent = last ? `${last.cells.toLocaleString()} cells remembered` : '';
  }
}

// ---------- stats + badges ----------
function renderStats() {
  const m = S.run.meta, sums = S.run.summaries, last = sums[sums.length - 1];
  const sel = sums[S.gen] || last;
  const tps = sums.slice(-5).reduce((a, s) => a + s.ticks, 0) / Math.max(0.001, sums.slice(-5).reduce((a, s) => a + s.seconds, 0));
  const cards = [
    ['Generation', `${S.gen ?? 0}<small>of ${sums.length}</small>`],
    ['Best progress', sel ? fmtPct(sel.progress) : '–'],
    m.fastest ? ['Fastest finish', `${fmtTime(m.fastest.time)}<small>gen ${m.fastest.gen}</small>`, 'good'] : ['Finished', 'not yet'],
    m.solved ? ['Proven possible', `gen ${m.solved.gen}<small>${fmtTime(m.solved.time)}</small>`, 'good'] : ['Steps reached', last ? `${last.steps} / ${S.run.map.plan.steps.length}` : '–'],
    m.algo === 'neat' ? ['Species', last ? last.species.length : '–'] : ['Cells', last ? last.cells.toLocaleString() : '–'],
    ['Sim speed', sums.length ? `${Math.round(tps / 1000)}k<small>ticks/s</small>` : '–'],
  ];
  $('stats').innerHTML = cards.map(([k, v, c]) => `<div class="stat ${c || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  const b = [`<span class="badge">${m.algo === 'neat' ? 'NEAT' : 'Go-Explore'}</span>`];
  if (S.run.live) b.push('<span class="badge live">training</span>');
  else b.push(`<span class="badge">${esc(m.status)}</span>`);
  if (m.solved) b.push('<span class="badge solved">possible ✓</span>');
  $('badges').innerHTML = b.join('');
  $('stop').hidden = !S.run.live;
}

// ---------- plan drawing ----------
function planTargets(map, steps) {
  const tiles = map.tiles, W = tiles.length, H = tiles[0].length;
  const find = (pred) => { const out = []; for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (pred(Number(tiles[x][y]))) out.push({ x, y, t: Number(tiles[x][y]) }); return out; };
  const flags = find((t) => t === 4 || t === 20 || t === 16), redFlags = find((t) => t === 3 || t === 19), zones = find((t) => Math.floor(t) === 17);
  const near = (list, p) => list.reduce((b, q) => (!b || Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? q : b), null) || p;
  let at = { x: Math.round(map.spawn.x / 0.4), y: Math.round(map.spawn.y / 0.4) }, flag = null;
  const pts = [at];
  for (const s of steps) {
    if (s.type === 'reach' || s.type === 'button') at = { x: s.x, y: s.y };
    else if (s.type === 'grab') { const f = near(flags, at); flag = f.t; at = f; } else at = near(flag === 16 && zones.length ? zones : redFlags, at);
    pts.push({ x: at.x, y: at.y });
  }
  return pts;
}

function stepLabel(s) {
  if (s.type === 'reach') return `Reach <small>${s.x}, ${s.y}</small>`;
  if (s.type === 'button') return `Touch button <small>${s.x}, ${s.y}</small>`;
  return s.type === 'grab' ? 'Grab the flag' : 'Cap';
}

// ---------- runs ----------
async function loadRuns() {
  const j = await api('/api/runs');
  S.runs = j.runs; S.live = j.live;
  const pick = $('run-picker');
  pick.innerHTML = S.runs.length ? S.runs.map((r) => {
    const when = new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tag = r.id === S.live ? '● ' : r.solved ? '✓ ' : '';
    return `<option value="${r.id}">${tag}${esc(r.map.name)} · ${r.algo === 'neat' ? 'NEAT' : 'Go-Explore'} · ${when}</option>`;
  }).join('') : '<option>no runs yet</option>';
  if (S.run) pick.value = S.run.meta.id;
}

async function openRun(id) {
  const j = await api(`/api/runs/${id}`);
  S.run = j; S.mode = 'run';
  S.genData = null; S.gen = null;
  showMode();
  await mapView.setMap(j.map, S.maps.pack);
  $('map-name').textContent = j.map.name;
  $('map-sub').textContent = [j.map.author && `by ${j.map.author}`, j.map.difficulty && `GLTP difficulty ${j.map.difficulty}`, `${j.map.settings.jumpLimit >= 51 ? 'unlimited' : j.map.settings.jumpLimit} jumps`].filter(Boolean).join(' · ');
  $('heat-toggle').hidden = j.meta.algo !== 'explore';
  $('net-card').hidden = j.meta.algo !== 'neat';
  $('plan-source').textContent = { gltp: 'GLTP rules', saved: "map's saved plan", run: 'custom' }[j.meta.plan && j.meta.plan.source] || '';
  $('run-steps').innerHTML = j.map.plan.steps.map((s) => `<li class="${s.type}"><span class="what">${stepLabel(s)}</span></li>`).join('');
  $('run-picker').value = id;
  drawCharts();
  if (j.summaries.length) await selectGen(j.summaries.length - 1, false);
  renderStats();
}

async function selectGen(g, byUser) {
  if (!S.run || g == null || g < 0 || g >= S.run.summaries.length) return;
  if (byUser) { S.follow = g === S.run.summaries.length - 1; $('follow').checked = S.follow; }
  S.gen = g;
  $('gen-slider').max = S.run.summaries.length - 1;
  $('gen-slider').value = g;
  drawCharts();
  renderStats();
  const want = `${S.run.meta.id}/${g}`;
  S.loadingGen = want;
  const d = await api(`/api/runs/${S.run.meta.id}/gens/${g}`);
  if (S.loadingGen !== want) return;
  S.genData = d;
  S.bestIndex = d.algo === 'neat' ? d.best.index : bestExploreRun(d);
  S.bestKeys = d.best.keys ? expandKeys(d.best.keys) : null;
  S.maxTick = Math.max(...d.runs.map((r) => r.path.length / 2 * 4)) + 60;
  $('scrub').max = S.maxTick;
  S.tick = 0;
  const sum = S.run.summaries[g];
  $('gen-label').textContent = `gen ${g} · ${fmtPct(sum.progress)}${sum.time != null ? ' · done in ' + fmtTime(sum.time) : ''}`;
  if (d.algo === 'neat') {
    network.set(d.best.genome);
    $('net-hint').textContent = `${d.best.genome.genes.filter((x) => x[3]).length} links · fitness ${Math.round(d.best.fitness)}`;
  }
}

// Go-Explore: the exploration that got furthest this generation is drawn as "best"
function bestExploreRun(d) {
  let bi = 0;
  d.runs.forEach((r, i) => { if (r.progress > d.runs[bi].progress || (r.time != null && (d.runs[bi].time == null || r.time < d.runs[bi].time))) bi = i; });
  return bi;
}

function expandKeys(rle) { const out = []; for (let i = 0; i < rle.length; i += 2) for (let n = 0; n < rle[i + 1]; n++) out.push(rle[i]); return out; }

// ---------- playback ----------
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.mode === 'run' && S.genData) {
    if (S.playing) {
      S.tick += dt * 60 * S.speed;
      if (S.tick > S.maxTick) S.tick = 0;
    }
    $('scrub').value = S.tick;
    $('clock').textContent = fmtTime(S.tick);
    const runs = S.genData.runs;
    mapView.draw({
      runs, best: S.bestIndex, tick: S.tick, show: S.show,
      heat: $('heat').checked && S.genData.heat ? S.genData.heat : null,
      plan: $('show-plan').checked ? S.run.map.plan : null, planTargets: planTargets(S.run.map, S.run.map.plan.steps),
    });
    if (S.genData.algo === 'neat') drawNetwork(runs[S.bestIndex]);
  } else if (S.mode === 'setup' && S.setup && S.setup.map) {
    mapView.draw({ plan: S.setup.plan, planTargets: planTargets(S.setup.map, S.setup.plan.steps), editing: true, insertAt: S.setup.insertAt });
  } else mapView.draw({});
  requestAnimationFrame(frame);
}

const gridBuf = new Array(I.SIDE * I.SIDE).fill(0);
function drawNetwork(run) {
  const i = Math.min(Math.floor(S.tick / 4), run.path.length / 2 - 1);
  const x = run.path[i * 2], y = run.path[i * 2 + 1];
  let grid = null, extras = null;
  if (x >= 0) {
    grid = I.grid(S.run.map.tiles, Math.round(x / TILE_PX), Math.round(y / TILE_PX), gridBuf);
    const j = Math.min(i + 1, run.path.length / 2 - 1);
    const vx = (run.path[j * 2] - x) * 15 / 100, vy = (run.path[j * 2 + 1] - y) * 15 / 100;
    const holding = run.grabTick != null && S.tick >= run.grabTick && (run.capTick == null || S.tick < run.capTick);
    extras = [vx / 5, vy / 5, 0, holding ? 1 : 0, 0, 0, 1];
  }
  const k = S.bestKeys ? S.bestKeys[Math.min(Math.floor(S.tick), S.bestKeys.length - 1)] || 0 : 0;
  network.draw(grid, extras, [k & 1, k & 2, k & 4, k & 8]);
}

// ---------- live updates ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') { S.live = m.live; return; }
    if (m.type === 'start') { S.live = m.run; await loadRuns(); if (S.mode !== 'setup') await openRun(m.run); return; }
    if (m.type === 'progress' && m.run === S.live) {
      $('live-progress').hidden = false;
      $('live-progress').querySelector('i').style.width = `${(m.done / m.of) * 100}%`;
      $('live-progress').querySelector('span').textContent = `gen ${m.gen}: ${m.done}/${m.of}`;
      return;
    }
    if (m.type === 'generation' && S.run && m.run === S.run.meta.id) {
      S.run.summaries.push(m.summary);
      S.run.meta = m.meta;
      drawCharts(); renderStats();
      if (S.follow) await selectGen(S.run.summaries.length - 1, false);
      else $('gen-slider').max = S.run.summaries.length - 1;
      return;
    }
    if (m.type === 'end') {
      S.live = null; $('live-progress').hidden = true;
      if (S.run && m.run === S.run.meta.id) { S.run.live = false; S.run.meta = m.meta; renderStats(); }
      loadRuns();
    }
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

// ---------- setup: map, goals, strategy ----------
const FIELDS = {
  explore: [
    ['exploreTicks', 'Explore length (ticks)'], ['holdMean', 'Avg key hold (ticks)'], ['frontier', 'Frontier pull'],
    ['batch', 'Explorations / gen (0 = auto)'], ['maxTicks', 'Ignore cells after (ticks)'], ['maxGens', 'Stop after gens (blank = never)'], ['seed', 'Random seed'],
  ],
  neat: [
    ['population', 'Population'], ['thinkEvery', 'Think every (ticks)'], ['patience', 'Give up after no progress (ticks)'],
    ['maxTicks', 'Run length cap (ticks)'], ['maxGens', 'Stop after gens (blank = never)'], ['seed', 'Random seed'], ['endOnPop', 'Popping ends the run', 'check'],
  ],
};

function showMode() {
  $('run-side').hidden = S.mode !== 'run';
  $('setup-side').hidden = S.mode !== 'setup';
  $('player').style.visibility = S.mode === 'run' ? 'visible' : 'hidden';
  $('empty').hidden = S.mode !== 'empty';
  $('edit-hint').hidden = !(S.mode === 'setup' && S.setup && S.setup.map);
  $('canvas-wrap').classList.toggle('editing', S.mode === 'setup');
  for (const id of ['show-mode', 'badges', 'heat-toggle', 'show-plan']) {
    const el = id === 'show-plan' ? $(id).parentElement : $(id);
    el.style.visibility = S.mode === 'run' ? 'visible' : 'hidden';
  }
}

function startSetup() {
  S.mode = 'setup';
  S.setup = S.setup || { map: null, plan: null, insertAt: 0, algo: 'explore' };
  showMode();
  renderMapLists();
  renderStrategy();
  if (S.setup.map) renderGoals();
}

function renderMapLists() {
  const m = S.maps;
  $('proxy-hint').textContent = `maps via ${m.proxy}`;
  $('tab-practice').innerHTML = m.practice.map((k) => `<button data-map="${esc(k)}"><span class="n">${esc(k)}</span><span class="d">practice</span></button>`).join('');
  renderGltpList();
}

function renderGltpList() {
  const q = $('map-search').value.trim().toLowerCase();
  const list = S.maps.gltp.filter((g) => g.gravity && (!q || `${g.name} ${g.author} ${g.categories.join(' ')} ${g.id}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.difficulty ?? 99) - (b.difficulty ?? 99)).slice(0, 300);
  $('gltp-list').innerHTML = list.map((g) => `<button data-map="${g.id}" title="${esc(g.categories.join(', '))} · ${esc(g.balls)} ball(s)">
    <span class="d">${g.difficulty ?? '?'}</span><span class="n">${esc(g.name)}</span>${g.downloaded ? '<span class="dl">✓</span>' : ''}<span class="d">${g.balls !== '1' ? esc(g.balls) + ' balls' : ''}</span></button>`).join('');
}

async function chooseMap(key) {
  $('map-err').hidden = true;
  document.querySelectorAll('.maplist button').forEach((b) => b.classList.toggle('on', b.dataset.map === String(key)));
  try {
    const map = await api(`/api/level?map=${encodeURIComponent(key)}`);
    S.setup.map = map;
    S.setup.plan = { steps: map.plan.steps.map((s) => ({ ...s })), timeFrom: map.plan.timeFrom, source: map.plan.source };
    S.setup.insertAt = firstNonReach(S.setup.plan.steps);
    await mapView.setMap(map, S.maps.pack);
    $('map-name').textContent = map.name;
    $('map-sub').textContent = [map.author && `by ${map.author}`, map.difficulty && `GLTP difficulty ${map.difficulty}`, map.gltp && map.gltp.balls !== '1' && `needs ${map.gltp.balls} balls (the bot plays alone)`].filter(Boolean).join(' · ');
    $('goals-card').hidden = false; $('strategy-card').hidden = false;
    showMode();
    renderGoals();
  } catch (e) {
    $('map-err').hidden = false;
    $('map-err').textContent = e.message;
  }
}

function firstNonReach(steps) { const i = steps.findIndex((s) => s.type !== 'reach'); return i < 0 ? steps.length : i; }

function renderGoals() {
  const p = S.setup.plan;
  const parts = [];
  p.steps.forEach((s, i) => {
    if (i === S.setup.insertAt) parts.push('<div class="insert"></div>');
    parts.push(`<li class="${s.type}${i === S.setup.insertAt - 1 ? ' sel' : ''}" data-i="${i}">
      <span class="what">${stepLabel(s)}</span>
      ${s.type === 'reach' ? `<label class="hint">r <input type="number" min="0.3" max="10" step="0.5" value="${s.r}" data-r="${i}"></label>` : ''}
      <button class="x" data-up="${i}" title="Move up">↑</button><button class="x" data-del="${i}" title="Remove">✕</button></li>`);
  });
  if (S.setup.insertAt >= p.steps.length) parts.push('<div class="insert"></div>');
  $('steps').innerHTML = parts.join('');
  $('time-from').innerHTML = '<option value="-1">at spawn</option>' + p.steps.map((s, i) => `<option value="${i}">after step ${i + 1} (${s.type})</option>`).join('');
  $('time-from').value = String(p.timeFrom ?? -1);
  $('goal-total').textContent = `${p.steps.length} steps`;
  $('plan-err').hidden = true;
}

function renderStrategy() {
  const algo = S.setup.algo, d = S.maps.defaults[algo];
  document.querySelectorAll('#algo button').forEach((b) => b.classList.toggle('on', b.dataset.algo === algo));
  $('fields').innerHTML = FIELDS[algo].map(([k, label, kind]) => (kind === 'check'
    ? `<label class="check"><input type="checkbox" data-k="${k}" ${d[k] ? 'checked' : ''}> ${label}</label>`
    : `<label>${label}<input type="number" data-k="${k}" value="${d[k] == null ? '' : d[k]}" placeholder="${d[k] == null ? 'never' : ''}"></label>`)).join('');
}

async function startTraining() {
  $('start-err').hidden = true;
  if (!S.setup.map) { $('start-err').hidden = false; $('start-err').textContent = 'Pick a map first.'; return; }
  const options = {};
  $('fields').querySelectorAll('input').forEach((el) => { options[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
  if (options.maxGens === '') delete options.maxGens;
  $('start').disabled = true;
  try {
    const p = S.setup.plan;
    const r = await api('/api/train', { method: 'POST', body: { map: S.setup.map.key, algo: S.setup.algo, options, plan: { steps: p.steps, timeFrom: p.timeFrom, source: p.source === 'gltp' && !p.edited ? 'gltp' : p.source === 'saved' && !p.edited ? 'saved' : 'run' } } });
    S.live = r.run;
    S.setup = null;
    await loadRuns();
    await openRun(r.run);
  } catch (e) {
    $('start-err').hidden = false; $('start-err').textContent = e.message;
  } finally { $('start').disabled = false; }
}

// ---------- events ----------
$('run-picker').addEventListener('change', (e) => openRun(e.target.value));
$('new-run').addEventListener('click', startSetup);
$('empty-new').addEventListener('click', startSetup);
$('cancel-setup').addEventListener('click', async () => {
  S.setup = null;
  if (S.runs.length) await openRun(($('run-picker').value) || S.runs[0].id); else { S.mode = 'empty'; showMode(); }
});
$('stop').addEventListener('click', () => api('/api/stop', { method: 'POST' }));
$('play').addEventListener('click', () => { S.playing = !S.playing; $('play').textContent = S.playing ? '❚❚' : '▶'; });
$('scrub').addEventListener('input', (e) => { S.tick = Number(e.target.value); });
$('speed').addEventListener('change', (e) => { S.speed = Number(e.target.value); });
$('gen-slider').addEventListener('input', (e) => selectGen(Number(e.target.value), true));
$('gen-prev').addEventListener('click', () => selectGen(S.gen - 1, true));
$('gen-next').addEventListener('click', () => selectGen(S.gen + 1, true));
$('follow').addEventListener('change', (e) => { S.follow = e.target.checked; if (S.follow && S.run) selectGen(S.run.summaries.length - 1, false); });
document.querySelectorAll('#show-mode button').forEach((b) => b.addEventListener('click', () => {
  S.show = b.dataset.show;
  document.querySelectorAll('#show-mode button').forEach((x) => x.classList.toggle('on', x === b));
}));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space' && S.mode === 'run') { e.preventDefault(); $('play').click(); }
  if (e.key === 'ArrowLeft' && S.mode === 'run') selectGen(S.gen - 1, true);
  if (e.key === 'ArrowRight' && S.mode === 'run') selectGen(S.gen + 1, true);
});
window.addEventListener('resize', () => { mapView.fit(); });

$('watch').addEventListener('click', async () => {
  if (!S.run || S.gen == null) return;
  $('watch').disabled = true;
  try {
    const r = await api(`/api/runs/${S.run.meta.id}/replay/${S.gen}?ghosts=30`);
    $('tagpro-title').textContent = `${S.run.map.name} · generation ${S.gen}`;
    $('tagpro-frame').src = r.url;
    $('tagpro-open').href = r.url;
    $('tagpro-dialog').showModal();
  } catch (e) { alert(e.message); } finally { $('watch').disabled = false; }
});
$('tagpro-close').addEventListener('click', () => { $('tagpro-dialog').close(); });
$('tagpro-dialog').addEventListener('close', () => { $('tagpro-frame').src = 'about:blank'; });

// setup
document.querySelectorAll('#map-tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#map-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['practice', 'gltp', 'id']) $('tab-' + t).hidden = t !== b.dataset.tab;
}));
$('setup-side').addEventListener('click', (e) => { const b = e.target.closest('[data-map]'); if (b) chooseMap(b.dataset.map); });
$('map-search').addEventListener('input', renderGltpList);
$('fm-load').addEventListener('click', () => { const id = $('fm-id').value.trim(); if (id) chooseMap(id); });
$('fm-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fm-load').click(); });
document.querySelectorAll('#algo button').forEach((b) => b.addEventListener('click', () => { S.setup.algo = b.dataset.algo; renderStrategy(); }));
$('start').addEventListener('click', startTraining);

const edited = () => { S.setup.plan.edited = true; S.setup.plan.source = 'run'; };
$('steps').addEventListener('click', (e) => {
  const p = S.setup.plan;
  if (e.target.dataset.del != null) {
    const i = Number(e.target.dataset.del);
    p.steps.splice(i, 1);
    if (S.setup.insertAt > i) S.setup.insertAt--;
    if (p.timeFrom >= p.steps.length) p.timeFrom = -1;
    edited(); renderGoals(); return;
  }
  if (e.target.dataset.up != null) {
    const i = Number(e.target.dataset.up);
    if (i > 0) { [p.steps[i - 1], p.steps[i]] = [p.steps[i], p.steps[i - 1]]; edited(); renderGoals(); }
    return;
  }
  if (e.target.matches('input')) return;
  const li = e.target.closest('li');
  if (li) { S.setup.insertAt = Number(li.dataset.i) + 1; renderGoals(); }
});
$('steps').addEventListener('change', (e) => {
  if (e.target.dataset.r == null) return;
  S.setup.plan.steps[Number(e.target.dataset.r)].r = Number(e.target.value) || 1;
  edited();
});
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  S.setup.plan.steps.splice(S.setup.insertAt, 0, { type: b.dataset.add });
  S.setup.insertAt++; edited(); renderGoals();
}));
$('time-from').addEventListener('change', (e) => { S.setup.plan.timeFrom = Number(e.target.value); edited(); });
$('plan-gltp').addEventListener('click', () => {
  S.setup.plan = { steps: S.setup.map.gltpSteps.map((s) => ({ ...s })), timeFrom: -1, source: 'gltp' };
  S.setup.insertAt = 0; renderGoals();
});
$('plan-clear').addEventListener('click', () => {
  S.setup.plan.steps = S.setup.plan.steps.filter((s) => s.type !== 'reach');
  S.setup.insertAt = 0; edited(); renderGoals();
});
$('plan-save').addEventListener('click', async () => {
  try {
    const map = await api('/api/plan', { method: 'PUT', body: { map: S.setup.map.key, steps: S.setup.plan.steps, timeFrom: S.setup.plan.timeFrom } });
    S.setup.plan.source = 'saved'; S.setup.plan.edited = false;
    $('goal-total').textContent = `saved ✓ · ${map.plan.steps.length} steps`;
  } catch (e) { $('plan-err').hidden = false; $('plan-err').textContent = e.message; }
});
$('map').addEventListener('mousemove', (e) => { mapView.hover = S.mode === 'setup' ? mapView.tileAt(e) : null; });
$('map').addEventListener('mouseleave', () => { mapView.hover = null; });
$('map').addEventListener('click', (e) => {
  if (S.mode !== 'setup' || !S.setup || !S.setup.map) return;
  const t = mapView.tileAt(e);
  if (!t) return;
  const tile = Number(S.setup.map.tiles[t.x][t.y]);
  const step = Math.floor(tile) === 8 ? { type: 'button', x: t.x, y: t.y } : { type: 'reach', x: t.x, y: t.y, r: 1 };
  S.setup.plan.steps.splice(S.setup.insertAt, 0, step);
  S.setup.insertAt++; edited(); renderGoals();
});

// ---------- start ----------
(async () => {
  S.maps = await api('/api/maps');
  await loadRuns();
  connect();
  if (S.live) await openRun(S.live);
  else if (S.runs.length) await openRun(S.runs[0].id);
  else { S.mode = 'empty'; showMode(); }
  requestAnimationFrame(frame);
})();
})();
