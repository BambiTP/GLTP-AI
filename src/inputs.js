// inputs.js - what a NEAT network sees, MarI/O style: the tiles in a 13x13 box around the ball
// (walls 1, things that pop you -1, boosts and bombs 0.5), plus the ball's velocity, jumps left,
// whether it has the flag, the direction the path goes next, and a bias.
// Shared with the dashboard (it draws the same box next to the network).
(function () {
const RADIUS = 6;
const SIDE = RADIUS * 2 + 1;
const EXTRAS = ['vx', 'vy', 'jumps', 'flag', 'pathX', 'pathY'];
const COUNT = SIDE * SIDE + EXTRAS.length + 1; // + bias, always last
const OUTPUTS = ['left', 'right', 'up', 'down'];

// a red ball's view of a tile
function tileValue(t) {
  const n = Number(t), b = Math.floor(n);
  if (b === 0 || b === 1) return 1;            // nothing / walls
  if (b === 7) return -1;                      // spike
  if (n === 9.1 || n === 9.3) return -1;       // green gate, blue gate
  if (b === 5 || b === 14 || b === 10) return 0.5; // boost, red boost, bomb
  return 0;
}

// fills out[0..SIDE*SIDE) with the box around tile (cx, cy), row by row
function grid(tiles, cx, cy, out) {
  const W = tiles.length, H = tiles[0].length;
  let i = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const x = cx + dx, y = cy + dy;
      out[i++] = x < 0 || y < 0 || x >= W || y >= H ? 1 : tileValue(tiles[x][y]);
    }
  }
  return out;
}

const api = { RADIUS, SIDE, EXTRAS, COUNT, OUTPUTS, tileValue, grid };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.GLTPInputs = api;
})();
