/**
 * scoop-booking/server.js — Scoop free-session funnel.
 *
 * Serves the funnel (public/index.html) and thank-you page, and handles the
 * lead submit. On submit the browser fires a Meta Pixel "Lead" with an eventID;
 * POST /api/lead fires the SAME Lead server-side via the Conversions API with the
 * matching eventID so Meta dedupes browser + server (the San Juan two-stream).
 *
 * Secrets (META_PIXEL_ID, META_CAPI_TOKEN) come from env only — never client-side,
 * never in git. Set them as Coolify env vars in production.
 *
 * Parked for a later pass: writing the lead into GHL and enrolling them into the
 * GymMaster Free Trial (must use programme_ref, not the numeric membership id).
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

const app = express()
app.set('trust proxy', true) // behind Coolify's reverse proxy — get the real client IP
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/thank-you', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'thank-you.html')))
app.get('/healthz', (_req, res) => res.json({ ok: true }))

const sha256 = (v) => (v ? createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined)
const digits = (v) => (v ? String(v).replace(/\D/g, '') : '')

app.post('/api/lead', async (req, res) => {
  const { firstName, email, phone, eventId, fbp, fbc, eventSourceUrl } = req.body || {}
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'email or phone required' })

  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    console.warn('[CAPI] META_PIXEL_ID / META_CAPI_TOKEN not set — server event skipped')
    return res.json({ ok: true, capi: 'skipped' })
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
      client_ip_address: req.ip,
      client_user_agent: req.get('user-agent'),
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
      return res.status(200).json({ ok: false, capi: 'error', detail: d.error.message })
    }
    console.log('[CAPI] Lead sent eventId=%s received=%s', eventId, d.events_received)
    return res.json({ ok: true, capi: 'sent', events_received: d.events_received, eventId })
  } catch (err) {
    console.error('[CAPI] exception', err.message)
    return res.status(200).json({ ok: false, capi: 'exception' })
  }
})

app.listen(PORT, '0.0.0.0', () => console.log(`scoop funnel listening on :${PORT}`))
