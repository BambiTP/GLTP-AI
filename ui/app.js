// app.js - paste a preset, press Go, watch. Or open a past run and continue it, or give it checkpoints.
(function () {
const $ = (id) => document.getElementById(id);
const view = new MapView($('map'));
let runId = null, live = false, version = '', meta = null, best = null, recent = [], heat = null;
let bestTick = 0, recentTick = 0, last = performance.now(), polling = null;
let editing = null; // the checkpoints being placed, while placing them
let red = null;     // ... and the red zones (tiles not to go in)
let mode = 'cp';    // what a click on the map places: 'cp' or 'red'
let fresh = null;   // the code pasted, while placing checkpoints on a map before its first run

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: 'the server stopped answering' }));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// the ones without the flag come first (before the grab), as the server orders them
const ordered = (cps) => [...cps.filter((c) => !c.flag), ...cps.filter((c) => c.flag)];

// death is permanent for new runs while ☠ is on (remembered in this browser)
let permadeath = false;
try { permadeath = localStorage.getItem('permadeath') === '1'; } catch (e) { /* no storage */ }
function setPermadeath(on) {
  permadeath = on;
  $('permadeath').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('permadeath', on ? '1' : '0'); } catch (e) { /* no storage */ }
}

function showError(e) { $('error').textContent = e ? e.message || String(e) : ''; $('error').hidden = !e; }
const time = (ticks) => { const s = ticks / 60; return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`; };

async function listRuns() {
  const { runs, live: liveId } = await api('/api/runs');
  $('runs').innerHTML = '<option value="">Past runs</option>' + runs.map((r) => {
    const when = new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dies = r.permadeath ? ' · ☠' : '';
    const tag = r.id === liveId ? '● ' : r.time != null ? '✓ ' : '';
    const cps = (r.checkpoints && r.checkpoints.length ? ` · ⚑${r.checkpoints.length}` : '') + (r.redZones && r.redZones.length ? ' · ⛔' : '');
    return `<option value="${r.id}">${tag}${r.map.replace(/</g, '&lt;')}${cps}${dies} · ${when}</option>`;
  }).join('');
  $('runs').value = runId || '';
  return liveId;
}

async function open(id) {
  showError(null);
  runId = id; version = ''; best = null; recent = []; heat = null; bestTick = 0;
  fresh = null;
  editCheckpoints(false);
  const map = await api(`/api/runs/${id}/map`);
  await view.setMap(map.tiles);
  $('hero').hidden = true;
  $('runs').value = id;
  await poll();
  $('code').value = meta.code;
  clearInterval(polling);
  polling = setInterval(poll, 1000);
}

async function poll() {
  if (!runId) return;
  try {
    const r = await api(`/api/runs/${runId}?since=${encodeURIComponent(version)}`);
    meta = r.meta; live = r.live; version = r.version;
    if (r.view) {
      if (!best || !r.view.best || best.tag !== r.view.best.tag) bestTick = 0;
      best = r.view.best; recent = r.view.recent || []; heat = r.view.heat; recentTick = 0;
      if (best) best.holding = (t) => (best.grabs || []).some((g, i) => t >= g && !(best.caps[i] <= t));
    }
    status();
  } catch (e) { showError(e); }
}

function status() {
  const done = meta.time != null;
  $('status').hidden = !!editing;
  $('status').classList.toggle('done', done);
  $('meter').style.width = `${Math.round(meta.progress * 100)}%`;
  $('headline').textContent = done ? `Possible ✓  ${time(meta.time)}` : `${live ? 'Exploring' : 'Stopped'} · ${Math.round(meta.progress * 100)}% of the way`;
  const speed = meta.seconds > 0 ? `${Math.round(meta.ticks / meta.seconds / 1000)}k ticks/s` : '';
  const splits = (meta.splits || []).map((t, i) => `⚑${i + 1} ${t == null ? '–' : time(t)}`).join('  ');
  $('detail').textContent = [
    `${meta.map}`, meta.permadeath ? '☠ permadeath' : '', splits, `generation ${meta.gen}`, `${meta.cells.toLocaleString()} places found`,
    done ? `proven at gen ${meta.provenAt}${meta.fastestAt !== meta.provenAt ? `, fastest at ${meta.fastestAt}` : ''}` : '',
    live ? speed : '',
  ].filter(Boolean).join(' · ');
  focusPicker();
  $('stop').hidden = !live;
  $('continue').hidden = live;
  $('watch').classList.toggle('off', !best);
  $('download').classList.toggle('off', !best);
  $('download').href = `/api/runs/${runId}/download`;
}

// where to explore: everywhere (normal), or 100% from just past one checkpoint it has reached
function focusPicker() {
  const sel = $('focus'), cps = meta.checkpoints || [];
  sel.hidden = !cps.length;
  // [value, label, not reached yet]
  const opts = [['', 'All ⚑', false], ...cps.map((c, i) => [String(i + 1), `⚑${i + 1} only`, !meta.splits || meta.splits[i] == null])];
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) { sel.innerHTML = opts.map(([v, t, off]) => `<option value="${v}"${off ? ' disabled' : ''}>${t}</option>`).join(''); sel.dataset.sig = sig; }
  if (document.activeElement !== sel) sel.value = meta.focus == null ? '' : String(meta.focus);
}
$('focus').addEventListener('change', (e) => {
  const n = e.target.value ? Number(e.target.value) : null;
  api(`/api/runs/${runId}/focus`, { checkpoint: n }).then(() => { e.target.blur(); return poll(); }).catch(showError);
});

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000) * 60;
  last = now;
  bestTick += dt; recentTick += dt;
  if (best && best.path && bestTick > best.path.length * 2 + 90) bestTick = 0;   // loop, with a pause
  if (recentTick > 90 * 1.5) recentTick = 0;
  view.draw({ heat, recent, recentTick, best, bestTick, checkpoints: editing || (meta && meta.checkpoints), redZones: red || (meta && meta.redZones), editing: !!editing });
  requestAnimationFrame(frame);
}

$('go-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  if (!code) return;
  $('go').disabled = true;
  showError(null);
  $('go').textContent = '…';
  try {
    const { id } = await api('/api/go', { code, checkpoints: fresh === code ? editing : [], redZones: fresh === code ? red : [], permadeath });
    await listRuns();
    await open(id);
  } catch (err) { showError(err); } finally { $('go').disabled = false; $('go').textContent = 'Go'; }
});
$('runs').addEventListener('change', (e) => { if (e.target.value) open(e.target.value).catch(showError); });
$('stop').addEventListener('click', () => api('/api/stop', {}).then(poll).then(listRuns).catch(showError));
$('continue').addEventListener('click', () => api(`/api/runs/${runId}/continue`, {}).then(poll).then(listRuns).catch(showError));
$('watch').addEventListener('click', () => {
  $('tagpro-title').textContent = `${meta.map}: ${meta.time != null ? 'finished in ' + time(meta.time) : 'furthest run so far'}`;
  $('tagpro-frame').src = `/game?replay=${runId}`;
  $('tagpro').showModal();
});
function editCheckpoints(on) {
  editing = on ? ((!fresh && meta && meta.checkpoints) || []).map((c) => ({ ...c })) : null;
  red = on ? ((!fresh && meta && meta.redZones) || []).map((c) => ({ ...c })) : null;
  setMode('cp');
  $('editing').hidden = !on;
  $('status').hidden = on || !runId;
}
// the pasted map, without starting: place its checkpoints first
$('place').addEventListener('click', async () => {
  const code = $('code').value.trim();
  if (!code) return showError(new Error('paste a map preset first'));
  showError(null);
  $('place').disabled = true;
  try {
    const map = await api('/api/map', { code });
    clearInterval(polling);
    runId = null; meta = null; best = null; recent = []; heat = null; fresh = code;
    $('runs').value = '';
    await view.setMap(map.tiles);
    $('hero').hidden = true;
    editCheckpoints(true);
  } catch (e) { showError(e); } finally { $('place').disabled = false; }
});
function setMode(m) {
  mode = m;
  $('mode-cp').setAttribute('aria-pressed', String(m === 'cp'));
  $('mode-red').setAttribute('aria-pressed', String(m === 'red'));
  $('edit-title').textContent = m === 'cp' ? 'Checkpoints' : 'Red zones';
  $('edit-help').textContent = m === 'cp'
    ? 'Click tiles in the order the bot must pass them. Click one again to make it a checkpoint passed holding the flag (⚑), a third time to remove it.'
    : "Click tiles the bot must never go in (outside the map too), or hold Shift and drag to paint them. Click a red tile to clear it. A run that goes in one stops there, so it's never remembered.";
  view.onPaint = m === 'red' ? paintRed : null;
  view.margin = m === 'red' ? RED_MARGIN : 0;
}
$('mode-cp').addEventListener('click', () => setMode('cp'));
$('mode-red').addEventListener('click', () => setMode('red'));

const RED_MARGIN = 30; // red zones can go this many tiles outside the map, as the server allows

// red zones: a click toggles a tile; a Shift-drag sets every tile it crosses the way its first tile went
let painting = true;
function paintRed(x, y, first) {
  if (!red) return;
  const i = red.findIndex((c) => c.x === x && c.y === y);
  if (first) painting = i < 0;
  if (painting && i < 0) red.push({ x, y });
  else if (!painting && i >= 0) red.splice(i, 1);
}

// a click on a tile: add a checkpoint there, make it a flag one, or remove it (or a red zone, toggled)
view.onTile = (x, y) => {
  if (!editing) return;
  if (mode === 'red') return paintRed(x, y, true);
  const i = editing.findIndex((c) => c.x === x && c.y === y);
  if (i < 0) editing.push({ x, y, flag: false });
  else if (!editing[i].flag) editing[i].flag = true;
  else editing.splice(i, 1);
  editing = ordered(editing);
};
$('permadeath').addEventListener('click', () => setPermadeath(!permadeath));
setPermadeath(permadeath);
$('checkpoints').addEventListener('click', () => editCheckpoints(true));
$('cp-cancel').addEventListener('click', () => { editCheckpoints(false); if (fresh) { fresh = null; view.tiles = null; view.bg = null; $('hero').hidden = false; } });
$('cp-apply').addEventListener('click', async () => {
  try {
    const { id } = fresh ? await api('/api/go', { code: fresh, checkpoints: editing, redZones: red, permadeath })
      : await api(`/api/runs/${runId}/checkpoints`, { checkpoints: editing, redZones: red, permadeath });
    await listRuns();
    await open(id);
  } catch (e) { showError(e); }
});
$('tagpro-close').addEventListener('click', () => $('tagpro').close());
$('tagpro').addEventListener('close', () => { $('tagpro-frame').src = 'about:blank'; });

listRuns().then((liveId) => { if (liveId) open(liveId); }).catch(showError);
requestAnimationFrame(frame);
})();
