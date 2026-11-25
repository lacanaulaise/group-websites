# group-websites

Websites for Les Brasseurs de l'Océan — the La Canaulaise brewery and its pubs.
Each site is a static Astro build served by a Cloudflare Worker.

| Site | Folder | Cloudflare Worker | Status |
|---|---|---|---|
| The Golden Apple (Bordeaux) | `sites/golden-apple` | `golden-apple` | Preview (pilot) |
| Pub La Canaulaise (Lacanau) | — | — | Planned |
| Pub L'Australien (Hourtin-Plage) | — | — | Planned |
| Buvette de la Gaîté | — | — | Planned |
| La Canaulaise brewery | — | — | Planned |

## Cloudflare build settings (per site)

- Root directory: `sites/<site>`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Preview sites send `noindex` headers and a blocking `robots.txt` until their DNS switch.
