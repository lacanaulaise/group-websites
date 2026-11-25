// Golden Apple Worker: serves the static site, plus small JSON endpoints under /api/.
// /api/hours — opening, kitchen and happy-hour times read from the Google listing (Places API New),
// cached at the edge for 6 hours so Google is called only a few times a day.

const PLACE_ID = 'ChIJk6QdxHsoVQ0RpmREzZMtMEg'; // The Golden Apple, 46 rue Borie
const HOURS_TTL_SECONDS = 6 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hours') return hours(request, env, ctx);
    if (url.pathname === '/api/privatisation' && request.method === 'POST') return privatisation(request, env);
    return env.ASSETS.fetch(request);
  },
};

// --- Privatisation requests -------------------------------------------------
// The form posts here; the Worker validates it and hands it to a small Google Apps Script
// (tools/form-relay.gs) that emails the pub and logs the request in a Sheet.
// The recipient is fixed here per venue, never taken from the form.
// Secrets (Cloudflare dashboard): FORM_RELAY_URL, FORM_RELAY_SECRET
const PRIVATISATION_TO = { 'golden-apple': 'goldenapplebx@gmail.com' };

async function privatisation(request, env) {
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'bad form' }, 400); }
  const get = (k, max = 200) => String(form.get(k) || '').trim().slice(0, max);

  if (get('website')) return json({ ok: true }); // honeypot filled: quietly ignore bots
  const data = {
    venue: get('venue', 40),
    name: get('name'), email: get('email'), phone: get('phone', 40),
    date: get('date', 20), guests: get('guests', 10), type: get('type', 60),
    budget: get('budget'), message: get('message', 3000),
  };
  const to = PRIVATISATION_TO[data.venue];
  if (!to) return json({ ok: false, error: 'unknown venue' }, 400);
  if (!data.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email) || !data.date || !data.guests) {
    return json({ ok: false, error: 'missing fields' }, 400);
  }
  if (!env.FORM_RELAY_URL || !env.FORM_RELAY_SECRET) return json({ ok: false, error: 'relay not configured' }, 500);

  const res = await fetch(env.FORM_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.FORM_RELAY_SECRET, kind: 'privatisation', to, ...data }),
    redirect: 'follow',
  });
  const out = await res.json().catch(() => ({}));
  return out.ok ? json({ ok: true }) : json({ ok: false, error: 'relay failed' }, 502);
}

async function hours(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/hours?v=2', request.url).toString()); // bump v to force a refresh
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.GOOGLE_PLACES_KEY) return json({ error: 'GOOGLE_PLACES_KEY secret is not set' }, 500);

  const res = await fetch(`https://places.googleapis.com/v1/places/${PLACE_ID}?languageCode=fr`, {
    headers: {
      'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': [
        'regularOpeningHours',
        'currentOpeningHours',
        'regularSecondaryOpeningHours',
        'currentSecondaryOpeningHours',
        'utcOffsetMinutes',
      ].join(','),
    },
  });
  if (!res.ok) return json({ error: 'Google Places request failed', status: res.status }, 502);
  const place = await res.json();

  const secondary = (type) =>
    (place.regularSecondaryOpeningHours || []).find((h) => h.secondaryHoursType === type) || null;

  const body = {
    fetchedAt: new Date().toISOString(),
    openNow: place.currentOpeningHours?.openNow ?? null,
    opening: place.regularOpeningHours?.weekdayDescriptions || [],
    // Includes holiday / special closures Google knows about for the coming days.
    thisWeek: place.currentOpeningHours?.weekdayDescriptions || [],
    kitchen: secondary('KITCHEN')?.weekdayDescriptions || [],
    happyHour: secondary('HAPPY_HOUR')?.weekdayDescriptions || [],
  };

  const response = json(body, 200, { 'Cache-Control': `public, max-age=${HOURS_TTL_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
