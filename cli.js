#!/usr/bin/env node
// GLTP-AI command line. Run with no arguments for help.
const fs = require('fs');
const path = require('path');

const HELP = `GLTP-AI: bots that learn TagPro gravity maps, on tagpro-local's real physics.

  node cli.js view                      the dashboard (http://localhost:8080)
  node cli.js explore <map> [options]   train with Go-Explore (proves a map possible, then gets faster)
  node cli.js neat <map> [options]      train with NEAT (MarI/O: evolves a network that plays)
  node cli.js fetch <id...>             download Fortunate Maps maps through your proxy into maps/
  node cli.js maps [search]             list GLTP leaderboard maps (easiest first)
  node cli.js verify <run>              replay a run's best keys in a fresh room and check it finishes
  node cli.js replay <run> [gen]        write a generation's best run as a TagPro replay (.ndjson)

<map> is a Fortunate Maps id (88528), a practice map in maps/ (steps, tower, spikes, slopes), or a .png.

Goals (both trainers):
  --goal "reach 10,5; grab; cap"   the plan: steps done in order (reach x,y [rN], grab, cap, button x,y)
                                   default: the map's saved plan (plans/), else its GLTP rules
  --time-from N                    the clock starts when step N (1-based) is done, not at spawn

Go-Explore:  --explore-ticks 90 --hold-mean 6 --frontier 4 --batch 0 --max-ticks 10800
NEAT:        --population 300 --think-every 2 --patience 180 --max-ticks 3600 --end-on-pop true
Both:        --max-gens N --seed 1 --workers N (default: one per CPU) --port 8080 --no-view
Maps:        --proxy URL (or FM_PROXY, or "proxy" in config.json); "{url}" in it is replaced by the
             encoded Fortunate Maps URL, otherwise the URL is appended
`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (k.startsWith('no-')) { opt[camel(k.slice(3))] = false; continue; }
    if (v === undefined) v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    opt[camel(k)] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return { pos, opt };
}
const camel = (s) => s.replace(/-(\w)/g, (m, c) => c.toUpperCase());

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const maps = require('./src/maps');

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);

  if (cmd === 'fetch') {
    const proxy = maps.configuredProxy(opt.proxy);
    if (!proxy) console.warn('no proxy set: trying Fortunate Maps directly (see --proxy)');
    for (const id of pos) {
      try { console.log(id, (await maps.fetchMap(id, proxy)) ? 'downloaded' : 'already here'); } catch (e) { console.error(id, e.message); process.exitCode = 1; }
    }
    return;
  }

  if (cmd === 'maps') {
    const q = pos.join(' ').toLowerCase();
    const list = maps.listGltp().filter((m) => m.gravity && (!q || `${m.name} ${m.author} ${m.categories.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.difficulty ?? 99) - (b.difficulty ?? 99));
    for (const m of list) console.log(`${String(m.id).padEnd(6)} ${String(m.difficulty ?? '?').padStart(4)}  ${m.downloaded ? '✓' : ' '} ${m.name}  [${m.categories.join(', ')}]${m.balls !== '1' ? `  (${m.balls} balls)` : ''}`);
    console.log(`\n${list.length} maps. Practice maps: ${maps.practiceMaps().join(', ')}`);
    return;
  }

  if (cmd === 'view') {
    const { Dashboard } = require('./src/server');
    const d = new Dashboard({ port: opt.port || 8080, host: opt.host || '127.0.0.1', proxy: opt.proxy });
    console.log('dashboard:', await d.listen());
    return;
  }

  if (cmd === 'verify' || cmd === 'replay') {
    const { Run } = require('./src/store');
    const run = Run.open(pos[0] || Run.list()[0].id);
    const level = maps.loadLevel(run.meta.map.key);
    if (cmd === 'verify') {
      const { play } = require('./src/sim');
      const { Plan } = require('./src/goals');
      const best = run.meta.fastest ? run.generation(run.meta.fastest.gen).best : run.meta.best;
      const plan = new Plan(level, run.meta.plan.steps, play(level, []).spawn, { timeFrom: run.meta.plan.timeFrom });
      const state = plan.start();
      play(level, best.keys, {}, (sim) => { plan.update(state, sim); return !plan.finished(state); });
      const t = plan.time(state);
      console.log(`${run.meta.map.name}: plan "${run.meta.plan.text}"`);
      if (t != null) console.log(`finished in ${t} ticks (${(t / 60).toFixed(3)} s) on a fresh room: the map is possible ✓`);
      else { console.log(`not finished: ${state.step} of ${plan.steps.length} steps`); process.exitCode = 1; }
      return;
    }
    const { buildReplay } = require('./src/replay');
    const gen = pos[1] != null ? Number(pos[1]) : (run.meta.fastest ? run.meta.fastest.gen : run.meta.generations - 1);
    const g = run.generation(gen);
    const out = buildReplay(level, g.best.keys, { name: `Gen ${gen} best` });
    const file = opt.o || opt.out || `${run.id}-gen${gen}.ndjson`;
    fs.writeFileSync(file, out.text);
    console.log('wrote', file);
    return;
  }

  if (cmd === 'explore' || cmd === 'neat') {
    if (!pos[0]) return console.log(HELP);
    if (/^\d+$/.test(pos[0])) await maps.fetchMap(pos[0], maps.configuredProxy(opt.proxy));
    const level = maps.loadLevel(pos[0]);
    if (opt.goal) {
      const { parseSteps } = require('./src/goals');
      opt.plan = { steps: parseSteps(opt.goal), timeFrom: opt.timeFrom ? opt.timeFrom - 1 : -1, source: 'run' };
    }
    const view = opt.view !== false, server = { port: opt.port || 8080, host: opt.host || '127.0.0.1', proxy: opt.proxy };
    for (const k of ['goal', 'timeFrom', 'view', 'port', 'host', 'proxy']) delete opt[k];
    const Trainer = cmd === 'explore' ? require('./src/train-explore').ExploreTrainer : require('./src/train-neat').NeatTrainer;
    const t = new Trainer(level, opt);
    if (view) {
      const { Dashboard } = require('./src/server');
      const d = new Dashboard(server);
      d.attach(t);
      console.log('dashboard:', await d.listen());
    }
    t.on('start', (m) => console.log(`run ${m.id}: ${level.name}, plan: ${m.plan.text}`));
    t.on('generation', (s) => {
      const extra = cmd === 'neat' ? `species ${s.species.length}` : `cells ${s.cells} (+${s.added})`;
      console.log(`gen ${String(s.gen).padStart(4)}  progress ${(s.progress * 100).toFixed(1).padStart(5)}%  ${s.time != null ? `finished ${(s.time / 60).toFixed(2)}s` : `step ${s.steps}`}  ${extra}  ${s.seconds.toFixed(1)}s`);
    });
    process.on('SIGINT', () => { if (t.stopped) process.exit(1); console.log('\nstopping after this generation (Ctrl+C again to quit now)'); t.stop(); });
    await t.start();
    const m = t.run.meta;
    console.log(m.fastest ? `done: finished in ${(m.fastest.time / 60).toFixed(2)} s (generation ${m.fastest.gen})` : `done: best progress ${(m.best.progress * 100).toFixed(1)}%`);
    if (view) console.log('dashboard still running; Ctrl+C to quit');
    else process.exit(0);
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
