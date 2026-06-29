/**
 * scoop-booking/server.js — Scoop free-session funnel.
 *
 * Serves the funnel (public/index.html) and thank-you page, and handles the
 * lead submit. On submit the browser fires a Meta Pixel "Lead" with an eventID;
 * POST /api/lead fires the SAME Lead server-side via the Conversions API with the
 * matching eventID so Meta dedupes browser + server (the San Juan two-stream), AND
 * creates the contact in Scoop's GHL CRM with the trigger_lead tag + a context note
 * (mirrors the join.strongpilates.ca funnel pattern in strong-funnel-platform/src/lib/ghl.ts).
 *
 * It also enrols the lead into the GymMaster Free Trial pass via /portal/api/v1/signup,
 * selecting the membership with `membershiptypeid` (the documented field; `membership_id`
 * is silently ignored and drops the lead into the gym's default paid plan).
 *
 * Secrets (META_CAPI_TOKEN, GHL_PIT, GM_API_KEY) come from env only — never client-side,
 * never in git. Set them as Coolify env vars in production.
 */

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { db } from './db.js'
import { buildStats } from './build-stats.js'

const insVisit = db.prepare(`INSERT INTO visits (visitor_id,page,url,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,fbc,fbp,ip,user_agent)
  VALUES (@visitor_id,@page,@url,@referrer,@utm_source,@utm_medium,@utm_campaign,@utm_content,@utm_term,@fbc,@fbp,@ip,@user_agent)`)

const insLead = db.prepare(`INSERT INTO leads (first_name,email,phone,event_id,fbc,fbp,ip,user_agent,ghl_status)
  VALUES (@first_name,@email,@phone,@event_id,@fbc,@fbp,@ip,@user_agent,'pending')`)
const updLead = db.prepare(`UPDATE leads SET ghl_contact_id=@cid, ghl_status=@ghl, capi_status=@capi, capi_received=@recv, gm_status=@gm WHERE id=@id`)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 3000
const META_PIXEL_ID = process.env.META_PIXEL_ID
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE // optional, routes to Events Manager Test Events

// GHL (Scoop Reformer Pilates sub-account on the Kaizen white-label)
const GHL_PIT = process.env.GHL_PIT
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'll5FjMyc9NTEDpflcgi9'
const GHL_SOURCE = 'Scoop Free Session Funnel'
const GHL_TAGS = ['trigger_lead', 'funnel-lead', 'location-scoop-pilates']
const STUDIO_TZ = 'Australia/Melbourne' // Carnegie, VIC
const FUNNEL_HOST = 'trial.scooppilates.com.au'

// GymMaster (Scoop member system) — enrol the lead into the Free Trial pass.
// The membership is selected by `membershiptypeid` (the documented field), NOT `membership_id`
// (which GymMaster silently ignores, dropping the lead into the default paid plan).
const GM_API_KEY = process.env.GM_API_KEY
const GM_BASE_URL = process.env.GM_BASE_URL || 'https://scooppilates.gymmasteronline.com'
const GM_MEMBERSHIPTYPEID = Number(process.env.GM_MEMBERSHIPTYPEID || 190009) // Free Trial ($0, 1-visit/3-week)
const GM_COMPANY_ID = Number(process.env.GM_COMPANY_ID || 2)
const GM_DEFAULT_DOB = process.env.GM_DEFAULT_DOB || '2000-01-01' // form does not collect dob; API requires it

const app = express()
app.set('trust proxy', true) // behind Coolify's reverse proxy — get the real client IP
app.use(express.json())

app.post('/api/track', (req, res) => {
  try {
    const b = req.body || {};
    insVisit.run({
      visitor_id: b.visitorId || null, page: b.page || null, url: b.url || null, referrer: b.referrer || null,
      utm_source: b.utmSource || null, utm_medium: b.utmMedium || null, utm_campaign: b.utmCampaign || null,
      utm_content: b.utmContent || null, utm_term: b.utmTerm || null,
      fbc: b.fbc || null, fbp: b.fbp || null, ip: req.ip || null, user_agent: req.get('user-agent') || null,
    });
  } catch (e) { /* analytics never blocks */ }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')))

app.get('/thank-you', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'thank-you.html')))
app.get('/healthz', (_req, res) => res.json({ ok: true }))

const FUNNEL_META = {
  slug: 'scoop-pilates',
  name: 'Scoop Pilates',
  host: 'trial.scooppilates.com.au',
  pixelId: process.env.META_PIXEL_ID,
  ghlLocationId: GHL_LOCATION_ID,
};

app.get('/api/stats', (req, res) => {
  if (!process.env.STATS_SECRET || req.query.secret !== process.env.STATS_SECRET) return res.status(401).json({ ok: false });
  try { res.json(buildStats(db, FUNNEL_META)); }
  catch (e) { console.error('stats error', e.message); res.status(500).json({ ok: false }); }
});

const sha256 = (v) => (v ? createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined)
const digits = (v) => (v ? String(v).replace(/\D/g, '') : '')

// ---- Meta Conversions API (server-side Lead, deduped with the browser pixel) ----
async function sendCapi({ firstName, email, phone, eventId, fbp, fbc, eventSourceUrl, ip, ua }) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    console.warn('[CAPI] META_PIXEL_ID / META_CAPI_TOKEN not set — server event skipped')
    return { capi: 'skipped' }
  }
  const ph = digits(phone)
  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId || undefined,
    action_source: 'website',
    event_source_url: eventSourceUrl || undefined,
    user_data: {
      em: email ? [sha256(email)] : undefined,
      ph: ph ? [sha256(ph)] : undefined,
      fn: firstName ? [sha256(firstName)] : undefined,
      client_ip_address: ip,
      client_user_agent: ua,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
    },
    custom_data: { content_name: 'free_session' },
  }
  const payload = { data: [event] }
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json()
    if (d.error) {
      console.error('[CAPI] error', JSON.stringify(d.error))
      return { capi: 'error', detail: d.error.message }
    }
    console.log('[CAPI] Lead sent eventId=%s received=%s', eventId, d.events_received)
    return { capi: 'sent', events_received: d.events_received, eventId }
  } catch (err) {
    console.error('[CAPI] exception', err.message)
    return { capi: 'exception' }
  }
}

// ---- GHL CRM: create the contact with the trigger tag, then attach a context note ----
function buildContactNote({ fbc, fbp, eventSourceUrl }) {
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: STUDIO_TZ,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  const lines = [
    'Lead submitted via Scoop Free Session Funnel',
    `Source: ${FUNNEL_HOST}`,
  ]
  if (eventSourceUrl) {
    try {
      const url = new URL(eventSourceUrl)
      const parts = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']
        .map((k) => url.searchParams.get(k)).filter(Boolean)
      if (parts.length) lines.push(`UTM: ${parts.join(' / ')}`)
    } catch { /* not a URL, skip */ }
  }
  lines.push(`FBC: ${fbc ? 'yes' : 'no'} | FBP: ${fbp ? 'yes' : 'no'}`)
  lines.push(`Submitted: ${timestamp} (${STUDIO_TZ})`)
  return lines.join('\n')
}

async function addContactNote(contactId, body) {
  const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GHL_PIT}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
    body: JSON.stringify({ body }),
  })
  if (!r.ok) throw new Error(`GHL notes ${r.status}: ${(await r.text()).slice(0, 300)}`)
}

async function syncToGhl({ firstName, email, phone, fbp, fbc, eventSourceUrl }) {
  if (!GHL_PIT) {
    console.warn('[GHL] GHL_PIT not set — CRM sync skipped')
    return { ghl: 'skipped' }
  }
  const nameParts = String(firstName || '').trim().split(/\s+/).filter(Boolean)
  const fn = nameParts[0] || ''
  const ln = nameParts.slice(1).join(' ') || ''
  try {
    const r = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GHL_PIT}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
      body: JSON.stringify({
        firstName: fn,
        lastName: ln,
        email: email || undefined,
        phone: phone || undefined,
        locationId: GHL_LOCATION_ID,
        source: GHL_SOURCE,
        tags: GHL_TAGS,
      }),
    })
    let contactId
    if (!r.ok) {
      const text = await r.text()
      // Locations with "don't allow duplicate contacts" return 400 with the existing
      // contactId in meta — the contact IS in the CRM, so treat it as a success.
      if (r.status === 400 && text.includes('does not allow duplicated contacts')) {
        try { contactId = JSON.parse(text)?.meta?.contactId } catch { /* keep going */ }
        console.log('[GHL] duplicate contact, reusing id=%s', contactId)
      } else {
        console.error('[GHL] contact create failed', r.status, text.slice(0, 300))
        return { ghl: 'error', status: r.status }
      }
    } else {
      const d = await r.json()
      contactId = d.contact?.id
    }
    if (contactId) {
      try { await addContactNote(contactId, buildContactNote({ fbc, fbp, eventSourceUrl })) }
      catch (err) { console.error('[GHL] note add failed for %s:', contactId, err.message) }
    }
    console.log('[GHL] contact synced id=%s tags=%s', contactId, GHL_TAGS.join(','))
    return { ghl: 'synced', contactId }
  } catch (err) {
    console.error('[GHL] exception', err.message)
    return { ghl: 'exception' }
  }
}

// ---- GymMaster: enrol the lead into the Free Trial pass ----
async function enrolInGymMaster({ firstName, email, phone }) {
  if (!GM_API_KEY) {
    console.warn('[GM] GM_API_KEY not set — enrolment skipped')
    return { gm: 'skipped' }
  }
  const parts = String(firstName || '').trim().split(/\s+/).filter(Boolean)
  const firstname = parts[0] || 'Member'
  const surname = parts.slice(1).join(' ') || 'Scoop' // form asks for full name; fallback if only one word given
  const password = 'Scoop-' + Math.random().toString(36).slice(2, 10) + 'A1' // generated; lead can reset for app access
  const payload = {
    api_key: GM_API_KEY,
    firstname,
    surname,
    dob: GM_DEFAULT_DOB,
    email,
    password,
    confirmpassword: password,
    phonecell: phone || '',
    membershiptypeid: GM_MEMBERSHIPTYPEID, // 190009 = Free Trial (NOT membership_id)
    companyid: GM_COMPANY_ID,
  }
  try {
    const r = await fetch(`${GM_BASE_URL}/portal/api/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json()
    if (d.error || d.result !== 'success') {
      // Duplicate email (already a member) is an expected, non-fatal case — the lead is still in the CRM.
      console.error('[GM] enrolment not successful:', JSON.stringify(d.error || d.result))
      return { gm: 'error', detail: String(d.error || '').slice(0, 200) }
    }
    console.log('[GM] enrolled into Free Trial memberid=%s', d.memberid)
    return { gm: 'enrolled', memberid: d.memberid }
  } catch (err) {
    console.error('[GM] exception', err.message)
    return { gm: 'exception' }
  }
}

app.post('/api/lead', async (req, res) => {
  const { firstName, email, phone, eventId, fbp, fbc, eventSourceUrl } = req.body || {}
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'email or phone required' })

  // Insert a pending row immediately so the lead is never lost even if downstream calls fail
  let leadRowId = null;
  try {
    leadRowId = insLead.run({
      first_name: firstName || null, email: email || null, phone: phone || null,
      event_id: eventId || null, fbc: fbc || null, fbp: fbp || null,
      ip: req.ip || null, user_agent: req.get('user-agent') || null,
    }).lastInsertRowid;
  } catch (e) { /* keep going */ }

  // Capture the lead in the CRM FIRST so it is never lost, then enrol in GymMaster and fire
  // Meta CAPI in parallel. Each step is independent - one failing cannot block the others.
  const ghl = await syncToGhl({ firstName, email, phone, fbp, fbc, eventSourceUrl })
  const [capi, gm] = await Promise.all([
    sendCapi({ firstName, email, phone, eventId, fbp, fbc, eventSourceUrl, ip: req.ip, ua: req.get('user-agent') }),
    enrolInGymMaster({ firstName, email, phone }),
  ])

  // Update the row with the outcomes from all three downstream calls
  if (leadRowId) {
    try {
      updLead.run({
        id: leadRowId,
        cid: ghl.contactId || null,
        ghl: ghl.ghl || 'error',
        capi: capi.capi || 'skipped',
        recv: capi.events_received || 0,
        gm: gm.gm || 'skipped',
      });
    } catch (e) {}
  }

  return res.json({ ok: true, ...capi, ...ghl, ...gm })
})

app.listen(PORT, '0.0.0.0', () => console.log(`scoop funnel listening on :${PORT}`))
