import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { buildStats } from '../build-stats.js';

function seed() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY, fbc TEXT, fbp TEXT, user_agent TEXT, utm_source TEXT, utm_campaign TEXT, created_at TEXT);
           CREATE TABLE leads (id INTEGER PRIMARY KEY, first_name TEXT, email TEXT, phone TEXT, ghl_status TEXT, capi_status TEXT, fbc TEXT, fbp TEXT, created_at TEXT);`);
  db.prepare("INSERT INTO visits (fbc,fbp,user_agent,utm_source,utm_campaign,created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run('fb.1', 'fbp.1', 'Mozilla mobile', 'fb', 'c1');
  db.prepare("INSERT INTO visits (fbc,fbp,user_agent,created_at) VALUES (?,?,?,datetime('now'))").run(null, 'fbp.2', 'Desktop');
  db.prepare("INSERT INTO leads (email,ghl_status,capi_status,fbc,created_at) VALUES (?,?,?,?,datetime('now'))")
    .run('a@b.com', 'created', 'sent', 'fb.1');
  return db;
}

test('contract shape and core aggregates', () => {
  const s = buildStats(seed(), { slug: 'scoop-pilates', name: 'Scoop Pilates', host: 'trial.scooppilates.com.au', pixelId: 'p', ghlLocationId: 'g' });
  assert.equal(s.funnel.slug, 'scoop-pilates');
  assert.equal(s.visits.total, 2);
  assert.equal(s.visits.withFbcPct, 50);   // 1 of 2 visits has fbc
  assert.equal(s.optIns.total, 1);
  assert.equal(s.optIns.synced, 1);        // ghl_status 'created' counts as synced
  assert.equal(s.capi.fired, 1);
  assert.equal(s.conversion, 50);          // 1 lead / 2 visits = 50%
  assert.equal(s.recentLeads.length, 1);
  // confirm all 8 top-level contract keys are present
  const keys = ['funnel','health','visits','optIns','capi','conversion','recentVisits','recentLeads'];
  keys.forEach(k => assert.ok(k in s, `missing key: ${k}`));
});
