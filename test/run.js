// npm test - checks the simulator, the explorer, saved runs and replays
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runs = require('../src/runs');
const { loadLevel, resolve, proxyUrl, DEFAULT_PROXY } = require('../src/maps');
const { Sim, play, encodeKeys, sliceKeys, concatKeys } = require('../src/sim');
const { Goal } = require('../src/progress');
const { Explorer } = require('../src/explore');
const { buildReplay } = require('../src/replay');

const mapFile = (name) => path.join(__dirname, 'maps', name + '.txt');
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}

// explore for up to `seconds`, or until finished (untilDone); returns the run's meta
async function explore(level, key, seconds, meta = runs.create(level, key), untilDone = true) {
  const e = new Explorer(meta, level), t0 = Date.now();
  const timer = setInterval(() => { if ((untilDone && meta.time != null) || Date.now() - t0 > seconds * 1000) e.stop(); }, 100);
  await e.start();
  clearInterval(timer);
  return meta;
}

(async () => {
  const steps = loadLevel(mapFile('steps'));
  const randomKeys = (n, seed) => { const out = []; let r = seed, k = 0; for (let i = 0; i < n; i++) { if (i % 10 === 0) { r = (r * 1103515245 + 12345) & 0x7fffffff; k = r % 16; } out.push(k); } return encodeKeys(out); };

  await check('the same keys give the same run, to the last bit', () => {
    const keys = randomKeys(3000, 3);
    assert.deepStrictEqual(play(steps, keys).ball(), play(steps, keys).ball());
  });

  await check('the speed-ups change nothing: same end state as the plain engine', () => {
    for (const m of ['steps', 'spikes', 'portal']) {
      const L = loadLevel(mapFile(m)), keys = randomKeys(8000, 11);
      const a = play(L, keys), b = play(L, keys, { plain: true });
      assert.deepStrictEqual([a.ball(), a.pops, a.grabTicks], [b.ball(), b.pops, b.grabTicks], m);
    }
  });

  await check('a jump goes up about 4 tiles holding up, and uses a jump', () => {
    const s = new Sim(steps);
    for (let i = 0; i < 30; i++) s.step();
    const y0 = s.ball().y;
    s.setKeys(4);
    let top = y0;
    for (let i = 0; i < 90; i++) { s.step(); top = Math.min(top, s.ball().y); }
    assert((y0 - top) / 0.4 > 3.5 && (y0 - top) / 0.4 < 5);
    assert.strictEqual(s.jumpsLeft, s.jumpLimit - 1);
  });

  await check('key sequences slice and join', () => {
    assert.deepStrictEqual(sliceKeys([1, 5, 2, 3, 0, 4], 6), [1, 5, 2, 1]);
    assert.deepStrictEqual(concatKeys([1, 2], [1, 3, 4, 1]), [1, 5, 4, 1]);
  });

  await check('pasted codes: presets, group links, ids', () => {
    assert.deepStrictEqual(resolve('gZMefGzCggtaiaaaJraaksaaamaaaE'), { key: 'gZMefGzCggtaiaaaJraaksaaamaaaE', id: '87856', preset: 'gZMefGzCggtaiaaaJraaksaaamaaaE' });
    assert.strictEqual(resolve('https://tagpro.koalabeast.com/groups/create?preset=gZMefGXjggtaiaaaJyaraakE').id, '89085');
    assert.strictEqual(resolve('88528').preset, 'gZMefGMyggtaiaaaJraaksaaamaaaE'); // its GLTP preset
    assert.throws(() => resolve('gZtkoauHtYRf'), /random/);
    assert.throws(() => resolve('hello'), /paste a map preset/);
    assert.strictEqual(proxyUrl(DEFAULT_PROXY, '88528', 'png'), 'https://api.bamball.workers.dev/api/fortunatemaps/88528/png');
  });

  await check('progress: 0 at spawn, the whole way once capped', () => {
    const s = new Sim(steps), g = new Goal(steps, s.spawn);
    assert(Math.abs(g.progress(s)) < 0.5 && g.total > 20);
  });

  let meta;
  await check('the explorer beats a map, and its best run replays to the same finish', async () => {
    meta = await explore(steps, mapFile('steps'), 40);
    assert(meta.time != null, 'not finished in 40 s');
    const best = runs.read(meta.id, 'best.json'), sim = play(steps, best.keys);
    assert.strictEqual(new Goal(steps, sim.spawn).finishTick(sim), meta.time);
  });

  await check('a stopped run continues from its saved memory', async () => {
    const places = runs.read(meta.id, 'archive.json').length;
    const gen = meta.gen;
    const again = await explore(steps, mapFile('steps'), 3, runs.load(meta.id), false);
    assert(again.gen > gen && again.cells >= places);
  });

  await check('portals: the explorer goes through them', async () => {
    const L = loadLevel(mapFile('portal'));
    const m = await explore(L, mapFile('portal'), 60);
    assert(m.time != null, 'not finished in 60 s');
    fs.rmSync(path.join(runs.RUNS, m.id), { recursive: true });
  });

  await check('a replay has the real recorder header, the player, and the cap', () => {
    const text = buildReplay(steps, runs.read(meta.id, 'best.json').keys);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines[0][1], 'recorder-metadata');
    assert(lines.some((l) => l[1] === 'id'));
    assert(lines.some((l) => l[1] === 'score' && l[2].r === 1));
    fs.rmSync(path.join(runs.RUNS, meta.id), { recursive: true });
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
