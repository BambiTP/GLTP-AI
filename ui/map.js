// map.js - draws a map with the real TagPro textures and walls (sprites.js), and on top of it: where
// the explorer has been (heat), what it's exploring right now (blue balls), the best run (red) and the
// checkpoints. Scroll to zoom, drag to move, double-click to see the whole map; a click (no drag) on a
// tile calls onTile(x, y). With onPaint set, a Shift-drag paints tiles instead of moving:
// onPaint(x, y, first) for each tile it crosses (first: the tile it started on). Clicks and paint
// reach up to `margin` tiles outside the map (0 by default), for red zones out there.
(function () {
const { SPRITES, DRAW_FLOOR, wallPieces } = globalThis.TPSprites;
const TS = 40; // texture pixels per tile

const image = (src) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
const PACK = '/textures/musclescupgradients/';
const textures = Promise.all(['tiles', 'speedpad', 'speedpadred', 'speedpadblue', 'portal', 'portalred', 'portalblue'].map((n) => image(PACK + n + '.png')))
  .then(([tiles, speedpad, speedpadRed, speedpadBlue, portal, portalRed, portalBlue]) => ({ tiles, speedpad, speedpadRed, speedpadBlue, portal, portalRed, portalBlue }));
// tiles drawn from their own sheet: x.1 (an exit portal, a used boost) is its last frame
const SHEETS = { 5: 'speedpad', 14: 'speedpadRed', 15: 'speedpadBlue', 13: 'portal', 24: 'portalRed', 25: 'portalBlue' };

class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.bg = null;
    this.moved = false;
    this.panZoom();
    window.addEventListener('resize', () => this.fit());
  }

  async setMap(tiles) {
    this.tiles = tiles;
    this.W = tiles.length;
    this.H = tiles[0].length;
    this.tex = await textures;
    this.bg = this.background();
    this.moved = false;
    this.fit();
  }

  background() {
    const c = document.createElement('canvas');
    c.width = this.W * TS; c.height = this.H * TS;
    const g = c.getContext('2d'), sheet = this.tex.tiles;
    const sprite = (key, x, y, size = TS) => {
      const s = SPRITES[key];
      if (!s || !sheet) return false;
      g.drawImage(sheet, s.x * TS, s.y * TS, size, size, x, y, size, size);
      return true;
    };
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const t = String(this.tiles[x][y]), n = Number(t), base = Math.floor(n);
      if (n === 0 || n === 1) continue;
      if (base !== 1 || DRAW_FLOOR.has(t)) sprite('2', x * TS, y * TS);
      if (base === 1 || n === 2) continue;
      const img = this.tex[SHEETS[base]];
      if (img) { g.drawImage(img, /\.1$/.test(t) ? img.width - TS : 0, 0, TS, TS, x * TS, y * TS, TS, TS); continue; }
      sprite(t, x * TS, y * TS) || sprite(String(Math.floor(n * 10) / 10), x * TS, y * TS);
    }
    const pieces = wallPieces(this.tiles), off = [[0, 0], [20, 0], [20, 20], [0, 20]];
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      pieces[x][y].forEach((k, i) => { if (typeof k === 'string') sprite(k, x * TS + off[i][0], y * TS + off[i][1], 20); });
    }
    return c;
  }

  // the whole map in view (unless the user has zoomed or moved it)
  fit(reset) {
    const dpr = window.devicePixelRatio || 1, c = this.canvas;
    const oldW = c.width, oldH = c.height;
    c.width = Math.max(1, Math.round(c.clientWidth * dpr));
    c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    if (!this.bg) return;
    this.base = Math.min(c.width / (this.W * TS), c.height / (this.H * TS)) * 0.95;
    if (reset || !this.moved) {
      this.moved = false;
      this.view = { k: this.base, x: (c.width - this.W * TS * this.base) / 2, y: (c.height - this.H * TS * this.base) / 2 };
    } else { this.view.x += (c.width - oldW) / 2; this.view.y += (c.height - oldH) / 2; }
  }

  panZoom() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.bg) return;
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, v = this.view;
      const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
      const k = Math.max(this.base * 0.5, Math.min(this.base * 12, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = px - (px - v.x) * (k / v.k); v.y = py - (py - v.y) * (k / v.k); v.k = k;
      this.moved = true;
    }, { passive: false });
    const tileAt = (e) => {
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, v = this.view;
      const x = Math.floor(((e.clientX - r.left) * dpr - v.x) / (TS * v.k)), y = Math.floor(((e.clientY - r.top) * dpr - v.y) / (TS * v.k));
      const m = this.margin || 0;
      return x >= -m && y >= -m && x < this.W + m && y < this.H + m ? [x, y] : null;
    };
    const paint = (e, first) => {
      const t = tileAt(e);
      if (!t || (drag.last && drag.last[0] === t[0] && drag.last[1] === t[1])) return;
      drag.last = t;
      this.onPaint(t[0], t[1], first);
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.shiftKey && this.onPaint && this.view) { drag = { paint: true, last: null }; return paint(e, true); }
      drag = { x: e.clientX, y: e.clientY, travel: 0 };
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      if (drag && drag.paint) return paint(e, false);
      if (!drag || !this.view) return;
      const dpr = window.devicePixelRatio || 1;
      this.view.x += (e.clientX - drag.x) * dpr; this.view.y += (e.clientY - drag.y) * dpr;
      drag = { x: e.clientX, y: e.clientY, travel: drag.travel + Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) };
      this.moved = true;
    });
    const up = () => { drag = null; c.classList.remove('dragging'); };
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.paint && drag.travel < 5 && this.onTile && this.view) {
        const t = tileAt(e);
        if (t) this.onTile(t[0], t[1]);
      }
      up();
    });
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => this.fit(true));
  }

  // ball positions are physics pixels (metres x 100): a tile's centre is at tile * 40
  sx(px) { return this.view.x + (px + TS / 2) * this.view.k; }
  sy(py) { return this.view.y + (py + TS / 2) * this.view.k; }

  ball(px, py, color, alpha) {
    const s = SPRITES[color + 'ball'], r = 19 * this.view.k;
    this.g.globalAlpha = alpha;
    this.g.drawImage(this.tex.tiles, s.x * TS, s.y * TS, TS, TS, this.sx(px) - r, this.sy(py) - r, 2 * r, 2 * r);
    this.g.globalAlpha = 1;
  }

  // where a path (a point every 4 ticks) is at a tick; null while dead or before/after it
  static at(path, tick) {
    const n = path.length / 2, f = tick / 4, i = Math.floor(f);
    if (i < 0 || i >= n) return null;
    const j = Math.min(i + 1, n - 1), a = f - i;
    if (path[i * 2] < 0) return null;
    if (path[j * 2] < 0) return [path[i * 2], path[i * 2 + 1]];
    return [path[i * 2] + (path[j * 2] - path[i * 2]) * a, path[i * 2 + 1] + (path[j * 2 + 1] - path[i * 2 + 1]) * a];
  }

  // red zones: tiles the ball must never go in
  redZones(list) {
    const g = this.g, v = this.view, s = TS * v.k;
    g.fillStyle = 'rgba(255, 50, 50, .38)';
    g.strokeStyle = 'rgba(255, 90, 90, .9)';
    g.lineWidth = Math.max(1, 1.5 * v.k);
    for (const c of list) { const x = v.x + c.x * s, y = v.y + c.y * s; g.fillRect(x, y, s, s); g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1); }
  }

  // the checkpoints, numbered in order: green once the best run (at `tick`) has passed them; the ones
  // to pass holding the flag are blue
  checkpoints(list, passed) {
    const g = this.g, v = this.view, s = TS * v.k;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 ${Math.max(9, s * 0.45)}px system-ui, sans-serif`;
    list.forEach((c, i) => {
      const x = v.x + c.x * s, y = v.y + c.y * s, done = i < passed;
      g.fillStyle = done ? 'rgba(155, 225, 93, .45)' : c.flag ? 'rgba(80, 140, 255, .35)' : 'rgba(255, 214, 10, .3)';
      g.strokeStyle = done ? '#9be15d' : c.flag ? '#6ea0ff' : '#ffd60a';
      g.lineWidth = Math.max(1.5, 2.5 * v.k);
      g.fillRect(x, y, s, s); g.strokeRect(x, y, s, s);
      g.fillStyle = '#fff';
      g.fillText((c.flag ? '⚑' : '') + (i + 1), x + s / 2, y + s / 2 + 1);
    });
  }

  // o: { heat: { W, H, cells }, recent: [path...], recentTick, best: { path, holding(tick), checkpoints },
  //      bestTick, checkpoints: [{ x, y, flag }], redZones: [{ x, y }] }
  draw(o) {
    const g = this.g, c = this.canvas, v = this.view;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!this.bg) return;
    g.drawImage(this.bg, v.x, v.y, this.W * TS * v.k, this.H * TS * v.k);
    if (o.heat) {
      let max = 1;
      for (const n of o.heat.cells) max = Math.max(max, n);
      for (let y = 0; y < o.heat.H; y++) for (let x = 0; x < o.heat.W; x++) {
        const n = o.heat.cells[y * o.heat.W + x];
        if (!n) continue;
        const f = Math.log(1 + n) / Math.log(1 + max);
        g.fillStyle = `hsla(${220 - 210 * f}, 90%, 55%, ${0.08 + 0.35 * f * f})`;
        g.fillRect(v.x + x * TS * v.k, v.y + y * TS * v.k, TS * v.k + 0.5, TS * v.k + 0.5);
      }
    }
    if (o.redZones && o.redZones.length) this.redZones(o.redZones);
    if (o.checkpoints) {
      const ticks = (o.best && o.best.checkpoints) || [];
      this.checkpoints(o.checkpoints, o.editing ? 0 : ticks.filter((t) => t <= o.bestTick).length);
    }
    for (const p of o.recent || []) {
      const q = MapView.at(p, o.recentTick);
      if (q) this.ball(q[0], q[1], 'blue', 0.45);
    }
    const b = o.best;
    if (!b || !b.path) return;
    const end = Math.min(Math.floor(o.bestTick / 4), b.path.length / 2 - 1);
    g.strokeStyle = 'rgba(255, 90, 90, .9)'; g.lineWidth = Math.min(5, Math.max(1.5, 3 * v.k)); g.lineJoin = 'round';
    g.beginPath();
    let on = false;
    for (let i = 0; i <= end; i++) {
      const x = b.path[i * 2], y = b.path[i * 2 + 1];
      if (x < 0) { on = false; continue; }
      if (on) g.lineTo(this.sx(x), this.sy(y)); else { g.moveTo(this.sx(x), this.sy(y)); on = true; }
    }
    g.stroke();
    const q = MapView.at(b.path, Math.min(o.bestTick, (b.path.length / 2 - 1) * 4));
    if (!q) return;
    this.ball(q[0], q[1], 'red', 1);
    if (b.holding && b.holding(o.bestTick)) {
      const s = SPRITES.blueflag, k = v.k;
      g.drawImage(this.tex.tiles, s.x * TS, s.y * TS, TS, TS, this.sx(q[0]) - 2 * k, this.sy(q[1]) - 34 * k, 26 * k, 26 * k);
    }
  }
}

globalThis.MapView = MapView;
})();
