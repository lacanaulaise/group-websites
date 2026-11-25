// Golden Apple Worker: serves the static site, plus small JSON endpoints under /api/.
// /api/hours — opening, kitchen and happy-hour times read from the Google listing (Places API New),
// cached at the edge for 6 hours so Google is called only a few times a day.

const PLACE_ID = 'ChIJk6QdxHsoVQ0RpmREzZMtMEg'; // The Golden Apple, 46 rue Borie
const HOURS_TTL_SECONDS = 6 * 60 * 60;

export default {
  // Weekly: renew the Instagram Login token (valid 60 days) and keep it in KV.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshInstagramToken(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hours') return hours(request, env, ctx);
    if (url.pathname === '/api/privatisation' && request.method === 'POST') return privatisation(request, env);
    if (url.pathname === '/api/carte') return carte(request, env, ctx);
    if (url.pathname === '/api/instagram') return instagram(request, env, ctx);
    if (url.pathname === '/api/events') return events(request, env, ctx);
    if (url.pathname.startsWith('/api/ev-img/')) return eventImage(request, env, ctx, url.pathname.slice(12));
    if (url.pathname.startsWith('/api/ig-img/')) return instagramImage(request, env, ctx, url.pathname.slice(12));
    if (url.pathname.startsWith('/api/beer-img/')) return beerImage(request, ctx, url.pathname.slice(14));
    if (url.pathname === '/api/newsletter' && request.method === 'POST') return newsletter(request, env);
    return env.ASSETS.fetch(request);
  },
};

// --- Privatisation requests -------------------------------------------------
// The form posts here; the Worker validates it and hands it to a small Google Apps Script
// (tools/form-relay.gs) that emails the pub and logs the request in a Sheet.
// The recipient is fixed here per venue, never taken from the form.
// Secrets (Cloudflare dashboard): FORM_RELAY_URL, FORM_RELAY_SECRET
const PRIVATISATION_TO = { 'golden-apple': 'goldenapplebx@gmail.com' };
// Copied on every privatisation request, all venues.
const PRIVATISATION_CC = ['james@lacanaulaise.fr', 'celine@lacanaulaise.fr'];

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
    body: JSON.stringify({ secret: env.FORM_RELAY_SECRET, kind: 'privatisation', to, cc: PRIVATISATION_CC.join(','), ...data }),
    redirect: 'follow',
  });
  const out = await res.json().catch(() => ({}));
  return out.ok ? json({ ok: true }) : json({ ok: false, error: 'relay failed' }, 502);
}

// --- Newsletter sign-ups -----------------------------------------------------
// Logged through the same Apps Script relay (tab "Newsletter") until the Brevo list is set up.
async function newsletter(request, env) {
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'bad form' }, 400); }
  if (String(form.get('website') || '')) return json({ ok: true }); // honeypot
  const email = String(form.get('email') || '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'email' }, 400);
  if (!env.FORM_RELAY_URL || !env.FORM_RELAY_SECRET) return json({ ok: false, error: 'not configured' }, 503);
  const res = await fetch(env.FORM_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.FORM_RELAY_SECRET, kind: 'newsletter', venue: 'golden-apple', email }),
    redirect: 'follow',
  });
  const out = await res.json().catch(() => ({}));
  return out.ok ? json({ ok: true }) : json({ ok: false, error: 'relay failed' }, 502);
}

// --- Beer images (EasyBeer product photos) -------------------------------------
// /api/beer-img/<EasyBeer product id>?u=<EasyBeer image uid>: fetched once, cached 30 days.
async function beerImage(request, ctx, id) {
  if (!/^\d+$/.test(id)) return new Response('Not found', { status: 404 });
  const u = new URL(request.url).searchParams.get('u') || '';
  if (!/^\d*$/.test(u)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/beer-img/${id}?u=${u}`, request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const res = await fetch(`https://api.easybeer.fr/image/produit/${id}?uid=${u}&size=200`);
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) return new Response('Not found', { status: 404 });
  const out = new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000' } });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

async function hours(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/hours?v=3', request.url).toString()); // bump v to force a refresh
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

// --- La carte ----------------------------------------------------------------
// Reads the "Carte site web" Sheet tab (published as CSV, URL in the CARTE_CSV_URL
// variable), written every morning from the Monora till by tools/monora_web_menu.gs.
// Keeps rows with Afficher = oui and Statut = actif, groups them by rubrique and merges
// the sizes of one drink (25 cl / 50 cl / 1,5 L) into a single line. Cached 1 hour.
const CARTE_TTL_SECONDS = 60 * 60;
const CARTE_ORDER = [
  'À partager', 'Burgers & plats', 'Desserts',
  'Bières à la pression', 'Bières en bouteille', 'Cocktails', 'Sans alcool', 'Vins',
  'Spiritueux & long drinks', 'Digestifs', 'Softs', 'Boissons chaudes', 'À emporter',
];
const FOOD = new Set(['À partager', 'Burgers & plats', 'Desserts']);
const FORMAT_ORDER = ['25 cl', '50 cl', '75 cl', '1,5 L'];

async function carte(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/carte?v=2', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  if (!env.CARTE_CSV_URL) return json({ error: 'CARTE_CSV_URL is not set' }, 500);

  // Last good copy, kept 30 days: if the Sheet is ever unreachable the site keeps its menu.
  const lastKey = new Request(new URL('/api/carte-last?v=1', request.url).toString());
  const res = await fetch(env.CARTE_CSV_URL, { redirect: 'follow' });
  if (!res.ok) {
    const last = await cache.match(lastKey);
    if (last) return new Response(last.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    return json({ error: 'menu sheet unavailable', status: res.status }, 502);
  }
  const rows = parseCsv(await res.text());
  const head = rows.shift() || [];
  const col = (name) => head.indexOf(name);
  const c = {
    rub: col('Rubrique'), price: col('Prix TTC'), hh: col('Prix happy hour'), fmt: col('Format'),
    name: col('Nom site'), desc: col('Description'), show: col('Afficher'), order: col('Ordre'), status: col('Statut'),
  };
  const num = (s) => {
    const n = parseFloat(String(s || '').replace(/[^\d,.-]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const sections = new Map();
  for (const r of rows) {
    if ((r[c.show] || '').trim().toLowerCase() !== 'oui') continue;
    if ((r[c.status] || '').trim() !== 'actif') continue;
    const rub = (r[c.rub] || '').trim();
    const name = (r[c.name] || '').trim();
    const price = num(r[c.price]);
    if (!rub || !name || price == null) continue;
    if (!sections.has(rub)) sections.set(rub, new Map());
    const items = sections.get(rub);
    const item = items.get(name) || { name, desc: '', order: null, prices: [] };
    if (!item.desc && r[c.desc]) item.desc = r[c.desc].trim();
    const o = num(r[c.order]);
    if (o != null && (item.order == null || o < item.order)) item.order = o;
    const format = (r[c.fmt] || '').trim();
    // The till has a few duplicate articles (same name, size and price): show them once.
    if (!item.prices.some((p) => p.format === format && p.price === price)) {
      item.prices.push({ format, price, hh: num(r[c.hh]) });
    }
    items.set(name, item);
  }

  const out = [];
  const names = [...sections.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'fr'));
  for (const title of names) {
    const items = [...sections.get(title).values()].map((i) => ({
      ...i,
      prices: i.prices.sort((a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format)),
    }));
    items.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'fr'));
    out.push({ title, food: FOOD.has(title), items });
  }

  const response = json({ fetchedAt: new Date().toISOString(), sections: out }, 200,
    { 'Cache-Control': `public, max-age=${CARTE_TTL_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  ctx.waitUntil(cache.put(lastKey, new Response(JSON.stringify({ fetchedAt: new Date().toISOString(), sections: out }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=2592000' } })));
  return response;
}

function rank(title) {
  const i = CARTE_ORDER.indexOf(title);
  return i < 0 ? 99 : i;
}

// Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, newlines inside quotes).
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- Instagram ------------------------------------------------------------------
// Latest posts of the pub's Instagram professional account, via the Instagram Graph API
// (account linked to the Facebook Page). Images are re-served from this site
// (/api/ig-img/<id>): Instagram CDN links expire and would load Meta trackers.
// A caption containing #nosite keeps a post off the website.
// Secret: IG_ACCESS_TOKEN (long-lived Page token) · Variable: IG_USER_ID
const IG_TTL_SECONDS = 60 * 60;
const IG_IMG_TTL_SECONDS = 7 * 24 * 60 * 60;
const IG_COUNT = 6;

async function instagramFeed(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/instagram-raw?v=1', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  let api;
  const igToken = await instagramToken(env);
  if (igToken && igToken.startsWith('EAA') && env.IG_USER_ID) {
    // Unified login (Facebook Login for Business) → system user token, never expires.
    api = `https://graph.facebook.com/${env.IG_USER_ID}/media?fields=${fields}&limit=24&access_token=${encodeURIComponent(igToken)}`;
  } else if (igToken && !igToken.startsWith('EAA')) {
    // "Instagram API with Instagram Login": token from the Instagram professional account itself.
    api = `https://graph.instagram.com/me/media?fields=${fields}&limit=24&access_token=${encodeURIComponent(igToken)}`;
  } else if (env.IG_ACCESS_TOKEN && env.IG_USER_ID) {
    // Facebook-linked route (Page with a linked Instagram account).
    api = `https://graph.facebook.com/${env.IG_USER_ID}/media?fields=${fields}&limit=24` +
      `&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`;
  } else {
    return { error: 'no Instagram token set' };
  }
  const res = await fetch(api);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return { error: 'instagram request failed', status: res.status, detail: e.error?.message };
  }
  const data = await res.json();
  const posts = (data.data || [])
    .filter((p) => !/#nosite\b/i.test(p.caption || ''))
    .map((p) => ({
      id: p.id,
      src: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url,
      permalink: p.permalink,
      caption: (p.caption || '').split('\n')[0].slice(0, 140),
      timestamp: p.timestamp,
    }))
    .filter((p) => p.src)
    .slice(0, IG_COUNT);
  const out = { fetchedAt: new Date().toISOString(), posts };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${IG_TTL_SECONDS}` },
  })));
  return out;
}

async function instagram(request, env, ctx) {
  const feed = await instagramFeed(request, env, ctx);
  if (feed.error) return json(feed, 502);
  return json({
    fetchedAt: feed.fetchedAt,
    posts: feed.posts.map(({ id, permalink, caption, timestamp }) =>
      ({ id, permalink, caption, timestamp, img: `/api/ig-img/${id}` })),
  }, 200, { 'Cache-Control': 'public, max-age=600' });
}

async function instagramImage(request, env, ctx, id) {
  if (!/^\d+$/.test(id)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/ig-img/${id}?v=1`, request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const feed = await instagramFeed(request, env, ctx);
  const post = (feed.posts || []).find((p) => p.id === id);
  if (!post) return new Response('Not found', { status: 404 });
  const img = await fetch(post.src);
  if (!img.ok) return new Response('Image unavailable', { status: 502 });
  const response = new Response(img.body, {
    headers: {
      'Content-Type': img.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': `public, max-age=${IG_IMG_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// --- Facebook events ------------------------------------------------------------------
// Upcoming events of the pub's Facebook Page. The Meta token (secret META_TOKEN, or the older
// IG_ACCESS_TOKEN) is a user token that can see the Page; the Page token is derived from it.
// Cover images are re-served from this site (/api/ev-img/<id>). Cached 1 hour.
const FB_PAGE_ID = '32013519230'; // The Golden Apple Craft Beer House
const EV_TTL_SECONDS = 60 * 60;

async function eventsFeed(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/events-raw?v=1', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const token = env.META_TOKEN || env.IG_ACCESS_TOKEN;
  if (!token) return { error: 'META_TOKEN not set' };

  // Page token for our Page (a user token lists the Pages it manages with their tokens).
  let pageToken = token;
  const acc = await (await fetch('https://graph.facebook.com/me/accounts?fields=id,access_token&limit=50&access_token=' +
    encodeURIComponent(token))).json();
  const mine = (acc.data || []).find((p) => p.id === FB_PAGE_ID);
  if (mine && mine.access_token) pageToken = mine.access_token;

  const fields = 'id,name,description,start_time,end_time,cover,ticket_uri,is_canceled';
  const res = await fetch(`https://graph.facebook.com/${FB_PAGE_ID}/events?time_filter=upcoming&fields=${fields}` +
    `&limit=25&access_token=${encodeURIComponent(pageToken)}`);
  const data = await res.json();
  if (data.error) return { error: data.error.message };
  const list = (data.data || [])
    .filter((e) => !e.is_canceled)
    .map((e) => ({
      id: e.id, name: e.name, start: e.start_time, end: e.end_time || null,
      description: (e.description || '').slice(0, 400),
      cover: e.cover && e.cover.source ? e.cover.source : null,
      ticket: e.ticket_uri || null,
      url: 'https://www.facebook.com/events/' + e.id,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const out = { fetchedAt: new Date().toISOString(), events: list };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${EV_TTL_SECONDS}` },
  })));
  return out;
}

// --- Events from the pub's calendar Sheet --------------------------------------------
// tools/web_events.gs flattens "CALENDRIER The Golden Apple" into the tab EVENEMENTS GOLDEN APPLE
// (Date, Heure, Début, Titre, Catégorie), published as CSV → EVENTS_CSV_URL.
// Each category gets a photo from the 2025 shoot (public/img/photos/<name>-card.webp).
const EV_PHOTO = {
  quiz: 'crowd', flechettes: 'darts-player', tournoi: 'darts-board', rugby: 'jersey',
  foot: 'cheers', nfl: 'interior', special: 'back-bar', soiree: 'espresso-martini',
};
const EV_LABEL = {
  quiz: 'Quiz', flechettes: 'Fléchettes', tournoi: 'Tournoi', rugby: 'Rugby', foot: 'Foot',
  nfl: 'NFL', special: 'Soirée', soiree: 'Soirée',
};

async function calendarFeed(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/events-cal?v=1', request.url).toString());
  const lastKey = new Request(new URL('/api/events-cal-last?v=1', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const res = await fetch(env.EVENTS_CSV_URL, { redirect: 'follow' });
  if (!res.ok) {
    const last = await cache.match(lastKey);
    return last ? last.json() : { error: 'events sheet unavailable', status: res.status };
  }
  const rows = parseCsv(await res.text());
  const head = rows.shift() || [];
  const col = (n) => head.indexOf(n);
  const c = { date: col('Date'), time: col('Heure'), start: col('Début'), title: col('Titre'), cat: col('Catégorie') };
  const list = rows.filter((r) => r[c.date] && r[c.title]).map((r, i) => {
    const title = r[c.title].trim();
    let cat = (r[c.cat] || 'special').trim();
    if (/nfl/i.test(title)) cat = 'nfl';
    else if (cat === 'special' && /tourn/i.test(title) && /dart|fl[eé]ch/i.test(title)) cat = 'tournoi';
    else if (cat === 'special' && /concert|blind|halloween|xmas|no[eë]l|new year|soir/i.test(title)) cat = 'soiree';
    return {
      id: 'cal' + i, name: title, date: r[c.date], time: r[c.time] || '',
      start: r[c.start] || r[c.date] + 'T12:00:00', allDay: !r[c.time],
      category: cat, label: EV_LABEL[cat] || 'Au pub',
      img: `/img/photos/${EV_PHOTO[cat] || 'interior'}-card.webp`,
    };
  });
  const out = { fetchedAt: new Date().toISOString(), source: 'calendar', events: list };
  const body = JSON.stringify(out);
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${EV_TTL_SECONDS}` } })));
  ctx.waitUntil(cache.put(lastKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2592000' } })));
  return out;
}

async function events(request, env, ctx) {
  if (env.EVENTS_CSV_URL) {
    const cal = await calendarFeed(request, env, ctx);
    if (cal.error) return json(cal, 502);
    // Drop what has already finished (events are listed until ~3 h after they start).
    const now = Date.now();
    const upcoming = cal.events.filter((e) => new Date(e.start).getTime() + (e.allDay ? 12 : 3) * 3600e3 > now);
    return json({ fetchedAt: cal.fetchedAt, source: 'calendar', events: upcoming.slice(0, 40) }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  const feed = await eventsFeed(request, env, ctx);
  if (feed.error) return json(feed, 502);
  return json({
    fetchedAt: feed.fetchedAt,
    events: feed.events.map(({ cover, ...e }) => ({ ...e, img: cover ? `/api/ev-img/${e.id}` : null })),
  }, 200, { 'Cache-Control': 'public, max-age=600' });
}

async function eventImage(request, env, ctx, id) {
  if (!/^\d+$/.test(id)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/ev-img/${id}?v=1`, request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const feed = await eventsFeed(request, env, ctx);
  const ev = (feed.events || []).find((e) => e.id === id);
  if (!ev || !ev.cover) return new Response('Not found', { status: 404 });
  const img = await fetch(ev.cover);
  if (!img.ok) return new Response('Image unavailable', { status: 502 });
  const response = new Response(img.body, {
    headers: { 'Content-Type': img.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// --- Instagram Login token ----------------------------------------------------------
// IG_LOGIN_TOKEN (secret) is the long-lived token generated in the Meta app dashboard
// ("API Instagram avec Connexion Instagram"). It lasts 60 days; the weekly cron renews it
// and stores the fresh one in the KV namespace bound as STATE (if bound).
async function instagramToken(env) {
  if (env.STATE) {
    const stored = await env.STATE.get('ig_login_token');
    if (stored) return stored;
  }
  return env.IG_LOGIN_TOKEN ? cleanToken(env.IG_LOGIN_TOKEN) : null;
}

// Copy/paste often brings spaces, line breaks or quotes along.
function cleanToken(t) {
  return String(t).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}

async function refreshInstagramToken(env) {
  const current = await instagramToken(env);
  if (!current || !env.STATE || current.startsWith('EAA')) return; // system user tokens never expire
  const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' +
    encodeURIComponent(current));
  const d = await r.json();
  if (d.access_token) {
    await env.STATE.put('ig_login_token', d.access_token);
    await env.STATE.put('ig_login_token_refreshed', new Date().toISOString());
  }
}
