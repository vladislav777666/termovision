'use strict';

// Показатель критичности аварии (0..100) и управленческие рекомендации.
// Всё вычисляется из результатов расчёта, пороги конфигурируемы.

const defaultThresholds = { low: 20, medium: 40, high: 70 };

// score 0..100 -> LOW/MEDIUM/HIGH/CRITICAL
function levelFromScore(score, thresholds = defaultThresholds) {
  if (score <= thresholds.low) return 'LOW';
  if (score <= thresholds.medium) return 'MEDIUM';
  if (score <= thresholds.high) return 'HIGH';
  return 'CRITICAL';
}

function computeCriticality(impact, config = {}) {
  const t = config.criticalityThresholds || defaultThresholds;
  const st = impact.stats;
  const weights = {
    affectedBuildings: 20,   // до 20 баллов (5+ зданий = максимум)
    apartments: 15,          // до 15 баллов (300+ квартир)
    lostLoad: 20,            // до 20 баллов (1.5+ Гкал/ч)
    area: 10,                // до 10 баллов (15k+ м²)
    noReserve: 15,           // резерва нет и есть отключённые
    criticalConsumers: 10,   // 2+ крит. потребителя (категории в meta)
    chambers: 5,             // до 5 баллов (5+ камер)
    length: 5                // до 5 баллов (500+ м участка)
  };
  const w = { ...weights, ...(config.criticalityWeights || {}) };

  const score = Math.min(100, Math.round(
    Math.min(1, st.affectedBuildings / 5) * w.affectedBuildings +
    Math.min(1, st.totalAffectedApartments / 300) * w.apartments +
    Math.min(1, st.totalLostLoadGcalH / 1.5) * w.lostLoad +
    Math.min(1, st.totalAffectedAreaM2 / 15000) * w.area +
    (st.noHeatBuildings > 0 ? w.noReserve : 0) +
    Math.min(1, (st.affectedChambers || 0) / 5) * w.chambers +
    Math.min(1, (st.failedPipeLengthM || 0) / 500) * w.length
  ));

  return {
    score,
    level: levelFromScore(score, t),
    breakdown: {
      affectedBuildings: Math.min(1, st.affectedBuildings / 5) * w.affectedBuildings,
      apartments: Math.min(1, st.totalAffectedApartments / 300) * w.apartments,
      lostLoad: Math.min(1, st.totalLostLoadGcalH / 1.5) * w.lostLoad,
      area: Math.min(1, st.totalAffectedAreaM2 / 15000) * w.area,
      noReserve: (st.noHeatBuildings > 0 ? w.noReserve : 0),
      chambers: Math.min(1, (st.affectedChambers || 0) / 5) * w.chambers,
      length: Math.min(1, (st.failedPipeLengthM || 0) / 500) * w.length
    },
    thresholds: t
  };
}

// ---- рекомендации (генерируются из результатов, без хардкода) ----
function generateRecommendations(impact, criticality, failureParams, timeline, model) {
  const rec = [];
  const st = impact.stats;
  const failed = impact.failedPipes[0];

  if (failed) {
    const pipe = model.pipe(failed.id);
    const chambers = model.nodes.filter(n =>
      pipe && (n.id === pipe.startNodeId || n.id === pipe.endNodeId) && /камер|chamber/i.test(String(n.type)));
    if (chambers.length >= 2) {
      rec.push(`Аварийный участок "${failed.name || failed.id}" рекомендуется изолировать между ${chambers[0].name || chambers[0].id} и ${chambers[1].name || chambers[1].id}.`);
    } else if (chambers.length === 1) {
      rec.push(`Аварийный участок "${failed.name || failed.id}" рекомендуется изолировать у камеры ${chambers[0].name || chambers[0].id}.`);
    }
  }

  if (impact.reserveRoutes.length) {
    rec.push(`Для сохранения теплоснабжения ${impact.reserveRoutes.length} узлов рекомендуется использовать резервные перемычки (${impact.reserveRoutes.map(r => r.nodeId).slice(0, 3).join(', ')}).`);
  } else if (st.noHeatBuildings > 0) {
    rec.push(`Без резервного питания полностью отключаются ${st.noHeatBuildings} зданий.`);
  }

  if (impact.worstBuilding) {
    rec.push(`Наибольшая потеря нагрузки приходится на ${impact.worstBuilding.address || impact.worstBuilding.id} — ${impact.worstBuilding.lostLoadGcalH} Гкал/ч.`);
  }

  if (st.partialBuildings > 0) {
    rec.push(`${st.partialBuildings} зданий переведены в режим частичного ограничения (PARTIAL); контроль температуры теплоносителя обязателен.`);
  }

  const restore = timeline && timeline.length ? timeline[timeline.length - 1] : null;
  if (restore) {
    rec.push(`Ожидаемое восстановление основного теплоснабжения — ${restore.label} (T+${restore.tMin} мин).`);
  } else if (failed) {
    rec.push(`Ожидаемое восстановление основного теплоснабжения — после завершения ремонта участка "${failed.name || failed.id}" и заполнения трубопровода.`);
  }

  rec.push(`Степень критичности аварии: ${criticality.level} (${criticality.score}/100).`);
  return rec;
}

module.exports = { computeCriticality, generateRecommendations, levelFromScore, defaultThresholds };