'use strict';

// Анализ последствий аварии.
// Логика статусов зданий (без хардкода, только граф + параметры):
//   1. Узел здания должен быть достижим от источника в обход аварийных участков.
//   2. Если пред-аварийный кратчайший маршрут от источника не затронут — NORMAL.
//   3. Если основной маршрут перерезан, но есть альтернативный — RESERVE_SUPPLY
//      (или PARTIAL, если пропускная способность резервного пути недостаточна).
//   4. Если маршрута нет вовсе — NO_HEAT.
//   5. Неизолирующая авария (частичное повреждение) не убирает ребро из графа,
//      но ограничивает пропускную способность участка (capacityFactor).
// Топологический слой считается всегда; физический — только при наличии диаметров/нагрузок.

const { buildGraph } = require('./graph');
const { BuildingStatus } = require('./networkModel');
const { buildingDemandKgS, statusFromFraction, dTDesign } = require('./thermal');
const { pathCapacity, pressureDrop, estimateDiameter, maxFlowByVelocity } = require('./hydraulic');

const impactScoreThresholds = { normal: 20, low: 50, partial: 80 }; // 0-100
const HEAT_GCAL_TO_KW = 1163;

function impactScoreFromFraction(frac, thresholds = impactScoreThresholds) {
  if (frac == null) return null;
  const s = (1 - frac) * 100;
  if (s <= thresholds.normal) return { score: Math.round(s), level: 'NORMAL' };
  if (s <= thresholds.low) return { score: Math.round(s), level: 'LOW_IMPACT' };
  if (s <= thresholds.partial) return { score: Math.round(s), level: 'PARTIAL' };
  return { score: Math.round(s), level: 'CRITICAL' };
}

// failures: [{ pipe, params }] — действующие аварии
function analyzeImpact(model, failures) {
  const graph = buildGraph(model);
  const realSourceIds = model.sources.map(s => s.id);
  const isolating = failures.filter(f => f.params.isolates);
  const degraded = failures.filter(f => !f.params.isolates);
  const blocked = new Set(isolating.map(f => f.pipe.id));
  const degradedFactor = new Map(); // pipeId -> capacityFactor
  for (const f of degraded) degradedFactor.set(f.pipe.id, f.params.capacityFactor || 1);
  const failedNodeIds = [...new Set(failures.flatMap(f => [f.pipe.startNodeId, f.pipe.endNodeId]))];

  // ---- источники и фрагментированные компоненты ----
  // Реальные KML-данные часто фрагментированы: компоненты связности не содержат
  // распознанный источник (НЕ хардкод — определяется по графу).
  // Гипотеза питания: каждый компонент запитан от своего представителя
  // (реальный источник компонента или, при фрагментации, первый узел компонента).
  // При аварии в компоненте без источника питание сохраняется только для
  // наибольшей остаточной части после изоляции аварии (bestRep).
  const components = graph.components();
  const compOfNode = new Map();
  components.forEach((comp, i) => comp.forEach(n => compOfNode.set(n, i)));
  const realSourceSet = new Set(realSourceIds);
  const reps = components.map(comp => {
    const real = comp.find(id => realSourceSet.has(id));
    return real || comp[0];
  });
  const failedCompIdx = new Set();
  for (const f of isolating) {
    const idx = compOfNode.get(f.pipe.startNodeId);
    if (idx != null) failedCompIdx.add(idx);
  }
  let fragmented = false;
  let bestRep = null;
  if (failedCompIdx.size > 0) {
    const compHasReal = [...failedCompIdx].some(i => components[i].some(id => realSourceSet.has(id)));
    if (!compHasReal) {
      // остаточные подкомпоненты после удаления аварийных участков:
      // питается сторона, похожая на магистральную — с наибольшим числом узлов
      // (при равенстве — наибольшей суммарной длиной труб, затем числом зданий).
      // Для реальных KML-данных это точнее, чем выбор по числу зданий:
      // потребительская ветка (ТК с домами) обычно короче питающего коридора.
      const seen = new Set();
      let best = null;
      for (const idx of failedCompIdx) for (const n of components[idx]) {
        if (seen.has(n)) continue;
        const sub = graph.reachable([n], p => !blocked.has(p.id)).nodes;
        sub.forEach(x => seen.add(x));
        const len = sub.reduce((s, x) => s + model.pipes.filter(p => p.isValid && (p.startNodeId === x || p.endNodeId === x)).reduce((s2, p) => s2 + (p.lengthM || 0), 0), 0);
        const bCount = sub.reduce((s, x) => s + model.buildingsAt(x).length, 0);
        const key = [sub.length, len, bCount];
        if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1]) || (key[0] === best.key[0] && key[1] === best.key[1] && key[2] > best.key[2])) {
          best = { nodes: sub, key };
        }
      }
      if (best) { bestRep = best.nodes[0]; fragmented = true; }
    }
  }
  const sourceIds = bestRep ? [...reps, bestRep] : reps;
  const isFailureCompNode = n => compOfNode.get(n) != null && failedCompIdx.has(compOfNode.get(n));
  const compSources = nodeId => {
    const idx = compOfNode.get(nodeId);
    const list = idx != null ? [reps[idx]] : [];
    if (bestRep && isFailureCompNode(nodeId) && !list.includes(bestRep)) list.push(bestRep);
    return list;
  };

  const { nodes: aliveNodes } = graph.reachable(sourceIds, p => !blocked.has(p.id));
  const aliveSet = new Set(aliveNodes);
  const isolatedNodeIds = model.nodes.filter(n => !aliveSet.has(n.id) && !sourceIds.includes(n.id)).map(n => n.id);
  const isolatedPipeIds = model.pipes.filter(p =>
    p.isValid && (aliveSet.has(p.startNodeId) !== aliveSet.has(p.endNodeId))).map(p => p.id);

  const weightByLength = p => (p.lengthM || 1);

  // Пред-аварийный основной маршрут узла (кэш) — от представителя компонента узла
  const primaryCache = new Map();
  function primaryRoute(nodeId) {
    if (primaryCache.has(nodeId)) return primaryCache.get(nodeId);
    let best = null;
    for (const s of compSources(nodeId)) {
      const r = graph.dijkstra(s, nodeId, weightByLength);
      if (r && (!best || r.totalWeight < best.totalWeight)) best = r;
    }
    primaryCache.set(nodeId, best);
    return best;
  }

  // Альтернативный маршрут в обход аварийных участков (кэш)
  const altCache = new Map();
  function alternativeRoute(nodeId) {
    if (altCache.has(nodeId)) return altCache.get(nodeId);
    let best = null;
    for (const s of compSources(nodeId)) {
      const r = graph.dijkstra(s, nodeId, (p) => blocked.has(p.id) ? Infinity : weightByLength(p));
      if (r && (!best || r.totalWeight < best.totalWeight)) best = r;
    }
    altCache.set(nodeId, best);
    return best;
  }

  // Доля расчётной мощности для узла: (status, frac, reason, route)
  const nodeStateCache = new Map();
  function nodeState(nodeId) {
    if (nodeStateCache.has(nodeId)) return nodeStateCache.get(nodeId);
    let out;
    if (aliveSet.has(nodeId)) {
      const primary = primaryRoute(nodeId);
      const primaryBroken = primary && primary.pipeIds.some(id => blocked.has(id));
      const degradedOnPrimary = primary ? primary.pipeIds.filter(id => degradedFactor.has(id)) : [];
      const fracCap = (cap, demand) => (cap != null && demand != null && cap > 0 && demand > 0) ? Math.min(1, cap / demand) : null;

      if (primary && !primaryBroken && degradedOnPrimary.length === 0) {
        out = { status: 'NORMAL', frac: 1, route: primary, viaReserve: false, reason: 'Основной маршрут сохранён' };
      } else if (primary && !primaryBroken && degradedOnPrimary.length > 0) {
        // неизолирующая авария на основном маршруте — ограничение мощности
        const factor = Math.min(...degradedOnPrimary.map(id => degradedFactor.get(id)));
        out = { status: 'PARTIAL', frac: factor, route: primary, viaReserve: false, reason: `Участок на пути частично повреждён (доступно ${Math.round(factor * 100)}% расчётной мощности)` };
      } else {
        // основной маршрут перерезан — ищем резервный
        const alt = alternativeRoute(nodeId);
        if (alt) {
          const demand = model.buildingsAt(nodeId).reduce((s, b) => s + (buildingDemandKgS(b, model.config) || 0), 0);
          const cap = pathCapacity(alt.pipeIds, model, model.config);
          const f = fracCap(cap, demand);
          const factor = Math.min(...alt.pipeIds.filter(id => degradedFactor.has(id)).map(id => degradedFactor.get(id)), 1);
          const frac = f == null ? null : Math.min(f, factor);
          out = {
            status: frac == null || frac >= 0.999 ? 'RESERVE_SUPPLY' : 'PARTIAL',
            frac,
            route: alt,
            viaReserve: true,
            reason: frac == null
              ? 'Питание сохранено по резервной схеме'
              : `Питание по резервной схеме (${Math.round(frac * 100)}% расчётной мощности)`
          };
        } else {
          out = { status: 'NO_HEAT', frac: 0, route: null, viaReserve: false, reason: 'Потеря единственного доступного маршрута питания' };
        }
      }
    } else {
      out = { status: 'NO_HEAT', frac: 0, route: null, viaReserve: false, reason: 'Потеря единственного доступного маршрута питания' };
    }
    nodeStateCache.set(nodeId, out);
    return out;
  }

  // ---- гидравлический слой: расходы по участкам, давление на вводах ----
  // Загрузка участка = сумма расчётных нагрузок зданий, чей маршрут питания
  // проходит через участок (древесное приближение по кратчайшим маршрутам).
  // Загрузка — характеристика ДО аварии: считаем по пред-аварийным маршрутам,
  // иначе отключённые здания «обнулили» бы нагрузку питающих их участков.
  const pipeLoadPre = new Map(); // pipeId -> { flowKgS, loadGcalH }
  for (const b of model.buildings) {
    if (!b.connectedNodeId) continue;
    const r = primaryRoute(b.connectedNodeId);
    if (!r) continue;
    const d = buildingDemandKgS(b, model.config) || 0;
    const ld = b.heatLoadGcalH || 0;
    for (const pid of r.pipeIds) {
      const acc = pipeLoadPre.get(pid) || { flowKgS: 0, loadGcalH: 0 };
      acc.flowKgS += d;
      acc.loadGcalH += ld;
      pipeLoadPre.set(pid, acc);
    }
  }
  // Расход по участкам ПОСЛЕ аварии (для давления на резервных маршрутах)
  const pipeFlow = new Map();
  for (const b of model.buildings) {
    if (!b.connectedNodeId) continue;
    const st = nodeState(b.connectedNodeId);
    if (!st || !st.route) continue;
    const d = buildingDemandKgS(b, model.config) || 0;
    for (const pid of st.route.pipeIds) {
      const acc = pipeFlow.get(pid) || { flowKgS: 0 };
      acc.flowKgS += d;
      pipeFlow.set(pid, acc);
    }
  }
  // Диаметр участка: паспортный или расчётный по расходу (помечается estimated)
  const pipeLoads = {};
  for (const p of model.pipes) {
    const f = pipeLoadPre.get(p.id) || { flowKgS: 0, loadGcalH: 0 };
    const est = p.diameterMm == null ? estimateDiameter(f.flowKgS, model.config) : null;
    pipeLoads[p.id] = {
      loadGcalH: +f.loadGcalH.toFixed(3),
      flowKgS: +f.flowKgS.toFixed(3),
      diameterMm: p.diameterMm || est,
      diameterEstimated: est != null
    };
  }
  // Расчётное давление на узле: feedPressureBar - ΣΔP по маршруту питания
  const nodePressureCache = new Map();
  function nodePressure(nodeId) {
    if (nodePressureCache.has(nodeId)) return nodePressureCache.get(nodeId);
    let out = null;
    const st = nodeState(nodeId);
    if (st && st.route) {
      let p = model.config.feedPressureBar;
      for (const pid of st.route.pipeIds) {
        const pp = model.pipe(pid);
        if (!pp || pp.lengthM == null) continue;
        const flow = (pipeFlow.get(pid) || {}).flowKgS || 0;
        const effD = pp.diameterMm || estimateDiameter(flow, model.config);
        if (effD == null) continue;
        const d = pressureDrop({ diameterMm: effD, lengthM: pp.lengthM }, flow, model.config);
        p -= d || 0;
      }
      out = +p.toFixed(2);
    }
    nodePressureCache.set(nodeId, out);
    return out;
  }

  const buildings = model.buildings.map(b => {
    const prevStatus = b.status || BuildingStatus.NORMAL;
    const demandKgS = buildingDemandKgS(b, model.config);
    const heatLoadKw = b.heatLoadGcalH != null ? b.heatLoadGcalH * HEAT_GCAL_TO_KW : null;
    let status, availableLoadGcalH = 0, lostLoadGcalH = heatLoadKw != null ? heatLoadKw / HEAT_GCAL_TO_KW : null;
    let reason, reserveRoute = null, flowRatio = null, distanceM = null, impact = null, primaryRouteStr = null;
    let pressureBar = null;

    if (!b.connectedNodeId) {
      status = BuildingStatus.UNKNOWN; reason = 'Здание не подключено к узлу';
    } else {
      const st = nodeState(b.connectedNodeId);
      status = st.status;
      reason = st.reason;
      flowRatio = st.frac;
      reserveRoute = st.viaReserve ? st.route : null;
      primaryRouteStr = st.route ? st.route.nodeIds.join(' → ') : null;
      const frac = st.frac;
      availableLoadGcalH = heatLoadKw != null && frac != null ? heatLoadKw / HEAT_GCAL_TO_KW * frac : (heatLoadKw != null ? null : 0);
      if (availableLoadGcalH == null && status === 'NORMAL') availableLoadGcalH = heatLoadKw / HEAT_GCAL_TO_KW;

      // давление на вводе (физический слой).
      // Статус пересчитывается только там, где авария реально изменила маршрут
      // питания (резервная схема): для зданий с неизменным основным маршрутом
      // давление до и после аварии одинаково, поэтому статус не трогаем —
      // иначе длинные фрагменты вне зоны аварии ложно деградировали бы.
      pressureBar = nodePressure(b.connectedNodeId);
      if (pressureBar != null && st.viaReserve && status !== BuildingStatus.NO_HEAT) {
        if (pressureBar <= 0) {
          // NO_HEAT решает только топология; давление не может «убить» маршрут —
          // при нулевом напоре остаётся минимальное потребление (аварийная схема)
          flowRatio = Math.min(flowRatio ?? 1, 0.05);
          status = BuildingStatus.PARTIAL;
          reason = 'Питание есть, но давление на вводе критически низкое (0 бар) — работа по аварийной схеме';
          availableLoadGcalH = heatLoadKw != null ? heatLoadKw / HEAT_GCAL_TO_KW * flowRatio : 0;
        } else if (pressureBar < model.config.minPressureBar) {
          const pFrac = Math.max(0, pressureBar / model.config.minPressureBar);
          flowRatio = flowRatio == null ? pFrac : Math.min(flowRatio, pFrac);
          if (flowRatio <= 0.01) {
            status = BuildingStatus.NO_HEAT;
            reason = `Давление на вводе ниже минимального (${pressureBar.toFixed(1)} бар)`;
          } else {
            status = BuildingStatus.PARTIAL;
            reason = (st.viaReserve ? 'Питание по резервной схеме, но ' : '') + `давление на вводе ниже минимального (${pressureBar.toFixed(1)} бар при норме ${model.config.minPressureBar})`;
          }
          availableLoadGcalH = heatLoadKw != null && flowRatio != null ? heatLoadKw / HEAT_GCAL_TO_KW * flowRatio : 0;
        }
      }
    }

    if (heatLoadKw != null) {
      const frac = heatLoadKw > 0 ? ((availableLoadGcalH != null ? availableLoadGcalH * HEAT_GCAL_TO_KW : 0) / heatLoadKw) : 1;
      lostLoadGcalH = heatLoadKw / HEAT_GCAL_TO_KW - (availableLoadGcalH || 0);
      impact = impactScoreFromFraction(frac, model.config.impactScoreThresholds || impactScoreThresholds);
    }
    distanceM = b.connectedNodeId ? graph.distanceFrom(b.connectedNodeId, failedNodeIds, { byLength: true }) : null;

    return {
      id: b.id, address: b.address, street: b.street, house: b.house, tk: b.tk,
      connectedNodeId: b.connectedNodeId,
      heatLoadGcalH: b.heatLoadGcalH, apartments: b.apartments, areaM2: b.areaM2, floors: b.floors, owner: b.owner,
      prevStatus, status, reason, reserveRoute, flowRatio, primaryRoute: primaryRouteStr,
      availableLoadGcalH: availableLoadGcalH != null ? +availableLoadGcalH.toFixed(4) : null,
      lostLoadGcalH: lostLoadGcalH != null ? +lostLoadGcalH.toFixed(4) : null,
      pressureBar,
      distanceM, impact
    };
  });

  const noHeat = buildings.filter(b => b.status === BuildingStatus.NO_HEAT);
  const partial = buildings.filter(b => b.status === BuildingStatus.PARTIAL);
  const reserve = buildings.filter(b => b.status === BuildingStatus.RESERVE_SUPPLY);
  const normal = buildings.filter(b => b.status === BuildingStatus.NORMAL || b.status === BuildingStatus.UNKNOWN);

  const affected = buildings.filter(b => b.status !== BuildingStatus.NORMAL && b.status !== BuildingStatus.UNKNOWN);
  const totalLostLoad = affected.reduce((s, b) => s + (b.lostLoadGcalH || 0), 0);
  const totalAffectedArea = affected.reduce((s, b) => s + (b.areaM2 || 0), 0);
  const totalAffectedApartments = affected.reduce((s, b) => s + (b.apartments || 0), 0);

  const chambers = model.nodes.filter(n =>
    isolatedNodeIds.includes(n.id) && /камер|chamber|узел|junction/i.test(String(n.type)));

  const reserveRoutes = [...nodeStateCache.entries()]
    .filter(([, v]) => v.viaReserve && v.route)
    .map(([nodeId, v]) => ({ nodeId, lengthM: v.route.totalWeight, pipeIds: v.route.pipeIds }));

  const failedList = failures.map(f => f.pipe);
  const anyEstimatedDiameter = failedList.some(p => p.diameterMm == null);
  const physicalAvailable = failedList.every(p => p.lengthM != null) &&
    model.buildings.every(b => b.heatLoadGcalH != null);

  const affectedForPressure = buildings.filter(b => b.status !== BuildingStatus.NORMAL && b.status !== BuildingStatus.UNKNOWN);
  const pressures = affectedForPressure.map(b => b.pressureBar).filter(p => p != null);
  const minPressureObserved = pressures.length ? Math.min(...pressures) : null;

  const fragmentationMsg = fragmented
    ? ' Компонент аварийного участка не содержит распознанного источника в исходных данных — оценка построена относительно наибольшей остаточной части компонента (фрагментированный граф).'
    : '';
  const physicalMsg = physicalAvailable
    ? (anyEstimatedDiameter
        ? ' Диаметры части участков — расчётные (оценка по расходу, т.к. паспортные данные отсутствуют); давление рассчитано по упрощённой модели Дарси-Вейсбаха.'
        : '')
    : ' Недостаточно данных для физически точного гидравлического расчёта — топологический прогноз основан на связности графа сети.';
  return {
    type: physicalAvailable ? 'PHYSICAL_SIMULATION' : 'TOPOLOGICAL_IMPACT',
    dataLimited: !physicalAvailable || fragmented || anyEstimatedDiameter,
    fragmented,
    limitationMessage: (fragmentationMsg + physicalMsg).trim(),
    failedPipes: failures.map(f => {
      const p = f.pipe;
      const pl = pipeLoads[p.id] || {};
      return { id: p.id, name: p.name, diameterMm: p.diameterMm || pl.diameterMm, diameterEstimated: pl.diameterEstimated || false, lengthM: p.lengthM, loadGcalH: pl.loadGcalH || 0 };
    }),
    hydraulic: {
      feedPressureBar: model.config.feedPressureBar,
      minPressureBar: model.config.minPressureBar,
      minPressureObservedBar: minPressureObserved,
      maxPressureDropBar: minPressureObserved != null ? +(model.config.feedPressureBar - minPressureObserved).toFixed(2) : null,
      diametersEstimated: anyEstimatedDiameter
    },
    pipeLoads,
    affectedNodes: isolatedNodeIds,
    affectedPipes: isolatedPipeIds,
    affectedChambers: chambers.map(n => ({ id: n.id, name: n.name, type: n.type })),
    buildings,
    stats: {
      affectedBuildings: affected.length,
      noHeatBuildings: noHeat.length,
      partialBuildings: partial.length,
      reserveBuildings: reserve.length,
      normalBuildings: normal.length,
      totalLostLoadGcalH: +totalLostLoad.toFixed(3),
      totalAffectedAreaM2: Math.round(totalAffectedArea),
      totalAffectedApartments,
      affectedChambers: chambers.length,
      failedPipeLengthM: failures.reduce((s, f) => s + (f.pipe.lengthM || 0), 0)
    },
    worstBuilding: affected.length
      ? affected.slice().sort((a, b) => (b.lostLoadGcalH || 0) - (a.lostLoadGcalH || 0))[0]
      : null,
    reserveRoutes
  };
}

module.exports = { analyzeImpact, impactScoreFromFraction, impactScoreThresholds };