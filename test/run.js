// node test/run.js - quick checks that the simulator, plans, trainers and replays hold together
const assert = require('assert');
const { loadLevel, fromText, proxyUrl, DEFAULT_PROXY } = require('../src/maps');
const { Sim, play, encodeKeys, keysLength, sliceKeys, concatKeys } = require('../src/sim');
const { Plan, parseSteps, stepsText } = require('../src/goals');
const { buildReplay } = require('../src/replay');
const { ExploreTrainer } = require('../src/train-explore');
const { NeatTrainer } = require('../src/train-neat');
const fs = require('fs');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}

(async () => {
  const level = loadLevel('steps');
  const random = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  await check('the same keys give the same run, to the last bit', () => {
    const r = random(3), keys = [];
    let k = 0;
    for (let i = 0; i < 1500; i++) { if (i % 9 === 0) k = Math.floor(r() * 16); keys.push(k); }
    const a = play(level, encodeKeys(keys)).ball(), b = play(level, encodeKeys(keys)).ball();
    assert.deepStrictEqual(a, b);
  });

  await check('a jump goes up about 4 tiles holding up, and uses a jump', () => {
    const s = new Sim(level);
    for (let i = 0; i < 30; i++) s.step();
    const y0 = s.ball().y;
    s.setKeys(4);
    let top = y0;
    for (let i = 0; i < 90; i++) { s.step(); top = Math.min(top, s.ball().y); }
    const tiles = (y0 - top) / 0.4;
    assert(tiles > 3.5 && tiles < 5, `jumped ${tiles} tiles`);
    assert.strictEqual(s.jumpsLeft, s.jumpLimit - 1);
  });

  await check('key sequences slice and join', () => {
    const k = [1, 5, 2, 3, 0, 4];
    assert.deepStrictEqual(sliceKeys(k, 6), [1, 5, 2, 1]);
    assert.deepStrictEqual(concatKeys([1, 2], [1, 3, 4, 1]), [1, 5, 4, 1]);
    assert.strictEqual(keysLength(k), 12);
  });

  await check('plans parse, print and validate', () => {
    const steps = parseSteps('reach 10,5 r2; grab; button 3,4; cap');
    assert.deepStrictEqual(steps[0], { type: 'reach', x: 10, y: 5, r: 2 });
    assert.strictEqual(stepsText(parseSteps('reach 3,3; via 5,5; via 6,6 r3; grab; cap')), 'reach 3,3; via 5,5; via 6,6 r3; grab; cap');
    assert.throws(() => new Plan(level, [{ type: 'button', x: 3, y: 3 }], new Sim(level).spawn), /no button/);
  });

  await check('passing a later via point counts for the ones before it', () => {
    const sim = new Sim(level);
    const tx = Math.round(sim.spawn.x / 0.4), ty = Math.round(sim.spawn.y / 0.4);
    const plan = new Plan(level, [{ type: 'reach', x: tx + 8, y: ty, r: 1, soft: true }, { type: 'reach', x: tx, y: ty, r: 1, soft: true }, { type: 'grab' }], sim.spawn);
    const st = plan.update(plan.start(), sim);
    assert.strictEqual(st.step, 2);
    const hard = new Plan(level, [{ type: 'reach', x: tx + 8, y: ty, r: 1 }, { type: 'reach', x: tx, y: ty, r: 1 }, { type: 'grab' }], sim.spawn);
    assert.strictEqual(hard.update(hard.start(), sim).step, 0);
  });

  await check('progress runs from 0 at spawn to the plan total', () => {
    const sim = new Sim(level);
    const plan = new Plan(level, parseSteps('grab; cap'), sim.spawn);
    const st = plan.start();
    assert(Math.abs(plan.progress(st, sim)) < 0.5, 'not ~0 at spawn');
    assert(plan.total > 20);
  });

  await check('proxy URLs', () => {
    assert.strictEqual(proxyUrl('https://p.example/?url={url}', 'https://a/b?c'), 'https://p.example/?url=https%3A%2F%2Fa%2Fb%3Fc');
    assert.strictEqual(proxyUrl('https://p.example/?u=', 'https://a/b'), 'https://p.example/?u=https%3A%2F%2Fa%2Fb');
    assert.strictEqual(proxyUrl('https://p.example/', 'https://a/b'), 'https://p.example/https://a/b');
    assert.strictEqual(proxyUrl(DEFAULT_PROXY, 'https://fortunatemaps.herokuapp.com/png/88528'), 'https://api.bamball.workers.dev/api/fortunatemaps/88528/png');
  });

  let run;
  await check('Go-Explore proves the steps practice map possible, and the keys replay to the same time', async () => {
    const t = new ExploreTrainer(level, { maxGens: 60 });
    await t.start();
    run = t.run;
    assert(t.run.meta.fastest, 'not finished in 60 generations');
    const best = t.run.generation(t.run.meta.fastest.gen).best;
    const sim = new Sim(level);
    const plan = new Plan(level, t.run.meta.plan.steps, sim.spawn);
    const st = plan.start();
    play(level, best.keys, {}, (s) => { plan.update(st, s); return !plan.finished(st); });
    assert.strictEqual(plan.time(st), t.run.meta.fastest.time);
  });

  await check('NEAT runs generations and gets somewhere', async () => {
    const t = new NeatTrainer(level, { maxGens: 5, population: 60 });
    await t.start();
    const s = t.run.summaries();
    assert.strictEqual(s.length, 5);
    assert(s[4].progress > 0.05);
    fs.rmSync(t.run.dir, { recursive: true });
  });

  await check('a replay has the real recorder header, a player id, and ghosts', () => {
    const g = run.generation(run.meta.fastest.gen);
    const r = buildReplay(level, g.best.keys, { ghosts: g.runs.slice(0, 3).map((x, i) => ({ name: '#' + i, path: x.path })) });
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines[0][1], 'recorder-metadata');
    assert(lines.some((l) => l[1] === 'id'));
    assert(lines.some((l) => l[1] === 'p' && l[2].u && l[2].u.some((u) => u.id === 1001)));
    assert(r.capTick != null);
    fs.rmSync(run.dir, { recursive: true });
  });

  await check('text maps', () => {
    const t = fromText('#####\n#S.B#\n#####\nset jumpLimit 3', 'x');
    assert.strictEqual(t.map.tiles[3][1], 4);
    assert.deepStrictEqual(t.map.spawnPoints.red, [{ x: 1, y: 1, radius: 0, weight: 1 }]);
    assert.strictEqual(t.settings.jumpLimit, 3);
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
