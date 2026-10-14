// neat.js - NeuroEvolution of Augmenting Topologies, ported from SethBling's MarI/O (2015): the
// same genome layout, mutation rates that mutate themselves, speciation, culling and breeding.
// Random numbers come from a seeded generator so a run can be repeated.
const { rng } = require('./sim');

const DEFAULTS = {
  population: 300,
  deltaDisjoint: 2.0,
  deltaWeights: 0.4,
  deltaThreshold: 1.0,
  staleSpecies: 15,
  mutateConnectionsChance: 0.25,
  perturbChance: 0.90,
  crossoverChance: 0.75,
  linkMutationChance: 2.0,
  nodeMutationChance: 0.50,
  biasMutationChance: 0.40,
  stepSize: 0.1,
  disableMutationChance: 0.4,
  enableMutationChance: 0.2,
};
const MAX_NODES = 1000000; // output neuron ids are MAX_NODES + 1..outputs

class Pool {
  // inputs includes the bias (the last input)
  constructor(inputs, outputs, cfg = {}, seed = 1) {
    this.cfg = Object.assign({}, DEFAULTS, cfg);
    this.inputs = inputs;
    this.outputs = outputs;
    this.random = rng(seed);
    this.species = [];
    this.generation = 0;
    this.innovation = outputs;
    this.maxFitness = -Infinity;
    this.nextSpeciesId = 1;
    for (let i = 0; i < this.cfg.population; i++) this.addToSpecies(this.basicGenome());
  }

  rand() { return this.random(); }
  randInt(lo, hi) { return lo + Math.floor(this.random() * (hi - lo + 1)); } // inclusive, like Lua's math.random(lo, hi)
  pick(list) { return list[Math.floor(this.random() * list.length)]; }
  newInnovation() { return ++this.innovation; }

  genomes() { return this.species.flatMap((s) => s.genomes); }

  // ---------- genomes ----------
  newGenome() {
    const c = this.cfg;
    return {
      genes: [], fitness: 0, adjustedFitness: 0, maxneuron: 0, globalRank: 0,
      rates: {
        connections: c.mutateConnectionsChance, link: c.linkMutationChance, bias: c.biasMutationChance,
        node: c.nodeMutationChance, enable: c.enableMutationChance, disable: c.disableMutationChance, step: c.stepSize,
      },
    };
  }

  copyGenome(g) {
    const g2 = this.newGenome();
    g2.genes = g.genes.map((x) => ({ ...x }));
    g2.maxneuron = g.maxneuron;
    g2.rates = { ...g.rates };
    return g2;
  }

  basicGenome() {
    const g = this.newGenome();
    g.maxneuron = this.inputs;
    this.mutate(g);
    return g;
  }

  crossover(g1, g2) {
    if (g2.fitness > g1.fitness) [g1, g2] = [g2, g1];
    const child = this.newGenome();
    const byInnov = new Map(g2.genes.map((x) => [x.innovation, x]));
    for (const gene1 of g1.genes) {
      const gene2 = byInnov.get(gene1.innovation);
      child.genes.push({ ...(gene2 && this.randInt(1, 2) === 1 && gene2.enabled ? gene2 : gene1) });
    }
    child.maxneuron = Math.max(g1.maxneuron, g2.maxneuron);
    child.rates = { ...g1.rates };
    return child;
  }

  randomNeuron(genes, nonInput) {
    const neurons = new Set();
    if (!nonInput) for (let i = 1; i <= this.inputs; i++) neurons.add(i);
    for (let o = 1; o <= this.outputs; o++) neurons.add(MAX_NODES + o);
    for (const g of genes) {
      if (!nonInput || g.into > this.inputs) neurons.add(g.into);
      if (!nonInput || g.out > this.inputs) neurons.add(g.out);
    }
    return this.pick([...neurons]);
  }

  containsLink(genes, into, out) { return genes.some((g) => g.into === into && g.out === out); }

  pointMutate(g) {
    const step = g.rates.step;
    for (const gene of g.genes) {
      if (this.rand() < this.cfg.perturbChance) gene.weight += this.rand() * step * 2 - step;
      else gene.weight = this.rand() * 4 - 2;
    }
  }

  linkMutate(g, forceBias) {
    let n1 = this.randomNeuron(g.genes, false), n2 = this.randomNeuron(g.genes, true);
    if (n1 <= this.inputs && n2 <= this.inputs) return; // both inputs
    if (n2 <= this.inputs) [n1, n2] = [n2, n1];
    if (forceBias) n1 = this.inputs;
    if (this.containsLink(g.genes, n1, n2)) return;
    g.genes.push({ into: n1, out: n2, weight: this.rand() * 4 - 2, enabled: true, innovation: this.newInnovation() });
  }

  nodeMutate(g) {
    if (!g.genes.length) return;
    const gene = this.pick(g.genes);
    if (!gene.enabled) return;
    g.maxneuron++;
    gene.enabled = false;
    g.genes.push({ into: gene.into, out: g.maxneuron, weight: 1, enabled: true, innovation: this.newInnovation() });
    g.genes.push({ into: g.maxneuron, out: gene.out, weight: gene.weight, enabled: true, innovation: this.newInnovation() });
  }

  enableDisableMutate(g, enable) {
    const candidates = g.genes.filter((x) => x.enabled !== enable);
    if (!candidates.length) return;
    const gene = this.pick(candidates);
    gene.enabled = !gene.enabled;
  }

  mutate(g) {
    for (const k of Object.keys(g.rates)) g.rates[k] *= this.randInt(1, 2) === 1 ? 0.95 : 1.05263;
    if (this.rand() < g.rates.connections) this.pointMutate(g);
    for (let p = g.rates.link; p > 0; p--) if (this.rand() < p) this.linkMutate(g, false);
    for (let p = g.rates.bias; p > 0; p--) if (this.rand() < p) this.linkMutate(g, true);
    for (let p = g.rates.node; p > 0; p--) if (this.rand() < p) this.nodeMutate(g);
    for (let p = g.rates.enable; p > 0; p--) if (this.rand() < p) this.enableDisableMutate(g, true);
    for (let p = g.rates.disable; p > 0; p--) if (this.rand() < p) this.enableDisableMutate(g, false);
  }

  // ---------- species ----------
  disjoint(a, b) {
    const ia = new Set(a.map((g) => g.innovation)), ib = new Set(b.map((g) => g.innovation));
    let n = 0;
    for (const g of a) if (!ib.has(g.innovation)) n++;
    for (const g of b) if (!ia.has(g.innovation)) n++;
    const m = Math.max(a.length, b.length);
    return m ? n / m : 0;
  }

  weights(a, b) {
    const ib = new Map(b.map((g) => [g.innovation, g]));
    let sum = 0, n = 0;
    for (const g of a) { const o = ib.get(g.innovation); if (o) { sum += Math.abs(g.weight - o.weight); n++; } }
    return n ? sum / n : 0;
  }

  sameSpecies(a, b) {
    const c = this.cfg;
    return c.deltaDisjoint * this.disjoint(a.genes, b.genes) + c.deltaWeights * this.weights(a.genes, b.genes) < c.deltaThreshold;
  }

  addToSpecies(child) {
    for (const s of this.species) if (this.sameSpecies(child, s.genomes[0])) { s.genomes.push(child); return; }
    this.species.push({ id: this.nextSpeciesId++, topFitness: 0, staleness: 0, averageFitness: 0, genomes: [child] });
  }

  rankGlobally() {
    const all = this.genomes().sort((a, b) => a.fitness - b.fitness);
    all.forEach((g, i) => { g.globalRank = i + 1; });
  }

  calculateAverageFitness(s) {
    s.averageFitness = s.genomes.reduce((t, g) => t + g.globalRank, 0) / s.genomes.length;
  }

  totalAverageFitness() { return this.species.reduce((t, s) => t + s.averageFitness, 0); }

  cullSpecies(cutToOne) {
    for (const s of this.species) {
      s.genomes.sort((a, b) => b.fitness - a.fitness);
      const keep = cutToOne ? 1 : Math.ceil(s.genomes.length / 2);
      s.genomes.length = Math.min(s.genomes.length, keep);
    }
  }

  breedChild(s) {
    const child = this.rand() < this.cfg.crossoverChance
      ? this.crossover(this.pick(s.genomes), this.pick(s.genomes))
      : this.copyGenome(this.pick(s.genomes));
    this.mutate(child);
    return child;
  }

  removeStaleSpecies() {
    this.species = this.species.filter((s) => {
      s.genomes.sort((a, b) => b.fitness - a.fitness);
      if (s.genomes[0].fitness > s.topFitness) { s.topFitness = s.genomes[0].fitness; s.staleness = 0; } else s.staleness++;
      return s.staleness < this.cfg.staleSpecies || s.topFitness >= this.maxFitness;
    });
  }

  removeWeakSpecies() {
    const sum = this.totalAverageFitness();
    this.species = this.species.filter((s) => Math.floor(s.averageFitness / sum * this.cfg.population) >= 1);
  }

  // call after every genome has its fitness
  newGeneration() {
    for (const g of this.genomes()) if (g.fitness > this.maxFitness) this.maxFitness = g.fitness;
    this.cullSpecies(false);
    this.rankGlobally();
    this.removeStaleSpecies();
    this.rankGlobally();
    for (const s of this.species) this.calculateAverageFitness(s);
    this.removeWeakSpecies();
    const sum = this.totalAverageFitness();
    const children = [];
    for (const s of this.species) {
      const n = Math.floor(s.averageFitness / sum * this.cfg.population) - 1;
      for (let i = 0; i < n; i++) children.push(this.breedChild(s));
    }
    this.cullSpecies(true);
    while (children.length + this.species.length < this.cfg.population) children.push(this.breedChild(this.pick(this.species)));
    for (const c of children) this.addToSpecies(c);
    for (const g of this.genomes()) g.fitness = 0;
    this.generation++;
  }

  // ---------- saving ----------
  toJSON() {
    return {
      cfg: this.cfg, inputs: this.inputs, outputs: this.outputs, generation: this.generation, innovation: this.innovation,
      maxFitness: this.maxFitness, nextSpeciesId: this.nextSpeciesId,
      species: this.species.map((s) => ({ ...s, genomes: s.genomes.map(packGenome) })),
    };
  }
}

// genomes travel to workers and into files as { genes: [[into, out, weight, enabled, innovation]], maxneuron, rates }
function packGenome(g) {
  return { genes: g.genes.map((x) => [x.into, x.out, x.weight, x.enabled ? 1 : 0, x.innovation]), maxneuron: g.maxneuron, rates: g.rates, fitness: g.fitness };
}

function unpackGenome(p) {
  return { genes: p.genes.map(([into, out, weight, enabled, innovation]) => ({ into, out, weight, enabled: !!enabled, innovation })), maxneuron: p.maxneuron, rates: { ...p.rates }, fitness: p.fitness || 0, adjustedFitness: 0, globalRank: 0 };
}

// ---------- networks ----------
function sigmoid(x) { return 2 / (1 + Math.exp(-4.9 * x)) - 1; }

class Network {
  constructor(packed, inputs, outputs) {
    this.inputs = inputs;
    this.outputs = outputs;
    const ids = new Set();
    for (let i = 1; i <= inputs; i++) ids.add(i);
    for (let o = 1; o <= outputs; o++) ids.add(MAX_NODES + o);
    const incoming = new Map();
    for (const [into, out, weight, enabled] of packed.genes) {
      if (!enabled) continue;
      ids.add(into); ids.add(out);
      if (!incoming.has(out)) incoming.set(out, []);
      incoming.get(out).push([into, weight]);
    }
    // evaluated in id order: hidden neurons (oldest first), then outputs; a link into an older neuron
    // reads last tick's value, which gives the network a little memory, as in MarI/O
    this.order = [...incoming.keys()].sort((a, b) => a - b).map((id) => [id, incoming.get(id)]);
    this.value = new Map([...ids].map((id) => [id, 0]));
  }

  evaluate(input) {
    const v = this.value;
    for (let i = 0; i < this.inputs; i++) v.set(i + 1, input[i]);
    for (const [id, inc] of this.order) {
      let sum = 0;
      for (const [into, w] of inc) sum += w * v.get(into);
      v.set(id, sigmoid(sum));
    }
    const out = [];
    for (let o = 1; o <= this.outputs; o++) out.push(v.get(MAX_NODES + o));
    return out;
  }
}

module.exports = { Pool, Network, packGenome, unpackGenome, MAX_NODES, DEFAULTS };
