'use strict';

// Валидатор топологии и данных сети. Запускается перед каждой симуляцией;
// ошибки топологии блокируют симуляцию, предупреждения по данным — помечают dataQuality.

const { NodeType } = require('./networkModel');

function validateNetwork(model) {
  const issues = [];
  const add = (level, code, message, refs = []) => issues.push({ level, code, message, refs });

  const nodeIds = new Set(model.nodes.map(n => n.id));
  const pipeIds = new Set();

  // трубы на несуществующие узлы (не блокируют симуляцию: граф пропускает невалидные рёбра)
  for (const p of model.pipes) {
    pipeIds.add(p.id);
    if (!p.startNodeId || !nodeIds.has(p.startNodeId)) add('warning', 'PIPE_DANGLING_START', `Участок ${p.name || p.id}: начальный узел "${p.startNodeId}" не существует`, [p.id]);
    if (!p.endNodeId || !nodeIds.has(p.endNodeId)) add('warning', 'PIPE_DANGLING_END', `Участок ${p.name || p.id}: конечный узел "${p.endNodeId}" не существует`, [p.id]);
    if (p.startNodeId && p.startNodeId === p.endNodeId) add('warning', 'PIPE_SELF_LOOP', `Участок ${p.name || p.id}: петля (startNodeId === endNodeId) — игнорируется графом`, [p.id]);
    if (p.id == null || p.id === '') add('error', 'PIPE_NO_ID', 'Участок без ID');
  }

  // дублирующиеся связи (пара узлов, две трубы)
  const pairs = new Map();
  for (const p of model.pipes) {
    if (!p.startNodeId || !p.endNodeId || p.startNodeId === p.endNodeId) continue;
    const key = [p.startNodeId, p.endNodeId].sort().join('|');
    if (pairs.has(key)) add('warning', 'PIPE_DUPLICATE_LINK', `Дублирующая связь ${pairs.get(key)} и ${p.id} между ${p.startNodeId} и ${p.endNodeId}`, [pairs.get(key), p.id]);
    else pairs.set(key, p.id);
  }

  // здания без подключения
  for (const b of model.buildings) {
    if (!b.connectedNodeId) add('warning', 'BUILDING_UNLINKED', `Здание ${b.address || b.id}: не подключено к узлу`, [b.id]);
    else if (!nodeIds.has(b.connectedNodeId)) add('warning', 'BUILDING_DANGLING', `Здание ${b.address || b.id}: узел подключения "${b.connectedNodeId}" не существует`, [b.id]);
    if (b.heatLoadGcalH != null && b.heatLoadGcalH < 0) add('error', 'NEGATIVE_LOAD', `Здание ${b.address || b.id}: отрицательная нагрузка ${b.heatLoadGcalH}`, [b.id]);
  }

  // источник
  if (model.sources.length === 0) add('error', 'NO_SOURCE', 'В сети не найден ни один источник тепла');
  else {
    // изолированные узлы и компоненты без источника
    const { buildGraph } = require('./graph');
    const g = buildGraph(model);
    const src = new Set(model.sources.map(s => s.id));
    const seen = new Set();
    for (const s of src) {
      const r = g.reachable([s]);
      r.nodes.forEach(n => seen.add(n));
    }
    for (const n of model.nodes) {
      if (!src.has(n.id) && !seen.has(n.id)) add('warning', 'NODE_ISOLATED', `Узел ${n.name || n.id}: не связан ни с одним источником`, [n.id]);
    }
    for (const b of model.buildings) {
      if (b.connectedNodeId && !seen.has(b.connectedNodeId)) add('warning', 'BUILDING_NO_SOURCE_PATH', `Здание ${b.address || b.id}: нет пути до источника`, [b.id]);
    }
  }

  // невозможные значения
  for (const p of model.pipes) {
    if (p.diameterMm != null && (p.diameterMm <= 0 || p.diameterMm > 2000)) add('error', 'BAD_DIAMETER', `Участок ${p.name || p.id}: диаметр ${p.diameterMm} вне допустимого диапазона`, [p.id]);
    if (p.lengthM != null && p.lengthM <= 0) add('error', 'BAD_LENGTH', `Участок ${p.name || p.id}: длина ${p.lengthM} <= 0`, [p.id]);
    if (p.diameterMm == null) add('warning', 'NO_DIAMETER', `Участок ${p.name || p.id}: диаметр не указан (физический расчёт недоступен)`, [p.id]);
  }
  for (const n of model.nodes) {
    if (n.lat != null && (n.lat < -90 || n.lat > 90)) add('error', 'BAD_LAT', `Узел ${n.name || n.id}: широта вне диапазона`, [n.id]);
    if (n.lon != null && (n.lon < -180 || n.lon > 180)) add('error', 'BAD_LON', `Узел ${n.name || n.id}: долгота вне диапазона`, [n.id]);
  }

  // циклы (наличие в графе = запасной маршрут) — информация
  const { Graph } = require('./graph');
  const g = new Graph(model.nodes, model.pipes.filter(p => p.isValid));
  const edgeCount = model.pipes.filter(p => p.isValid).length;
  const nodeCount = new Set([...model.pipes.filter(p => p.isValid).flatMap(p => [p.startNodeId, p.endNodeId])]).size;
  if (edgeCount > nodeCount) add('info', 'CYCLES_PRESENT', `В графе ${edgeCount - nodeCount} циклических связей (есть резервные маршруты)`);

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  const info = issues.filter(i => i.level === 'info');
  return { valid: errors.length === 0, errors, warnings, info, counts: model.stats() };
}

module.exports = { validateNetwork };