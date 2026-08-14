'use strict';

// Упрощённая гидравлическая модель (явно НЕ заменяет инженерный гидравлический расчёт).
//
// Допущения (конфигурируемы):
//   - постоянный коэффициент трения λ (frictionFactor), без зависимости от Re/шероховатости;
//   - потеря давления по Дарси-Вейсбаху: ΔP = λ * (L/D) * (ρ*v²/2), v = G/(ρ*A);
//   - предельный расход по предельной скорости v_max (гидравлическая способность участка).
// При отсутствии диаметра/длины расчёт недоступен (возвращает null), и система
// помечает результат как TOPOLOGICAL_ONLY.

const { waterDensity } = require('./units');

// Гидравлическое сопротивление участка, Па·с²/кг²: ΔP[Па] = R * G²[кг/с]²
// Дарси-Вейсбах: ΔP = λ*(L/D)*ρ*v²/2, v = G/(ρ*A)  =>  R = λ*(L/D)/(2*ρ*A²)
function resistance(pipe, config) {
  if (pipe.diameterMm == null || pipe.lengthM == null) return null;
  const D = pipe.diameterMm / 1000;
  const L = pipe.lengthM;
  const lam = (config && config.frictionFactor) || 0.025;
  const A = Math.PI * D * D / 4;
  return lam * (L / D) / (2 * waterDensity() * A * A);
}

// Предельный расход по скорости, кг/с
function maxFlowByVelocity(pipe, config) {
  if (pipe.diameterMm == null) return null;
  const D = pipe.diameterMm / 1000;
  const A = Math.PI * D * D / 4;
  const vMax = (config && config.maxVelocityMps) || 1.5;
  return vMax * A * waterDensity();
}

// Потеря давления на участке, бар
function pressureDrop(pipe, flowKgS, config) {
  const R = resistance(pipe, config);
  if (R == null || flowKgS == null) return null;
  return (R * flowKgS * flowKgS) / 1e5;
}

// Проверка достаточности способности участка для пропуска заданного расхода.
// Возвращает { ok, availableFlowKgS } — если не хватает, ограничиваем расход.
function flowCapacity(pipe, demandKgS, config) {
  const max = pipe.maxFlowKgS || maxFlowByVelocity(pipe, config);
  if (max == null) return { ok: true, availableFlowKgS: null, dataLimited: true };
  return { ok: demandKgS <= max, availableFlowKgS: max, dataLimited: false };
}

// Суммарная доступная пропускная способность пути (минимум по участкам пути).
function pathCapacity(pipeIds, model, config) {
  let cap = Infinity;
  for (const id of pipeIds) {
    const p = model.pipe(id);
    if (!p) continue;
    const m = maxFlowByVelocity(p, config);
    if (m == null) continue; // нет данных — не ограничиваем
    cap = Math.min(cap, m);
  }
  return Number.isFinite(cap) ? cap : null;
}

// Расчётный диаметр по расходу и предельной скорости (для участков без паспортных
// данных; результат помечается как estimated). Диаметр ступенчато округляется к
// ближайшему стандартному (мм), чтобы не имитировать несуществующую точность.
function estimateDiameter(flowKgS, config) {
  if (flowKgS == null || flowKgS <= 0) return null;
  const vDesign = (config && config.designVelocityMps) || 1.0;
  const D = Math.sqrt(4 * flowKgS / (vDesign * Math.PI * waterDensity()));
  const standard = [25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000];
  const mm = D * 1000;
  let chosen = standard[0];
  for (const s of standard) { chosen = s; if (s >= mm) break; }
  return chosen;
}

module.exports = { resistance, maxFlowByVelocity, pressureDrop, flowCapacity, pathCapacity, estimateDiameter };