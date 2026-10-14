// map.js - draws a map with the real TagPro textures, a generation's runs on top of it, the plan,
// and Go-Explore's archive as a heat map.
(function () {
const { SPRITES, DRAW_FLOOR, wallPieces } = globalThis.TPSprites;
const TS = 40; // texture pixels per tile

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

let texturesPromise = null;
function textures(pack) {
  if (!texturesPromise) {
    const get = (k, fallback) => loadImage(pack[k] || fallback);
    texturesPromise = Promise.all([
      get('tiles', '/images/tiles.png'), get('speedpad', '/images/speedpad.png'), get('speedpadRed', '/images/speedpadred.png'),
      get('speedpadBlue', '/images/speedpadblue.png'), get('portal', '/images/portal.png'), get('portalRed', '/images/portalred.png'),
      get('portalBlue', '/images/portalblue.png'), loadImage('/images/gravitywell.png'),
    ]).then(([tiles, speedpad, speedpadRed, speedpadBlue, portal, portalRed, portalBlue, gravityWell]) => ({ tiles, speedpad, speedpadRed, speedpadBlue, portal, portalRed, portalBlue, gravityWell }));
  }
  return texturesPromise;
}

// tiles that come from their own sheet (frame 0)
const SHEETS = { 5: 'speedpad', 5.1: 'speedpad', 14: 'speedpadRed', 14.1: 'speedpadRed', 15: 'speedpadBlue', 15.1: 'speedpadBlue', 13: 'portal', 13.1: 'portal', 24: 'portalRed', 24.1: 'portalRed', 25: 'portalBlue', 25.1: 'portalBlue', 22: 'gravityWell' };

class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = null;
    this.bg = null;
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.hover = null;
  }

  async setMap(map, pack) {
    this.map = map;
    this.W = map.tiles.length;
    this.H = map.tiles[0].length;
    this.tex = await textures(pack || {});
    this.bg = this.renderBackground();
    this.fit(true);
  }

  // the static map at texture resolution (40 px per tile)
  renderBackground() {
    const c = document.createElement('canvas');
    c.width = this.W * TS; c.height = this.H * TS;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    const { tiles: sheet } = this.tex;
    const tiles = this.map.tiles;
    const sprite = (key, x, y, size = TS, src = sheet) => {
      const s = SPRITES[key];
      if (!s || !src) return false;
      g.drawImage(src, s.x * TS, s.y * TS, size, size, x, y, size, size);
      return true;
    };
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const t = String(tiles[x][y]), n = Number(t);
      if (n === 0 || n === 1) continue;
      if (Math.floor(n) !== 1 || DRAW_FLOOR.has(t)) sprite('2', x * TS, y * TS);
      if (Math.floor(n) === 1 || n === 2) continue;
      if (SHEETS[t] !== undefined || SHEETS[n] !== undefined) {
        const img = this.tex[SHEETS[t] || SHEETS[n]];
        if (img) g.drawImage(img, 0, 0, TS, TS, x * TS, y * TS, TS, TS);
        continue;
      }
      sprite(t, x * TS, y * TS) || sprite(String(Math.floor(n * 10) / 10), x * TS, y * TS);
    }
    const pieces = wallPieces(tiles);
    const off = [[0, 0], [20, 0], [20, 20], [0, 20]];
    for (let x = 0; x < this.W; x++) for (let y = 0; y < this.H; y++) {
      const q = pieces[x][y];
      for (let i = 0; i < 4; i++) if (typeof q[i] === 'string') sprite(q[i], x * TS + off[i][0], y * TS + off[i][1], 20);
    }
    return c;
  }

  // the whole map in view; after the user has zoomed or panned, a resize keeps their view
  fit(reset) {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const oldW = this.canvas.width, oldH = this.canvas.height;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    if (!this.map) return;
    const scale = Math.min(cw / (this.W * TS), ch / (this.H * TS)) * 0.96 * dpr;
    this.base = scale;
    if (reset || !this.moved) {
      this.moved = false;
      this.view = { scale, ox: (this.canvas.width - this.W * TS * scale) / 2, oy: (this.canvas.height - this.H * TS * scale) / 2 };
    } else {
      // keep what was in the middle in the middle
      this.view.ox += (this.canvas.width - oldW) / 2;
      this.view.oy += (this.canvas.height - oldH) / 2;
    }
  }

  // zoom by `factor` keeping the map point under (clientX, clientY) where it is
  zoomAt(clientX, clientY, factor) {
    if (!this.map) return;
    const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const cx = (clientX - r.left) * dpr, cy = (clientY - r.top) * dpr, v = this.view;
    const scale = Math.max(this.base * 0.5, Math.min(this.base * 12, v.scale * factor));
    const k = scale / v.scale;
    v.ox = cx - (cx - v.ox) * k;
    v.oy = cy - (cy - v.oy) * k;
    v.scale = scale;
    this.moved = true;
  }

  panBy(dx, dy) {
    const dpr = window.devicePixelRatio || 1;
    this.view.ox += dx * dpr;
    this.view.oy += dy * dpr;
    this.moved = true;
  }

  // Wheel and pinch zoom; dragging pans when shouldPan(event) says so (or with two fingers). A
  // pointerdown that starts a pan is marked with preventDefault(), so drawing tools can skip it, and
  // this.dragged says whether the last press moved (so a pan doesn't also count as a click).
  enablePanZoom(shouldPan, onPinch) {
    const c = this.canvas, touches = new Map();
    let pan = null, pinch = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(e.clientX, e.clientY, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      this.dragged = false;
      if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pan = null;
        if (onPinch) onPinch();
        e.preventDefault();
        return;
      }
      if (!shouldPan(e)) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      c.classList.add('panning');
    });
    c.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
        this.panBy(x - pinch.x, y - pinch.y);
        if (pinch.d > 0) this.zoomAt(x, y, d / pinch.d);
        pinch = { d, x, y };
        this.dragged = true;
        return;
      }
      if (!pan || e.pointerId !== pan.id) return;
      this.panBy(e.clientX - pan.x, e.clientY - pan.y);
      pan.x = e.clientX; pan.y = e.clientY;
      if (Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) > 4) this.dragged = true;
    });
    const up = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (pan && e.pointerId === pan.id) { pan = null; c.classList.remove('panning'); }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  // texture px <-> canvas px (tile x covers texture px x*40 .. x*40+40)
  sx(px) { return this.view.ox + px * this.view.scale; }
  sy(py) { return this.view.oy + py * this.view.scale; }
  // ball positions (physics px: metres x 100, where tile x's centre is at x*40) -> canvas px
  bx(px) { return this.sx(px + TS / 2); }
  by(py) { return this.sy(py + TS / 2); }

  // the map point under a mouse event, in tiles (0.5 = middle of the first tile)
  pointAt(ev) {
    const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return {
      x: ((ev.clientX - r.left) * dpr - this.view.ox) / this.view.scale / TS,
      y: ((ev.clientY - r.top) * dpr - this.view.oy) / this.view.scale / TS,
    };
  }

  // the tile under a mouse event
  tileAt(ev) {
    const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const px = ((ev.clientX - r.left) * dpr - this.view.ox) / this.view.scale;
    const py = ((ev.clientY - r.top) * dpr - this.view.oy) / this.view.scale;
    const x = Math.floor(px / TS), y = Math.floor(py / TS);
    return x >= 0 && y >= 0 && x < this.W && y < this.H ? { x, y } : null;
  }

  ball(px, py, color, alpha, radius = 19) {
    const g = this.ctx, s = SPRITES[color === 'blue' ? 'blueball' : 'redball'];
    const r = radius * this.view.scale;
    g.globalAlpha = alpha;
    if (this.tex.tiles && s) g.drawImage(this.tex.tiles, s.x * TS, s.y * TS, TS, TS, this.bx(px) - r, this.by(py) - r, r * 2, r * 2);
    g.globalAlpha = 1;
  }

  flag(px, py, alpha) {
    const s = SPRITES.blueflag, g = this.ctx, k = this.view.scale;
    if (!this.tex.tiles || !s) return;
    g.globalAlpha = alpha;
    g.drawImage(this.tex.tiles, s.x * TS, s.y * TS, TS, TS, this.bx(px) - 2 * k, this.by(py) - 34 * k, 26 * k, 26 * k);
    g.globalAlpha = 1;
  }

  // o: { runs, best, tick, show ('all'|'top'|'best'), heat, plan, planTargets, editing, insertAt }
  draw(o) {
    const g = this.ctx, c = this.canvas;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!this.bg) return;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.bg, this.view.ox, this.view.oy, this.W * TS * this.view.scale, this.H * TS * this.view.scale);
    if (o.heat) this.drawHeat(o.heat);
    if (o.spawns) this.drawSpawns(o.spawns, o.spawn);
    if (o.portals) this.drawPortals(o.portals, o.portalAlpha ?? 1);
    if (o.plan) this.drawPlan(o.plan, o.planTargets, o.editing, o.insertAt);
    if (o.runs) this.drawRuns(o);
    if (o.editing && this.hover) {
      const k = this.view.scale;
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 2;
      g.strokeRect(this.sx(this.hover.x * TS), this.sy(this.hover.y * TS), TS * k, TS * k);
    }
  }

  // spawn areas: a dashed circle per spawn point (its radius, at least the tile itself), and the
  // exact spot the bot spawns at
  drawSpawns(spawns, at) {
    const g = this.ctx, k = this.view.scale;
    g.save();
    for (const [team, rgb] of [['blue', '77,171,247'], ['red', '255,90,90']]) {
      for (const p of spawns[team] || []) {
        const x = this.sx(p.x * TS + TS / 2), y = this.sy(p.y * TS + TS / 2), r = (Math.max(0, p.radius || 0) + 0.5) * TS * k;
        g.fillStyle = `rgba(${rgb},.10)`; g.strokeStyle = `rgba(${rgb},.85)`;
        g.lineWidth = Math.min(3, Math.max(1.5, 2.5 * k)); g.setLineDash([Math.min(10, 6 * k + 2), Math.min(8, 5 * k + 2)]);
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.setLineDash([]);
        g.fillStyle = `rgba(${rgb},.95)`;
        g.beginPath(); g.arc(x, y, Math.min(5, Math.max(2.5, 4 * k)), 0, Math.PI * 2); g.fill();
      }
    }
    if (at) {
      const px = at.x * 100, py = at.y * 100;
      this.ball(px, py, 'red', 0.55, 19);
      const fs = Math.min(18, Math.max(10, Math.round(13 * k)));
      g.font = `700 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.fillStyle = '#fff';
      g.strokeText('SPAWN', this.bx(px), this.by(py) - 21 * k);
      g.fillText('SPAWN', this.bx(px), this.by(py) - 21 * k);
    }
    g.restore();
  }

  // a curved arrow from each portal to where it sends the ball
  drawPortals(portals, alpha) {
    const g = this.ctx, k = this.view.scale;
    g.save();
    g.globalAlpha = alpha;
    for (const p of portals) {
      if (!p.to) continue;
      const x0 = this.sx(p.x * TS + TS / 2), y0 = this.sy(p.y * TS + TS / 2);
      const x1 = this.sx(p.to.x * TS + TS / 2), y1 = this.sy(p.to.y * TS + TS / 2);
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const bend = Math.min(80, len * 0.25), cx = mx - (y1 - y0) / len * bend, cy = my + (x1 - x0) / len * bend;
      const color = p.team === 'red' ? '255,110,110' : p.team === 'blue' ? '110,170,255' : '200,125,255';
      g.strokeStyle = `rgba(${color},.9)`; g.lineWidth = Math.min(3, Math.max(1.5, 2 * k));
      g.setLineDash([Math.min(8, 5 * k + 2), Math.min(6, 4 * k + 2)]);
      g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(cx, cy, x1, y1); g.stroke();
      g.setLineDash([]);
      // arrowhead along the curve's end direction
      const ang = Math.atan2(y1 - cy, x1 - cx), r = Math.min(12, Math.max(6, 9 * k));
      g.fillStyle = `rgba(${color},1)`;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - r * Math.cos(ang - 0.45), y1 - r * Math.sin(ang - 0.45)); g.lineTo(x1 - r * Math.cos(ang + 0.45), y1 - r * Math.sin(ang + 0.45)); g.closePath(); g.fill();
    }
    g.restore();
  }

  drawHeat(h) {
    const g = this.ctx, k = this.view.scale;
    let max = 1;
    for (const n of h.cells) max = Math.max(max, n);
    for (let y = 0; y < h.H; y++) for (let x = 0; x < h.W; x++) {
      const n = h.cells[y * h.W + x];
      if (!n) continue;
      const v = Math.log(1 + n) / Math.log(1 + max);
      g.fillStyle = `hsla(${220 - 210 * v}, 90%, 55%, ${0.08 + 0.4 * v * v})`;
      g.fillRect(this.sx(x * TS), this.sy(y * TS), TS * k + 0.5, TS * k + 0.5);
    }
  }

  drawPlan(plan, targets, editing, insertAt) {
    const g = this.ctx, k = this.view.scale;
    const pts = targets.map((t) => [this.sx(t.x * TS + TS / 2), this.sy(t.y * TS + TS / 2)]);
    g.save();
    g.setLineDash([8 * k, 6 * k]);
    g.lineWidth = Math.max(2, 3 * k);
    g.strokeStyle = 'rgba(255, 214, 10, 0.85)';
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    g.setLineDash([]);
    plan.steps.forEach((s, i) => {
      const [x, y] = pts[i + 1];
      if (s.type === 'reach') {
        g.fillStyle = 'rgba(255, 214, 10, 0.16)';
        g.strokeStyle = 'rgba(255, 214, 10, 0.9)';
        g.lineWidth = Math.max(1, 2 * k);
        g.beginPath(); g.arc(x, y, s.r * TS * k, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      const r = Math.max(9, 13 * k);
      g.fillStyle = editing && i === insertAt - 1 ? '#fff' : s.type === 'reach' ? '#ffd60a' : s.type === 'grab' ? '#4dabf7' : s.type === 'cap' ? '#ff6b6b' : '#c0a080';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111'; g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y + 1);
    });
    g.restore();
  }

  drawRuns(o) {
    const g = this.ctx, k = this.view.scale;
    const { runs, best, tick } = o;
    const every = o.pathEvery || 4;
    const at = (path, t) => {
      const n = path.length / 2, f = t / every, i = Math.min(Math.floor(f), n - 1), j = Math.min(i + 1, n - 1), a = f - Math.floor(f);
      const x0 = path[i * 2], y0 = path[i * 2 + 1], x1 = path[j * 2], y1 = path[j * 2 + 1];
      if (x0 < 0) return null;
      if (x1 < 0 || i === j) return [x0, y0];
      return [x0 + (x1 - x0) * a, y0 + (y1 - y0) * a];
    };
    let order = runs.map((r, i) => i).filter((i) => i !== best);
    order.sort((a, b) => (runs[b].fitness ?? runs[b].progress) - (runs[a].fitness ?? runs[a].progress));
    if (o.show === 'top') order = order.slice(0, 10);
    if (o.show === 'best') order = [];
    // ghosts: short tails, then the balls
    for (const i of order) {
      const r = runs[i];
      if (tick / every > r.path.length / 2 + 30) continue; // a run that ended a while ago
      const end = Math.min(Math.floor(tick / every), r.path.length / 2 - 1);
      g.strokeStyle = 'rgba(120, 190, 255, 0.35)'; g.lineWidth = Math.min(3, Math.max(1, 2 * k));
      g.beginPath();
      let started = false;
      for (let p = Math.max(0, end - 10); p <= end; p++) {
        const x = r.path[p * 2], y = r.path[p * 2 + 1];
        if (x < 0) { started = false; continue; }
        if (started) g.lineTo(this.bx(x), this.by(y)); else { g.moveTo(this.bx(x), this.by(y)); started = true; }
      }
      g.stroke();
    }
    for (const i of order) {
      const r = runs[i];
      if (tick / every > r.path.length / 2 + 30) continue;
      const p = at(r.path, tick);
      if (!p) continue;
      const ended = tick / every > r.path.length / 2;
      this.ball(p[0], p[1], 'blue', ended ? 0.15 : 0.45, 17);
    }
    // the best run: full trail, ball, flag
    const b = runs[best];
    if (!b) return;
    const end = Math.min(Math.floor(tick / every), b.path.length / 2 - 1);
    g.strokeStyle = 'rgba(255, 90, 90, 0.9)'; g.lineWidth = Math.min(5, Math.max(1.5, 3 * k)); g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (let i = 0; i <= end; i++) {
      const x = b.path[i * 2], y = b.path[i * 2 + 1];
      if (x < 0) { started = false; continue; }
      if (started) g.lineTo(this.bx(x), this.by(y)); else { g.moveTo(this.bx(x), this.by(y)); started = true; }
    }
    g.stroke();
    const p = at(b.path, tick);
    if (p) {
      this.ball(p[0], p[1], 'red', 1, 19);
      const holding = b.grabTick != null && tick >= b.grabTick && (b.capTick == null || tick < b.capTick);
      if (holding) this.flag(p[0], p[1], 1);
    }
  }
}

globalThis.MapView = MapView;
})();
