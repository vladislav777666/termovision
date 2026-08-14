'use strict';

// SimulationEngine: оркестратор симуляций.
//  - создаёт симуляцию на основе сети (БД или импорт);
//  - валидирует сеть перед расчётом;
//  - обрабатывает аварию (fail-pipe), пересчитывает граф, последствия, резервы,
//    критичность, таймлайн, рекомендации;
//  - хранит результаты в памяти и (опционально) в БД платформы.

const { fromDb, fromJson, PipeStatus } = require('./networkModel');
const { buildGraph } = require('./graph');
const { validateNetwork } = require('./validator');
const { FailureParams, FailureType } = require('./failure');
const { analyzeImpact } = require('./impact');
const { computeCriticality, generateRecommendations } = require('./criticality');
const { buildTimeline } = require('./timeline');

let simCounter = 0;

class SimulationEngine {
  constructor({ db = null } = {}) {
    this.db = db;
    this.simulations = new Map(); // id -> SimulationRecord
  }

  // Сеть из БД платформы (реальные данные) либо из JSON-объекта.
  loadNetwork({ source = 'db', data = null, config = {} } = {}) {
    if (source === 'json') return fromJson(data, config);
    if (!this.db) throw new Error('БД не подключена');
    return fromDb(this.db, config);
  }

  createSimulation({ source = 'db', data = null, config = {}, label = '' } = {}) {
    const model = this.loadNetwork({ source, data, config });
    const validation = validateNetwork(model);
    simCounter++;
    const id = 'sim-' + Date.now() + '-' + simCounter;
    const record = {
      id,
      label: label || `Симуляция №${simCounter}`,
      createdAt: new Date().toISOString(),
      model,
      validation,
      failures: [],   // действующие аварии
      result: null,
      status: 'READY'
    };
    this.simulations.set(id, record);
    this._persist(record);
    return this._publicRecord(record);
  }

  // Список аварийных участков: все трубы с активным отказом.
  _failedPipes(record) {
    const out = [];
    for (const f of record.failures) {
      const p = record.model.pipe(f.params.affectedPipeId);
      if (p) out.push({ pipe: p, params: f.params });
    }
    return out;
  }

  failPipe(simulationId, rawParams) {
    const record = this.simulations.get(simulationId);
    if (!record) throw new Error('Симуляция не найдена: ' + simulationId);
    if (!record.validation.valid) {
      throw new Error('Сеть не прошла валидацию: ' + record.validation.errors.map(e => e.message).join('; '));
    }
    const params = new FailureParams(rawParams);
    const pipe = record.model.pipe(params.affectedPipeId);
    if (!pipe) throw new Error('Участок не найден: ' + params.affectedPipeId);
    if (!pipe.isValid) throw new Error('Участок не может участвовать в симуляции (петля или отсутствуют узлы): ' + pipe.id);

    // повторный отказ того же участка — заменяем
    const prevIdx = record.failures.findIndex(f => f.params.affectedPipeId === pipe.id);
    if (prevIdx >= 0) record.failures.splice(prevIdx, 1);
    record.failures.push({ at: new Date().toISOString(), params });

    pipe.status = PipeStatus.FAILED;
    this._recompute(record);
    this._persist(record);
    return record.result;
  }

  // Пересчёт всех слоёв симуляции после изменения состояния графа.
  _recompute(record) {
    const { model } = record;
    const failed = this._failedPipes(record);

    // восстановить статусы всех труб, кроме аварийных
    for (const p of model.pipes) if (p.status === PipeStatus.FAILED) p.status = PipeStatus.NORMAL;
    const failedIds = new Set(failed.map(f => f.pipe.id));
    for (const f of failed) f.pipe.status = PipeStatus.FAILED;

    // 1) топологическая зона отключения
    const graph = buildGraph(model);
    const sourceIds = model.sources.map(s => s.id);

    // 2) анализ последствий
    const impact = analyzeImpact(model, failed);
    const primary = failed[0];
    const criticality = computeCriticality(impact, model.config);
    const timeline = buildTimeline(model, primary ? primary.params : new FailureParams(), impact);
    const recommendations = generateRecommendations(impact, criticality, primary ? primary.params : new FailureParams(), timeline.phases, model);

    // статусы труб для визуализации: аварийная — FAILED; изолированные — ISOLATED
    for (const p of model.pipes) {
      if (p.status === PipeStatus.FAILED || failedIds.has(p.id)) continue;
      if (impact.affectedPipes.includes(p.id)) p.status = PipeStatus.ISOLATED;
    }

    const result = {
      simulationId: record.id,
      createdAt: new Date().toISOString(),
      failedElements: failed.map(f => ({ id: f.pipe.id, name: f.pipe.name, type: f.params.type, severity: f.params.severity, label: f.params.label })),
      impact,
      criticality,
      timeline: timeline.phases,
      estimatedRepairMinutes: timeline.estimatedRepairMinutes,
      estimatedRecovery: timeline.formatTotal(),
      recommendations,
      totalLostLoadGcalH: impact.stats.totalLostLoadGcalH,
      totalAffectedAreaM2: impact.stats.totalAffectedAreaM2,
      totalAffectedApartments: impact.stats.totalAffectedApartments,
      severity: primary ? primary.params.severity : 0,
      pipeStates: model.pipes.map(p => ({ id: p.id, status: p.status })),
      nodeStates: model.nodes.map(n => ({ id: n.id, status: n.status }))
    };
    record.result = result;
    record.status = 'ACTIVE';
    return result;
  }

  // Прогноз критичности ДО аварии ("что будет, если труба выйдет из строя").
  criticalityForecast(simulationId, pipeId) {
    const record = this.simulations.get(simulationId);
    if (!record) throw new Error('Симуляция не найдена');
    const model = record.model;
    const pipe = model.pipe(pipeId);
    if (!pipe) throw new Error('Участок не найден: ' + pipeId);
    const params = new FailureParams({ affectedPipeId: pipeId, type: FailureType.RUPTURE, severity: 4 });
    const impact = analyzeImpact(model, [{ pipe, params }]);
    const criticality = computeCriticality(impact, model.config);
    const reserve = impact.reserveRoutes.length > 0;
    return {
      pipe: { id: pipe.id, name: pipe.name, diameterMm: pipe.diameterMm, lengthM: pipe.lengthM },
      forecast: impact.stats,
      criticality,
      hasReserve: reserve,
      reserveRoutes: impact.reserveRoutes.slice(0, 5),
      topAffected: impact.buildings.filter(b => b.status !== 'NORMAL').slice(0, 10),
      type: impact.type,
      limitationMessage: impact.limitationMessage
    };
  }

  getSimulation(id) { return this._publicRecord(this.simulations.get(id)); }

  listSimulations() {
    return [...this.simulations.values()].map(r => this._publicRecord(r));
  }

  _publicRecord(record) {
    if (!record) return null;
    return {
      id: record.id,
      label: record.label,
      createdAt: record.createdAt,
      status: record.status,
      validation: {
        valid: record.validation.valid,
        errors: record.validation.errors,
        warnings: record.validation.warnings,
        info: record.validation.info
      },
      stats: record.model.stats(),
      failures: record.failures.map(f => ({ at: f.at, ...f.params })),
      result: record.result,
      model: {
        nodes: record.model.nodes,
        pipes: record.model.pipes,
        buildings: record.model.buildings
      }
    };
  }

  _persist(record) {
    if (!this.db) return;
    try {
      const data = JSON.stringify(this._publicRecord(record).result);
      this.db.prepare(`CREATE TABLE IF NOT EXISTS sim_results (
        simulation_id TEXT PRIMARY KEY,
        result TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`).run();
      this.db.prepare('INSERT OR REPLACE INTO sim_results(simulation_id, result) VALUES(?,?)').run(record.id, data);
    } catch (e) { /* persistence is best-effort */ }
  }
}

module.exports = { SimulationEngine };