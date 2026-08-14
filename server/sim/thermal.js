'use strict';

// Тепловой расчёт: Q = G * Cp * ΔT.
// Все мощности внутри движка — кВт; наружу (API/UI) отдаём в Гкал/ч через units.js.

const { massFlowToKw, gcalPerHourToKw, kwToMassFlow } = require('./units');

// Расчётный массовый расход здания, кг/с
function buildingDemandKgS(building, config) {
  if (building.heatLoadGcalH == null) return null;
  const dT = dTDesign(config);
  return kwToMassFlow(gcalPerHourToKw(building.heatLoadGcalH), dT);
}

// Располагаемая тепловая мощность здания при доступном расходе, кВт
function availableLoadKw(flowKgS, config) {
  if (flowKgS == null) return null;
  return massFlowToKw(flowKgS, dTDesign(config));
}

function dTDesign(config) {
  return (config.supplyTempC || 95) - (config.returnTempC || 70);
}

// Статус здания по доступной доле расчётной мощности (0..1).
// 1 -> NORMAL, >0.5 -> PARTIAL, >0 -> PARTIAL(низкое), 0 -> NO_HEAT.
function statusFromFraction(frac, { reserve = false } = {}) {
  if (frac == null) return 'UNKNOWN';
  if (frac >= 0.999) return reserve ? 'RESERVE_SUPPLY' : 'NORMAL';
  if (frac > 0) return 'PARTIAL';
  return 'NO_HEAT';
}

module.exports = {
  buildingDemandKgS,
  availableLoadKw,
  dTDesign,
  statusFromFraction,
  buildingDemandGcalH: b => b.heatLoadGcalH
};