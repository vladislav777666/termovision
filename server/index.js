require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const telemetry = require('./lib/telemetrySim');
const { zone } = require('./lib/network');
const { matchTk, logUnmatched } = require('./lib/matchTk');
const auth = require('./lib/auth');
const heatMeters = require('./lib/heatMeters');
const analytics = require('./lib/analytics');
const apiRoutes = require('./routes/api');
const simRoutes = require('./routes/sim');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const id = p => p + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
const fc = (rows, g) => ({ type: 'FeatureCollection', features: rows.map(x => ({ type: 'Feature', properties: x, geometry: g(x) })) });
const normalizeSearch = (v = '') => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// ---- API session helper: allow demo auto-login for GET reads; require auth for writes in prod ----
app.use('/api', (req, res, next) => {
  const demo = (process.env.USE_MOCK_INTEGRATIONS || 'true') === 'true';
  if (demo) {
    if (!auth.currentUser(req)) auth.createSession('u-dispatch');
    req.user = auth.currentUser(req);
    return next();
  }
  next();
});
app.use('/api', apiRoutes);
app.use('/api/sim', simRoutes);

// ---- LEGACY ENDPOINTS (preserved for backward compatibility) ----
app.get('/api/session/roles', (q, s) => s.json(db.prepare('SELECT * FROM roles').all()));

function nodeState(n) {
  return db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM bursts WHERE node_id=? AND status='active') THEN 'emergency' WHEN EXISTS(SELECT 1 FROM bursts WHERE node_id=? AND status='capital_repair') THEN 'repair' WHEN EXISTS(SELECT 1 FROM defects WHERE node_id=? AND resolved=0) THEN 'monitored' ELSE (SELECT status FROM nodes WHERE id=?) END state").get(n.id, n.id, n.id, n.id).state;
}

app.get('/api/map', (q, s) => {
  const base = db.prepare('SELECT * FROM nodes').all();
  const nodes = base.map(n => ({ ...n, status: nodeState(n) }));

  const pipes = db.prepare('SELECT * FROM pipes').all().map(p => {
    const fromS = nodes.find(n => n.id === p.from_node_id)?.status;
    const toS = nodes.find(n => n.id === p.to_node_id)?.status;
    const st = fromS === 'emergency' || toS === 'emergency' ? 'emergency' : (fromS === 'repair' || toS === 'repair') ? 'repair' : p.status;
    return { ...p, status: st };
  });

  // risk overlay status from analytics engine
  const riskMap = new Map(analytics.riskScores(1000).map(r => [r.id, r.status]));

  const socialObjects = db.prepare('SELECT * FROM social_objects').all()
    .filter(x => x.lat && x.lon) // only objects with real coordinates
    .map(x => ({
      ...x,
      status: x.status || (riskMap.get(x.source_id) || 'normal'),
      district: x.district || 'Центр'
    }));

  // Houses are intentionally NOT sent to the map: the digital model lives in
  // node passports. Sending 6k+ points destroys map performance. The passport
  // endpoint returns houses per node on demand.
  const houseCountByNode = db.prepare('SELECT node_id, COUNT(*) n FROM houses WHERE node_id IS NOT NULL GROUP BY node_id').all();
  const hcm = new Map(houseCountByNode.map(r => [r.node_id, r.n]));

  s.json({
    nodes: fc(nodes, x => ({ type: 'Point', coordinates: [x.lon, x.lat] })),
    pipes: fc(pipes, x => ({ type: 'LineString', coordinates: JSON.parse(x.coordinates) })),
    housesByNode: Object.fromEntries(hcm),
    socialObjects: { type: 'FeatureCollection', features: socialObjects.map(x => ({ type: 'Feature', properties: x, geometry: { type: 'Point', coordinates: [x.lon, x.lat] } })) },
    fleet: db.prepare('SELECT * FROM vehicle_positions').all()
  });
});

app.get('/api/social-objects', (q, s) => s.json(db.prepare('SELECT * FROM social_objects').all()));
app.get('/api/nodes', (q, s) => s.json(fc(db.prepare('SELECT * FROM nodes').all(), x => ({ type: 'Point', coordinates: [x.lon, x.lat] }))));
app.get('/api/pipes', (q, s) => s.json(fc(db.prepare('SELECT * FROM pipes').all(), x => ({ type: 'LineString', coordinates: JSON.parse(x.coordinates) }))));

app.get('/api/passports/node/:id', (q, s) => {
  const n = db.prepare('SELECT * FROM nodes WHERE id=?').get(q.params.id);
  if (!n) return s.sendStatus(404);
  s.json({
    node: n,
    status: nodeState(n),
    passport: db.prepare('SELECT * FROM object_passports WHERE entity_id=? LIMIT 1').get(n.id) || null,
    pipes: db.prepare('SELECT * FROM pipes WHERE from_node_id=? OR to_node_id=?').all(n.id, n.id),
    houses: db.prepare('SELECT * FROM houses WHERE node_id=?').all(n.id),
    bursts: db.prepare('SELECT * FROM bursts WHERE node_id=? ORDER BY date_detected DESC').all(n.id),
    defects: db.prepare('SELECT * FROM defects WHERE node_id=? ORDER BY date_observed DESC').all(n.id),
    inspections: db.prepare('SELECT * FROM inspections WHERE node_id=? ORDER BY observed_at DESC').all(n.id),
    repairs: db.prepare('SELECT * FROM repair_tasks WHERE node_id=? ORDER BY created_at DESC').all(n.id),
    risk: analytics.riskScores(1000).find(r => r.id === n.id) || null
  });
});

app.get('/api/passports/house/:id', (q, s) => {
  const h = db.prepare('SELECT * FROM houses WHERE id=?').get(q.params.id);
  if (!h) return s.sendStatus(404);
  const node = h.node_id && db.prepare('SELECT * FROM nodes WHERE id=?').get(h.node_id);
  const relatedPipes = node ? db.prepare('SELECT * FROM pipes WHERE from_node_id=? OR to_node_id=?').all(node.id, node.id) : [];
  const source = node && node.source ? node.source : (h.source || null);
  const history = h.node_id ? db.prepare('SELECT * FROM bursts WHERE node_id=? ORDER BY date_detected DESC LIMIT 20').all(h.node_id) : [];
  const defects = h.node_id ? db.prepare('SELECT * FROM defects WHERE node_id=? ORDER BY date_observed DESC LIMIT 20').all(h.node_id) : [];
  const inspections = h.node_id ? db.prepare('SELECT * FROM inspections WHERE node_id=? ORDER BY observed_at DESC LIMIT 20').all(h.node_id) : [];
  const meter = h.id ? db.prepare('SELECT * FROM heat_meters WHERE house_id=? LIMIT 1').get(h.id) : null;
  s.json({ house: h, node, source, relatedPipes, history, defects, inspections, outages: [], meter });
});

app.get('/api/passports/pipe/:id', (q, s) => {
  const p = db.prepare('SELECT * FROM pipes WHERE id=?').get(q.params.id);
  if (!p) return s.sendStatus(404);
  const from = db.prepare('SELECT * FROM nodes WHERE id=?').get(p.from_node_id);
  const to = db.prepare('SELECT * FROM nodes WHERE id=?').get(p.to_node_id);
  const nodeIds = [p.from_node_id, p.to_node_id].filter(Boolean);
  let m = nodeIds.map(() => '?').join(',');
  if (!m) m = 'NULL';
  const bursts = nodeIds.length ? db.prepare(`SELECT * FROM bursts WHERE node_id IN (${m}) ORDER BY date_detected DESC`).all(...nodeIds) : [];
  const defects = nodeIds.length ? db.prepare(`SELECT * FROM defects WHERE node_id IN (${m}) ORDER BY date_observed DESC`).all(...nodeIds) : [];
  s.json({ pipe: p, passport: db.prepare('SELECT * FROM object_passports WHERE entity_id=? LIMIT 1').get(p.id) || null, fromNode: from, toNode: to, bursts, defects });
});

app.post('/api/outage-zone', (q, s) => {
  try { s.json(zone(q.body)); }
  catch (e) { s.status(400).json({ error: e.message }); }
});

app.post('/api/scenarios', (q, s) => {
  try {
    const z = zone(q.body);
    const x = {
      id: id('scenario'),
      title: q.body.title || 'Сценарий ремонта',
      pipe_id: q.body.pipeId || null,
      node_id: q.body.nodeId || null,
      created_by: q.body.createdBy || (auth.currentUser(q)?.name) || 'Диспетчер',
      created_at: new Date().toISOString(),
      zone_json: JSON.stringify(z),
      note: q.body.note || ''
    };
    db.prepare('INSERT INTO scenarios VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(x));
    auth.logAudit(auth.currentUser(q), 'scenario.create', 'scenario', x.id, { title: x.title, nodeId: q.body.nodeId, pipeId: q.body.pipeId });
    s.json({ ...x, zone: z });
  } catch (e) { s.status(400).json({ error: e.message }); }
});

app.get('/api/scenarios', (q, s) => s.json(db.prepare('SELECT * FROM scenarios ORDER BY created_at DESC').all()));

app.get('/api/analytics', (q, s) => {
  const risk = analytics.riskScores(20);
  s.json({
    counts: {
      nodes: db.prepare('SELECT count(*) n FROM nodes').get().n,
      pipes: db.prepare('SELECT count(*) n FROM pipes').get().n,
      houses: db.prepare('SELECT count(*) n FROM houses').get().n,
      activeBursts: db.prepare("SELECT count(*) n FROM bursts WHERE status='active'").get().n,
      openDefects: db.prepare('SELECT count(*) n FROM defects WHERE resolved=0').get().n
    },
    risk
  });
});

app.get('/api/telemetry', (q, s) => s.json({ simulated: true, updatedAt: new Date().toISOString(), items: telemetry.all() }));

app.get('/api/trail/:nodeId', (q, s) => {
  const nid = q.params.nodeId;
  s.json({
    bursts: db.prepare('SELECT * FROM bursts WHERE node_id=? ORDER BY date_detected DESC').all(nid),
    defects: db.prepare('SELECT * FROM defects WHERE node_id=? ORDER BY date_observed DESC').all(nid),
    inspections: db.prepare('SELECT * FROM inspections WHERE node_id=? ORDER BY observed_at DESC').all(nid),
    repairs: db.prepare('SELECT * FROM repair_tasks WHERE node_id=? ORDER BY created_at DESC').all(nid)
  });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ nodes: [], houses: [], pipes: [], socialObjects: [] });
  const type = req.query.type || 'all';
  const out = { nodes: [], houses: [], pipes: [], socialObjects: [] };
  const allNodes = db.prepare('SELECT * FROM nodes').all();
  const query = normalizeSearch(q);
  const compactQuery = query.replace(/\s+/g, ''); // remove spaces for symbol-level match
  const tokens = query.split(/\s+/).filter(Boolean);

  // "Symbol-level" matcher: the user expects that entering characters finds
  // objects containing those characters in the same order (substring), even
  // when the query is a partial fragment of a name/address/TK/ID.
  function matchText(text) {
    const normalized = normalizeSearch(text);
    if (!normalized) return false;
    const compact = normalized.replace(/\s+/g, '');
    // 1) exact substring on compact form ("5-03" matches "ТК 5 03 05")
    if (compact.includes(compactQuery)) return true;
    // 2) token-level: every word of the query must appear as a substring
    if (tokens.length && tokens.every(t => normalized.includes(t))) return true;
    // 3) symbol-chain fallback: every character of the query appears in order
    //    anywhere in the haystack (useful for fragments like "тк503")
    let pos = 0;
    for (const ch of compactQuery) {
      const found = compact.indexOf(ch, pos);
      if (found === -1) return false;
      pos = found + 1;
    }
    return compact.length > 0;
  }

  function jitter(id) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; const ang = (h % 360) * (Math.PI / 180); const r = (5e-5) * ((h % 10) / 10 + 0.2); return [Math.cos(ang) * r, Math.sin(ang) * r]; }

  if (type === 'all' || type === 'node') {
    out.nodes = db.prepare('SELECT * FROM nodes').all().filter(n => matchText([n.id, n.name, n.type, n.folder].join(' '))).slice(0, 200);
  }
  if (type === 'all' || type === 'house') {
    const raw = db.prepare('SELECT * FROM houses').all().filter(h => matchText([h.street, h.house, h.block, h.tk, h.note, h.id, h.owner, h.year].join(' '))).slice(0, 500);
    out.houses = raw.map(h => {
      const node = h.node_id ? db.prepare('SELECT * FROM nodes WHERE id=?').get(h.node_id) : null;
      const pipes = node ? db.prepare('SELECT * FROM pipes WHERE from_node_id=? OR to_node_id=?').all(node.id, node.id) : [];
      let lon = 0, lat = 0;
      if (node && node.lon && node.lat) { lon = node.lon; lat = node.lat; }
      else if (h.tk) { try { const m = matchTk(h.tk); if (m && m.candidates && m.candidates.length) { const c = allNodes.find(n => n.id === m.candidates[0].id); if (c && c.lon && c.lat) { lon = c.lon; lat = c.lat; } } } catch (e) {} }
      if (lon === 0 && lat === 0 && h.node_id) { const c = allNodes.find(n => n.id === h.node_id); if (c) { lon = c.lon; lat = c.lat; } }
      const off = jitter(String(h.id || h.tk || Math.random())); lon += off[0]; lat += off[1];
      return { ...h, node, linkedPipes: pipes, geometry: { type: 'Point', coordinates: [lon, lat] }, year: h.year ?? null };
    });
  }
  if (type === 'all' || type === 'pipe') {
    out.pipes = db.prepare('SELECT * FROM pipes').all().filter(p => matchText([p.id, p.name, p.folder, p.meta].join(' '))).slice(0, 200);
  }
  if (type === 'all' || type === 'social') {
    out.socialObjects = db.prepare('SELECT * FROM social_objects').all().filter(s => matchText([s.name, s.type, s.address, s.notes, s.id].join(' '))).slice(0, 200);
  }
  res.json(out);
});

// ---- FIELD (mobile) endpoints ----
app.get('/api/field/tasks', (q, s) => s.json(db.prepare("SELECT t.*,n.name node_name FROM inspection_tasks t LEFT JOIN nodes n ON n.id=t.node_id WHERE t.status!='done' ORDER BY t.priority DESC, t.planned_at").all()));

app.post('/api/field/tasks/:id/complete', upload.array('photos', 4), (q, s) => {
  const t = db.prepare('SELECT * FROM inspection_tasks WHERE id=?').get(q.params.id);
  if (!t) return s.sendStatus(404);
  const inspId = id('inspection');
  db.prepare('INSERT INTO inspections VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(inspId, t.node_id, t.id, q.body.worker || 'Бригада', new Date().toISOString(), q.body.result || 'Выполнено', q.body.note || '', JSON.stringify((q.files || []).map(f => '/uploads/' + f.filename)), q.body.lat || null, q.body.lon || null, new Date().toISOString());
  db.prepare("UPDATE inspection_tasks SET status='done' WHERE id=?").run(t.id);
  // status history
  if (t.node_id) {
    db.prepare("INSERT INTO object_status_history(id,entity_type,entity_id,old_status,new_status,changed_at,changed_by,reason) VALUES(?,?,?,?,?,?,?,?)")
      .run(id('hist'), 'node', t.node_id, 'monitored', 'normal', new Date().toISOString(), q.body.worker || 'Бригада', 'Осмотр завершён');
  }
  auth.logAudit(auth.currentUser(q), 'field.inspection.complete', 'inspection', inspId, { taskId: t.id, nodeId: t.node_id });
  s.json({ ok: true });
});

app.post('/api/field/defects', upload.array('photos', 4), (q, s) => {
  const x = q.body;
  const m = matchTk(x.tk);
  const i = id('defect');
  const photoPaths = (q.files || []).map(f => '/uploads/' + f.filename);
  db.prepare('INSERT INTO defects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(i, x.source || '', x.dateObserved || new Date().toISOString(), x.tk || '', m.nodeId, x.address || '', x.defectType || '', x.networkType || '', x.note || '', x.detectedBy || '', +x.priority || 5, x.planDate || '', 0, '', '', JSON.stringify(photoPaths), JSON.stringify(x));
  logUnmatched('defect', i, x.tk, m);
  if (m.nodeId) {
    db.prepare("UPDATE nodes SET status='monitored' WHERE id=? AND status='normal'").run(m.nodeId);
    db.prepare("INSERT INTO object_status_history(id,entity_type,entity_id,old_status,new_status,changed_at,changed_by,reason) VALUES(?,?,?,?,?,?,?,?)")
      .run(id('hist'), 'node', m.nodeId, 'normal', 'monitored', new Date().toISOString(), x.detectedBy || 'Бригада', 'Зафиксирован дефект: ' + (x.defectType || ''));
  }
  // Create notification for dispatcher
  db.prepare('INSERT INTO notifications(id,type,severity,title,message,entity_type,entity_id,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
    .run(id('notif'), 'defect', +x.priority > 7 ? 'high' : 'info', 'Новый дефект ' + (x.tk || ''), (x.address || '') + ' — ' + (x.defectType || ''), 'node', m.nodeId || '', new Date().toISOString());
  auth.logAudit(auth.currentUser(q), 'field.defect.create', 'defect', i, { tk: x.tk, address: x.address });
  s.json({ id: i, nodeId: m.nodeId });
});

app.post('/api/field/topology-edit', (q, s) => {
  db.prepare('INSERT INTO topology_edits(node_id,lat,lon,note) VALUES(?,?,?,?)').run(q.body.nodeId, q.body.lat, q.body.lon, q.body.note || '');
  auth.logAudit(auth.currentUser(q), 'field.topology.edit', 'node', q.body.nodeId, { lat: q.body.lat, lon: q.body.lon });
  s.json({ ok: true });
});

app.get('/api/utilities', (q, s) => s.json(db.prepare('SELECT * FROM utility_crossings').all()));
app.post('/api/utilities', (q, s) => {
  const x = q.body;
  db.prepare('INSERT INTO utility_crossings(type,lat,lon,note) VALUES(?,?,?,?)').run(x.type, x.lat, x.lon, x.note || '');
  auth.logAudit(auth.currentUser(q), 'utility.create', 'utility', '', { type: x.type, lat: x.lat, lon: x.lon });
  s.json({ ok: true });
});

// ---- ADMIN endpoints ----
app.get('/api/admin/unmatched', (q, s) => s.json(db.prepare('SELECT * FROM unmatched_tk WHERE resolved_node_id IS NULL LIMIT 500').all()));
app.post('/api/admin/unmatched/:i', (q, s) => {
  const x = db.prepare('SELECT * FROM unmatched_tk WHERE id=?').get(q.params.i);
  const tab = { house: 'houses', burst: 'bursts', defect: 'defects', complaint: 'complaints' }[x?.entity_type];
  if (!tab || !q.body.nodeId) return s.status(400).json({ error: 'Некорректные данные' });
  db.prepare(`UPDATE ${tab} SET node_id=? WHERE id=?`).run(q.body.nodeId, x.entity_id);
  db.prepare('UPDATE unmatched_tk SET resolved_node_id=? WHERE id=?').run(q.body.nodeId, x.id);
  auth.logAudit(auth.currentUser(q), 'admin.tk.link', x.entity_type, x.entity_id, { nodeId: q.body.nodeId });
  s.json({ ok: true });
});

app.get('/api/admin/config', (q, s) => s.json({
  thresholds: db.prepare('SELECT * FROM thresholds').all(),
  types: db.prepare('SELECT * FROM node_types').all(),
  fields: db.prepare('SELECT * FROM passport_fields').all(),
  defectTypes: db.prepare('SELECT * FROM defect_types').all(),
  severities: db.prepare('SELECT * FROM severity_levels').all(),
  priorities: db.prepare('SELECT * FROM repair_priorities').all()
}));
app.put('/api/admin/thresholds/:k', (q, s) => {
  db.prepare('UPDATE thresholds SET min=?,max=? WHERE key=?').run(+q.body.min, +q.body.max, q.params.k);
  auth.logAudit(auth.currentUser(q), 'admin.threshold.update', 'threshold', q.params.k, { min: +q.body.min, max: +q.body.max });
  s.json({ ok: true });
});
app.post('/api/admin/node-types', (q, s) => {
  db.prepare('INSERT INTO node_types(name,color) VALUES(?,?)').run(q.body.name, q.body.color || '#64748b');
  auth.logAudit(auth.currentUser(q), 'admin.nodeType.create', 'node_type', q.body.name, {});
  s.json({ ok: true });
});
app.post('/api/admin/passport-fields', (q, s) => {
  db.prepare('INSERT INTO passport_fields(entity_type,field_key,label,field_type) VALUES(?,?,?,?)').run(q.body.entityType, q.body.key, q.body.label, q.body.type || 'text');
  s.json({ ok: true });
});
app.post('/api/admin/defect-types', (q, s) => {
  db.prepare('INSERT OR IGNORE INTO defect_types(name) VALUES(?)').run(q.body.name);
  auth.logAudit(auth.currentUser(q), 'admin.defectType.create', 'defect_type', q.body.name, {});
  s.json({ ok: true });
});

// ---- Startup seed ----
const seed = () => {
  if (!db.prepare('SELECT count(*) n FROM inspection_tasks').get().n) {
    const ns = db.prepare('SELECT id,name FROM nodes LIMIT 5').all();
    for (const [n, x] of ns.entries())
      db.prepare('INSERT INTO inspection_tasks(id,node_id,title,planned_at,priority,status,assignee,note) VALUES(?,?,?,?,?,?,?,?)')
        .run('task-' + (n + 1), x.id, 'Плановый осмотр: ' + x.name, new Date(Date.now() + n * 864e5).toISOString(), 10 - n, 'planned', 'Бригада №1', 'Фото и GPS обязательны');
  }
  if (!db.prepare('SELECT count(*) n FROM utility_crossings').get().n) {
    for (const x of [[53.214, 63.624, 'Кабельная линия'], [53.218, 63.632, 'Водопровод'], [53.221, 63.627, 'Канализация']])
      db.prepare('INSERT INTO utility_crossings(type,lat,lon,note) VALUES(?,?,?,?)').run(x[2], x[0], x[1], 'Демо-слой для безопасных земляных работ');
  }
  if (!db.prepare('SELECT count(*) n FROM social_objects').get().n) {
    const defaults = [
      ['school-1', 'Школа №12', 'Школа', 'normal', 53.2128, 63.6241, 'ул. Ленина, 12', 'Социальный объект', '', '{"category":"school"}', 'Центр'],
      ['clinic-1', 'Городская поликлиника', 'Больница', 'normal', 53.2182, 63.6306, 'ул. Гагарина, 30', 'Социальный объект', '', '{"category":"clinic"}', 'Центр'],
      ['kindergarten-1', 'Детский сад №4', 'Детский сад', 'normal', 53.2068, 63.6184, 'ул. Садовая, 8', 'Социальный объект', '', '{"category":"kindergarten"}', 'Центр']
    ];
    for (const x of defaults) db.prepare('INSERT INTO social_objects(id,name,type,status,lat,lon,address,notes,source_id,meta,district) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...x);
  }
  // Seed realistic repair tasks from active bursts (real data → real planning)
  if (!db.prepare('SELECT count(*) n FROM repair_tasks').get().n) {
    const active = db.prepare("SELECT b.*, n.name node_name FROM bursts b LEFT JOIN nodes n ON n.id=b.node_id WHERE b.status='active' LIMIT 5").all();
    db.transaction(() => {
      for (const b of active) {
        let affectedHouses = 0, affectedSocial = 0;
        if (b.node_id) {
          try {
            const z = zone({ nodeId: b.node_id });
            affectedHouses = z.houseCount; affectedSocial = z.socialCount;
          } catch (e) {}
        }
        db.prepare('INSERT INTO repair_tasks(id,title,description,node_id,pipe_id,reason,priority,status,assignee,brigade,planned_date,deadline,actual_fix_date,affected_houses,affected_social,created_at,created_by,scenario_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id('repair'), 'Ликвидация аварии: ' + (b.defect_char || b.address || b.tk), b.defect_char || b.address || '', b.node_id || null, null, 'Аварийные работы', 10, 'in_progress', b.master || b.brigade || 'Бригада №1', b.brigade || 'Бригада №1', new Date().toISOString().slice(0, 10), b.deadline || '', null, affectedHouses, affectedSocial, new Date().toISOString(), 'Система (импорт)', null);
      }
    })();
  }
  heatMeters.seedMeters();
};
seed();

// ---- Simulated anomaly notifications (periodic; honest flag: simulation until SCADA) ----
setInterval(() => {
  try {
    const alerts = telemetry.all().filter(n => n.metrics.some(m => m.alert)).slice(0, 5);
    for (const n of alerts) {
      const alertMetric = n.metrics.find(m => m.alert);
      const existing = db.prepare('SELECT COUNT(*) n FROM notifications WHERE entity_id=? AND type=? AND read_at IS NULL').get(n.nodeId, 'anomaly').n;
      if (!existing && alertMetric) {
        db.prepare('INSERT INTO notifications(id,type,severity,title,message,entity_type,entity_id,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
          .run(id('notif'), 'anomaly', 'high', 'Аномалия: ' + n.name, `${alertMetric.key}: ${alertMetric.value} (норма ${alertMetric.min}–${alertMetric.max})`, 'node', n.nodeId, new Date().toISOString());
      }
    }
  } catch (e) {}
}, 60000);

app.listen(process.env.PORT || 4000, () => console.log('KTEK platform on http://localhost:' + (process.env.PORT || 4000)));