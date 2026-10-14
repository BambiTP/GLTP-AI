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

// Dijkstra from every target tile outwards
function field(map, isTarget) {
  const tiles = map.tiles, W = tiles.length, H = tiles[0].length;
  const D = new Float64Array(W * H).fill(Infinity);
  const open = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) open[x * H + y] = passable(tiles[x][y]) ? 1 : 0;
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
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (isTarget(Number(tiles[x][y]))) { D[x * H + y] = 0; heap.push(0, x * H + y); }
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

// A red ball's goal: grab the blue (or yellow) flag, cap it on the red flag (a yellow one on a red
// endzone), as many times as the map needs. progress() is in tiles, from 0 at spawn to `total`.
class Goal {
  constructor(level, spawn) {
    const map = level.map;
    this.caps = level.caps;
    this.toFlag = field(map, (t) => t === T.BLUE_FLAG || t === T.BLUE_POTATO || t === T.YELLOW_FLAG);
    this.toRedFlag = field(map, (t) => t === T.RED_FLAG || t === T.RED_POTATO);
    this.toEndzone = field(map, (t) => Math.floor(t) === T.RED_ENDZONE);
    let leg = Infinity; // flag to cap
    map.tiles.forEach((col, x) => col.forEach((t, y) => {
      if (this.toFlag.D[x * this.toFlag.H + y] !== 0) return;
      const f = this.capField(Number(t) === T.YELLOW_FLAG ? 3 : 2);
      leg = Math.min(leg, f.D[x * f.H + y]);
    }));
    const first = distAt(this.toFlag, spawn.x, spawn.y);
    this.leg = Number.isFinite(leg) ? leg : 0;
    this.first = Number.isFinite(first) ? first : 0;
    this.lap = this.first + this.leg;      // spawn -> flag -> cap
    this.again = 2 * this.leg;             // cap -> flag -> cap, for maps that need more caps
    this.total = this.lap + (this.caps - 1) * this.again;
  }

  capField(flag) { return flag === 3 ? this.toEndzone : this.toRedFlag; }

  done(sim) { return sim.capTicks.length >= this.caps; }

  // the tick the map was finished on (null if not yet)
  finishTick(sim) { return this.done(sim) ? sim.capTicks[this.caps - 1] : null; }

  progress(sim) {
    const k = sim.capTicks.length;
    if (k >= this.caps) return this.total;
    const base = k === 0 ? 0 : this.lap + (k - 1) * this.again;
    const toGrab = k === 0 ? this.first : this.leg;
    const b = sim.ball();
    if (!b) return base;
    if (!sim.flag) {
      const d = distAt(this.toFlag, b.x, b.y);
      return base + (Number.isFinite(d) ? Math.max(0, toGrab - d) : 0);
    }
    const d = distAt(this.capField(sim.flag), b.x, b.y);
    return base + toGrab + (Number.isFinite(d) ? Math.max(0, this.leg - d) : 0);
  }
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

module.exports = { Goal, field, distAt, TILE };
