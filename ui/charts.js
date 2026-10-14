// charts.js - small canvas charts for the dashboard: lines and areas over generations, a hover
// readout, and click to pick a generation.
(function () {
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hue(id) { return (id * 137.508) % 360; }

class Chart {
  // opts: { onSelect(gen), format(v), rightFormat(v), height }
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.data = null;
    this.hoverX = null;
    canvas.addEventListener('mousemove', (e) => { this.hoverX = this.genAt(e); this.draw(); });
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.draw(); });
    canvas.addEventListener('click', (e) => { const g = this.genAt(e); if (g != null && this.opts.onSelect) this.opts.onSelect(g); });
  }

  // data: { n (generations), series: [{ name, values, color, fill, axis, step, dash }], stacks: [{ color, values }],
  //         markers: [{ x, y, color }], selected, yMax, rightMax }
  set(data) { this.data = data; this.draw(); }

  frame() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    return { w, h, dpr, L: 40, R: this.data && this.data.series.some((s) => s.axis === 'right') ? 44 : 12, T: 10, B: 20 };
  }

  genAt(e) {
    if (!this.data || !this.data.n) return null;
    const f = this.frame(), r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const g = Math.round((x - f.L) / Math.max(1, f.w - f.L - f.R) * Math.max(1, this.data.n - 1));
    return Math.max(0, Math.min(this.data.n - 1, g));
  }

  draw() {
    const d = this.data, f = this.frame(), g = this.canvas.getContext('2d');
    g.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    g.clearRect(0, 0, f.w, f.h);
    const muted = css('--muted') || '#888', grid = css('--grid') || '#333', text = css('--text') || '#ddd';
    g.font = '11px system-ui, sans-serif';
    if (!d || !d.n) {
      g.fillStyle = muted; g.textAlign = 'center'; g.fillText('waiting for the first generation…', f.w / 2, f.h / 2);
      return;
    }
    const pw = f.w - f.L - f.R, ph = f.h - f.T - f.B;
    const X = (i) => f.L + (d.n > 1 ? (i / (d.n - 1)) * pw : pw / 2);
    let yMax = d.yMax;
    if (yMax == null) {
      yMax = 0;
      for (const s of d.series) if (s.axis !== 'right') for (const v of s.values) if (v != null) yMax = Math.max(yMax, v);
      if (d.stacks) for (let i = 0; i < d.n; i++) yMax = Math.max(yMax, d.stacks.reduce((a, s) => a + (s.values[i] || 0), 0));
      yMax = yMax || 1;
    }
    let rMax = d.rightMax;
    if (rMax == null) { rMax = 0; for (const s of d.series) if (s.axis === 'right') for (const v of s.values) if (v != null) rMax = Math.max(rMax, v); rMax = rMax * 1.1 || 1; }
    const Y = (v, axis) => f.T + ph - (v / (axis === 'right' ? rMax : yMax)) * ph;

    // grid + axes
    g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4, y = Y(v);
      g.beginPath(); g.moveTo(f.L, Math.round(y) + 0.5); g.lineTo(f.w - f.R, Math.round(y) + 0.5); g.stroke();
      g.fillText((this.opts.format || String)(v), f.L - 6, y);
    }
    if (d.series.some((s) => s.axis === 'right')) {
      g.textAlign = 'left';
      for (let i = 0; i <= 4; i++) { const v = (rMax * i) / 4; g.fillText((this.opts.rightFormat || String)(v), f.w - f.R + 6, Y(v, 'right')); }
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(d.n / 8));
    for (let i = 0; i < d.n; i += step) g.fillText(String(i), X(i), f.h - f.B + 5);

    // stacked areas (species)
    if (d.stacks) {
      const base = new Array(d.n).fill(0);
      for (const s of d.stacks) {
        g.fillStyle = s.color;
        g.beginPath();
        for (let i = 0; i < d.n; i++) g.lineTo(X(i), Y(base[i] + (s.values[i] || 0)));
        for (let i = d.n - 1; i >= 0; i--) g.lineTo(X(i), Y(base[i]));
        g.closePath(); g.fill();
        for (let i = 0; i < d.n; i++) base[i] += s.values[i] || 0;
      }
    }

    // lines
    for (const s of d.series) {
      const pts = [];
      s.values.forEach((v, i) => { if (v != null) pts.push([X(i), Y(v, s.axis)]); else pts.push(null); });
      if (s.fill) {
        g.fillStyle = s.fill;
        let open = false;
        g.beginPath();
        let firstX = 0;
        pts.forEach((p, i) => {
          if (!p) return;
          if (!open) { g.moveTo(p[0], Y(0, s.axis)); firstX = p[0]; open = true; }
          g.lineTo(p[0], p[1]);
          if (i === pts.length - 1 || !pts[i + 1]) { g.lineTo(p[0], Y(0, s.axis)); g.lineTo(firstX, Y(0, s.axis)); }
        });
        g.fill();
      }
      g.strokeStyle = s.color; g.lineWidth = s.width || 2; g.lineJoin = 'round';
      g.setLineDash(s.dash || []);
      g.beginPath();
      let prev = null;
      pts.forEach((p) => {
        if (!p) { prev = null; return; }
        if (!prev) g.moveTo(p[0], p[1]);
        else if (s.step) { g.lineTo(p[0], prev[1]); g.lineTo(p[0], p[1]); } else g.lineTo(p[0], p[1]);
        prev = p;
      });
      g.stroke();
      g.setLineDash([]);
    }
    for (const m of d.markers || []) {
      g.fillStyle = m.color; g.beginPath(); g.arc(X(m.x), Y(m.y, m.axis), 3.5, 0, Math.PI * 2); g.fill();
    }

    // selected generation, hover readout
    if (d.selected != null) {
      g.strokeStyle = text; g.globalAlpha = 0.5; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(X(d.selected)) + 0.5, f.T); g.lineTo(Math.round(X(d.selected)) + 0.5, f.T + ph); g.stroke();
      g.globalAlpha = 1;
    }
    if (this.hoverX != null) {
      const i = this.hoverX, x = X(i);
      g.strokeStyle = muted; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, f.T); g.lineTo(Math.round(x) + 0.5, f.T + ph); g.stroke();
      g.setLineDash([]);
      const lines = [`gen ${i}`].concat(d.series.filter((s) => s.name).map((s) => `${s.name}: ${s.values[i] == null ? '–' : (s.axis === 'right' ? (this.opts.rightFormat || String) : (this.opts.format || String))(s.values[i])}`));
      if (d.stacks) lines.push(`species: ${d.stacks.filter((s) => s.values[i]).length}`);
      g.font = '11px system-ui, sans-serif';
      const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 14, bh = lines.length * 15 + 8;
      const bx = x + bw + 10 > f.w ? x - bw - 8 : x + 8;
      g.fillStyle = 'rgba(10,12,16,.92)'; g.strokeStyle = grid;
      g.beginPath(); g.roundRect(bx, f.T + 2, bw, bh, 6); g.fill(); g.stroke();
      g.fillStyle = text; g.textAlign = 'left'; g.textBaseline = 'top';
      lines.forEach((l, k) => g.fillText(l, bx + 7, f.T + 7 + k * 15));
    }
  }
}

globalThis.Charts = { Chart, hue };
})();
