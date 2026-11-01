# WhatsApp bridge

Keeps the studio's WhatsApp linked (scan a QR once, like WhatsApp Web) and
sends the booking site's messages: request received, booking confirmed with
details and entry code, what-to-wear card, exit code at check-in, final bill,
reschedule, cancel.

The booking site is on Vercel, which can't hold a WhatsApp connection open, so
this runs on its own server: Render's free plan, kept awake by Supabase.

## Deploy (Render + Supabase)

1. Render → **New → Blueprint** → pick this repo (it reads `render.yaml`).
2. Fill the two variables Render asks for:
   - `DATABASE_URL`: the same Supabase connection string the booking site uses.
     The WhatsApp login is saved there (table `wa_auth`), so restarts and
     redeploys don't need a new QR scan.
   - `WA_BRIDGE_SECRET`: the long random string you were given; the booking site
     uses the same value.
3. Once it's live, note the URL (e.g. `https://namaste-wa-bridge.onrender.com`)
   and check `/health` shows `{"ok":true}`.
4. Supabase → SQL editor → run `keepalive.sql` (with your URL). It pings
   `/health` every 10 minutes so the free plan never sleeps.
5. In Vercel (booking site) set `WA_BRIDGE_URL` (the Render URL) and
   `WA_BRIDGE_SECRET`, then redeploy.
6. Site admin → Bookings → **WhatsApp messages** card → scan the QR with the
   sending number (WhatsApp → Linked devices → Link a device).

## Two-way messages

Incoming WhatsApp messages are relayed to the site (`/api/wa/inbound`): the
studio's admin number can reply **received** / **not received** to a booking
alert to confirm or cancel it, and payment screenshots customers send into the
chat are forwarded to the admin. Every 5 minutes the bridge calls
`/api/wa/tick`, which releases unpaid holds and messages those customers.
`WA_SITE_URL` overrides the site address (default https://namaste-booking.vercel.app).

## Endpoints (all but /health need `Authorization: Bearer <secret>`)

- `GET /health`: liveness (this is what Supabase pings)
- `GET /status`: `{ state: starting|scan|connected|reconnecting|logged_out, qr, me, store: postgres|files, upSince, pings }` (pings = recent /health hits, to confirm the keep-alive)
- `POST /send` `{ to: "919812345678", text, image? }`: one message (`image` = https URL, sent with `text` as caption); sends are spaced ~2.5s apart
- `POST /logout`: unlink the number; a fresh QR appears

## Notes

- This uses WhatsApp Web's protocol (Baileys), not Meta's official API. Keep it
  to booking messages: bulk or promotional sending can get the number banned.
- The `wa_auth` table (or `auth/` folder when run without `DATABASE_URL`) is a
  live login for the number. Never share it.
