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
 * Secrets (META_CAPI_TOKEN, GHL_PIT) come from env only — never client-side, never
 * in git. Set them as Coolify env vars in production.
 *
 * Parked for a later pass: enrolling the lead into the GymMaster Free Trial pass
 * (must use programme_ref caef21f8..., not the numeric membership id). That is a
 * live write to their member system and needs its own validated pass + GymMaster
 * creds added to this app's env.
 */

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

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

const app = express()
app.set('trust proxy', true) // behind Coolify's reverse proxy — get the real client IP
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/thank-you', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'thank-you.html')))
app.get('/healthz', (_req, res) => res.json({ ok: true }))

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

app.post('/api/lead', async (req, res) => {
  const { firstName, email, phone, eventId, fbp, fbc, eventSourceUrl } = req.body || {}
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'email or phone required' })

  // Fire Meta CAPI and the GHL CRM sync independently — one failing must not block the other.
  const [capi, ghl] = await Promise.all([
    sendCapi({ firstName, email, phone, eventId, fbp, fbc, eventSourceUrl, ip: req.ip, ua: req.get('user-agent') }),
    syncToGhl({ firstName, email, phone, fbp, fbc, eventSourceUrl }),
  ])
  return res.json({ ok: true, ...capi, ...ghl })
})

app.listen(PORT, '0.0.0.0', () => console.log(`scoop funnel listening on :${PORT}`))
