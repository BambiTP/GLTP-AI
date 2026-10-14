// demo.js - turns a TagPro replay (NDJSON lines of [ms, event, data], the format TagPro's Replays page
// downloads and tagpro-local records) into a rough path for the bot: the good parts of a run, with
// the deaths and dead ends left out.
//
// The followed player's run is split into lives (spawn to death, or spawn to cap). The path is the
// life that capped, from its start to the cap. If that life began at a checkpoint rather than spawn,
// the earlier life that passed closest to that checkpoint provides the way there, and so on back to
// spawn. Inside a life, lines split at teleports (portals: the server marks the ball's position
// "directSet"), and the bot treats the gap as a teleport, not a walk.
// Shared with the page (it reads dropped replays without uploading them).
(function () {
const TILE = 0.4;
const JUMP = 8;      // tiles: farther than this between two positions in a row is a teleport even unmarked
const NEAR = 3;      // tiles: a life "passes" a checkpoint within this

function parse(text) {
  const lines = String(text).split('\n');
  let id = null, mapId = null, mapName = null, W = null, H = null, players = {}, t0 = null;
  const events = [];
  for (const line of lines) {
    if (!line || line[0] !== '[') continue;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    const [t, ev, d] = e;
    if (ev === 'id' && id == null) id = d;
    else if (ev === 'map' && d && d.tiles) { W = d.tiles.length; H = d.tiles[0].length; mapName = d.info && d.info.name; }
    else if (ev === 'clientInfo' && d) { const m = /^fm_id\/(\d+)$/.exec(d.mapfile || ''); if (m) mapId = m[1]; }
    else if (ev === 'recorder-metadata' && d) { mapName = mapName || d.mapName; }
    else if (ev === 'time' && d && d.state === 1 && t0 == null) t0 = t;
    else if (ev === 'p') {
      const u = Array.isArray(d) ? d : (d && d.u) || [];
      for (const x of u) if (x && x.id != null) { events.push([t, x]); if (!players[x.id]) players[x.id] = { id: x.id, name: x.name, caps: 0 }; if (x.name) players[x.id].name = x.name; if (typeof x['s-captures'] === 'number') players[x.id].caps = Math.max(players[x.id].caps, x['s-captures']); }
    }
  }
  if (!events.length) throw new Error("that file doesn't look like a TagPro replay");
  // the player to learn from: the one the replay follows, else the one with the most caps
  if (id == null || !players[id]) id = Object.values(players).sort((a, b) => b.caps - a.caps)[0].id;

  // lives
  const lives = [];
  let life = null, caps = null, flag = null;
  for (const [t, x] of events) {
    if (x.id !== id) continue;
    if (x.dead === true) { if (life) { life.end = t; life.died = true; lives.push(life); life = null; } continue; }
    if ('flag' in x) { flag = x.flag; if (life && flag && life.grab == null) life.grab = t; }
    if (typeof x['s-captures'] === 'number') {
      if (caps != null && x['s-captures'] > caps && life) { life.cap = t; life.end = t; lives.push(life); life = null; }
      caps = x['s-captures'];
    }
    if (typeof x.rx !== 'number' || typeof x.ry !== 'number') continue;
    if (!life) life = { start: t, points: [], died: false, cap: null, grab: flag ? t : null }; // spawned
    life.points.push({ t, x: x.rx / TILE + 0.5, y: x.ry / TILE + 0.5, tele: x.directSet === true && life.points.length > 0 });
  }
  if (life && life.points.length) { life.end = life.points[life.points.length - 1].t; lives.push(life); }
  const good = lives.filter((l) => l.points.length > 1);
  if (!good.length) throw new Error("couldn't find the player's movement in that replay");
  return { mapId, mapName, W, H, player: players[id], lives: good, t0 };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// points -> lines, split wherever the ball jumped (a teleport)
function toLines(points) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && (p.tele || dist(cur[cur.length - 1], p) > JUMP)) { if (cur.length > 1) out.push(cur); cur = []; }
    cur.push({ x: p.x, y: p.y });
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// the good parts, as lines of { x, y } in tiles (0.5 = middle of the first tile) for the page's path
// tool; spawn: { x, y } in the same units. Returns { lines, used, summary }
function goodPath(demo, spawn) {
  const lives = demo.lives;
  let last = lives.findIndex((l) => l.cap != null);
  let why;
  if (last >= 0) why = 'capped';
  else {
    last = lives.findIndex((l) => l.grab != null);
    if (last >= 0) why = 'grabbed the flag';
    else { last = lives.reduce((b, l, i) => (l.end - l.start > lives[b].end - lives[b].start ? i : b), 0); why = 'lasted longest'; }
  }
  const pieces = [lives[last].points];
  const used = [last];
  // back to spawn through earlier lives, if the good life began somewhere else (a checkpoint)
  let from = lives[last].points[0];
  for (let guard = 0; spawn && dist(from, spawn) > NEAR && guard < lives.length; guard++) {
    let best = null;
    for (let i = 0; i < last; i++) {
      if (used.includes(i)) continue;
      const pts = lives[i].points;
      let k = -1, d = Infinity;
      pts.forEach((p, j) => { const q = dist(p, from); if (q < d) { d = q; k = j; } });
      if (d <= NEAR && (!best || d < best.d)) best = { i, k, d };
    }
    if (!best) break;
    pieces.unshift(lives[best.i].points.slice(0, best.k + 1));
    used.unshift(best.i);
    from = lives[best.i].points[0];
  }
  const lines = pieces.flatMap(toLines);
  const secs = (t) => ((t - (lives[0].start)) / 1000).toFixed(1);
  const life = lives[last];
  return {
    lines, used,
    summary: `${demo.player.name || 'the player'}'s life ${last + 1} of ${lives.length} (${why}${life.cap != null ? ` at ${secs(life.cap)} s` : ''})` +
      (used.length > 1 ? `, joined to ${used.length - 1} earlier life${used.length > 2 ? 's' : ''} for the way from spawn` : '') +
      `; ${lives.filter((l) => l.died).length} death${lives.filter((l) => l.died).length === 1 ? '' : 's'} left out`,
  };
}

const api = { parse, goodPath, toLines };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.GLTPDemo = api;
})();
