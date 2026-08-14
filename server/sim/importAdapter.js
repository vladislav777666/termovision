'use strict';

// Адаптер импорта реальных данных: JSON / CSV -> единая внутренняя модель.
// Отсутствующие параметры НЕ выдумываются: они остаются null и помечаются
// dataQuality='UNKNOWN' (см. networkModel). Значения по умолчанию для расчётов
// задаются отдельно в config и не смешиваются с исходными данными.
//
// Excel: файл .xlsx конвертируйте в CSV (импорт через multer text/upload),
// либо передавайте JSON — структура описана в README.

const { fromJson } = require('./networkModel');

function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('CSV пуст');
  // поддержка многотабличного CSV: строка-заголовок содержит ключевое слово kind
  let header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (cells[0] === 'kind' || cells[0] === 'Kind' || cells[0] === 'KIND') { header = cells; continue; }
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

const num = v => { const n = +v; return Number.isFinite(n) && v !== '' ? n : null; };

function importData(raw, { kind = 'json' } = {}) {
  let data;
  if (kind === 'json') {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } else if (kind === 'csv') {
    const rows = parseCsv(raw);
    data = { nodes: [], pipes: [], buildings: [] };
    for (const r of rows) {
      if (r.kind === 'node' || r.type === 'node' || r.id?.startsWith?.('N')) {
        data.nodes.push({ id: r.id, name: r.name, type: r.type, lat: num(r.lat), lon: num(r.lon) });
      } else if (r.kind === 'pipe' || r.type === 'pipe' || r.id?.startsWith?.('P')) {
        data.pipes.push({
          id: r.id, name: r.name, startNodeId: r.startNodeId || r.start, endNodeId: r.endNodeId || r.end,
          diameterMm: num(r.diameterMm ?? r.diameter_mm ?? r.diameter),
          lengthM: num(r.lengthM ?? r.length_m ?? r.length),
          material: r.material || null
        });
      } else if (r.kind === 'building' || r.type === 'building' || r.id?.startsWith?.('B')) {
        data.buildings.push({
          id: r.id, address: r.address, street: r.street, house: r.house,
          connectedNodeId: r.connectedNodeId || r.node_id, tk: r.tk,
          heatLoadGcalH: num(r.heatLoadGcalH ?? r.heatLoad ?? r.load),
          areaM2: num(r.areaM2 ?? r.area), apartments: num(r.apartments ?? r.flats), floors: num(r.floors)
        });
      }
    }
  } else {
    throw new Error('Неизвестный формат импорта: ' + kind);
  }
  const model = fromJson(data, {});
  if (!model.nodes.length && !model.pipes.length && !model.buildings.length) {
    throw new Error('Импорт не содержит данных (nodes/pipes/buildings)');
  }
  return model;
}

module.exports = { importData, parseCsv };