'use strict';

// Временная динамика аварии. Времена фаз ВЫЧИСЛЯЮТСЯ моделью из параметров участка,
// типа аварии и конфигурации — а не фиксированы заранее.
//
// Фазы: DETECTED -> SIGNALED -> ISOLATED -> ZONE_FORMED -> DEGRADATION (по тепловой
// инерции зданий) -> STABILIZED -> REPAIR -> FILLED -> PRESSURIZED -> NORMALIZED.

const { FailureType } = require('./failure');

// Оценка времени ремонта, мин (см. spec §30):
// базовое время из диаметра, длины, типа аварии, сложности доступа.
function estimateRepairMinutes(pipe, failureParams, config) {
  const cfg = config.repair || {};
  const complexity = cfg.complexityFactorByType[failureParams.type] || 1.0;
  const lengthM = pipe.lengthM || 10;
  const d = pipe.diameterMm || 100;

  let base = cfg.accessMinutes || 40;
  base += lengthM * (cfg.weldingMinutesPerMeter || 1.2);       // сварочные работы
  base += lengthM * (cfg.drainFillMinutesPerMeter || 0.8);     // слив/заполнение
  base += (cfg.pressurizeMinutes || 30);                       // опрессовка
  // диаметр: крупные трубы дольше
  base *= (0.8 + d / 500);
  base *= complexity;
  // утечка с большим расходом — сложнее найти точку повреждения
  if (failureParams.type === FailureType.LEAK) base *= 1.2;
  return Math.round(base);
}

// Построение таймлайна. Возвращает массив фаз { tMin, phase, label, description }.
function buildTimeline(model, failureParams, impact) {
  const cfg = model.config;
  const pipe = model.pipe(failureParams.affectedPipeId);
  const st = impact.stats;

  const tDetect = cfg.detectionMinutes || 5;
  const tValves = (cfg.valvesPerPipeSide || 1) * (cfg.valveCloseMinutesPerValve || 3);
  const tZone = 10;
  const tDegrade = Math.round(30 * (1 + (cfg.thermalInertiaK || 0.55))); // тепловая инерция зданий
  const tStabilize = Math.round(tDegrade * 0.6);
  const repair = failureParams.repairTime != null
    ? failureParams.repairTime
    : estimateRepairMinutes(pipe || {}, failureParams, cfg);
  const tFill = Math.round((pipe && pipe.lengthM ? pipe.lengthM : 10) * 0.8);
  const tPressure = cfg.repair.pressurizeMinutes || 30;
  const tRecover = 20;

  let t = 0;
  const phases = [];
  const add = (phase, label, description, delta) => {
    t += delta;
    phases.push({ tMin: t, phase, label, description });
  };

  add('DETECTED', 'Обнаружено повреждение',
    `Участок "${pipe ? pipe.name || pipe.id : failureParams.affectedPipeId}" работает нестабильно: падение давления, рост расхода через повреждённый участок, фиксация аномалии.`,
    tDetect);
  add('SIGNALED', 'Диспетчер получил сигнал аварии',
    'Автоматически определены аварийный участок, ближайшие тепловые камеры и потенциальная зона воздействия.',
    tValves);
  add('ISOLATED', 'Участок изолирован',
    failureParams.isolates
      ? 'Запорная арматура закрыта, граф сети пересчитан, зона отключения определена.'
      : 'Изоляция не требуется: авария частичная, участок продолжает работать с ограничением.',
    tValves);
  add('ZONE_FORMED', 'Сформирована зона отключения',
    `Топологически отключено: ${st.affectedBuildings} зданий, ${st.affectedChambers} камер. ${impact.reserveRoutes.length ? `Резервное питание возможно для ${impact.reserveRoutes.length} узлов.` : 'Резервных маршрутов нет.'}`,
    tZone);
  if (st.noHeatBuildings > 0) {
    add('DEGRADATION', 'Начало деградации теплоснабжения',
      `${st.noHeatBuildings} зданий теряют доступную тепловую мощность (тепловая инерция зданий ${Math.round(cfg.thermalInertiaK * 100)}%).`,
      tDegrade);
  } else if (st.partialBuildings > 0) {
    add('DEGRADATION', 'Частичное снижение подачи',
      `${st.partialBuildings} зданий переходят в режим PARTIAL.`,
      Math.round(tDegrade * 0.5));
  }
  add('STABILIZED', 'Стабилизация режима',
    'Параметры сети в затронутой зоне стабилизированы, отключённые потребители учтены.',
    tStabilize);
  add('REPAIR', 'Ремонт участка',
    `Ремонт участка "${pipe ? pipe.name || pipe.id : ''}" (диаметр ${pipe && pipe.diameterMm ? pipe.diameterMm + ' мм' : 'н/д'}, длина ${pipe && pipe.lengthM ? pipe.lengthM + ' м' : 'н/д'}).`,
    repair);
  add('FILLED', 'Заполнение трубопровода',
    'Участок заполнен теплоносителем, воздух удалён.',
    tFill);
  add('PRESSURIZED', 'Повышение давления',
    'Постепенное повышение давления до рабочего, контроль температуры и расхода.',
    tPressure);
  add('NORMALIZED', 'Сеть нормализована',
    `Здания возвращены в штатный режим (${st.affectedBuildings} зданий восстановлено).`,
    tRecover);

  return {
    phases,
    estimatedRepairMinutes: repair,
    totalMinutes: t,
    formatTotal: () => {
      const h = Math.floor(t / 60), m = t % 60;
      return h ? `${h} ч ${m} мин` : `${m} мин`;
    }
  };
}

module.exports = { buildTimeline, estimateRepairMinutes };