// goals.js - what counts as beating a map, and how far along a run is.
//
// A plan is an ordered list of steps; finishing the last one is the win, and the tick it happens on
// is the run's time:
//   { type: 'reach', x, y, r }   get the ball's centre within r tiles of tile (x, y) (a waypoint)
//   { type: 'reach', ..., soft } a "via" waypoint: a rough-path guide. Reaching any later via point
//                                in the same run of them counts for the ones before it, so the ball
//                                can cut corners, while progress still follows the path
//   { type: 'grab' }             grab a flag (blue or yellow)
//   { type: 'cap' }              cap (blue flag on the red flag, yellow flag on a red endzone)
//   { type: 'button', x, y }     touch the button on tile (x, y)
// A custom path is just reach steps in order. By default a map's plan is its GLTP rules: grab then
// cap, repeated for maps that need more than one cap.
//
// Progress is measured in tiles along the plan: each step's distance is the walkable path length from
// the previous step's spot to this step's target, and inside the current step it's how much of that
// distance is already covered.
const fs = require('fs');
const path = require('path');
const { T } = require('./tagpro');
const { field, distAt, TILE } = require('./progress');

const PLAN_DIR = path.join(__dirname, '..', 'plans');

const GRAB_TILES = [T.BLUE_FLAG, T.BLUE_POTATO, T.YELLOW_FLAG];

// text form, one step per ";" or line: "reach 10,5 r2; via 14,3; grab; button 7,3; cap"
function parseSteps(text) {
  return String(text).split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [type, at, r] = s.split(/\s+/);
    if (type === 'grab' || type === 'cap') return { type };
    const m = /^(\d+),(\d+)$/.exec(at || '');
    if (!m) throw new Error(`"${s}": expected "${type} x,y"`);
    if (type === 'reach') return { type, x: +m[1], y: +m[2], r: r ? Number(r.replace(/^r/, '')) : 1 };
    if (type === 'via') return { type: 'reach', x: +m[1], y: +m[2], r: r ? Number(r.replace(/^r/, '')) : 2, soft: true };
    if (type === 'button') return { type, x: +m[1], y: +m[2] };
    throw new Error(`unknown step "${type}" (reach, via, grab, cap, button)`);
  });
}

function stepsText(steps) {
  return steps.map((s) => {
    if (s.type === 'reach' && s.soft) return `via ${s.x},${s.y}${s.r !== 2 ? ' r' + s.r : ''}`;
    if (s.type === 'reach') return `reach ${s.x},${s.y}${s.r !== 1 ? ' r' + s.r : ''}`;
    return s.type === 'button' ? `button ${s.x},${s.y}` : s.type;
  }).join('; ');
}

// a map's GLTP rules as a plan (red ball): grab and cap, as many caps as the leaderboard wants
function defaultSteps(level) {
  const info = level.gltp;
  const caps = info && Number(info.caps_to_win) > 1 ? Number(info.caps_to_win) : 1;
  const out = [];
  for (let i = 0; i < caps; i++) out.push({ type: 'grab' }, { type: 'cap' });
  return out;
}

function validate(steps, map) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a plan needs at least one step');
  const W = map.tiles.length, H = map.tiles[0].length;
  return steps.map((s) => {
    if (s.type === 'grab' || s.type === 'cap') return { type: s.type };
    const x = Math.round(Number(s.x)), y = Math.round(Number(s.y));
    if (!(x >= 0 && y >= 0 && x < W && y < H)) throw new Error(`${s.type} ${s.x},${s.y} is off the map`);
    if (s.type === 'reach') return Object.assign({ type: 'reach', x, y, r: Math.max(0.3, Math.min(10, Number(s.r) || 1)) }, s.soft ? { soft: true } : {});
    if (s.type === 'button') {
      if (Math.floor(Number(map.tiles[x][y])) !== T.BUTTON) throw new Error(`there's no button at ${x},${y}`);
      return { type: 'button', x, y };
    }
    throw new Error('unknown step type ' + s.type);
  });
}

class Plan {
  // timeFrom: -1 = the clock runs from spawn, else from the moment step `timeFrom` is done
  constructor(level, steps, spawn, { timeFrom = -1 } = {}) {
    const map = level.map;
    this.steps = validate(steps, map);
    this.timeFrom = timeFrom;
    const tiles = map.tiles;
    const grab = field(map, (t) => GRAB_TILES.includes(Number(t)));
    const capFlag = field(map, (t) => [T.RED_FLAG, T.RED_POTATO].includes(Number(t)));
    const capZone = field(map, (t) => Math.floor(Number(t)) === T.RED_ENDZONE);
    this.capFor = (flag) => (flag === 3 ? capZone : capFlag);
    // cheapest flag-to-cap leg, for "cap" while not holding a flag (grab first, then this)
    let leg = Infinity;
    for (let x = 0; x < tiles.length; x++) for (let y = 0; y < tiles[0].length; y++) {
      if (!GRAB_TILES.includes(Number(tiles[x][y]))) continue;
      const f = this.capFor(Number(tiles[x][y]) === T.YELLOW_FLAG ? 3 : 4);
      leg = Math.min(leg, f.D[x * f.H + y]);
    }
    this.leg = Number.isFinite(leg) ? leg : 0;
    this.grab = grab;

    // each step's target field, the spot it ends at, and its length from the previous spot
    this.fields = [];
    this.seg = [];
    this.cum = [0];
    let at = { x: spawn.x, y: spawn.y };
    for (const s of this.steps) {
      let f;
      if (s.type === 'grab') f = grab;
      else if (s.type === 'cap') f = null; // depends on the flag held; see dist()
      else if (s.type === 'reach') f = field(map, (t, x, y) => Math.hypot(x - s.x, y - s.y) <= s.r + 1e-9);
      else f = field(map, (t, x, y) => x === s.x && y === s.y);
      this.fields.push(f);
      const len = f ? distAt(f, at.x, at.y) : Math.min(distAt(capFlag, at.x, at.y), distAt(capZone, at.x, at.y));
      const d = Number.isFinite(len) ? len : 0;
      this.seg.push(d);
      this.cum.push(this.cum[this.cum.length - 1] + d);
      at = f ? nearestTarget(f, at, map) : nearestTarget(distAt(capFlag, at.x, at.y) <= distAt(capZone, at.x, at.y) ? capFlag : capZone, at, map);
    }
    this.total = this.cum[this.cum.length - 1];
  }

  start() { return { step: 0, done: [], grabs: 0, caps: 0 }; }

  finished(state) { return state.step >= this.steps.length; }

  // ticks the run took by this plan's clock (null if not finished)
  time(state) {
    if (!this.finished(state)) return null;
    const end = state.done[state.done.length - 1];
    return this.timeFrom >= 0 ? end - state.done[this.timeFrom] : end;
  }

  // call after every tick: ticks off every step that's now done
  update(state, sim) {
    while (state.step < this.steps.length) {
      const s = this.steps[state.step];
      let ok = false;
      if (s.type === 'grab') { ok = sim.grabCount > state.grabs; if (ok) state.grabs = sim.grabCount; }
      else if (s.type === 'cap') { ok = sim.capCount > state.caps; if (ok) state.caps = sim.capCount; }
      else if (s.type === 'button') ok = !sim.dead && sim.p.touching.has(s.x + ',' + s.y);
      else {
        const b = sim.ball();
        if (!b) break;
        const at = (w) => Math.hypot(b.x / TILE - w.x, b.y / TILE - w.y) <= w.r;
        // via points: the furthest one reached in this run of them counts for all before it
        let hit = at(s) ? state.step : -1;
        if (s.soft) for (let j = state.step + 1; j < this.steps.length && this.steps[j].type === 'reach' && this.steps[j].soft; j++) if (at(this.steps[j])) hit = j;
        if (hit < 0) break;
        while (state.step < hit) { state.done.push(sim.tick); state.step++; }
        ok = true;
      }
      if (!ok) break;
      state.done.push(sim.tick);
      state.step++;
    }
    return state;
  }

  // tiles still to go to the current step's target
  dist(state, x, y, flag) {
    const s = this.steps[state.step];
    if (s.type === 'cap') return flag ? distAt(this.capFor(flag), x, y) : distAt(this.grab, x, y) + this.leg;
    return distAt(this.fields[state.step], x, y);
  }

  // progress in tiles: 0 at spawn, total when the plan is done
  progress(state, sim) {
    if (this.finished(state)) return this.total;
    const b = sim.ball();
    if (!b) return this.cum[state.step];
    const d = this.dist(state, b.x, b.y, sim.flag);
    const into = Number.isFinite(d) ? Math.min(this.seg[state.step], this.seg[state.step] - d) : -this.seg[state.step];
    return this.cum[state.step] + into;
  }

  // unit vector to the best neighbouring tile on the way to the current target (network input)
  direction(state, sim) {
    const b = sim.ball();
    if (!b || this.finished(state)) return [0, 0];
    const s = this.steps[state.step];
    const f = s.type === 'cap' ? (sim.flag ? this.capFor(sim.flag) : this.grab) : this.fields[state.step];
    const tx = Math.round(b.x / TILE), ty = Math.round(b.y / TILE);
    let best = Infinity, dx = 0, dy = 0;
    for (let a = tx - 1; a <= tx + 1; a++) for (let c = ty - 1; c <= ty + 1; c++) {
      if (a < 0 || c < 0 || a >= f.W || c >= f.H || (a === tx && c === ty)) continue;
      const d = f.D[a * f.H + c];
      if (d < best) { best = d; dx = a * TILE - b.x; dy = c * TILE - b.y; }
    }
    if (best === Infinity) return [0, 0];
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
  }
}

// the target tile of f closest (by walking) to point `from`
function nearestTarget(f, from, map) {
  const src = field(map, (t, x, y) => x === Math.round(from.x / TILE) && y === Math.round(from.y / TILE));
  let best = Infinity, bx = from.x, by = from.y, any = false;
  for (let i = 0; i < f.D.length; i++) {
    if (f.D[i] !== 0) continue;
    any = true;
    if (src.D[i] < best) { best = src.D[i]; bx = Math.floor(i / f.H) * TILE; by = (i % f.H) * TILE; }
  }
  if (!any || best === Infinity) {
    // unreachable by walking: the straight-line nearest target
    let bd = Infinity;
    for (let i = 0; i < f.D.length; i++) {
      if (f.D[i] !== 0) continue;
      const x = Math.floor(i / f.H) * TILE, y = (i % f.H) * TILE, d = Math.hypot(x - from.x, y - from.y);
      if (d < bd) { bd = d; bx = x; by = y; }
    }
  }
  return { x: bx, y: by };
}

// ---------- saved plans ----------
// plans/<map>.json holds a map's custom plan ({ steps, timeFrom }); runs on that map use it unless
// they're given their own

const planFile = (level) => path.join(PLAN_DIR, String(level.slug || level.key).replace(/\.[a-z]+$/i, '').split(/[\\/]/).pop().replace(/[^\w-]+/g, '-') + '.json');

function savedPlan(level) {
  try { return JSON.parse(fs.readFileSync(planFile(level), 'utf8')); } catch (e) { return null; }
}

function savePlan(level, plan) {
  const clean = { steps: validate(plan.steps, level.map), timeFrom: Number.isInteger(plan.timeFrom) ? plan.timeFrom : -1 };
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  fs.writeFileSync(planFile(level), JSON.stringify(clean, null, 1) + '\n');
  return clean;
}

function deletePlan(level) { try { fs.unlinkSync(planFile(level)); } catch (e) { /* none */ } }

// the plan a run uses: its own, else the map's saved one, else the GLTP rules
function resolvePlan(level, own) {
  if (own && own.steps) {
    const out = { steps: validate(own.steps, level.map), timeFrom: Number.isInteger(own.timeFrom) ? own.timeFrom : -1, source: own.source || 'run' };
    if (Array.isArray(own.drawn)) out.drawn = own.drawn; // the path as drawn (strokes of [x, y] tiles), for the UI
    return out;
  }
  const saved = savedPlan(level);
  if (saved) return { steps: validate(saved.steps, level.map), timeFrom: saved.timeFrom ?? -1, source: 'saved' };
  return { steps: defaultSteps(level), timeFrom: -1, source: 'gltp' };
}

module.exports = { Plan, parseSteps, stepsText, defaultSteps, validate, savedPlan, savePlan, deletePlan, resolvePlan };
