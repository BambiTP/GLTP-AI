// path.js - a rough path (drawn on the page, or the good parts of a replay, see demo.js) becomes
// the bot's goals: "via" waypoints every few tiles along it (goals.js), the grab where the path passes
// the flag (after the last waypoint if it never does), and the cap at the end.
// Shared by the page and the command line.
(function () {
const SPACING = 3;       // a waypoint every 3 tiles along the path
const REACH = 2;         // ... each counts as passed within 2 tiles (and passing a later one counts too)

function isOpen(tiles, x, y) {
  const t = tiles;
  if (x < 0 || y < 0 || x >= t.length || y >= t[0].length) return false;
  const n = Number(t[x][y]), b = Math.floor(n);
  return b !== 0 && n !== 1 && b !== 7;
}

function tilesWhere(tiles, pred) {
  const out = [], t = tiles;
  for (let x = 0; x < t.length; x++) for (let y = 0; y < t[0].length; y++) if (pred(Number(t[x][y]))) out.push({ x, y });
  return out;
}

// points every `step` tiles along each drawn line, its start and end included. Lines are kept apart:
// the gap between the end of one line and the start of the next is a teleport (a portal, or popping
// and respawning), not a walk, so no waypoints go in it
function resample(strokes, step) {
  const out = [];
  for (const line of strokes) {
    if (!line.length) continue;
    out.push(line[0]);
    let carry = 0;
    for (let i = 1; i < line.length; i++) {
      let from = line[i - 1];
      const p = line[i];
      let d = Math.hypot(p.x - from.x, p.y - from.y);
      while (carry + d >= step) {
        const k = (step - carry) / d;
        const q = { x: from.x + (p.x - from.x) * k, y: from.y + (p.y - from.y) * k };
        out.push(q);
        d -= step - carry; carry = 0; from = q;
      }
      carry += d;
    }
    const last = line[line.length - 1], prev = out[out.length - 1];
    if (Math.hypot(last.x - prev.x, last.y - prev.y) > step / 3) out.push(last);
  }
  return out;
}

// the nearest open tile to a point (the path is rough; walls and spikes aren't targets)
function snap(tiles, p) {
  let best = null, bd = Infinity;
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) {
    if (!isOpen(tiles, x, y)) continue;
    const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best || { x: cx, y: cy };
}

// strokes: lines of { x, y } in tiles (0.5 = middle of the first tile); spawn: the ball's spawn in
// metres; baseSteps: the map's GLTP rules (grab, cap, ...)
function pathToPlan(tiles, spawnPos, baseSteps, strokes, { spacing = SPACING, reach: r = REACH } = {}) {
  const base = baseSteps.map((s) => ({ ...s }));
  const pts = strokes.flat();
  if (pts.length < 2) return { steps: base, timeFrom: -1, source: 'gltp' };
  const near = (list, p) => Math.min(...list.map((q) => Math.hypot(q.x - p.x, q.y - p.y)), Infinity);
  const flags = tilesWhere(tiles, (t) => t === 4 || t === 20 || t === 16);
  const caps = tilesWhere(tiles, (t) => t === 3 || t === 19 || Math.floor(t) === 17);
  const spawn = { x: Math.round(spawnPos.x / 0.4), y: Math.round(spawnPos.y / 0.4) };
  let way = [];
  for (const p of resample(strokes, spacing)) {
    const t = snap(tiles, p);
    if (!way.length || way[way.length - 1].x !== t.x || way[way.length - 1].y !== t.y) way.push(t);
  }
  way = way.filter((w, i) => !(i === 0 && Math.hypot(w.x - spawn.x, w.y - spawn.y) < 2));
  // grab where the path passes the flag, if it does; cap at the end
  let gi = -1, gd = Infinity;
  way.forEach((w, i) => { const d = near(flags, w); if (d < gd) { gd = d; gi = i; } });
  const steps = [];
  const reach = (w) => ({ type: 'reach', x: w.x, y: w.y, r, soft: true });
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
  return { steps, timeFrom: -1, source: 'run', drawn: strokes.map((l) => l.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100])) };
}

const api = { pathToPlan, resample, SPACING, REACH };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.GLTPPath = api;
})();
