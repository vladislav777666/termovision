'use strict';

// Модель отказов: типы аварий, severity, влияние на граф и параметры.

const FailureType = Object.freeze({
  RUPTURE: 'rupture',          // разрыв трубы — полная изоляция участка
  LEAK: 'leak',                // утечка — изоляция + частичное сохранение подачи
  PLANNED: 'planned',          // плановое отключение — изоляция участка
  FULL_SHUTOFF: 'full_shutoff',// полное перекрытие — изоляция участка
  PARTIAL_DAMAGE: 'partial_damage' // частичное повреждение — участок работает с ограничением
});

const FAILURE_LABELS = {
  [FailureType.RUPTURE]: 'Разрыв трубопровода',
  [FailureType.LEAK]: 'Утечка',
  [FailureType.PLANNED]: 'Плановое отключение',
  [FailureType.FULL_SHUTOFF]: 'Полное перекрытие',
  [FailureType.PARTIAL_DAMAGE]: 'Частичное повреждение'
};

// severity 0..4: 0 — норма, 1 — небольшое нарушение, 2 — частичное, 3 — существенное, 4 — полное отключение
const SEVERITY_LABELS = ['Норма', 'Небольшое нарушение', 'Частичное ограничение', 'Существенное снижение', 'Полное отключение'];

const failureConfig = Object.freeze({
  [FailureType.RUPTURE]: { isolates: true, capacityFactor: 0, severityDefault: 4 },
  [FailureType.LEAK]: { isolates: true, capacityFactor: 0, severityDefault: 3 },
  [FailureType.PLANNED]: { isolates: true, capacityFactor: 0, severityDefault: 2 },
  [FailureType.FULL_SHUTOFF]: { isolates: true, capacityFactor: 0, severityDefault: 4 },
  [FailureType.PARTIAL_DAMAGE]: { isolates: false, capacityFactor: 0.55, severityDefault: 2 }
});

// Параметры аварии с проверкой диапазонов.
class FailureParams {
  constructor(raw = {}) {
    this.affectedPipeId = raw.affectedPipeId ?? raw.pipeId ?? '';
    this.type = raw.type || FailureType.RUPTURE;
    this.severity = Math.max(0, Math.min(4, +(raw.severity ?? failureConfig[this.type].severityDefault) || 0));
    this.leakRate = raw.leakRate != null ? +raw.leakRate : null; // кг/с (потеря расхода при утечке)
    this.duration = raw.duration != null ? +raw.duration : null; // мин (длительность аварии, если задана)
    this.repairTime = raw.repairTime != null ? +raw.repairTime : null; // мин (явное время ремонта, иначе считается моделью)
    this.pressureLoss = raw.pressureLoss != null ? +raw.pressureLoss : null; // бар (падение давления в зоне)
    this.temperatureLoss = raw.temperatureLoss != null ? +raw.temperatureLoss : null; // °C (снижение температуры подачи)
  }

  get config() { return failureConfig[this.type] || failureConfig[FailureType.RUPTURE]; }
  get isolates() { return this.config.isolates; }
  get capacityFactor() { return this.config.capacityFactor; }
  get label() { return FAILURE_LABELS[this.type] || this.type; }
  get severityLabel() { return SEVERITY_LABELS[this.severity] || String(this.severity); }
}

module.exports = { FailureType, FAILURE_LABELS, SEVERITY_LABELS, failureConfig, FailureParams };