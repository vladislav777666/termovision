'use strict';

// Поиск резервных маршрутов от источника до узла здания, не использующих
// аварийные участки. Если маршрут существует — здание НЕ считается отключённым.

const { buildGraph } = require('./graph');
const { pathCapacity } = require('./hydraulic');
const { buildingDemandKgS, dTDesign, statusFromFraction } = require('./thermal');

// Для каждого узла с зданиями: есть ли альтернативный путь от любого источника
// (исключая маршруты, проходящие через failedPipes).
// Возвращает Map<nodeId, { route, capacityKgS, flowRatio, status }>
function analyzeReserveRoutes(model, failedPipes) {
  const graph = buildGraph(model);
  const blocked = new Set(failedPipes.map(p => p.id));
  const sourceIds = model.sources.map(s => s.id);
  const out = new Map();

  const demandByNode = new Map();
  for (const b of model.buildings) {
    if (!b.connectedNodeId) continue;
    const d = buildingDemandKgS(b, model.config);
    if (d == null) continue;
    demandByNode.set(b.connectedNodeId, (demandByNode.get(b.connectedNodeId) || 0) + d);
  }

  for (const nodeId of demandByNode.keys()) {
    let best = null;
    for (const s of sourceIds) {
      const route = graph.findAlternativeRoute(s, nodeId, blocked);
      if (!route) continue;
      if (!best || route.totalWeight < best.route.totalWeight) best = { route, sourceId: s };
    }
    if (!best) { out.set(nodeId, null); continue; }
    const cap = pathCapacity(best.route.pipeIds, model, model.config);
    const demand = demandByNode.get(nodeId);
    let status = 'RESERVE_SUPPLY', flowRatio = null, capacityKgS = cap;
    if (cap != null && demand != null) {
      flowRatio = Math.min(1, cap / demand);
      status = statusFromFraction(flowRatio, { reserve: true });
      capacityKgS = cap * (model.config.reserveFlowFactor || 0.8);
    }
    out.set(nodeId, {
      route: { nodeIds: best.route.nodeIds, pipeIds: best.route.pipeIds, lengthM: best.route.totalWeight },
      sourceId: best.sourceId,
      capacityKgS: capacityKgS,
      demandKgS: demand,
      flowRatio,
      status
    });
  }
  return out;
}

module.exports = { analyzeReserveRoutes };