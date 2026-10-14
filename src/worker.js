// worker.js - a worker thread that plays runs on one map with one plan (see pool.js)
const { parentPort, workerData } = require('worker_threads');
const { loadLevel } = require('./maps');
const { Sim } = require('./sim');
const { Plan } = require('./goals');
const episodes = require('./episodes');

const level = loadLevel(workerData.level);
const plan = new Plan(level, workerData.plan.steps, new Sim(level).spawn, { timeFrom: workerData.plan.timeFrom });

parentPort.on('message', ({ id, type, task }) => {
  try {
    let result;
    if (type === 'genome') result = episodes.runGenome(level, plan, task.genome, task.cfg);
    else if (type === 'explore') result = episodes.explore(level, plan, task);
    else throw new Error('unknown task ' + type);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.stack || String(e) });
  }
});
