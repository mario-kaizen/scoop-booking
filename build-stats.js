// build-stats.js - computes the funnel stats contract from the SQLite DB.
// Ported from spine-and-health-co/funnel/lib/build-stats.js (CJS -> ESM).
// Logic is intentionally kept identical so both funnels compute the same contract.

const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);

// ghl_status vocabulary: 'created'/'duplicate' => synced; 'pending' => pending; anything starting 'error' => failed.
function ghlClass(s) {
  if (s === 'created' || s === 'duplicate') return 'synced';
  if (s === 'pending' || s == null) return 'pending';
  return 'failed';
}

function buildStats(db, meta) {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const vTotal = one('SELECT COUNT(*) n FROM visits');
  const vToday = one("SELECT COUNT(*) n FROM visits WHERE created_at >= datetime('now','start of day')");
  const vWeek  = one("SELECT COUNT(*) n FROM visits WHERE created_at >= datetime('now','weekday 0','-7 days','start of day')");
  const vFbc   = one('SELECT COUNT(*) n FROM visits WHERE fbc IS NOT NULL');
  const vFbp   = one('SELECT COUNT(*) n FROM visits WHERE fbp IS NOT NULL');
  const vMob   = one("SELECT COUNT(*) n FROM visits WHERE lower(user_agent) LIKE '%mobile%'");

  const leads = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const lTotal = leads.length;
  const synced = leads.filter(l => ghlClass(l.ghl_status) === 'synced').length;
  const failed = leads.filter(l => ghlClass(l.ghl_status) === 'failed').length;
  const pending = leads.filter(l => ghlClass(l.ghl_status) === 'pending').length;
  const lFbc = leads.filter(l => l.fbc).length;
  const capiFired = leads.filter(l => l.capi_status === 'sent').length;
  const capiFail  = leads.filter(l => l.capi_status === 'error').length;
  const lastCapi = leads.find(l => l.capi_status);

  const recentVisits = db.prepare('SELECT created_at, utm_source, utm_campaign, fbc, fbp FROM visits ORDER BY id DESC LIMIT 50').all()
    .map(v => ({ at: v.created_at, utmSource: v.utm_source, utmCampaign: v.utm_campaign, fbc: !!v.fbc, fbp: !!v.fbp }));
  const recentLeads = leads.slice(0, 50).map(l => ({
    at: l.created_at, name: l.first_name, email: l.email, phone: l.phone,
    ghlStatus: l.ghl_status, capiStatus: l.capi_status || 'skipped', fbc: !!l.fbc, fbp: !!l.fbp,
  }));

  return {
    funnel: meta,
    health: {
      capiConfigured: !!(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN),
      ghlConfigured: !!process.env.GHL_PIT,
      lastCapiResult: lastCapi ? lastCapi.capi_status : 'none',
      lastCapiAt: lastCapi ? lastCapi.created_at : null,
    },
    visits: { total: vTotal, today: vToday, week: vWeek, withFbcPct: pct(vFbc, vTotal), withFbpPct: pct(vFbp, vTotal), mobilePct: pct(vMob, vTotal) },
    optIns: { total: lTotal, synced, failed, pending, withFbcPct: pct(lFbc, lTotal) },
    capi: { fired: capiFired, failed: capiFail, firedPct: pct(capiFired, lTotal) },
    conversion: pct(lTotal, vTotal),
    recentVisits, recentLeads,
  };
}

export { buildStats };
