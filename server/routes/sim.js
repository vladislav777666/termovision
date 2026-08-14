'use strict';

// REST API симулятора:
//   GET  /api/sim/network                     — сводка сети + статусы
//   POST /api/sim/simulations                 — создать симуляцию (db | json)
//   GET  /api/sim/simulations                 — список
//   GET  /api/sim/simulations/:id             — симуляция с результатом
//   POST /api/sim/simulations/:id/fail-pipe   — авария на участке
//   GET  /api/sim/simulations/:id/impact      — панель последствий
//   GET  /api/sim/pipes/:id/criticality       — прогноз критичности ДО аварии
//   GET  /api/sim/validate                    — валидация текущей сети (БД)
//   POST /api/sim/import                      — импорт JSON/CSV

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { SimulationEngine } = require('../sim/simulation');
const { importData } = require('../sim/importAdapter');
const { validateNetwork } = require('../sim/validator');
const { fromDb } = require('../sim/networkModel');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// единый движок на весь процесс (сеть — из БД платформы)
const engine = new SimulationEngine({ db });

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

router.get('/network', (req, res) => {
  const model = fromDb(db, {});
  const validation = validateNetwork(model);
  res.json({
    stats: model.stats(),
    validation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings },
    sources: model.sources.map(s => ({ id: s.id, name: s.name })),
    config: model.config
  });
});

// Дома с координатами для интерактивной карты.
// Без nodeId — все дома (до limit), с nodeId — только привязанные к узлу.
// Координаты наследуются от узла с детерминированным смещением (дома не имеют собственных точек в KML).
router.get('/houses', (req, res) => {
  const nodeId = req.query.nodeId || null;
  const limit = Math.min(+req.query.limit || 2000, 8000);
  const rows = nodeId
    ? db.prepare('SELECT h.*, n.lat node_lat, n.lon node_lon FROM houses h LEFT JOIN nodes n ON n.id=h.node_id WHERE h.node_id=? LIMIT ?').all(nodeId, limit)
    : db.prepare('SELECT h.*, n.lat node_lat, n.lon node_lon FROM houses h LEFT JOIN nodes n ON n.id=h.node_id WHERE h.node_id IS NOT NULL LIMIT ?').all(limit);
  const jitter = id => {
    let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
    const ang = (h % 360) * Math.PI / 180; const r = 5e-5 * ((h % 10) / 10 + 0.2);
    return [Math.cos(ang) * r, Math.sin(ang) * r];
  };
  res.json(rows.map(r => {
    const [dx, dy] = jitter(r.id);
    return {
      id: r.id, street: r.street, house: r.house, block: r.block, tk: r.tk, nodeId: r.node_id,
      lat: r.node_lat + dy, lon: r.node_lon + dx,
      load: r.load, area: r.area, flats: r.flats, floors: r.floors, year: r.year, owner: r.owner
    };
  }));
});

router.get('/validate', (req, res) => {
  const model = fromDb(db, {});
  res.json(validateNetwork(model));
});

router.post('/simulations', wrap((req, res) => {
  const { source = 'db', data = null, label = '', config = {} } = req.body || {};
  if (source === 'json' && !data) return res.status(400).json({ error: 'Для source=json укажите data' });
  const rec = engine.createSimulation({ source, data, label, config });
  res.json({ id: rec.id, label: rec.label, validation: rec.validation, stats: rec.stats });
}));

router.get('/simulations', (req, res) => res.json(engine.listSimulations().map(r => ({
  id: r.id, label: r.label, createdAt: r.createdAt, status: r.status,
  validation: r.validation, stats: r.stats, failures: r.failures
}))));

router.get('/simulations/:id', wrap((req, res) => {
  const rec = engine.getSimulation(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Симуляция не найдена' });
  res.json(rec);
}));

router.post('/simulations/:id/fail-pipe', wrap((req, res) => {
  const rec = engine.failPipe(req.params.id, req.body || {});
  res.json(rec || { error: 'Расчёт не выполнен' });
}));

router.get('/simulations/:id/impact', wrap((req, res) => {
  const rec = engine.getSimulation(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Симуляция не найдена' });
  if (!rec.result) return res.status(400).json({ error: 'Авария ещё не смоделирована' });
  res.json({
    impact: rec.result.impact,
    criticality: rec.result.criticality,
    timeline: rec.result.timeline,
    estimatedRecovery: rec.result.estimatedRecovery,
    recommendations: rec.result.recommendations
  });
}));

router.get('/pipes/:id/criticality', wrap((req, res) => {
  // прогноз по текущей сети БД (всегда доступен, без создания симуляции)
  const model = fromDb(db, {});
  const pipe = model.pipe(req.params.id);
  if (!pipe) return res.status(404).json({ error: 'Участок не найден' });
  const loopNote = !pipe.isValid
    ? 'Участок является петлёй или не имеет узлов (ошибка исходных данных) — топология через него не определяется.'
    : '';
  const impact = require('../sim/impact').analyzeImpact(model, [{ pipe, params: new (require('../sim/failure').FailureParams)({ affectedPipeId: pipe.id }) }]);
  const criticality = require('../sim/criticality').computeCriticality(impact, model.config);
  const pl = (impact.pipeLoads || {})[pipe.id] || {};
  res.json({
    pipe: {
      id: pipe.id, name: pipe.name, diameterMm: pipe.diameterMm || pl.diameterMm, lengthM: pipe.lengthM,
      loadGcalH: pl.loadGcalH || 0, flowKgS: pl.flowKgS || 0, diameterEstimated: !!pl.diameterEstimated
    },
    forecast: impact.stats,
    criticality,
    hasReserve: impact.reserveRoutes.length > 0,
    reserveRoutes: impact.reserveRoutes.slice(0, 5).map(r => ({ nodeId: r.nodeId, lengthM: r.route.lengthM })),
    topAffected: impact.buildings.filter(b => b.status !== 'NORMAL' && b.status !== 'UNKNOWN').slice(0, 10).map(b => ({ id: b.id, address: b.address, status: b.status, lostLoadGcalH: b.lostLoadGcalH })),
    type: impact.type,
    fragmented: impact.fragmented,
    hydraulic: impact.hydraulic,
    limitationMessage: (loopNote + ' ' + (impact.limitationMessage || '')).trim()
  });
}));

router.post('/import', upload.single('file'), wrap((req, res) => {
  const bodyText = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.data);
  if (!bodyText) return res.status(400).json({ error: 'Передайте файл (field "file") или data' });
  const kind = req.body.kind || (req.file ? (req.file.originalname.endsWith('.csv') ? 'csv' : 'json') : 'json');
  const model = importData(bodyText, { kind });
  const validation = validateNetwork(model);
  const rec = engine.createSimulation({ source: 'json', data: model, label: 'Импорт: ' + (req.body.label || '') });
  res.json({ imported: model.stats(), validation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings }, simulationId: rec.id });
}));

module.exports = router;