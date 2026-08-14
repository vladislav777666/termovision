// Единый frontend диспетчерской карты КТЭК
// - полный паспорт узла (с привязанными домами) по клику
// - обычный поиск (подстрока символов)
// - виртуальная симуляция отключения с честной пометкой ограничений данных
// - редактор топологии: добавить/удалить/изменить узлы и участки

(function () {
  'use strict';

  // ---------- constants ----------
  const COLORS = {
    normal: '#22c55e',
    monitored: '#f59e0b',
    emergency: '#ef4444',
    repair: '#8b5cf6',
    data_missing: '#94a3b8',
    high_risk: '#f97316'
  };
  const TYPE_COLORS = {
    'Источник': '#7c3aed',
    'Камера': '#2563eb',
    'Узел': '#0f766e',
    'Дренаж': '#0ea5e9',
    'Воздушник': '#f59e0b',
    'Задвижка': '#dc2626'
  };

  // ---------- state ----------
  let map = null;
  const layers = { nodes: null, pipes: null, social: null, zone: null, demo: null, houses: null };
  const houseCoords = new Map(); // id -> [lat, lon] (для перекраски после аварии)
  const houseData = new Map();   // id -> исходные данные дома
  let currentNodeId = null;
  let simState = null; // результат аварии: { impact, criticality, timeline, pipeStates, houseStatuses }
  let selected = null; // {type:'node'|'pipe', id, name}
  let editorMode = null; // 'add-node'|'add-line'|'add-demo-node'|'add-deadend'|null
  let pendingLineFrom = null; // node id
  let demoSelection = [];
  const api = {
    get: p => fetch('/api/' + p).then(r => r.json()),
    post: (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json().catch(() => ({})))
  };
  const fmt = v => (v == null || v === '') ? '—' : v;
  const esc = s => String(s ?? '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');

  // ---------- init ----------
  function init() {
    map = L.map('map').setView([53.214, 63.63], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    loadMapData();
    buildUI();
    bindEditorTools();

    // periodic refresh of statuses/telemetry
    setInterval(loadMapData, 60000);
  }

  // ---------- map data ----------
  async function loadMapData() {
    try {
      const d = await api.get('map');
      renderLayers(d);
    } catch (e) {
      console.error('map load failed', e);
    }
  }

  function renderLayers(d) {
    // clear old layers
    Object.values(layers).forEach(l => { if (l && l !== layers.demo && l !== layers.houses) { try { map.removeLayer(l); } catch (e) {} } });
    layers.zone = null;
    if (!layers.demo) {
      layers.demo = L.layerGroup().addTo(map);
    } else {
      layers.demo.clearLayers();
    }

    // pipes
    layers.pipes = L.geoJSON(d.pipes, {
      style: f => ({ color: COLORS[f.properties.status] || '#64748b', weight: 3 }),
      onEachFeature: (f, l) => {
        l.on('click', e => { L.DomEvent.stopPropagation(e); selectObject('pipe', f.properties.id, f.properties.name); });
        l.bindTooltip((f.properties.name || f.properties.id) + (f.properties.diameter_mm ? ' · ' + f.properties.diameter_mm + ' мм' : ''), { sticky: true });
      }
    }).addTo(map);

    // nodes
    layers.nodes = L.geoJSON(d.nodes, {
      pointToLayer: (f, ll) => {
        const t = f.properties.type || 'Камера';
        const clr = TYPE_COLORS[t] || COLORS[f.properties.status] || '#22c55e';
        const r = t === 'Источник' ? 9 : (t === 'Узел' ? 6 : 4);
        return L.circleMarker(ll, { radius: r, color: clr, fillOpacity: 0.95, weight: 2 });
      },
      onEachFeature: (f, l) => {
        l.on('click', e => { L.DomEvent.stopPropagation(e); selectObject('node', f.properties.id, f.properties.name); });
        const cnt = d.housesByNode ? d.housesByNode[f.properties.id] : undefined;
        l.bindTooltip((f.properties.name || f.properties.id) + (cnt ? ' · домов: ' + cnt : ''), { sticky: true });
      }
    }).addTo(map);

    // social objects intentionally hidden from map view; keep them in backend data only
    if (layers.social) { try { map.removeLayer(layers.social); } catch (e) {} }
    layers.social = null;
    try {
      const group = L.featureGroup([layers.nodes, layers.pipes]);
      const b = group.getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [20, 20] });
    } catch (e) {}
  }

  // ---------- selection & passport ----------
  function clearSelectionVisuals() {
    if (layers.nodes && layers.nodes.eachLayer) {
      layers.nodes.eachLayer(l => {
        l.setStyle({ weight: 2, color: TYPE_COLORS[(l.feature && l.feature.properties.type) || 'Камера'] || COLORS[(l.feature && l.feature.properties.status) || 'normal'] });
      });
    }
  }

  async function selectObject(type, id, name) {
    selected = { type, id, name: name || id };
    clearSelectionVisuals();
    if (layers.pipes && layers.pipes.eachLayer) {
      layers.pipes.eachLayer(l => l.setStyle({ color: COLORS[(l.feature && l.feature.properties.status) || 'normal'] || '#64748b', weight: 3 }));
    }
    if (type === 'node') {
      // highlight node
      if (layers.nodes) {
        layers.nodes.eachLayer(l => {
          if (l.feature && l.feature.properties.id === id) l.setStyle({ weight: 5, color: '#fbbf24' });
        });
      }
      currentNodeId = id;
      showNodePassport(id);
      loadNodeHouses(id);
    } else {
      currentNodeId = null;
      // highlight pipe
      if (layers.pipes) {
        layers.pipes.eachLayer(l => {
          if (l.feature && l.feature.properties.id === id) l.setStyle({ color: '#fbbf24', weight: 6 });
        });
      }
      showPipePassport(id);
    }
  }

  // ---------- дома на карте (интерактивные) ----------
  async function loadNodeHouses(nodeId) {
    try {
      const houses = await api.get('sim/houses?nodeId=' + encodeURIComponent(nodeId) + '&limit=300');
      renderHouses(houses);
    } catch (e) { /* слой домов не критичен */ }
  }

  function renderHouses(houses, statusMap) {
    if (layers.houses) { try { map.removeLayer(layers.houses); } catch (e) {} }
    if (!houses || !houses.length) { layers.houses = null; return; }
    houseCoords.clear();
    layers.houses = L.layerGroup();
    const statusColor = { NORMAL: '#22c55e', PARTIAL: '#f59e0b', NO_HEAT: '#ef4444', RESERVE_SUPPLY: '#3b82f6', RECOVERING: '#a78bfa', UNKNOWN: '#94a3b8' };
    for (const h of houses) {
      houseCoords.set(h.id, [h.lat, h.lon]);
      houseData.set(h.id, h);
      const st = statusMap && statusMap[h.id] ? statusMap[h.id] : 'NORMAL';
      const m = L.circleMarker([h.lat, h.lon], {
        radius: 4, color: statusColor[st] || '#64748b', weight: 1.5, fillOpacity: 0.85
      });
      m.bindTooltip((h.street ? h.street + ' ' + (h.house || '') : h.id) + (st !== 'NORMAL' ? ' · ' + st : ''), { sticky: true });
      m.on('click', e => { L.DomEvent.stopPropagation(e); showHousePassport(h.id); });
      m.addTo(layers.houses);
    }
    layers.houses.addTo(map);
  }

  async function toggleAllHouses() {
    const btn = document.getElementById('houses-toggle');
    if (layers.houses) {
      try { map.removeLayer(layers.houses); } catch (e) {}
      layers.houses = null;
      btn.textContent = '🏠 Показать все дома';
      return;
    }
    btn.textContent = 'Загрузка…';
    try {
      const houses = await api.get('sim/houses?limit=6000');
      renderHouses(houses);
      btn.textContent = '🏠 Скрыть все дома';
    } catch (e) {
      btn.textContent = '🏠 Показать все дома';
      alert('Не удалось загрузить дома: ' + (e.message || ''));
    }
  }

  function applySimHouseStatuses(impact) {
    const st = {};
    for (const b of impact.buildings) st[b.id] = b.status;
    if (houseData.size === 0) {
      // дома не загружены — подтянем все и раскрасим
      api.get('sim/houses?limit=6000').then(hs => {
        houseData.clear(); houseCoords.clear();
        renderHouses(hs, st);
      }).catch(() => {});
      return;
    }
    renderHouses([...houseData.values()], st);
  }

  function passportBlock(title, rows) {
    return `<div class="pp-block"><div class="pp-title">${title}</div>${rows.join('') || '<div class="pp-empty">Нет данных</div>'}</div>`;
  }
  function row(label, value) {
    return `<div class="pp-row"><span class="pp-label">${label}</span><span class="pp-value">${value}</span></div>`;
  }

  async function showNodePassport(id) {
    const body = document.getElementById('passport-body');
    body.innerHTML = '<div class="pp-loading">Загрузка паспорта…</div>';
    try {
      const p = await api.get('passports/node/' + id);
      const n = p.node || {};
      const statusLabels = { normal: 'Норма', monitored: 'На контроле', emergency: 'Авария', repair: 'Ремонт', high_risk: 'Высокий риск', data_missing: 'Нет данных' };
      const st = p.status || n.status || 'normal';
      const risk = p.risk ? `<span class="pill ${p.risk.level}">${p.risk.score} · ${p.risk.level}</span>` : '—';
      const pk = p.passport;

      const passportRows = pk ? [
        row('Номер секции', esc(pk.section_number || '—')),
        row('Диаметр, мм', fmt(pk.diameter_mm)),
        row('Год установки', fmt(pk.year_installed)),
        row('Материал', esc(pk.material || '—')),
        row('Статус', esc(pk.status || '—')),
        row('Источник данных', esc(pk.source || '—')),
        row('Паспорт (Google Drive)', pk.passport_url ? `<a class="pp-link" href="${esc(pk.passport_url)}" target="_blank" rel="noopener">открыть паспорт ↗</a>` : '—'),
        row('Примечания', esc(pk.notes || '—'))
      ] : [];

      const houseRows = (p.houses || []).slice(0, 200).map(h =>
        `<div class="pp-house" onclick="window.__showHouse('${h.id}')"><b>${esc([h.street, h.house, h.block].filter(Boolean).join(' ') || h.id)}</b><br><small>${esc(h.tk || '')} · ${h.year ? 'Год: ' + h.year : ''} · Нагр: ${h.load != null ? h.load + ' Гкал/ч' : '—'}</small></div>`
      ).join('');

      const html = [
        `<div class="pp-head"><b>${esc(n.name || n.id)}</b><span class="status-dot ${st}"></span>${statusLabels[st] || st}</div>`,
        row('Тип', esc(n.type || '—')),
        row('ID', esc(n.id)),
        row('Район', esc((n.folder || '—'))),
        row('Координаты', (n.lat ? n.lat.toFixed(6) : '—') + ', ' + (n.lon ? n.lon.toFixed(6) : '—')),
        row('Риск (baseline-модель)', risk),
        row('Подключено домов', (p.houses || []).length),
        row('Участков', (p.pipes || []).length),
        row('Инспекций', (p.inspections || []).length),
        row('Аварий', (p.bursts || []).length),
        row('Дефектов', (p.defects || []).length),
        passportBlock('Паспорт объекта', passportRows),
        passportBlock('Дома (паспорта из БД)', houseRows ? [houseRows] : []),
        passportBlock('История аварий', (p.bursts || []).slice(0, 8).map(b => `<div class="pp-event danger">${esc(fmt(b.date_detected).slice(0, 16))} — ${esc(b.defect_char || b.address || b.tk || b.status)}</div>`)),
        passportBlock('Дефекты', (p.defects || []).slice(0, 8).map(b => `<div class="pp-event warn">${esc(fmt(b.date_observed).slice(0, 16))} — P${fmt(b.priority)} ${esc(b.defect_type || '')}</div>`)),
        passportBlock('Инспекции', (p.inspections || []).slice(0, 8).map(b => `<div class="pp-event ok">${esc(fmt(b.observed_at).slice(0, 16))} — ${esc(b.result || '')}</div>`)),
        passportBlock('Ремонты', (p.repairs || []).slice(0, 8).map(b => `<div class="pp-event">${esc(fmt(b.planned_date))} — ${esc(b.title || '')} (${esc(b.status || '')})</div>`))
      ].join('');

      body.innerHTML = `<div class="passport-meta"><button onclick="runSimulation()">🔍 Симуляция отключения</button></div>${html}`;
      window.__showHouse = (hid) => showHousePassport(hid);
    } catch (e) {
      body.innerHTML = '<div class="pp-loading">Ошибка загрузки паспорта</div>';
    }
  }

  async function showPipePassport(id) {
    const body = document.getElementById('passport-body');
    body.innerHTML = '<div class="pp-loading">Загрузка паспорта…</div>';
    try {
      const p = await api.get('passports/pipe/' + id);
      const pp = p.pipe || {};
      const pk = p.passport;
      const passportRows = pk ? [
        row('Номер секции', esc(pk.section_number || '—')),
        row('Диаметр, мм', fmt(pk.diameter_mm)),
        row('Год установки', fmt(pk.year_installed)),
        row('Материал', esc(pk.material || '—')),
        row('Статус', esc(pk.status || '—')),
        row('Источник данных', esc(pk.source || '—')),
        row('Паспорт (Google Drive)', pk.passport_url ? `<a class="pp-link" href="${esc(pk.passport_url)}" target="_blank" rel="noopener">открыть паспорт ↗</a>` : '—'),
        row('Примечания', esc(pk.notes || '—'))
      ] : [];
      const html = [
        `<div class="pp-head"><b>${esc(pp.name || pp.id)}</b></div>`,
        row('ID', esc(pp.id)),
        row('Диаметр', fmt(pp.diameter_mm) + ' мм'),
        row('Длина', fmt(pp.length_m) + ' м'),
        row('От узла', p.fromNode ? esc(p.fromNode.name) + ' (' + esc(p.fromNode.id) + ')' : '—'),
        row('До узла', p.toNode ? esc(p.toNode.name) + ' (' + esc(p.toNode.id) + ')' : '—'),
        `<div class="pp-row"><span class="pp-label">Загрузка</span><span class="pp-value" id="pipe-load-cell">—</span></div>`,
        passportBlock('Паспорт объекта', passportRows),
        passportBlock('Аварии', (p.bursts || []).slice(0, 8).map(b => `<div class="pp-event danger">${esc(fmt(b.date_detected).slice(0, 16))} — ${esc(b.defect_char || b.address || '')}</div>`)),
        passportBlock('Дефекты', (p.defects || []).slice(0, 8).map(b => `<div class="pp-event warn">${esc(fmt(b.date_observed).slice(0, 16))} — ${esc(b.defect_type || '')}</div>`))
      ].join('');
      body.innerHTML = `<div class="passport-meta">
        <button onclick="runSimulation()">🔍 Симуляция отключения</button>
        <button id="sim-accident-btn" style="background:#b91c1c">🚨 СИМУЛИРОВАТЬ АВАРИЮ</button>
        <div id="pipe-forecast" class="pp-loading">Прогноз критичности…</div>
      </div>${html}`;
      document.getElementById('sim-accident-btn').onclick = () => openFailureModal(id, pp.name || pp.id);
      // прогноз "что будет, если эта труба выйдет из строя" — до аварии
      api.get('sim/pipes/' + encodeURIComponent(id) + '/criticality').then(f => {
        const box = document.getElementById('pipe-forecast');
        if (!box) return;
        const loadCell = document.getElementById('pipe-load-cell');
        if (loadCell && f.pipe && f.pipe.loadGcalH != null) {
          loadCell.textContent = f.pipe.loadGcalH.toLocaleString('ru', { maximumFractionDigits: 3 }) + ' Гкал/ч' +
            (f.pipe.diameterEstimated ? ' · Ø' + (f.pipe.diameterMm || '—') + ' мм (расч.)' : '');
        }
        box.innerHTML = `<b>Что будет, если эта труба выйдет из строя?</b>
          <div class="pp-row"><span class="pp-label">Загрузка линии</span><span class="pp-value"><b>${(f.pipe.loadGcalH || 0).toLocaleString('ru', { maximumFractionDigits: 3 })} Гкал/ч</b></span></div>
          <div class="pp-row"><span class="pp-label">Расход</span><span class="pp-value">${(f.pipe.flowKgS || 0).toLocaleString('ru', { maximumFractionDigits: 1 })} кг/с</span></div>
          <div class="pp-row"><span class="pp-label">Давление на источнике</span><span class="pp-value">${f.hydraulic ? f.hydraulic.feedPressureBar : '—'} бар</span></div>
          <div class="pp-row"><span class="pp-label">Домов затронуто</span><span class="pp-value"><b>${f.forecast.affectedBuildings}</b></span></div>
          <div class="pp-row"><span class="pp-label">Квартир</span><span class="pp-value"><b>${f.forecast.totalAffectedApartments}</b></span></div>
          <div class="pp-row"><span class="pp-label">Нагрузка</span><span class="pp-value"><b>${f.forecast.totalLostLoadGcalH} Гкал/ч</b></span></div>
          <div class="pp-row"><span class="pp-label">Площадь</span><span class="pp-value"><b>${f.forecast.totalAffectedAreaM2.toLocaleString('ru')} м²</b></span></div>
          <div class="pp-row"><span class="pp-label">Резерв</span><span class="pp-value"><b>${f.hasReserve ? 'ЕСТЬ' : 'НЕТ'}</b></span></div>
          <div class="pp-row"><span class="pp-label">Критичность</span><span class="pp-value"><span class="pill ${f.criticality.level.toLowerCase()}">${f.criticality.level} · ${f.criticality.score}</span></span></div>
          ${f.limitationMessage ? `<div class="sim-warning">⚠️ ${esc(f.limitationMessage)}</div>` : ''}`;
      }).catch(() => {});
    } catch (e) {
      body.innerHTML = '<div class="pp-loading">Ошибка</div>';
    }
  }

  // ---------- симуляция аварии ----------
  function openFailureModal(pipeId, pipeName) {
    simState = null;
    document.getElementById('fail-pipe-id').value = pipeId;
    document.getElementById('fail-pipe-name').textContent = 'Аварийный участок: ' + pipeName + ' (' + pipeId + ')';
    document.getElementById('fail-type').value = 'rupture';
    document.getElementById('fail-severity').value = 4;
    document.getElementById('fail-modal').style.display = 'block';
  }

  async function runFailureSim() {
    const pipeId = document.getElementById('fail-pipe-id').value;
    const type = document.getElementById('fail-type').value;
    const severity = +document.getElementById('fail-severity').value;
    const body = { affectedPipeId: pipeId, type, severity };
    const leak = document.getElementById('fail-leak').value;
    if (leak) body.leakRate = +leak;
    const btn = document.getElementById('fail-run-btn');
    btn.disabled = true; btn.textContent = 'Расчёт…';
    try {
      const s = await api.post('sim/simulations', { source: 'db', label: 'Авария ' + pipeId });
      if (!s.id) throw new Error(s.error || 'не удалось создать симуляцию');
      const res = await api.post('sim/simulations/' + s.id + '/fail-pipe', body);
      if (res.error) throw new Error(res.error);
      document.getElementById('fail-modal').style.display = 'none';
      simState = res;
      showImpactPanel(res);
      applySimHouseStatuses(res.impact);
      recolorPipesBySim(res.pipeStates || []);
    } catch (e) {
      alert('Ошибка симуляции: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '🚨 Запустить аварию';
    }
  }

  function recolorPipesBySim(states) {
    if (!layers.pipes) return;
    const stMap = {};
    for (const s of states) stMap[s.id] = s.status;
    layers.pipes.eachLayer(l => {
      const id = l.feature && l.feature.properties.id;
      const st = stMap[id];
      if (st === 'FAILED') l.setStyle({ color: '#f97316', weight: 6, dashArray: '6 4' });
      else if (st === 'ISOLATED') l.setStyle({ color: '#ef4444', weight: 5, opacity: 0.9 });
      else l.setStyle({ color: COLORS[(l.feature && l.feature.properties.status) || 'normal'] || '#64748b', weight: 3 });
    });
  }

  function showImpactPanel(res) {
    const modal = document.getElementById('impact-modal');
    const body = document.getElementById('impact-body');
    modal.style.display = 'block';
    const st = res.impact.stats;
    const crit = res.criticality;
    const failed = (res.failedElements || []).map(f => f.name || f.id).join(', ') || '—';

    const houseRows = res.impact.buildings.filter(b => b.status !== 'NORMAL' && b.status !== 'UNKNOWN').slice(0, 60).map(b => `
      <div class="pp-house" onclick="showHousePassport('${esc(b.id)}')">
        <b style="color:${b.status === 'NO_HEAT' ? '#f87171' : (b.status === 'PARTIAL' ? '#fbbf24' : '#60a5fa')}">${esc(b.address || b.id)}</b> · ${b.status}
        <br><small>${b.status === 'NO_HEAT' ? 'Потеря: ' + b.lostLoadGcalH + ' Гкал/ч' : 'Доступно: ' + (b.availableLoadGcalH ?? 0) + ' Гкал/ч'}${b.pressureBar != null ? ' · P=' + b.pressureBar + ' бар' : ''} · ${esc(b.reason || '')}</small>
      </div>`).join('');

    body.innerHTML = `
      <div class="sim-warning" style="margin-top:0"><b>Аварийная ситуация</b><br>
        Участок: ${esc(failed)}<br>
        Тип: ${esc((res.failedElements || []).map(f => f.label).join(', ') || '—')}<br>
        Статус: ЛОКАЛИЗОВАНА · Критичность: <span class="pill ${crit.level.toLowerCase()}">${crit.level} · ${crit.score}/100</span></div>
      <div class="pp-block">
        <div class="pp-title">Затронуто</div>
        <div class="pp-row"><span class="pp-label">Домов</span><span class="pp-value"><b>${st.affectedBuildings}</b></span></div>
        <div class="pp-row"><span class="pp-label">Полностью отключено</span><span class="pp-value"><b style="color:#f87171">${st.noHeatBuildings}</b></span></div>
        <div class="pp-row"><span class="pp-label">Частично ограничено</span><span class="pp-value"><b style="color:#fbbf24">${st.partialBuildings}</b></span></div>
        <div class="pp-row"><span class="pp-label">Резервное питание</span><span class="pp-value"><b style="color:#60a5fa">${st.reserveBuildings}</b></span></div>
        <div class="pp-row"><span class="pp-label">Квартир</span><span class="pp-value">${st.totalAffectedApartments}</span></div>
        <div class="pp-row"><span class="pp-label">Площадь</span><span class="pp-value">${st.totalAffectedAreaM2.toLocaleString('ru')} м²</span></div>
        <div class="pp-row"><span class="pp-label">Потеря нагрузки</span><span class="pp-value"><b>${st.totalLostLoadGcalH} Гкал/ч</b></span></div>
        <div class="pp-row"><span class="pp-label">Тепловые камеры</span><span class="pp-value">${st.affectedChambers}</span></div>
        <div class="pp-row"><span class="pp-label">Давление на источнике</span><span class="pp-value">${res.impact.hydraulic ? res.impact.hydraulic.feedPressureBar : '—'} бар</span></div>
        <div class="pp-row"><span class="pp-label">Мин. давление в зоне</span><span class="pp-value"><b>${res.impact.hydraulic && res.impact.hydraulic.minPressureObservedBar != null ? res.impact.hydraulic.minPressureObservedBar : '—'} бар</b></span></div>
        <div class="pp-row"><span class="pp-label">Расчётное восстановление</span><span class="pp-value"><b>${esc(res.estimatedRecovery || '—')}</b></span></div>
      </div>
      ${res.impact.limitationMessage ? `<div class="sim-warning">⚠️ ${esc(res.impact.limitationMessage)}</div>` : ''}
      ${res.impact.worstBuilding ? `<div class="pp-block"><div class="pp-title">Самый затронутый объект</div>
        ${esc(res.impact.worstBuilding.address || res.impact.worstBuilding.id)} — потеря <b>${res.impact.worstBuilding.lostLoadGcalH} Гкал/ч</b> · ${res.impact.worstBuilding.status}<br>
        <small>${esc(res.impact.worstBuilding.reason || '')}</small></div>` : ''}
      <div class="pp-block"><div class="pp-title">Здания (${res.impact.buildings.filter(b => b.status !== 'NORMAL').length})</div>${houseRows || '<div class="pp-empty">Нет затронутых зданий</div>'}</div>
      <div class="pp-block"><div class="pp-title">Таймлайн аварии</div>
        ${(res.timeline || []).map(t => `<div class="pp-event"><b>T+${t.tMin} мин</b> — ${esc(t.label)}<br><small style="color:var(--muted)">${esc(t.description)}</small></div>`).join('')}
      </div>
      <div class="pp-block"><div class="pp-title">Рекомендации</div>
        ${(res.recommendations || []).map(r => `<div class="pp-event">• ${esc(r)}</div>`).join('')}
      </div>`;
  }

  async function showHousePassport(id) {
    const body = document.getElementById('house-body');
    const modal = document.getElementById('house-modal');
    modal.style.display = 'block';
    body.innerHTML = '<div class="pp-loading">Загрузка…</div>';
    try {
      const r = await api.get('passports/house/' + id);
      const h = r.house || {};
      const n = r.node || null;
      const pipesRows = (r.relatedPipes || []).map(p =>
        `<div class="pp-house" onclick="window.__showPipe('${esc(p.id)}')"><b>${esc(p.name || p.id)}</b> · ${p.diameter_mm ? p.diameter_mm + ' мм' : '—'} · ${p.length_m ? p.length_m + ' м' : '—'}</div>`
      ).join('');
      body.innerHTML = [
        `<div class="pp-head"><b>${esc([h.street, h.house, h.block].filter(Boolean).join(' ') || h.id)}</b></div>`,
        row('ID', esc(h.id)),
        row('ТК', esc(h.tk || '—')),
        row('Подключен к узлу', n ? esc(n.name) + ' (' + esc(n.id) + ')' : '—'),
        row('Год постройки', fmt(h.year)),
        row('Нагрузка', h.load != null ? h.load + ' Гкал/ч' : '—'),
        row('Площадь', h.area != null ? (+h.area).toLocaleString('ru') + ' м²' : '—'),
        row('Квартир', fmt(h.flats)),
        row('Этажей', fmt(h.floors)),
        row('Владелец', esc(h.owner || '—')),
        row('Примечание', esc(h.note || '—')),
        passportBlock('Прилежащие участки', pipesRows ? [pipesRows] : []),
        passportBlock('История', (r.history || []).slice(0, 8).map(b => `<div class="pp-event ${b.status === 'active' ? 'danger' : ''}">${esc(fmt(b.date_detected).slice(0, 16))} — ${esc(b.defect_char || b.address || '')}</div>`))
      ].join('');
      window.__showPipe = (pid) => { modal.style.display = 'none'; selectObject('pipe', pid, pid); };
    } catch (e) {
      body.innerHTML = '<div class="pp-loading">Ошибка</div>';
    }
  }

  // ---------- simulation ----------
  async function runSimulation() {
    if (!selected) { alert('Выберите узел или участок на карте'); return; }
    const body = selected.type === 'node' ? { nodeId: selected.id } : { pipeId: selected.id };
    try {
      const z = await api.post('outage-zone', body);
      if (z.error) { alert(z.error); return; }
      drawZone(z);
      const simModal = document.getElementById('sim-modal');
      simModal.style.display = 'block';
      const simPanel = document.getElementById('sim-result');
      let html = `<b>Виртуальное отключение (без ограничений безопасности)</b><br>
        Объект: ${esc(selected.name || selected.id)}<br>
        Узлов в зоне: ${z.nodeIds.length} · Участков: ${z.pipeIds.length}<br>
        Домов: <b>${z.houseCount}</b> · Квартир: ${z.affectedFlats} · Соцобъектов: ${z.socialCount}<br>
        ИТП: ${z.itpCount}`;
      if (z.criticalConsumers && z.criticalConsumers.length) {
        html += `<br>Критические потребители: <b>${z.criticalConsumers.length}</b>`;
      }
      if (z.upstreamSource) html += `<br>Источник: ${esc(z.upstreamSource.name)}`;
      if (z.dataLimited) {
        html += `<div class="sim-warning">⚠️ ${esc(z.limitationMessage || 'Недостаточно данных для точного расчёта.')}</div>`;
      }
      html += `<br><button onclick="saveScenarioFromSim()">💾 Сохранить сценарий</button>`;
      simPanel.innerHTML = html;
      simPanel.style.display = 'block';
      selectedZone = z;
    } catch (e) { alert('Ошибка расчёта: ' + e.message); }
  }
  let selectedZone = null;

  function drawZone(z) {
    if (layers.zone) { try { map.removeLayer(layers.zone); } catch (e) {} }
    const feat = [
      ...(z.nodes || []).map(n => ({ type: 'Feature', properties: { ...n, kind: 'zone-node' }, geometry: { type: 'Point', coordinates: [n.lon, n.lat] } })),
      ...(z.pipes || []).map(p => { try { return { type: 'Feature', properties: { ...p, kind: 'zone-pipe' }, geometry: { type: 'LineString', coordinates: JSON.parse(p.coordinates) } }; } catch (e) { return null; } }).filter(Boolean)
    ];
    layers.zone = L.geoJSON({ type: 'FeatureCollection', features: feat }, {
      style: f => f.properties.kind === 'zone-pipe' ? { color: '#f43f5e', weight: 6, opacity: 0.85 } : {},
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 9, color: '#f43f5e', weight: 3, fillOpacity: 0.2 })
    }).addTo(map);
    try { map.fitBounds(layers.zone.getBounds(), { padding: [30, 30] }); } catch (e) {}
  }

  async function saveScenarioFromSim() {
    if (!selectedZone || !selected) return;
    const title = prompt('Название сценария', 'Сценарий ремонта ' + (selected.name || selected.id));
    if (!title) return;
    const body = { title, note: document.getElementById('sim-result').innerText || '', createdBy: 'Веб-диспетчер' };
    if (selected.type === 'node') body.nodeId = selected.id;
    else body.pipeId = selected.id;
    try {
      const r = await api.post('scenarios', body);
      if (r.id) alert('Сценарий сохранён: ' + r.id);
      else alert('Ошибка: ' + (r.error || 'неизвестно'));
    } catch (e) { alert('Ошибка: ' + e.message); }
  }

  // ---------- editor ----------
  function bindEditorTools() {
    document.getElementById('ed-add-node').onclick = () => {
      editorMode = editorMode === 'add-node' ? null : 'add-node';
      pendingLineFrom = null;
      updateEditorHint('Режим добавления узла: кликните по карте.');
    };
    document.getElementById('ed-add-line').onclick = () => {
      editorMode = editorMode === 'add-line' ? null : 'add-line';
      pendingLineFrom = null;
      updateEditorHint('Режим добавления участка: кликните по двум узлам последовательно.');
    };
    document.getElementById('ed-demo-node').onclick = () => {
      editorMode = editorMode === 'add-demo-node' ? null : 'add-demo-node';
      pendingLineFrom = null;
      updateEditorHint('Демо-узел: кликните на карту и будет создан временный узел, привязанный к ближайшему участку.');
    };
    document.getElementById('ed-deadend').onclick = () => {
      editorMode = editorMode === 'add-deadend' ? null : 'add-deadend';
      pendingLineFrom = null;
      updateEditorHint('Dead-end: кликните по линии, после чего будет создан временный узел на конце ветки и, при необходимости, привязка к реальному дому.');
    };
    document.getElementById('ed-delete').onclick = () => {
      if (!selected) { alert('Сначала выберите объект на карте'); return; }
      const ok = confirm(`Удалить ${selected.type === 'node' ? 'узел' : 'участок'} ${selected.name || selected.id}?`);
      if (!ok) return;
      const url = selected.type === 'node' ? 'editor/nodes/' + selected.id : 'editor/pipes/' + selected.id;
      fetch('/api/' + url, { method: 'DELETE' }).then(r => r.json()).then(() => { alert('Удалено'); loadMapData(); }).catch(e => alert('Ошибка: ' + e.message));
    };
    document.getElementById('ed-save-node').onclick = saveNodeForm;
    map.on('click', onMapClick);
  }

  function updateEditorHint(msg) {
    document.getElementById('ed-hint').textContent = msg || '';
  }

  function nearestPipePoint(latlng) {
    if (!layers.pipes || !layers.pipes.eachLayer) return null;
    let nearest = null;
    layers.pipes.eachLayer(layer => {
      const coords = layer.feature && layer.feature.geometry && layer.feature.geometry.coordinates ? layer.feature.geometry.coordinates : [];
      if (!Array.isArray(coords) || !coords.length) return;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = L.latLng(coords[i][1], coords[i][0]);
        const b = L.latLng(coords[i + 1][1], coords[i + 1][0]);
        const closest = L.LineUtil.closestPointOnSegment(latlng, a, b);
        const dist = latlng.distanceTo(closest);
        if (!nearest || dist < nearest.dist) {
          nearest = { dist, point: closest, pipe: layer.feature, line: [a, b] };
        }
      }
    });
    return nearest;
  }

  async function createDemoNodeAt(latlng, { deadend = false } = {}) {
    const nearest = nearestPipePoint(latlng);
    if (!nearest) {
      alert('Чтобы добавить временный узел, нажмите рядом с существующей теплолинией.');
      return;
    }
    const point = nearest.point;
    const marker = L.circleMarker(point, { radius: deadend ? 8 : 6, color: '#c084fc', fillOpacity: 0.95, weight: 3 }).addTo(layers.demo);
    marker.bindPopup(`<b>${deadend ? 'Dead-end' : 'Демо-узел'}</b><br>Временная привязка к участку.<br>Точка: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`);
    if (deadend) {
      const branch = L.polyline([[point.lat, point.lng], [latlng.lat, latlng.lng]], { color: '#c084fc', weight: 4, dashArray: '8 8', opacity: 0.8 }).addTo(layers.demo);
      branch.bindPopup('Временная ветка dead-end');
      const houseId = (document.getElementById('demo-house-id') || {}).value?.trim() || prompt('Введите ID реального дома из БД для привязки к dead-end', '');
      if (houseId) {
        try {
          const houseRes = await api.get('passports/house/' + encodeURIComponent(houseId));
          const h = houseRes && houseRes.house ? houseRes.house : null;
          if (h) {
            const housePoint = [latlng.lat, latlng.lng];
            const houseMarker = L.marker(housePoint, { title: `Дом ${h.id}` }).addTo(layers.demo);
            houseMarker.bindPopup(`<b>Дом ${esc(h.street || '')} ${esc(h.house || '')}</b><br>ID: ${esc(h.id)}<br>ТК: ${esc(h.tk || '—')}<br>Подключён временно к dead-end.`);
            const houseLine = L.polyline([[point.lat, point.lng], [housePoint[0], housePoint[1]]], { color: '#f59e0b', weight: 3, dashArray: '4 8', opacity: 0.9 }).addTo(layers.demo);
            houseLine.bindPopup('Реальный дом из БД временно прикреплён к dead-end');
          } else {
            alert('Дом с таким ID не найден. Временный dead-end создан без привязки к дому.');
          }
        } catch (e) {
          alert('Не удалось привязать дом к dead-end: ' + (e.message || 'ошибка интерфейса'));
        }
      }
    } else {
      L.polyline([[point.lat, point.lng], [latlng.lat, latlng.lng]], { color: '#a78bfa', weight: 3, dashArray: '6 8', opacity: 0.8 }).addTo(layers.demo);
    }
    demoSelection.push(marker);
    updateEditorHint('Временный объект создан. Он не сохраняется в БД и служит только для демонстрации логики.');
  }

  function onMapClick(e) {
    if (editorMode === 'add-node') {
      const lat = e.latlng.lat.toFixed(6), lon = e.latlng.lng.toFixed(6);
      document.getElementById('node-lat').value = lat;
      document.getElementById('node-lon').value = lon;
      document.getElementById('node-name').focus();
      updateEditorHint(`Клик зафиксирован: ${lat}, ${lon}. Введите название и сохраните.`);
      return;
    }
    if (editorMode === 'add-demo-node') {
      createDemoNodeAt(e.latlng, { deadend: false });
      return;
    }
    if (editorMode === 'add-deadend') {
      createDemoNodeAt(e.latlng, { deadend: true });
      return;
    }
    if (editorMode === 'add-line') {
      // click a node
      let clickedNode = null;
      if (layers.nodes) {
        layers.nodes.eachLayer(l => {
          const dist = Math.sqrt((l.getLatLng().lat - e.latlng.lat) ** 2 + (l.getLatLng().lng - e.latlng.lng) ** 2);
          if (dist < 0.004 && !clickedNode) clickedNode = l.feature.properties.id;
        });
      }
      if (!clickedNode) { updateEditorHint('Кликните по существующему узлу (точке)'); return; }
      if (!pendingLineFrom) {
        pendingLineFrom = clickedNode;
        updateEditorHint('Первый узел выбран. Кликните по второму узлу.');
      } else {
        createPipe(pendingLineFrom, clickedNode);
        pendingLineFrom = null;
      }
    }
  }

  function createPipe(from, to) {
    const pid = prompt('ID участка (или пусто — сгенерировать)', '');
    const name = prompt('Название участка', 'Новый участок');
    const dia = prompt('Диаметр, мм', '');
    const body = { fromNodeId: from, toNodeId: to, name: name || 'Новый участок', diameter_mm: dia ? +dia : null };
    if (pid) body.id = pid;
    api.post('editor/pipes', body).then(r => {
      if (r.ok) { alert('Участок создан'); loadMapData(); }
      else alert('Ошибка: ' + (r.error || ''));
    });
  }

  async function saveNodeForm() {
    const id = document.getElementById('node-id').value.trim();
    const name = document.getElementById('node-name').value.trim();
    const type = document.getElementById('node-type').value;
    const lat = +document.getElementById('node-lat').value;
    const lon = +document.getElementById('node-lon').value;
    if (!lat || !lon) { alert('Укажите координаты (кликом по карте в режиме добавления)'); return; }
    const body = { name: name || 'Новый узел', type, lat, lon };
    if (id) body.id = id;
    try {
      const r = await api.post('editor/nodes', body);
      if (r.ok) {
        alert('Узел сохранён: ' + r.id);
        document.getElementById('node-id').value = '';
        document.getElementById('node-name').value = '';
        editorMode = null;
        updateEditorHint('');
        loadMapData();
      } else alert('Ошибка: ' + (r.error || ''));
    } catch (e) { alert('Ошибка: ' + e.message); }
  }

  // ---------- UI & search ----------
  function buildUI() {
    document.getElementById('passport-close').onclick = () => {
      const card = document.getElementById('passport-card');
      const isCollapsed = card.classList.toggle('collapsed');
      document.getElementById('passport-close').textContent = isCollapsed ? 'развернуть' : 'свернуть';
      const body = document.getElementById('passport-body');
      if (body) body.style.display = isCollapsed ? 'none' : 'block';
    };
    document.getElementById('house-close').onclick = () => {
      document.getElementById('house-modal').style.display = 'none';
    };
    document.getElementById('sim-clear').onclick = () => {
      document.getElementById('sim-modal').style.display = 'none';
      if (layers.zone) { try { map.removeLayer(layers.zone); } catch (e) {} layers.zone = null; }
    };

    // search
    const inp = document.getElementById('search-input');
    const typeSel = document.getElementById('search-type');
    const results = document.getElementById('search-results');
    let timer = null;
    async function doSearch() {
      const q = inp.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      results.innerHTML = '<div class="search-loading">Поиск…</div>';
      try {
        const j = await api.get('search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(typeSel.value));
        const items = [];
        (j.nodes || []).forEach(n => items.push({ kind: 'node', title: 'Узел ' + (n.name || n.id), sub: (n.type || '') + ' · ' + n.id, data: n }));
        (j.pipes || []).forEach(p => items.push({ kind: 'pipe', title: 'Участок ' + (p.name || p.id), sub: p.id, data: p }));
        (j.houses || []).forEach(h => items.push({ kind: 'house', title: 'Дом ' + [h.street, h.house, h.block].filter(Boolean).join(' '), sub: 'ТК ' + (h.tk || '—') + ' · ' + (h.node ? h.node.id : 'не привязан'), data: h }));
        (j.socialObjects || []).forEach(s => items.push({ kind: 'social', title: s.name, sub: s.type + ' · ' + (s.address || '') , data: s }));
        if (!items.length) { results.innerHTML = '<div class="search-empty">Ничего не найдено</div>'; return; }
        results.innerHTML = items.slice(0, 50).map(it =>
          `<div class="search-item" data-kind="${it.kind}" data-id="${esc(it.data.id)}">` +
          `<b>${esc(it.title)}</b><br><small>${esc(it.sub)}</small></div>`
        ).join('');
        results.querySelectorAll('.search-item').forEach(el => {
          el.onclick = () => {
            const kind = el.getAttribute('data-kind');
            const id = el.getAttribute('data-id');
            if (kind === 'node') selectObject('node', id, id);
            else if (kind === 'pipe') selectObject('pipe', id, id);
            else if (kind === 'house') {
              const item = items.find(x => x.kind === 'house' && x.data.id === id);
              if (item && item.data.node) selectObject('node', item.data.node.id, item.data.node.name);
              else showHousePassport(id);
            } else if (kind === 'social') {
              const s = items.find(x => x.kind === 'social' && x.data.id === id).data;
              if (s.lat && s.lon) map.flyTo([s.lat, s.lon], 16);
            }
          };
        });
      } catch (e) { results.innerHTML = '<div class="search-empty">Ошибка поиска</div>'; }
    }
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 250); });
    typeSel.addEventListener('change', doSearch);
    document.getElementById('search-clear').onclick = () => { inp.value = ''; results.innerHTML = ''; };
  }

  // ---------- deep-link ----------
  function handleHash() {
    const m = location.hash.match(/^#\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      // wait for layers to be rendered
      setTimeout(() => {
        if (layers.nodes && id) {
          let found = false;
          layers.nodes.eachLayer(l => {
            if (l.feature && l.feature.properties.id === id) { found = true; map.flyTo(l.getLatLng(), 16); selectObject('node', id, l.feature.properties.name); }
          });
          if (!found) { const n = layers.nodes; map.flyTo([53.214, 63.63], 13); showNodePassport(id); }
        }
      }, 800);
    }
  }
  addEventListener('hashchange', handleHash);

  // ---------- boot ----------
  window.__toggleHouses = toggleAllHouses;
  window.__runFailure = runFailureSim;
  document.addEventListener('DOMContentLoaded', () => { init(); handleHash(); });
})();
