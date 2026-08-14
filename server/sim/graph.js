'use strict';

// Граф теплосети: обходы, компоненты связности, мосты, кратчайшие пути,
// резервные маршруты. Все алгоритмы работают ТОЛЬКО по топологии
// (pipe.startNodeId/endNodeId, building.connectedNodeId) — без хардкода имён.

class Graph {
  constructor(nodes, pipes) {
    this.nodeIds = nodes.map(n => n.id);
    this.pipes = pipes;
    // adjacency: nodeId -> [{ pipeId, to }]
    this.adj = new Map();
    for (const n of nodes) this.adj.set(n.id, []);
    for (const p of pipes) {
      if (!p.isValid) continue;
      this.adj.get(p.startNodeId)?.push({ pipeId: p.id, to: p.endNodeId });
      this.adj.get(p.endNodeId)?.push({ pipeId: p.id, to: p.startNodeId });
    }
  }

  neighbors(nodeId) { return this.adj.get(nodeId) || []; }

  // BFS от набора стартовых узлов, edgeFilter(pipe) — разрешён ли участок.
  reachable(startIds, edgeFilter = () => true) {
    const seen = new Set(startIds);
    const queue = [...startIds];
    const usedPipes = new Set();
    while (queue.length) {
      const cur = queue.shift();
      for (const e of this.adj.get(cur) || []) {
        const p = this.pipes.find(x => x.id === e.pipeId);
        if (p && !edgeFilter(p)) continue;
        usedPipes.add(e.pipeId);
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
    return { nodes: [...seen], pipes: [...usedPipes] };
  }

  // Компоненты связности по всем узлам (без фильтров).
  components() {
    const seen = new Set();
    const out = [];
    for (const id of this.nodeIds) {
      if (seen.has(id)) continue;
      const { nodes } = this.reachable([id]);
      nodes.forEach(n => seen.add(n));
      out.push(nodes);
    }
    return out;
  }

  // Мосты (критические участки) — алгоритм Тарьяна.
  findBridges() {
    const disc = new Map(), low = new Map(), parent = new Map();
    const bridges = [];
    let time = 0;
    const nodes = this.nodeIds;
    const edgeKey = (a, b) => [a, b].sort().join('|');

    const dfs = (u) => {
      disc.set(u, ++time); low.set(u, disc.get(u));
      for (const e of this.adj.get(u) || []) {
        const v = e.to;
        if (!disc.has(v)) {
          parent.set(v, { node: u, pipeId: e.pipeId });
          dfs(v);
          low.set(u, Math.min(low.get(u), low.get(v)));
          if (low.get(v) > disc.get(u)) bridges.push(e.pipeId);
        } else if (parent.get(u)?.pipeId !== e.pipeId && parent.get(u)?.node !== v) {
          low.set(u, Math.min(low.get(u), disc.get(v)));
        }
      }
    };
    for (const n of nodes) if (!disc.has(n)) dfs(n);
    return [...new Set(bridges)];
  }

  // Dijkstra с весом ребра. weight(pipe, from) — функция веса; default — длина (или 1).
  // Рёбра с неконечным весом (Infinity/NaN) считаются непроходимыми.
  dijkstra(fromId, toId, weight = (p) => (p.lengthM || 1)) {
    const dist = new Map(), prev = new Map(), done = new Set();
    dist.set(fromId, 0);
    while (done.size < this.nodeIds.length) {
      let cur = null, best = Infinity;
      for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; cur = id; }
      if (cur == null) break;
      if (cur === toId) break;
      done.add(cur);
      for (const e of this.adj.get(cur) || []) {
        if (done.has(e.to)) continue;
        const p = this.pipes.find(x => x.id === e.pipeId);
        const w = p ? weight(p, cur) : 1;
        if (!Number.isFinite(w) || w < 0) continue; // непроходимое ребро
        const nd = dist.get(cur) + w;
        if (!dist.has(e.to) || nd < dist.get(e.to)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, pipeId: e.pipeId }); }
      }
    }
    if (!prev.has(toId) && fromId !== toId) return null;
    const path = { nodeIds: [], pipeIds: [], totalWeight: dist.get(toId) };
    let cur = toId;
    while (cur !== fromId) {
      path.nodeIds.unshift(cur);
      const pr = prev.get(cur);
      if (!pr) return null;
      path.pipeIds.unshift(pr.pipeId);
      cur = pr.from;
    }
    path.nodeIds.unshift(fromId);
    return path;
  }

  // Есть ли альтернативный маршрут fromId->toId, не использующий blockedPipes.
  // Возвращает путь или null.
  findAlternativeRoute(fromId, toId, blockedPipes, weight = (p) => (p.lengthM || 1)) {
    return this.dijkstra(fromId, toId, (p, u) => {
      if (blockedPipes.has(p.id)) return Infinity;
      return weight(p, u);
    });
  }

  // Зона отключения: узлы, которые теряют доступ к источникам при отказе pipes
  // (компонент после удаления участков минус компоненты с источником).
  affectedZone(failedPipes, sourceIds) {
    const blocked = new Set(failedPipes.map(p => p.id));
    const { nodes } = this.reachable(sourceIds, p => !blocked.has(p.id));
    const alive = new Set(nodes);
    const affected = this.nodeIds.filter(id => !alive.has(id));
    const affectedPipes = this.pipes.filter(p =>
      (p.isValid && (alive.has(p.startNodeId) !== alive.has(p.endNodeId))) || blocked.has(p.id));
    return { affectedNodes: affected, affectedPipes: affectedPipes.map(p => p.id) };
  }

  // Дистанция от узла до места аварии (по числу рёбер / метрам).
  distanceFrom(nodeId, failedNodes, { byLength = false } = {}) {
    const w = byLength ? (p) => (p.lengthM || 1) : () => 1;
    let best = Infinity;
    for (const f of failedNodes) {
      const path = this.dijkstra(f, nodeId, w);
      if (path) best = Math.min(best, path.totalWeight);
    }
    return Number.isFinite(best) ? best : null;
  }
}

function buildGraph(model) {
  return new Graph(model.nodes, model.pipes);
}

module.exports = { Graph, buildGraph };