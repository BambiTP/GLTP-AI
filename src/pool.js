// pool.js - worker threads that each load the map and plan once, then play runs on request
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

class WorkerPool {
  // work: { level (map name), plan: { steps, timeFrom } }
  constructor(work, size) {
    this.size = size || Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length));
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: work });
      w.busy = false;
      w.on('message', ({ id, result, error }) => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        w.busy = false;
        if (error) p.reject(new Error(error)); else p.resolve(result);
        this.drain();
      });
      w.on('error', (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
      this.workers.push(w);
    }
  }

  run(type, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, type, task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = true;
      this.pending.set(job.id, job);
      w.postMessage({ id: job.id, type: job.type, task: job.task });
    }
  }

  close() { return Promise.all(this.workers.map((w) => w.terminate())); }
}

module.exports = { WorkerPool };
