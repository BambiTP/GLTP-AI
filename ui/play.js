// play.js - paste a map preset, draw a rough path, press Go, and watch the bot learn the map.
(function () {
const $ = (id) => document.getElementById(id);
const TS = 40;           // texture px per tile (MapView's units)
const SPACING = 3;       // a drawn path becomes a waypoint every 3 tiles
const REACH = 2;         // ... each counts as passed within 2 tiles (and passing a later one counts too)

const S = {
  map: null,             // /api/level or the run's map
  strokes: [],           // the drawn path: lines of { x, y } in tiles
  pen: true, stroke: null,
  run: null,             // { id, meta, last (summary) } while watching a run
  live: false,
  route: null, ghosts: [], tick: 0, maxTick: 0,
};
const mapView = new MapView($('map'));
let pack = {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t == null ? '–' : `${Math.floor(t / 3600)}:${((t / 60) % 60).toFixed(2).padStart(5, '0')}`);
async function api(url, opts) {
  const r = await fetch(url, opts && opts.body ? { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : opts);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function say(text, err) { $('msg').textContent = text || ''; $('msg').classList.toggle('err', !!err); }

// ---------- map ----------
async function loadMap(code) {
  code = String(code || '').trim();
  if (!code) return;
  say('loading ' + code + '…');
  try {
    const map = await api(`/api/level?map=${encodeURIComponent(code)}`);
    S.map = map; S.strokes = []; S.run = null; S.route = null; S.ghosts = [];
    await mapView.setMap(map, pack);
    $('code').value = code;
    history.replaceState(null, '', '#' + encodeURIComponent(map.key));
    say(describe(map));
    showEditing();
  } catch (e) {
    say(e.message, true);
    $('hero-code').value = code;
  }
}

// the map and the settings it's played with
function describe(map) {
  const st = map.settings, bits = [map.name + (map.author ? ' by ' + map.author : '')];
  bits.push(st.mode === 'gravity' ? `gravity, ${st.jumpLimit >= 51 ? 'unlimited' : st.jumpLimit} jumps` : st.mode);
  if (st.accel && st.accel !== 1) bits.push(`${Math.round(st.accel * 100)}% accel`);
  if (st.topspeed && st.topspeed !== 1) bits.push(`${Math.round(st.topspeed * 100)}% top speed`);
  if (map.gltp && map.gltp.balls !== '1') bits.push(`needs ${map.gltp.balls} balls, the bot plays alone`);
  return bits.join(' · ');
}

function showEditing() {
  $('hero').hidden = true;
  $('tools').hidden = false;
  $('hint').hidden = S.strokes.length > 0;
  $('status').hidden = !S.run;
  $('go').disabled = !S.map || S.live;
  for (const id of ['pen', 'undo', 'clear']) $(id).disabled = S.live;
  $('stage').classList.toggle('drawing', S.pen && !S.live);
}

// ---------- drawn path -> plan ----------
function isOpen(x, y) {
  const t = S.map.tiles;
  if (x < 0 || y < 0 || x >= t.length || y >= t[0].length) return false;
  const n = Number(t[x][y]), b = Math.floor(n);
  return b !== 0 && n !== 1 && b !== 7;
}

function tilesWhere(pred) {
  const out = [], t = S.map.tiles;
  for (let x = 0; x < t.length; x++) for (let y = 0; y < t[0].length; y++) if (pred(Number(t[x][y]))) out.push({ x, y });
  return out;
}

// points every `step` tiles along the drawn lines (in drawing order)
function resample(strokes, step) {
  const out = [];
  let carry = 0, prev = null;
  for (const line of strokes) {
    for (const p of line) {
      if (!prev) { out.push(p); prev = p; continue; }
      let d = Math.hypot(p.x - prev.x, p.y - prev.y), from = prev;
      while (carry + d >= step) {
        const k = (step - carry) / d;
        const q = { x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k };
        out.push(q);
        d -= step - carry; carry = 0; from = q;
      }
      carry += d; prev = p;
    }
  }
  const last = strokes[strokes.length - 1];
  if (last && last.length) out.push(last[last.length - 1]);
  return out;
}

// the nearest open tile to a point (the path is rough; walls and spikes aren't targets)
function snap(p) {
  let best = null, bd = Infinity;
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) {
    if (!isOpen(x, y)) continue;
    const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best || { x: cx, y: cy };
}

function planFromPath() {
  const base = S.map.gltpSteps.map((s) => ({ ...s }));
  const pts = S.strokes.flat();
  if (pts.length < 2) return { steps: base, timeFrom: -1, source: 'gltp' };
  const near = (list, p) => Math.min(...list.map((q) => Math.hypot(q.x - p.x, q.y - p.y)), Infinity);
  const flags = tilesWhere((t) => t === 4 || t === 20 || t === 16);
  const caps = tilesWhere((t) => t === 3 || t === 19 || Math.floor(t) === 17);
  const spawn = { x: Math.round(S.map.spawn.x / 0.4), y: Math.round(S.map.spawn.y / 0.4) };
  let way = [];
  for (const p of resample(S.strokes, SPACING)) {
    const t = snap(p);
    if (!way.length || way[way.length - 1].x !== t.x || way[way.length - 1].y !== t.y) way.push(t);
  }
  way = way.filter((w, i) => !(i === 0 && Math.hypot(w.x - spawn.x, w.y - spawn.y) < 2));
  // grab where the path passes the flag, if it does; cap at the end
  let gi = -1, gd = Infinity;
  way.forEach((w, i) => { const d = near(flags, w); if (d < gd) { gd = d; gi = i; } });
  const steps = [];
  const reach = (w) => ({ type: 'reach', x: w.x, y: w.y, r: REACH, soft: true });
  if (flags.length && gd <= 3) {
    way.slice(0, gi).filter((w) => near(flags, w) > 1.5).forEach((w) => steps.push(reach(w)));
    steps.push({ type: 'grab' });
    const back = way.slice(gi + 1).filter((w) => near(flags, w) > 1.5);
    while (back.length && near(caps, back[back.length - 1]) < 2.5) back.pop();
    back.forEach((w) => steps.push(reach(w)));
    steps.push({ type: 'cap' });
  } else {
    way.forEach((w) => steps.push(reach(w)));
    steps.push({ type: 'grab' }, { type: 'cap' });
  }
  // maps that need more than one cap: the rest of the GLTP rules after the drawn first lap
  steps.push(...base.slice(2));
  return { steps, timeFrom: -1, source: 'run', drawn: S.strokes.map((l) => l.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100])) };
}

// ---------- drawing ----------
$('map').addEventListener('pointerdown', (e) => {
  if (!S.map || !S.pen || S.live || e.button !== 0) return;
  $('map').setPointerCapture(e.pointerId);
  S.stroke = [mapView.pointAt(e)];
  S.strokes.push(S.stroke);
  $('hint').hidden = true;
});
$('map').addEventListener('pointermove', (e) => {
  if (!S.stroke) return;
  const p = mapView.pointAt(e), q = S.stroke[S.stroke.length - 1];
  if (Math.hypot(p.x - q.x, p.y - q.y) >= 0.15) S.stroke.push(p);
});
const endStroke = () => {
  if (!S.stroke) return;
  if (S.stroke.length < 2) S.strokes.pop();
  S.stroke = null;
  S.plan = null;
};
$('map').addEventListener('pointerup', endStroke);
$('map').addEventListener('pointercancel', endStroke);
$('pen').addEventListener('click', () => { S.pen = !S.pen; $('pen').classList.toggle('on', S.pen); showEditing(); });
$('undo').addEventListener('click', () => { S.strokes.pop(); S.plan = null; });
$('clear').addEventListener('click', () => { S.strokes = []; S.plan = null; $('hint').hidden = false; });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (!S.live) $('undo').click(); }
});

// ---------- drawing the screen ----------
function drawPath(g, alpha) {
  const k = mapView.view.scale;
  const X = (p) => mapView.sx(p.x * TS), Y = (p) => mapView.sy(p.y * TS);
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [w, c] of [[9, `rgba(0,0,0,${0.45 * alpha})`], [5, `rgba(255,214,10,${0.9 * alpha})`]]) {
    g.strokeStyle = c; g.lineWidth = Math.max(2, w * k * 1.2);
    for (const line of S.strokes) {
      g.beginPath();
      line.forEach((p, i) => (i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p))));
      g.stroke();
    }
  }
  // arrows along the way, so the direction is clear
  g.fillStyle = `rgba(255,214,10,${alpha})`;
  for (const p of resample(S.strokes, 4).slice(1)) {
    const line = S.strokes.flat();
    let i = 0, bd = Infinity;
    line.forEach((q, j) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; i = j; } });
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const ang = Math.atan2(b.y - a.y, b.x - a.x), r = Math.max(5, 9 * k * 1.2);
    g.save(); g.translate(X(p), Y(p)); g.rotate(ang);
    g.beginPath(); g.moveTo(r, 0); g.lineTo(-r * 0.7, r * 0.75); g.lineTo(-r * 0.7, -r * 0.75); g.closePath();
    g.strokeStyle = `rgba(0,0,0,${0.5 * alpha})`; g.lineWidth = 1.5; g.stroke(); g.fill();
    g.restore();
  }
  g.restore();
}

function drawWaypoints(g, plan) {
  const k = mapView.view.scale;
  g.save();
  for (const s of plan.steps) {
    if (s.type !== 'reach') continue;
    const x = mapView.sx((s.x + 0.5) * TS), y = mapView.sy((s.y + 0.5) * TS);
    g.strokeStyle = 'rgba(255,214,10,.55)'; g.lineWidth = 1.5; g.setLineDash([4, 4]);
    g.beginPath(); g.arc(x, y, s.r * TS * k, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const g = mapView.ctx;
  if (S.route || S.ghosts.length) {
    S.tick += dt * 60;
    if (S.tick > S.maxTick) S.tick = 0;
    const runs = S.route ? [S.route].concat(S.ghosts) : S.ghosts;
    mapView.draw({ runs, best: S.route ? 0 : -1, tick: S.tick, show: 'all', spawns: S.map.spawns });
    if (S.strokes.length) drawPath(g, 0.35);
  } else {
    mapView.draw(S.map ? { spawns: S.map.spawns, spawn: S.map.spawn } : {});
    if (S.map && S.strokes.length) {
      if (!S.plan && !S.stroke) S.plan = planFromPath();
      if (S.plan) drawWaypoints(g, S.plan);
      drawPath(g, 1);
    }
  }
  requestAnimationFrame(frame);
}

// ---------- running ----------
async function go() {
  if (!S.map || S.live) return;
  $('go').disabled = true;
  try {
    const plan = planFromPath();
    const r = await api('/api/train', { method: 'POST', body: { map: S.map.key, algo: $('algo').value, options: {}, plan } });
    await watch(r.run);
  } catch (e) {
    say(e.message, true);
    $('go').disabled = false;
  }
}

async function watch(id) {
  const j = await api(`/api/runs/${id}`);
  if (!S.map || S.map.key !== j.map.key) { S.map = j.map; await mapView.setMap(j.map, pack); $('code').value = j.map.key; }
  $('download').href = `/api/runs/${id}/download`;
  S.run = { id, meta: j.meta, last: j.summaries[j.summaries.length - 1] || null };
  S.live = j.live;
  if (j.meta.plan && j.meta.plan.drawn) S.strokes = j.meta.plan.drawn.map((l) => l.map(([x, y]) => ({ x, y })));
  $('status').hidden = false;
  say(describe(j.map));
  showEditing();
  renderStatus();
  await refresh(true);
}

let refreshing = false, lastRefresh = 0, routeTag = '';
async function refresh(force) {
  if (!S.run || refreshing || (!force && Date.now() - lastRefresh < 1200)) return;
  refreshing = true; lastRefresh = Date.now();
  try {
    const m = S.run.meta;
    const tag = m.fastest ? 'f' + m.fastest.time : m.best ? 'b' + m.best.gen + ':' + m.best.progress : '';
    if (tag && tag !== routeTag) {
      const r = await api(`/api/runs/${S.run.id}/route`);
      if (r.path) { S.route = r; routeTag = tag; }
    }
    if (S.run.last) {
      const d = await api(`/api/runs/${S.run.id}/gens/${S.run.last.gen}`);
      S.ghosts = d.runs.slice().sort((a, b) => (b.fitness ?? b.progress) - (a.fitness ?? a.progress)).slice(0, 40);
    }
    S.maxTick = Math.max(S.route ? S.route.path.length * 2 : 0, ...S.ghosts.map((r) => r.path.length * 2)) + 60;
  } catch (e) { /* the next generation will try again */ } finally { refreshing = false; }
}

function renderStatus() {
  const m = S.run.meta, s = S.run.last;
  const done = !!m.fastest;
  $('status').classList.toggle('done', done);
  $('meter').style.width = `${Math.round((done ? 1 : (s ? s.progress : 0)) * 100)}%`;
  const steps = (m.plan && m.plan.steps) || [];
  const where = s ? (s.steps >= steps.length ? 'finished' : `${s.steps} of ${steps.length} goals`) : '';
  if (done) {
    $('headline').textContent = `Possible ✓  ${fmtTime(m.fastest.time)}`;
    $('detail').textContent = `proven at generation ${m.solved.gen}` + (m.fastest.gen !== m.solved.gen ? `, fastest at ${m.fastest.gen}` : '') + (S.live ? ` · still looking for faster (gen ${s ? s.gen : 0})` : ` · ${m.status}`);
  } else {
    $('headline').textContent = s ? `${S.live ? 'Learning' : 'Stopped'} · ${Math.round(s.progress * 100)}% of the way` : 'Starting…';
    $('detail').textContent = s ? `generation ${s.gen} · ${where}` + (m.algo === 'explore' ? ` · ${s.cells.toLocaleString()} places remembered` : ` · ${s.species.length} species`) : '';
  }
  $('stop').hidden = !S.live;
  $('watch').disabled = !S.route;
  $('download').classList.toggle('off', !S.route);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello' && m.live && !S.run) return watch(m.live);
    if (m.type === 'start' && (!S.run || !S.live)) return watch(m.run);
    if (!S.run || m.run !== S.run.id) return;
    if (m.type === 'generation') {
      S.run.meta = m.meta; S.run.last = m.summary;
      renderStatus();
      refresh(false);
    }
    if (m.type === 'end') {
      S.live = false; S.run.meta = m.meta;
      renderStatus(); showEditing(); refresh(true);
    }
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

// ---------- buttons ----------
$('code-form').addEventListener('submit', (e) => { e.preventDefault(); loadMap($('code').value); });
$('hero-form').addEventListener('submit', (e) => { e.preventDefault(); loadMap($('hero-code').value); });
document.querySelectorAll('[data-map]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); loadMap(a.dataset.map); }));
$('go').addEventListener('click', go);
$('stop').addEventListener('click', () => api('/api/stop', { method: 'POST' }));
$('watch').addEventListener('click', async () => {
  if (!S.run || !S.route) return;
  try {
    const r = await api(`/api/runs/${S.run.id}/replay/${S.route.gen}?ghosts=30`);
    $('tagpro-title').textContent = `${S.map.name} · ${S.route.finished ? 'finished in ' + fmtTime(S.route.time) : 'best so far'}`;
    $('tagpro-frame').src = r.url;
    $('tagpro').showModal();
  } catch (e) { say(e.message, true); }
});
$('tagpro-close').addEventListener('click', () => $('tagpro').close());
$('tagpro').addEventListener('close', () => { $('tagpro-frame').src = 'about:blank'; });
// editing again after a run: forget the run's view, keep the path
$('map').addEventListener('pointerdown', () => {
  if (S.run && !S.live && S.pen) { S.run = null; S.route = null; S.ghosts = []; routeTag = ''; showEditing(); }
}, true);
window.addEventListener('resize', () => mapView.fit());
window.addEventListener('hashchange', () => { const c = decodeURIComponent(location.hash.slice(1)); if (c && !S.live && (!S.map || c !== S.map.key)) loadMap(c); });

(async () => {
  try { pack = (await api('/api/maps')).pack || {}; } catch (e) { /* default textures */ }
  connect();
  const code = decodeURIComponent(location.hash.slice(1));
  const runs = await api('/api/runs').catch(() => ({ live: null }));
  if (!runs.live && code) await loadMap(code);
  requestAnimationFrame(frame);
})();
})();
