'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { demoModel } = require('../sim/demo');
const { SimulationEngine } = require('../sim/simulation');
const { validateNetwork } = require('../sim/validator');
const { FailureType, FailureParams } = require('../sim/failure');
const { analyzeImpact } = require('../sim/impact');
const units = require('../sim/units');
const { importData } = require('../sim/importAdapter');
const { fromJson } = require('../sim/networkModel');

// ---------- юнит-тесты: единицы измерения ----------
test('units: Гкал/ч <-> кВт <-> кг/с согласованы', () => {
  const kw = units.gcalPerHourToKw(1);
  assert.equal(kw, 1163);
  assert.equal(units.kwToGcalPerHour(kw), 1);
  const g = units.kwToMassFlow(1163, 25); // 1 Гкал/ч при ΔT=25
  assert.ok(g > 10 && g < 12, 'расход ~11.1 кг/с, получено ' + g);
  assert.equal(units.massFlowToKw(g, 25), 1163);
});

// ---------- демо-сеть ----------
function freshEngine() {
  const engine = new SimulationEngine({});
  return engine.createSimulation({ source: 'json', data: demoModel() });
}

test('demo: сеть проходит валидацию', () => {
  const m = demoModel();
  const v = validateNetwork(m);
  assert.ok(v.valid, JSON.stringify(v.errors));
  assert.ok(m.sources.length === 1);
  assert.ok(m.pipes.length >= 20);
  assert.ok(m.buildings.length >= 15);
});

test('demo: в графе есть цикл (резервный маршрут)', () => {
  const m = demoModel();
  const v = validateNetwork(m);
  assert.ok(v.info.some(i => i.code === 'CYCLES_PRESENT'), 'должно быть кольцо');
});

// ---------- сценарий 1: авария на магистральной трубе ----------
test('scenario 1: rupture на магистрали N1-N2 отключает все downstream-здания', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const res = eng.failPipe(s.id, { affectedPipeId: 'P02', type: FailureType.RUPTURE, severity: 4 });

  const st = res.impact.stats;
  // живыми остаются только здания ветки от N1 (B01..B05): 28 - 5 = 23
  assert.equal(st.affectedBuildings, 23, 'после отключения N1-N2 тепла лишаются все здания ниже по сети, получено ' + st.affectedBuildings);
  assert.equal(st.noHeatBuildings, 23, 'резервного кольца для стороны N2 нет');
  const expectedLoad = demoModel().buildings
    .filter(b => !['N1', 'N9', 'N10', 'N11'].includes(b.connectedNodeId))
    .reduce((s, b) => s + b.heatLoadGcalH, 0);
  assert.ok(Math.abs(st.totalLostLoadGcalH - expectedLoad) < 0.001,
    'потерянная нагрузка = сумме отключённых, получено ' + st.totalLostLoadGcalH + ' ожидалось ' + expectedLoad);
  assert.ok(res.criticality.score > 40, 'магистральная авария — высокая критичность');
});

// ---------- сценарий 2: авария на тупиковой ветке ----------
test('scenario 2: rupture на тупике N5-N6 затрагивает только здания ветки', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const res = eng.failPipe(s.id, { affectedPipeId: 'P09', type: FailureType.RUPTURE, severity: 4 });
  const st = res.impact.stats;
  // дома B08, B09 подключены к N6 (тупик), остальные сохраняют питание
  assert.equal(st.affectedBuildings, 2);
  assert.equal(st.noHeatBuildings, 2);
  const lost = st.totalLostLoadGcalH;
  assert.ok(Math.abs(lost - (0.25 + 0.22)) < 0.001, 'потеря = нагрузка B08+B09');
});

// ---------- сценарий 3: труба с резервным питанием ----------
test('scenario 3: rupture N3-N4 — здания N4-стороны получают тепло по кольцу', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const res = eng.failPipe(s.id, { affectedPipeId: 'P04', type: FailureType.RUPTURE, severity: 4 });
  const st = res.impact.stats;
  // N4, N5, N6, N8, N7 достижимы через кольцо N2-N12-N7
  const onReserve = res.impact.buildings.filter(b => b.status === 'RESERVE_SUPPLY' || (b.status === 'PARTIAL' && /резерв/i.test(b.reason || '')));
  assert.ok(onReserve.length >= 4, 'часть зданий должна получать тепло по резервной схеме, получено ' + onReserve.length);
  assert.equal(st.noHeatBuildings, 0, 'при наличии кольца никто не должен полностью отключаться');
  assert.ok(res.impact.reserveRoutes.length >= 1, 'система нашла резервные маршруты');
  const b14 = res.impact.buildings.find(b => b.id === 'B14');
  assert.ok(b14, 'B14 существует');
  assert.ok(/резерв/i.test(b14.reason || ''), 'B14 питается по резервной схеме, статус ' + b14.status + ': ' + b14.reason);
  // N4-сторона без основного маршрута: N4, N5, N6, N14, N17 (N8 остаётся на живом пути через N7)
  const expectedAffected = ['N4', 'N5', 'N6', 'N14', 'N17']
    .reduce((cnt, nodeId) => cnt + demoModel().buildings.filter(b => b.connectedNodeId === nodeId).length, 0);
  assert.equal(st.affectedBuildings, expectedAffected);
});

// ---------- сценарий 4: частичная утечка ----------
test('scenario 4: partial damage — здания остаются подключены, но PARTIAL', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const res = eng.failPipe(s.id, { affectedPipeId: 'P02', type: FailureType.PARTIAL_DAMAGE, severity: 2 });
  const st = res.impact.stats;
  assert.equal(st.noHeatBuildings, 0, 'частичное повреждение не отключает здания');
  assert.ok(st.partialBuildings > 0, 'есть здания в PARTIAL');
  assert.ok(st.totalLostLoadGcalH > 0);
  assert.equal(res.impact.type, 'PHYSICAL_SIMULATION', 'с полными данными доступен физический расчёт');
});

// ---------- сценарий 5: одновременная авария двух участков ----------
test('scenario 5: одновременный отказ P02 и P10 — комбинированное воздействие', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const res1 = eng.failPipe(s.id, { affectedPipeId: 'P02', type: FailureType.RUPTURE, severity: 4 });
  const res2 = eng.failPipe(s.id, { affectedPipeId: 'P10', type: FailureType.RUPTURE, severity: 4 });
  const st = res2.impact.stats;
  assert.equal(res2.failedElements.length, 2, 'обе аварии активны');
  assert.equal(st.affectedBuildings, res1.impact.stats.affectedBuildings, 'P10 уже в отключённой зоне — состав не меняется');
  assert.ok(st.totalLostLoadGcalH >= res1.impact.stats.totalLostLoadGcalH);
});

// ---------- валидатор ----------
test('validator: находит петли, висячие трубы, отсутствие источника', () => {
  const bad = fromJson({
    nodes: [{ id: 'N1', name: 'ТК 1', type: 'Камера', lat: 1, lon: 1 }],
    pipes: [
      { id: 'P1', name: 'петля', startNodeId: 'N1', endNodeId: 'N1', diameterMm: 100, lengthM: 10 },
      { id: 'P2', name: 'висячая', startNodeId: 'N1', endNodeId: 'NX', diameterMm: 100, lengthM: 10 }
    ],
    buildings: [{ id: 'B1', address: 'ул. X 1', connectedNodeId: 'N1', heatLoadGcalH: 0.1 }]
  });
  const v = validateNetwork(bad);
  assert.ok(v.warnings.some(e => e.code === 'PIPE_SELF_LOOP'));
  assert.ok(v.warnings.some(e => e.code === 'PIPE_DANGLING_END'));
  assert.ok(v.errors.some(e => e.code === 'NO_SOURCE'));
});

test('validator: реальная сеть БД не содержит ошибок, блокирующих симуляцию', () => {
  const db = require('../db');
  const { fromDb } = require('../sim/networkModel');
  const m = fromDb(db, {});
  const v = validateNetwork(m);
  // петли/висячие ссылки реального KML — предупреждения, они не блокируют расчёт
  assert.ok(v.errors.length === 0, JSON.stringify(v.errors));
  assert.ok(m.buildings.length > 4000, 'в БД должны быть реальные дома');
});

// ---------- импорт ----------
test('import: JSON и CSV дают одинаковую модель', () => {
  const json = {
    nodes: [{ id: 'S1', name: 'ТЭЦ', type: 'Источник', lat: 53.25, lon: 63.6 }, { id: 'N1', name: 'ТК 1', type: 'Камера', lat: 53.24, lon: 63.6 }],
    pipes: [{ id: 'P1', name: 'М-1', startNodeId: 'S1', endNodeId: 'N1', diameterMm: 400, lengthM: 100 }],
    buildings: [{ id: 'B1', address: 'ул. Ленина 1', connectedNodeId: 'N1', heatLoadGcalH: 0.3, flats: 120 }]
  };
  const m1 = importData(JSON.stringify(json), { kind: 'json' });
  const csv = `kind,id,name,type,lat,lon
node,S1,ТЭЦ,Источник,53.25,63.6
node,N1,ТК 1,Камера,53.24,63.6
kind,id,name,startNodeId,endNodeId,diameterMm,lengthM
pipe,P1,М-1,S1,N1,400,100
kind,id,address,connectedNodeId,heatLoadGcalH,flats
building,B1,ул. Ленина 1,N1,0.3,120`;
  const m2 = importData(csv, { kind: 'csv' });
  assert.equal(m1.nodes.length, m2.nodes.length);
  assert.equal(m1.pipes[0].diameterMm, m2.pipes[0].diameterMm);
  assert.equal(m1.buildings[0].heatLoadGcalH, m2.buildings[0].heatLoadGcalH);
  assert.equal(m2.pipes[0].dataQuality, 'OK');
});

// ---------- Engine: прогноз критичности до аварии ----------
test('criticality forecast: прогноз до аварии совпадает с расчётом после неё', () => {
  const eng = new SimulationEngine({});
  const s = eng.createSimulation({ source: 'json', data: demoModel() });
  const forecast = eng.criticalityForecast(s.id, 'P02');
  const after = eng.failPipe(s.id, { affectedPipeId: 'P02', type: FailureType.RUPTURE, severity: 4 });
  assert.equal(forecast.forecast.affectedBuildings, after.impact.stats.affectedBuildings);
  assert.ok(forecast.criticality.score > 0);
});

// ---------- реальные данные: ТК25-07-01 (N71) ----------
test('real: ТК25-07-01 — ровно 3 дома (Юбилейный 46/48/49), нагрузка и давление ТМ25', () => {
  const db = require('../db');
  const { fromDb } = require('../sim/networkModel');
  const m = fromDb(db, {});
  const houses = m.buildings.filter(b => b.connectedNodeId === 'N71');
  assert.equal(houses.length, 3, 'к ТК25-07-01 подключено 3 дома, получено ' + houses.length);
  const names = houses.map(h => h.house).sort();
  assert.deepEqual(names, ['46', '48', '49']);
  const totalLoad = +houses.reduce((s, h) => s + (h.heatLoadGcalH || 0), 0).toFixed(3);
  assert.ok(Math.abs(totalLoad - 0.903) < 0.001, 'суммарная нагрузка 0.903 Гкал/ч, получено ' + totalLoad);

  // нагрузка питающего участка ТМ25 (P88, N82→N71) = нагрузка ТК
  const impact = analyzeImpact(m, [{ pipe: m.pipe('P88'), params: new FailureParams({ affectedPipeId: 'P88' }) }]);
  const pl = impact.pipeLoads && impact.pipeLoads.P88;
  assert.ok(pl && Math.abs(pl.loadGcalH - totalLoad) < 0.05,
    'загрузка ТМ25 (P88) = нагрузка ТК ≈ ' + totalLoad + ', получено ' + (pl && pl.loadGcalH));
  assert.ok(pl.diameterEstimated, 'диаметр ТМ25 расчётный (паспортных данных нет)');
  assert.ok(impact.hydraulic && impact.hydraulic.minPressureBar > 0, 'гидравлический слой активен');

  // после аварии на питающем ТМ25 все 3 дома отключаются, давление на вводах отсутствует
  const eng = new SimulationEngine({ db });
  const s = eng.createSimulation({ source: 'db', label: 'ТК25-07-01' });
  const res = eng.failPipe(s.id, { affectedPipeId: 'P88', type: FailureType.RUPTURE, severity: 4 });
  const st = res.impact.stats;
  assert.equal(st.affectedBuildings, 3, 'авария ТМ25 отключает 3 дома, получено ' + st.affectedBuildings);
  assert.equal(st.noHeatBuildings, 3);
  assert.ok(Math.abs(st.totalLostLoadGcalH - totalLoad) < 0.05, 'потеря = нагрузка ТК, получено ' + st.totalLostLoadGcalH);
  const b46 = res.impact.buildings.find(b => b.house === '46' && b.connectedNodeId === 'N71');
  assert.ok(b46 && b46.status === 'NO_HEAT');
});