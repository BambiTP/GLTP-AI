// progress.js - how far along the map a run is: walking distance to the flag, then back to cap.
//
// A field holds, for every tile, how far it is from the nearest target tile: along open tiles, in 8
// directions without cutting wall corners, and through portals. So it's a path length, not a
// straight line (it can't know what's too high to jump, which is why the explorer only leans on it
// lightly).
const { T } = require('./tagpro');

const TILE = 0.4;
const SQRT2 = Math.SQRT2;

function passable(t) {
  const n = Number(t), b = Math.floor(n);
  if (b === 0 || b === T.SPIKE) return false;
  if (b === 1) return n !== 1; // 45° walls are half open
  return true;
}

// Dijkstra from every target tile outwards; `blocked` (x * H + y) are red zones, walked around like walls
function field(map, isTarget, blocked) {
  const tiles = map.tiles, W = tiles.length, H = tiles[0].length;
  const D = new Float64Array(W * H).fill(Infinity);
  const open = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) open[x * H + y] = passable(tiles[x][y]) && !(blocked && blocked.has(x * H + y)) ? 1 : 0;
  // portals, reversed: arriving at a portal's destination means the portal tile is one step further
  const into = new Map();
  for (const [k, conf] of Object.entries(map.portals || {})) {
    if (!conf || !conf.destination) continue;
    const [px, py] = k.split(',').map(Number), d = conf.destination;
    if (!(d.x >= 0 && d.y >= 0 && d.x < W && d.y < H)) continue;
    const to = d.x * H + d.y;
    if (!into.has(to)) into.set(to, []);
    into.get(to).push(px * H + py);
  }
  const heap = new Heap();
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (isTarget(Number(tiles[x][y]), x, y)) { D[x * H + y] = 0; heap.push(0, x * H + y); }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > D[i]) continue;
    const x = Math.floor(i / H), y = i % H;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = nx * H + ny;
      if (!open[j]) continue;
      if (dx && dy && (!open[(x + dx) * H + y] || !open[x * H + y + dy])) continue;
      const nd = d + (dx && dy ? SQRT2 : 1);
      if (nd < D[j]) { D[j] = nd; heap.push(nd, j); }
    }
    for (const j of into.get(i) || []) {
      const nd = d + 1;
      if (nd < D[j]) { D[j] = nd; heap.push(nd, j); }
    }
  }
  return { D, W, H };
}

// distance from a point (metres) to the field's targets: through whichever nearby tile centre is best
function distAt(f, x, y) {
  const tx = Math.round(x / TILE), ty = Math.round(y / TILE);
  let best = Infinity;
  for (let a = tx - 1; a <= tx + 1; a++) for (let b = ty - 1; b <= ty + 1; b++) {
    if (a < 0 || b < 0 || a >= f.W || b >= f.H) continue;
    const d = f.D[a * f.H + b];
    if (d === Infinity) continue;
    const v = d + Math.hypot(x - a * TILE, y - b * TILE) / TILE;
    if (v < best) best = v;
  }
  return best;
}

// A red ball's goal: grab the blue (or yellow) flag, cap it on the red flag or in a red endzone (a
// yellow one in a red endzone only), as many times as the map needs. On the first lap it passes the
// creator's checkpoints in order: the ones without the flag on the way to it, the ones with the flag
// on the way back. A cap only counts once every checkpoint is passed. progress() is in tiles, from 0 at spawn to `total`.
class Goal {
  constructor(level, spawn) {
    const map = level.map, H = map.tiles[0].length;
    this.caps = level.caps;
    this.blocked = new Set((level.redZones || []).filter((c) => c.x >= 0 && c.y >= 0 && c.x < map.tiles.length && c.y < H).map((c) => c.x * H + c.y));
    this.toFlag = field(map, (t) => t === T.BLUE_FLAG || t === T.BLUE_POTATO || t === T.YELLOW_FLAG, this.blocked);
    this.toRedFlag = field(map, (t) => t === T.RED_FLAG || t === T.RED_POTATO, this.blocked);
    this.toEndzone = field(map, (t) => Math.floor(t) === T.RED_ENDZONE, this.blocked);
    // the blue flag caps on the red flag or in a red endzone (see Sim.endzone)
    this.toCap = field(map, (t) => t === T.RED_FLAG || t === T.RED_POTATO || Math.floor(t) === T.RED_ENDZONE, this.blocked);
    // flag tiles: [x, y, the field to cap it on]
    const flags = [];
    map.tiles.forEach((col, x) => col.forEach((t, y) => {
      if (this.toFlag.D[x * this.toFlag.H + y] === 0) flags.push([x, y, this.capField(Number(t) === T.YELLOW_FLAG ? 3 : 2)]);
    }));
    const cps = level.checkpoints || [];
    this.pre = cps.filter((c) => !c.flag).length;
    // the first lap's targets in order: checkpoints, the flag, checkpoints with the flag, the cap
    this.targets = [...cps.slice(0, this.pre).map((c) => this.point(map, c)), { flag: true }, ...cps.slice(this.pre).map((c) => this.point(map, c)), { cap: true }];
    const fin = (d) => (Number.isFinite(d) ? d : 0);
    // legs[i]: the walk into target i from the one before it (from spawn for the first)
    this.legs = this.targets.map((to, i) => {
      const from = i ? this.targets[i - 1] : { x: spawn.x / TILE, y: spawn.y / TILE };
      if (from.flag) return fin(Math.min(...flags.map(([x, y, f]) => { const g = to.cap ? f : to.field; return g.D[x * g.H + y]; })));
      return fin(Math.min(...this.fieldsOf(to).map((f) => distAt(f, from.x * TILE, from.y * TILE))));
    });
    this.cum = [0];
    for (const l of this.legs) this.cum.push(this.cum[this.cum.length - 1] + l);
    this.leg = fin(Math.min(...flags.map(([x, y, f]) => f.D[x * f.H + y]))); // flag to cap
    this.lap = this.cum[this.legs.length];  // spawn -> checkpoints -> flag -> checkpoints -> cap
    this.again = 2 * this.leg;              // cap -> flag -> cap, for maps that need more caps
    this.total = this.lap + (this.caps - 1) * this.again;
  }

  point(map, c) { return { x: c.x, y: c.y, field: field(map, (t, x, y) => x === c.x && y === c.y, this.blocked) }; }

  fieldsOf(target, flag) {
    if (target.field) return [target.field];
    if (target.flag) return [this.toFlag];
    return flag ? [this.capField(flag)] : [this.toRedFlag, this.toEndzone];
  }

  capField(flag) { return flag === 3 ? this.toEndzone : this.toCap; }

  done(sim) { return sim.goalCaps.length >= this.caps; }

  // the tick the map was finished on (null if not yet)
  finishTick(sim) { return this.done(sim) ? sim.goalCaps[this.caps - 1] : null; }

  progress(sim) {
    const k = sim.goalCaps.length;
    if (k >= this.caps) return this.total;
    const b = sim.ball();
    if (k > 0) {
      const base = this.lap + (k - 1) * this.again;
      if (!b) return base;
      if (!sim.flag) {
        const d = distAt(this.toFlag, b.x, b.y);
        return base + (Number.isFinite(d) ? Math.max(0, this.leg - d) : 0);
      }
      const d = distAt(this.capField(sim.flag), b.x, b.y);
      return base + this.leg + (Number.isFinite(d) ? Math.max(0, this.leg - d) : 0);
    }
    // the first lap: which target it's heading for
    const s = sim.cpTicks.length;
    let i;
    if (!sim.flag) i = Math.min(s, this.pre);   // a checkpoint, or the flag
    else if (s < this.pre) return this.cum[s];   // grabbed before its checkpoints: off the route
    else i = s + 1;                              // a checkpoint with the flag, or the cap
    if (!b) return this.cum[i];
    const d = Math.min(...this.fieldsOf(this.targets[i], sim.flag).map((f) => distAt(f, b.x, b.y)));
    return this.cum[i] + (Number.isFinite(d) ? Math.max(0, this.legs[i] - d) : 0);
  }
}

// What makes two moments "the same place": tile, rough speed, jumps left, flag, caps done,
// checkpoints passed, gates.
function placeKey(sim, goal) {
  if (goal.done(sim)) return 'done';
  const b = sim.ball();
  if (!b) return null;
  const vx = Math.max(-2, Math.min(2, Math.round(b.vx / 1.25)));
  const vy = b.vy < -1.5 ? 'u' : b.vy > 1.5 ? 'd' : 's';
  return `${Math.round(b.x / TILE)},${Math.round(b.y / TILE)},${vx}${vy},${Math.min(sim.jumpsLeft, 3)},${sim.flag},${sim.capTicks.length},${sim.cpTicks.length},${sim.gateState()}`;
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

module.exports = { Goal, placeKey, field, distAt, TILE };
