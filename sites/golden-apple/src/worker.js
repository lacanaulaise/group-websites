// Golden Apple Worker: serves the static site, plus small JSON endpoints under /api/.
// /api/hours — opening, kitchen and happy-hour times read from the Google listing (Places API New),
// cached at the edge for 6 hours so Google is called only a few times a day.

const PLACE_ID = 'ChIJk6QdxHsoVQ0RpmREzZMtMEg'; // The Golden Apple, 46 rue Borie
const HOURS_TTL_SECONDS = 6 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hours') return hours(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};

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
