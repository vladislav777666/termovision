'use strict';

// Единая система единиц для расчётов.
// Базовые единицы внутри движка:
//   мощность    — кВт
//   массовый расход — кг/с
//   давление    — бар
//   температура — °C
//   длина       — м
//   диаметр     — мм
// Тепловая нагрузка зданий из исходных данных приходит в Гкал/ч — конвертируем явно.

const CP_WATER_KJ_PER_KG_K = 4.187;          // кДж/(кг·К)
const WATER_DENSITY_KG_M3 = 958;             // кг/м³ при ~100°C
const GCAL_PER_HOUR_TO_KW = 1163;            // 1 Гкал/ч = 1163 кВт

function gcalPerHourToKw(gcal) {
  if (gcal == null || Number.isNaN(+gcal)) return null;
  return +gcal * GCAL_PER_HOUR_TO_KW;
}

function kwToGcalPerHour(kw) {
  if (kw == null || Number.isNaN(+kw)) return null;
  return +kw / GCAL_PER_HOUR_TO_KW;
}

// Q = G * Cp * ΔT  =>  G(кг/с) = Q(кВт) / (Cp(кДж/кг·К) * ΔT(К))
function kwToMassFlow(kw, dT) {
  if (kw == null || !dT || dT <= 0) return null;
  return kw / (CP_WATER_KJ_PER_KG_K * dT);
}

function massFlowToKw(kgPerS, dT) {
  if (kgPerS == null || !dT || dT <= 0) return null;
  return kgPerS * CP_WATER_KJ_PER_KG_K * dT;
}

// Гкал/ч -> кг/с при заданном ΔT (удобно для нагрузок зданий)
function gcalPerHourToMassFlow(gcal, dT) {
  const kw = gcalPerHourToKw(gcal);
  return kw == null ? null : kwToMassFlow(kw, dT);
}

function massFlowToGcalPerHour(kgPerS, dT) {
  const kw = massFlowToKw(kgPerS, dT);
  return kw == null ? null : kwToGcalPerHour(kw);
}

function waterDensity() { return WATER_DENSITY_KG_M3; }
function cpWater() { return CP_WATER_KJ_PER_KG_K; }

module.exports = {
  CP_WATER_KJ_PER_KG_K,
  WATER_DENSITY_KG_M3,
  GCAL_PER_HOUR_TO_KW,
  gcalPerHourToKw,
  kwToGcalPerHour,
  kwToMassFlow,
  massFlowToKw,
  gcalPerHourToMassFlow,
  massFlowToGcalPerHour,
  waterDensity,
  cpWater
};