// app.js - paste a preset, press Go, watch. Or open a past run and continue it.
(function () {
const $ = (id) => document.getElementById(id);
const view = new MapView($('map'));
let runId = null, live = false, version = '', meta = null, best = null, recent = [], heat = null;
let bestTick = 0, recentTick = 0, last = performance.now(), polling = null;

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: 'the server stopped answering' }));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function showError(e) { $('error').textContent = e ? e.message || String(e) : ''; $('error').hidden = !e; }
const time = (ticks) => { const s = ticks / 60; return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`; };

async function listRuns() {
  const { runs, live: liveId } = await api('/api/runs');
  $('runs').innerHTML = '<option value="">Past runs</option>' + runs.map((r) => {
    const when = new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tag = r.id === liveId ? '● ' : r.time != null ? '✓ ' : '';
    return `<option value="${r.id}">${tag}${r.map.replace(/</g, '&lt;')} · ${when}</option>`;
  }).join('');
  $('runs').value = runId || '';
  return liveId;
}

async function open(id) {
  showError(null);
  runId = id; version = ''; best = null; recent = []; heat = null; bestTick = 0;
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
  $('status').hidden = false;
  $('status').classList.toggle('done', done);
  $('meter').style.width = `${Math.round(meta.progress * 100)}%`;
  $('headline').textContent = done ? `Possible ✓  ${time(meta.time)}` : `${live ? 'Exploring' : 'Stopped'} · ${Math.round(meta.progress * 100)}% of the way`;
  const speed = meta.seconds > 0 ? `${Math.round(meta.ticks / meta.seconds / 1000)}k ticks/s` : '';
  $('detail').textContent = [
    `${meta.map}`, `generation ${meta.gen}`, `${meta.cells.toLocaleString()} places found`,
    done ? `proven at gen ${meta.provenAt}${meta.fastestAt !== meta.provenAt ? `, fastest at ${meta.fastestAt}` : ''}` : '',
    live ? speed : '',
  ].filter(Boolean).join(' · ');
  $('stop').hidden = !live;
  $('continue').hidden = live;
  $('watch').classList.toggle('off', !best);
  $('download').classList.toggle('off', !best);
  $('download').href = `/api/runs/${runId}/download`;
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000) * 60;
  last = now;
  bestTick += dt; recentTick += dt;
  if (best && best.path && bestTick > best.path.length * 2 + 90) bestTick = 0;   // loop, with a pause
  if (recentTick > 90 * 1.5) recentTick = 0;
  view.draw({ heat, recent, recentTick, best, bestTick });
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
    const { id } = await api('/api/go', { code });
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
$('tagpro-close').addEventListener('click', () => $('tagpro').close());
$('tagpro').addEventListener('close', () => { $('tagpro-frame').src = 'about:blank'; });

listRuns().then((liveId) => { if (liveId) open(liveId); }).catch(showError);
requestAnimationFrame(frame);
})();
