'use strict';

// Доменная модель теплосети: узлы, трубопроводы, здания, источники.
// Сеть строится из внешнего источника (SQLite-БД платформы или JSON/CSV-импорта).
// Отсутствующие физические параметры помечаются dataQuality='UNKNOWN' и НЕ выдумываются.
// Значения по умолчанию для физического расчёта живут отдельно в config (см. defaultConfig).

const NodeType = Object.freeze({
  SOURCE: 'SOURCE',
  HEAT_CHAMBER: 'HEAT_CHAMBER',
  JUNCTION: 'JUNCTION',
  BUILDING: 'BUILDING',
  CONSUMER: 'CONSUMER',
  UNKNOWN: 'UNKNOWN'
});

const PipeStatus = Object.freeze({
  NORMAL: 'NORMAL',
  DEGRADING: 'DEGRADING',
  ISOLATED: 'ISOLATED',
  FAILED: 'FAILED',
  RECOVERING: 'RECOVERING'
});

const BuildingStatus = Object.freeze({
  NORMAL: 'NORMAL',
  DEGRADING: 'DEGRADING',
  PARTIAL: 'PARTIAL',
  ISOLATED: 'ISOLATED',
  NO_HEAT: 'NO_HEAT',
  RESERVE_SUPPLY: 'RESERVE_SUPPLY',
  RECOVERING: 'RECOVERING',
  UNKNOWN: 'UNKNOWN'
});

const DataQuality = Object.freeze({ OK: 'OK', UNKNOWN: 'UNKNOWN' });

function normalizeType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (/(источник|source|тэц|тэс|бмк|рк|котельн)/.test(t)) return NodeType.SOURCE;
  if (/(камера|chamber|тепл[а-я]* камер|tk\b|тк\b)/.test(t) || /^tk\d|-?\d{2}-\d{2}/i.test(t)) return NodeType.HEAT_CHAMBER;
  if (/(узел|узел|узл|junction)/.test(t)) return NodeType.JUNCTION;
  if (/(дом|building|жил)/.test(t)) return NodeType.BUILDING;
  if (/(потреб|consumer|абонент)/.test(t)) return NodeType.CONSUMER;
  if (/(дрен|задвиж|вент|возд)/.test(t)) return NodeType.JUNCTION;
  return NodeType.UNKNOWN;
}

const defaultConfig = Object.freeze({
  supplyTempC: 95,          // температура подачи, °C (демо-конфигурация сети)
  returnTempC: 70,          // температура обратки, °C
  maxVelocityMps: 1.5,      // предельная скорость теплоносителя, м/с
  designVelocityMps: 1.0,   // скорость для расчётного диаметра участков без паспортных данных
  frictionFactor: 0.025,    // коэффициент трения (упрощённая модель)
  ambientTempC: -20,        // наружная температура, °C
  detectionMinutes: 5,
  valveCloseMinutesPerValve: 3,
  valvesPerPipeSide: 1,
  pressureLossMin: 0.5,     // мин. перепад давления на участке, бар
  feedPressureBar: 8.0,     // расчётное давление на подающем коллекторе источника, бар
  minPressureBar: 1.5,      // минимально допустимое давление на вводе в здание, бар
  reserveFlowFactor: 0.8,   // допустимая загрузка резервного маршрута от расчётной
  thermalInertiaK: 0.55,    // коэффициент тепловой инерции зданий (0..1), выше — медленнее остывание
  criticalityThresholds: { low: 20, medium: 40, high: 70 }, // score -> LOW/MEDIUM/HIGH/CRITICAL
  impactScoreThresholds: { normal: 20, low: 50, partial: 80 }, // 0..100
  repair: {
    accessMinutes: 40,          // подготовка места работ
    weldingMinutesPerMeter: 1.2,
    drainFillMinutesPerMeter: 0.8,
    pressurizeMinutes: 30,
    complexityFactorByType: { rupture: 1.25, leak: 1.0, planned: 0.7, full_shutoff: 1.0, partial_damage: 1.1 }
  }
});

class NetworkNode {
  constructor(raw = {}, source = 'import') {
    this.id = String(raw.id ?? '');
    this.name = String(raw.name ?? raw.id ?? '');
    const rt = String(raw.type || '').toUpperCase();
    this.type = Object.values(NodeType).includes(rt) ? rt : normalizeType(raw.type);
    this.lat = Number.isFinite(+raw.lat) ? +raw.lat : null;
    this.lon = Number.isFinite(+raw.lon) ? +raw.lon : null;
    this.status = raw.status || 'NORMAL';
    this.source = source;
    this.dataQuality = (this.lat != null && this.lon != null) ? DataQuality.OK : DataQuality.UNKNOWN;
  }
}

class NetworkPipe {
  constructor(raw = {}, source = 'import') {
    const num = v => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
    this.id = String(raw.id ?? '');
    this.name = String(raw.name ?? raw.id ?? '');
    this.startNodeId = String(raw.startNodeId ?? raw.from_node_id ?? raw.start ?? '');
    this.endNodeId = String(raw.endNodeId ?? raw.to_node_id ?? raw.end ?? '');
    this.diameterMm = num(raw.diameterMm ?? raw.diameter_mm ?? raw.diameter);
    this.lengthM = num(raw.lengthM ?? raw.length_m ?? raw.length);
    this.material = raw.material || null;
    this.year = Number.isFinite(+raw.year) ? +raw.year : null;
    this.flowKgS = Number.isFinite(+raw.flowKgS ?? +raw.flow) ? +((raw.flowKgS ?? raw.flow)) : null;
    this.maxFlowKgS = Number.isFinite(+raw.maxFlowKgS ?? +raw.max_flow) ? +((raw.maxFlowKgS ?? raw.max_flow)) : null;
    this.pressureBar = Number.isFinite(+raw.pressureBar ?? +raw.pressure) ? +((raw.pressureBar ?? raw.pressure)) : null;
    this.tempSupplyC = Number.isFinite(+raw.tempSupplyC ?? +raw.temp_supply) ? +((raw.tempSupplyC ?? raw.temp_supply)) : null;
    this.tempReturnC = Number.isFinite(+raw.tempReturnC ?? +raw.temp_return) ? +((raw.tempReturnC ?? raw.temp_return)) : null;
    this.status = raw.status || PipeStatus.NORMAL;
    this.source = source;
    this.dataQuality = (this.diameterMm != null && this.lengthM != null) ? DataQuality.OK : DataQuality.UNKNOWN;
  }

  get isValid() {
    return !!this.id && !!this.startNodeId && !!this.endNodeId && this.startNodeId !== this.endNodeId;
  }
}

class NetworkBuilding {
  constructor(raw = {}, source = 'import') {
    this.id = String(raw.id ?? '');
    this.street = raw.street || '';
    this.house = raw.house || '';
    this.address = raw.address || ([raw.street, raw.house].filter(Boolean).join(' ') || raw.id);
    this.connectedNodeId = String(raw.connectedNodeId ?? raw.node_id ?? raw.tk_node ?? '');
    this.tk = raw.tk || '';
    this.heatLoadGcalH = Number.isFinite(+raw.heatLoadGcalH ?? +raw.heatLoad ?? +raw.load) ? +((raw.heatLoadGcalH ?? raw.heatLoad ?? raw.load)) : null;
    this.areaM2 = Number.isFinite(+raw.areaM2 ?? +raw.area) ? +((raw.areaM2 ?? raw.area)) : null;
    this.apartments = Number.isFinite(+raw.apartments ?? +raw.flats) ? +((raw.apartments ?? raw.flats)) : null;
    this.floors = Number.isFinite(+raw.floors) ? +raw.floors : null;
    this.year = Number.isFinite(+raw.year) ? +raw.year : null;
    this.owner = raw.owner || null;
    this.status = raw.status || BuildingStatus.NORMAL;
    this.source = source;
    this.dataQuality = (this.connectedNodeId && this.heatLoadGcalH != null) ? DataQuality.OK : DataQuality.UNKNOWN;
  }
}

class NetworkModel {
  constructor({ nodes = [], pipes = [], buildings = [], config = {} } = {}) {
    this.nodes = nodes;
    this.pipes = pipes;
    this.buildings = buildings;
    this.config = { ...defaultConfig, ...config };
    this.sources = nodes.filter(n => n.type === NodeType.SOURCE);
  }

  node(id) { return this.nodes.find(n => n.id === id) || null; }
  pipe(id) { return this.pipes.find(p => p.id === id) || null; }
  building(id) { return this.buildings.find(b => b.id === id) || null; }

  pipesAt(nodeId) {
    return this.pipes.filter(p => p.startNodeId === nodeId || p.endNodeId === nodeId);
  }

  buildingsAt(nodeId) {
    return this.buildings.filter(b => b.connectedNodeId === nodeId);
  }

  buildingsOf(pipeId) {
    const p = this.pipe(pipeId);
    if (!p) return [];
    return this.buildings.filter(b => b.connectedNodeId === p.startNodeId || b.connectedNodeId === p.endNodeId);
  }

  stats() {
    return {
      nodes: this.nodes.length,
      pipes: this.pipes.length,
      buildings: this.buildings.length,
      sources: this.sources.length,
      buildingsLinked: this.buildings.filter(b => b.connectedNodeId).length
    };
  }
}

// ---- загрузка из БД платформы ----
function fromDb(db, config = {}) {
  const nodes = db.prepare('SELECT * FROM nodes').all().map(r => new NetworkNode({
    id: r.id, name: r.name, type: r.type, lat: r.lat, lon: r.lon, status: 'NORMAL', source: r.folder || 'db'
  }));
  const pipes = db.prepare('SELECT * FROM pipes').all().map(r => {
    let coordinates = [];
    try { coordinates = r.coordinates ? JSON.parse(r.coordinates) : []; } catch (e) {}
    let len = r.length_m;
    if (len == null && coordinates.length >= 2) {
      let s = 0;
      for (let i = 0; i < coordinates.length - 1; i++) {
        const dx = (coordinates[i][0] - coordinates[i + 1][0]) * 111.32 * 1000;
        const dy = (coordinates[i][1] - coordinates[i + 1][1]) * 111.0 * 1000;
        s += Math.sqrt(dx * dx + dy * dy);
      }
      len = Math.round(s);
    }
    return new NetworkPipe({
      id: r.id, name: r.name, startNodeId: r.from_node_id, endNodeId: r.to_node_id,
      diameterMm: r.diameter_mm, lengthM: len, material: r.material || r.meta || null, source: r.folder || 'db'
    });
  });
  const buildings = db.prepare('SELECT * FROM houses').all().map(r => new NetworkBuilding({
    id: r.id, street: r.street, house: r.house, tk: r.tk, connectedNodeId: r.node_id,
    heatLoadGcalH: r.load, areaM2: r.area, flats: r.flats, floors: r.floors, year: r.year, owner: r.owner, source: 'db'
  }));
  return new NetworkModel({ nodes, pipes, buildings, config });
}

// ---- загрузка из JSON ----
function fromJson(data, config = {}) {
  const nodes = (data.nodes || []).map(r => new NetworkNode(r));
  const pipes = (data.pipes || []).map(r => new NetworkPipe(r));
  const buildings = (data.buildings || []).map(r => new NetworkBuilding(r));
  return new NetworkModel({ nodes, pipes, buildings, config });
}

module.exports = {
  NodeType, PipeStatus, BuildingStatus, DataQuality, defaultConfig,
  NetworkNode, NetworkPipe, NetworkBuilding, NetworkModel,
  normalizeType, fromDb, fromJson
};