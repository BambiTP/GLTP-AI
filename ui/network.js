// network.js - a NEAT network drawn the way MarI/O draws it: the box of tiles the network sees on the
// left, its extra inputs under it, the four keys on the right, hidden neurons settled in between,
// and links coloured by weight (green positive, red negative).
(function () {
const I = globalThis.GLTPInputs;
const MAX_NODES = 1000000;

class NetworkView {
  constructor(canvas) { this.canvas = canvas; this.genome = null; }

  set(genome) {
    this.genome = genome;
    this.layout = genome ? this.place(genome) : null;
  }

  // logical coordinates: 320 x 210
  place(genome) {
    const cell = 9, gx = 8, gy = 8, pos = new Map();
    for (let i = 0; i < I.SIDE * I.SIDE; i++) pos.set(i + 1, { x: gx + (i % I.SIDE) * cell + cell / 2, y: gy + Math.floor(i / I.SIDE) * cell + cell / 2 });
    const ey = gy + I.SIDE * cell + 12;
    for (let k = 0; k <= I.EXTRAS.length; k++) pos.set(I.SIDE * I.SIDE + k + 1, { x: gx + cell / 2 + k * 17, y: ey });
    I.OUTPUTS.forEach((o, k) => pos.set(MAX_NODES + k + 1, { x: 296, y: 30 + k * 34 }));
    const genes = genome.genes.filter((g) => g[3]);
    for (const [into, out] of genes) for (const id of [into, out]) if (!pos.has(id)) pos.set(id, { x: 200, y: 70 });
    // MarI/O's settling: pull each hidden neuron towards what it connects to, a few times
    for (let n = 0; n < 4; n++) {
      for (const [into, out] of genes) {
        const c1 = pos.get(into), c2 = pos.get(out);
        const hid = (id) => id > I.COUNT && id <= MAX_NODES;
        if (hid(into)) {
          c1.x = 0.75 * c1.x + 0.25 * c2.x; if (c1.x >= c2.x) c1.x -= 30;
          c1.x = Math.max(150, Math.min(262, c1.x)); c1.y = 0.75 * c1.y + 0.25 * c2.y;
        }
        if (hid(out)) {
          c2.x = 0.25 * c1.x + 0.75 * c2.x; if (c1.x >= c2.x) c2.x += 30;
          c2.x = Math.max(150, Math.min(262, c2.x)); c2.y = 0.25 * c1.y + 0.75 * c2.y;
        }
      }
    }
    return pos;
  }

  // grid: the input box values (SIDE*SIDE), extras: the extra inputs (or null), keys: [left, right, up, down]
  draw(grid, extras, keys) {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!this.genome) return;
    const k = Math.min(w / 320, h / 210) * dpr;
    g.setTransform(k, 0, 0, k, (c.width - 320 * k) / 2, (c.height - 210 * k) / 2);
    const pos = this.layout, cell = 9;
    // input box
    for (let i = 0; i < I.SIDE * I.SIDE; i++) {
      const p = pos.get(i + 1), v = grid ? grid[i] : 0;
      g.fillStyle = v > 0.75 ? 'rgba(235,235,235,.9)' : v > 0 ? 'rgba(255,214,10,.75)' : v < 0 ? 'rgba(255,80,80,.9)' : 'rgba(255,255,255,.06)';
      g.fillRect(p.x - cell / 2 + 0.5, p.y - cell / 2 + 0.5, cell - 1, cell - 1);
    }
    const centre = pos.get(Math.floor(I.SIDE * I.SIDE / 2) + 1);
    g.strokeStyle = '#ff5a5a'; g.lineWidth = 1.5; g.beginPath(); g.arc(centre.x, centre.y, 4, 0, Math.PI * 2); g.stroke();
    // extras
    const names = I.EXTRAS.concat(['bias']);
    for (let n = 0; n < names.length; n++) {
      const p = pos.get(I.SIDE * I.SIDE + n + 1), v = extras ? extras[n] : n === names.length - 1 ? 1 : 0;
      g.fillStyle = v > 0 ? `rgba(120,220,120,${0.3 + 0.7 * Math.min(1, Math.abs(v))})` : v < 0 ? `rgba(255,90,90,${0.3 + 0.7 * Math.min(1, Math.abs(v))})` : 'rgba(255,255,255,.08)';
      g.fillRect(p.x - 6, p.y - 6, 12, 12);
      g.save(); g.translate(p.x, p.y + 9); g.rotate(Math.PI / 4); g.fillStyle = 'rgba(200,205,215,.7)'; g.font = '6px system-ui'; g.fillText(names[n], 0, 0); g.restore();
    }
    // links
    for (const [into, out, w, enabled] of this.genome.genes) {
      if (!enabled) continue;
      const a = pos.get(into), b = pos.get(out);
      if (!a || !b) continue;
      const s = Math.min(1, Math.abs(w) / 2);
      g.strokeStyle = w > 0 ? `rgba(80,220,110,${0.15 + 0.6 * s})` : `rgba(255,80,80,${0.15 + 0.6 * s})`;
      g.lineWidth = 0.6 + 1.4 * s;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    // hidden neurons
    for (const [id, p] of pos) {
      if (!(id > I.COUNT && id <= MAX_NODES)) continue;
      g.fillStyle = '#e8e8ef'; g.strokeStyle = '#111'; g.lineWidth = 1;
      g.beginPath(); g.rect(p.x - 3.5, p.y - 3.5, 7, 7); g.fill(); g.stroke();
    }
    // outputs
    const arrows = ['←', '→', '↑', '↓'];
    I.OUTPUTS.forEach((o, n) => {
      const p = pos.get(MAX_NODES + n + 1), on = keys && keys[n];
      g.fillStyle = on ? '#ffd60a' : 'rgba(255,255,255,.08)';
      g.strokeStyle = on ? '#ffd60a' : 'rgba(255,255,255,.25)';
      g.beginPath(); g.roundRect(p.x - 11, p.y - 11, 22, 22, 4); g.fill(); g.stroke();
      g.fillStyle = on ? '#111' : 'rgba(230,230,240,.7)'; g.font = '700 13px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(arrows[n], p.x, p.y + 1);
    });
  }
}

globalThis.NetworkView = NetworkView;
})();
