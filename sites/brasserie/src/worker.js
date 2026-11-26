// La Canaulaise brewery Worker: serves the static site, plus small JSON endpoints under /api/.
// /api/demande   — visit booking, event quote, trade enquiry, shop order → Apps Script relay (email + Sheet)
// /api/newsletter — sign-ups, logged by the same relay until Brevo
// /api/partners   — stockists from the PARTENAIRES tab of "Carte site web" (Afficher = oui)
// /api/instagram  — latest @biere.lacanaulaise posts (images re-served from /api/ig-img/<id>)
// /api/beer-img/<id>?u=<uid> — EasyBeer label images, cached 30 days

const VENUE = 'brasserie';

export default {
  // Weekly: renew the Instagram Login token (valid 60 days) and keep it in KV, if one is used.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshInstagramToken(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/demande' && request.method === 'POST') return demande(request, env);
    if (url.pathname === '/api/newsletter' && request.method === 'POST') return newsletter(request, env);
    if (url.pathname === '/api/partners') return partners(request, env, ctx);
    if (url.pathname === '/api/instagram') return instagram(request, env, ctx);
    if (url.pathname.startsWith('/api/ig-img/')) return instagramImage(request, env, ctx, url.pathname.slice(12));
    if (url.pathname.startsWith('/api/beer-img/')) return beerImage(request, ctx, url.pathname.slice(14));
    return env.ASSETS.fetch(request);
  },
};

// --- Requests from the site forms ------------------------------------------------
// Each kind has its own recipient (fixed here, never taken from the form) and its own fields.
// The Worker validates and hands the request to tools/form-relay.gs (kind "demande"), which
// emails the team with Reply-To = the customer and logs it in the tab "Demandes brasserie".
// Secrets (Cloudflare dashboard): FORM_RELAY_URL, FORM_RELAY_SECRET
const DEMANDE_TO = 'info@lacanaulaise.fr';
const DEMANDE_CC = ['james@lacanaulaise.fr', 'celine@lacanaulaise.fr'];
const KINDS = {
  visite: { label: 'Visite de la brasserie', required: ['name', 'email', 'date', 'people'],
    fields: { date: 'Date souhaitée', time: 'Créneau', people: 'Personnes', group: 'Type de groupe' } },
  evenement: { label: 'Devis événement / tireuse', required: ['name', 'email', 'phone', 'date', 'place', 'guests'],
    fields: { date: "Date de l'événement", place: 'Lieu', guests: 'Personnes', type: "Type d'événement", need: 'Besoin' } },
  pro: { label: 'Demande professionnelle', required: ['name', 'email', 'company', 'city'],
    fields: { company: 'Établissement', city: 'Ville', type: 'Type', interest: 'Intéressé par' } },
  commande: { label: 'Commande boutique', required: ['name', 'email', 'phone', 'product', 'qty', 'where', 'adult'],
    fields: { product: 'Produit', choice: 'Bière / variante', qty: 'Quantité', where: 'Retrait', adult: '18 ans ou plus' } },
};

async function demande(request, env) {
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'bad form' }, 400); }
  const get = (k, max = 200) => String(form.get(k) || '').trim().slice(0, max);
  if (get('website')) return json({ ok: true }); // honeypot filled: quietly ignore bots
  const kind = KINDS[get('kind', 20)];
  if (!kind) return json({ ok: false, error: 'unknown kind' }, 400);
  const base = { name: get('name'), email: get('email'), phone: get('phone', 40), message: get('message', 3000), lang: get('lang', 2) };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base.email)) return json({ ok: false, error: 'email' }, 400);
  const details = Object.entries(kind.fields).map(([k, label]) => [label, get(k)]);
  const missing = kind.required.filter((k) => !(k in base ? base[k] : get(k)));
  if (missing.length) return json({ ok: false, error: 'missing fields', missing }, 400);
  if (!env.FORM_RELAY_URL || !env.FORM_RELAY_SECRET) return json({ ok: false, error: 'relay not configured' }, 500);

  const res = await fetch(env.FORM_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.FORM_RELAY_SECRET, kind: 'demande', venue: VENUE, subject: kind.label,
      to: DEMANDE_TO, cc: DEMANDE_CC.join(','), ...base, details,
    }),
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
    body: JSON.stringify({ secret: env.FORM_RELAY_SECRET, kind: 'newsletter', venue: VENUE, email }),
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

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

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
  } else if ((env.META_TOKEN || env.IG_ACCESS_TOKEN) && env.IG_USER_ID) {
    // Facebook-linked route (Page with a linked Instagram account).
    api = `https://graph.facebook.com/${env.IG_USER_ID}/media?fields=${fields}&limit=24` +
      `&access_token=${encodeURIComponent(env.META_TOKEN || env.IG_ACCESS_TOKEN)}`;
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

// --- Partners (stockists) -------------------------------------------------------
// Tab PARTENAIRES of "Carte site web", published as CSV (PARTNERS_CSV_URL). Rows come from
// EasyBeer (customers who ordered in the last 12 months); James's columns K–M (Nom site,
// Afficher, Note) decide what is shown. Cached 1 hour, last good copy kept 30 days.
const PARTNERS_TTL_SECONDS = 60 * 60;

async function partners(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/partners?v=1', request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  if (!env.PARTNERS_CSV_URL) return json({ error: 'PARTNERS_CSV_URL is not set' }, 500);
  const lastKey = new Request(new URL('/api/partners-last?v=1', request.url).toString());
  const res = await fetch(env.PARTNERS_CSV_URL, { redirect: 'follow' });
  if (!res.ok) {
    const last = await cache.match(lastKey);
    if (last) return new Response(last.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    return json({ error: 'partners sheet unavailable', status: res.status }, 502);
  }
  const rows = parseCsv(await res.text());
  const head = (rows.shift() || []).map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const c = { name: col('Nom EasyBeer'), site: col('Nom site'), type: col('Type'), addr: col('Adresse'), cp: col('Code postal'),
    city: col('Ville'), lat: col('Latitude'), lng: col('Longitude'), show: col('Afficher'), last: col('Dernière commande') };
  const num = (s) => { const n = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
  // A partner stays listed for 12 months after its last order (column "Dernière commande",
  // yyyy-mm-dd or dd/mm/yyyy); rows are never deleted from the Sheet.
  const cutoff = Date.now() - 365 * 86400000;
  const date = (v) => {
    const t = String(v || '').trim(); let m;
    if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return Date.UTC(+m[1], m[2] - 1, +m[3]);
    if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return Date.UTC(+m[3], m[2] - 1, +m[1]);
    return null;
  };
  const list = [];
  for (const r of rows) {
    if ((r[c.show] || '').trim().toLowerCase() !== 'oui') continue;
    const last = c.last >= 0 ? date(r[c.last]) : null;
    if (last != null && last < cutoff) continue;
    const name = ((r[c.site] || '').trim() || (r[c.name] || '').trim());
    if (!name) continue;
    list.push({
      name, type: (r[c.type] || '').trim(), address: (r[c.addr] || '').trim(), cp: (r[c.cp] || '').trim(),
      city: (r[c.city] || '').trim(), lat: num(r[c.lat]), lng: num(r[c.lng]),
    }); // column Note is internal and never published
  }
  // Lacanau (home) first, then towns alphabetically.
  const home = (x) => (/^lacanau/i.test(x.city) ? 0 : 1);
  list.sort((a, b) => home(a) - home(b) || a.city.localeCompare(b.city, 'fr') || a.name.localeCompare(b.name, 'fr'));
  const body = JSON.stringify({ fetchedAt: new Date().toISOString(), partners: list });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${PARTNERS_TTL_SECONDS}` } });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  ctx.waitUntil(cache.put(lastKey, new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=2592000' } })));
  return response;
}

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
