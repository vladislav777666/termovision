const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const network = require('../lib/network');

test('real source import row counts are complete', () => {
  assert.ok(db.prepare('SELECT count(*) n FROM nodes').get().n >= 400);
  assert.ok(db.prepare('SELECT count(*) n FROM pipes').get().n >= 780);
  assert.ok(db.prepare('SELECT count(*) n FROM houses').get().n >= 4000);
  assert.ok(db.prepare('SELECT count(*) n FROM bursts').get().n >= 400);
  assert.ok(db.prepare('SELECT count(*) n FROM defects').get().n >= 190);
});

test('network has connected topology and linked consumers', () => {
  assert.ok(db.prepare('SELECT count(*) n FROM pipes WHERE from_node_id IS NOT NULL AND to_node_id IS NOT NULL').get().n > 700);
  assert.ok(db.prepare('SELECT count(*) n FROM houses WHERE node_id IS NOT NULL').get().n > 700);
});

test('zone computation is honest about data limitations', () => {
  const active = db.prepare("SELECT node_id FROM bursts WHERE status='active' AND node_id IS NOT NULL LIMIT 1").get();
  if (active) {
    const z = network.zone({ nodeId: active.node_id });
    assert.ok(Array.isArray(z.nodeIds) && z.nodeIds.length > 0);
    assert.ok(typeof z.dataLimited === 'boolean');
    assert.ok(z.houseCount >= 0);
  }
});

test('risk baseline model returns interpretable factors', () => {
  const risk = require('../lib/analytics').riskScores(10);
  assert.ok(Array.isArray(risk) && risk.length > 0);
  assert.ok(typeof risk[0].score === 'number');
  assert.ok(risk[0].factors && typeof risk[0].factors.bursts === 'number');
});

test('dashboard KPI query handles active bursts without sql binding errors', () => {
  const analytics = require('../lib/analytics');
  const stats = analytics.dashboardKpis();
  assert.ok(stats && typeof stats.nodes === 'number');
  assert.ok(stats.affectedConsumers >= 0);
  assert.ok(typeof stats.burstsLastYear === 'number');
});

test('passport registry is filled for imported object types', () => {
  const count = db.prepare('SELECT count(*) n FROM object_passports').get().n;
  assert.ok(count >= 30, 'passport registry should contain imported KML objects');
  const example = db.prepare("SELECT * FROM object_passports WHERE entity_type='heat_chamber' LIMIT 1").get();
  assert.ok(example && example.entity_name, 'a heat chamber should have a populated passport row');
  assert.ok(example.entity_id || example.entity_name, 'passport row should carry object identity');
});