// progress.js - walking distances over a map's open tiles (see goals.js for how they're used).
//
// A field holds, for every tile, how far it is from the nearest target tile: along open tiles, in 8
// directions without cutting wall corners, and through portals. So it's a path length, not a
// straight line.
const { T } = require('./tagpro');

const TILE = 0.4;
const SQRT2 = Math.SQRT2;

function passable(t) {
  const n = Number(t), b = Math.floor(n);
  if (b === 0 || b === T.SPIKE) return false;
  if (b === 1) return n !== 1; // 45° walls are half open
  return true;
}

// Dijkstra from every target tile outwards; isTarget(tile, x, y)
function field(map, isTarget) {
  const tiles = map.tiles, W = tiles.length, H = tiles[0].length;
  const D = new Float64Array(W * H).fill(Infinity);
  const open = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) open[x * H + y] = passable(tiles[x][y]) ? 1 : 0;
  // portal edges, reversed: arriving at dest means the portal tile is one step further
  const into = new Map();
  for (const [k, conf] of Object.entries(map.portals || {})) {
    if (!conf || !conf.destination) continue;
    const [px, py] = k.split(',').map(Number), d = conf.destination;
    if (!(d.x >= 0 && d.y >= 0 && d.x < W && d.y < H)) continue;
    const di = d.x * H + d.y;
    if (!into.has(di)) into.set(di, []);
    into.get(di).push(px * H + py);
  }
  const heap = new Heap();
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (isTarget(tiles[x][y], x, y)) { D[x * H + y] = 0; heap.push(0, x * H + y); }
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

module.exports = { field, distAt, TILE };
