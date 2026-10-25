<div align="center">

<img src="client/public/icons/icon-512.png" alt="shelfIt" width="140" />

# shelfIt

**A self-hosted, single-user PWA for tracking the movies and TV shows you own and watch — styled like a physical video-rental shelf.**

![License](https://img.shields.io/badge/license-MIT-blue)
![Node.js](https://img.shields.io/badge/node-22-brightgreen)
![Docker](https://img.shields.io/badge/docker-required-2496ED)
![PWA](https://img.shields.io/badge/PWA-installable%20%2B%20offline-5A0FC8)
![i18n](https://img.shields.io/badge/i18n-English%20%2B%20Italian-informational)
![Built with AI](https://img.shields.io/badge/built%20with-AI%20assistance-8A2BE2)

</div>

---

shelfIt is a personal media library for one person and their household. It pulls
rich metadata and artwork from The Movie Database, lays your collection out as a
tactile shelf of DVD spines and disc art, and tracks what you own, what you have
watched, per-episode progress for series, ratings, and viewing statistics. It is
designed to be run at home in Docker, installed to the home screen as a Progressive
Web App, and used comfortably offline. It optionally talks to a local Kodi instance
so you can start playback from your phone, and it can pull in your history from a
TV Time export or an existing Kodi library.

It is deliberately **not** a multi-tenant service: there is one library, guarded by
a single app password (or magic-link login), and all data lives in a single SQLite
database and cache folder that you own.

> **In a hurry?** Jump to [Running shelfIt](#running-shelfit). There are three
> supported setups: [**A. localhost / LAN only**](#a-localhost--lan-only-no-reverse-proxy)
> (five small edits, no proxy), [**B. Tailscale + HTTPS behind a reverse proxy**](#b-tailscale--https-behind-a-reverse-proxy-recommended)
> (keep the defaults, add Caddy, reach it over your tailnet) and
> [**C. Dynamic DNS + port forwarding**](#c-dynamic-dns--port-forwarding) (the
> same proxy, exposed to the internet). Read [The `/shelfit/` base path](#the-shelfit-base-path-read-this-first)
> first: it is the one thing that trips up every new deployment.

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [The `/shelfit/` base path](#the-shelfit-base-path-read-this-first)
- [Running shelfIt](#running-shelfit)
  - [A. localhost / LAN only](#a-localhost--lan-only-no-reverse-proxy)
  - [B. Tailscale + HTTPS behind a reverse proxy](#b-tailscale--https-behind-a-reverse-proxy-recommended)
  - [C. Dynamic DNS + port forwarding](#c-dynamic-dns--port-forwarding)
  - [Serving it under a different sub-path](#serving-it-under-a-different-sub-path)
- [Configuration](#configuration)
- [Data layout](#data-layout)
- [Settings tour](#settings-tour)
- [Import guides](#import-guides)
- [Kodi integration](#kodi-integration)
- [Updating the app](#updating-the-app)
- [Backup and restore](#backup-and-restore)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [AI disclaimer](#ai-disclaimer)

## Screenshots

<table>
  <tr>
    <td width="33%"><img src="brand/screenshot/home.webp" alt="Home screen" /><br /><sub><b>Home</b> — profile, watch-time stats & currently watching</sub></td>
    <td width="33%"><img src="brand/screenshot/home_2.webp" alt="The Desk and The Wall" /><br /><sub><b>The Desk & The Wall</b> — ticket drawer, receipt printer, taped-up favourites</sub></td>
    <td width="33%"><img src="brand/screenshot/movies.webp" alt="Movies grid" /><br /><sub><b>Movies</b> — virtualised poster grid with filters & ratings</sub></td>
  </tr>
  <tr>
    <td><img src="brand/screenshot/details.webp" alt="Title detail" /><br /><sub><b>Detail</b> — disc art, status, ownership, Play on Kodi</sub></td>
    <td><img src="brand/screenshot/details-liner.webp" alt="Liner Notes" /><br /><sub><b>Liner Notes</b> — production, director, budget & tagline</sub></td>
    <td><img src="brand/screenshot/whats-next.webp" alt="What's Next" /><br /><sub><b>What's Next</b> — On the Horizon + Up Next progress</sub></td>
  </tr>
  <tr>
    <td><img src="brand/screenshot/btts.webp" alt="Back to the Shelf" /><br /><sub><b>Back to the Shelf</b> — spin up a disc you have already watched</sub></td>
    <td><img src="brand/screenshot/dustitoff.webp" alt="Dust It Off" /><br /><sub><b>Dust It Off</b> — pick by mood, duration, rating & era</sub></td>
    <td><img src="brand/screenshot/rateomatic.webp" alt="Rate-O-Matic" /><br /><sub><b>Rate-O-Matic</b> — quick-rate everything still unrated</sub></td>
  </tr>
  <tr>
    <td><img src="brand/screenshot/receipt.webp" alt="Monthly rental receipt" /><br /><sub><b>Rental receipt</b> — a shareable monthly wrap-up</sub></td>
    <td><img src="brand/screenshot/cinema.webp" alt="My Tickets" /><br /><sub><b>My Tickets</b> — a ticket per cinema screening, swipeable</sub></td>
    <td><img src="brand/screenshot/showcase.webp" alt="Feature showcase" /><br /><sub><b>Showcase</b> — the illustrated tour shown on first launch</sub></td>
  </tr>
  <tr>
    <td><img src="brand/screenshot/login.webp" alt="Login screen" /><br /><sub><b>Login</b> — password or passwordless magic-link</sub></td>
    <td></td>
    <td></td>
  </tr>
</table>

<sub>Screenshots come from a demo library built for this README — invented profile, ratings and watch history over real TMDB titles.</sub>

## Features

### Library management

- One personal library of movies and TV shows, each with ownership ("owned on
  disc"), watch status (plan to watch / watching / paused / completed /
  abandoned), rating, personal notes, watch dates, and rewatch counts.
- Per-episode and per-season progress for series, with **Mark all watched**,
  per-episode notes, rewatch tracking, and a **catch-up prompt** when earlier
  episodes were skipped (finishing a series fires confetti).
- An editable **"watched on" date**, and **dated movie rewatch events** you can
  add, list and delete individually — each one shows up on the monthly receipt.
- Movie collections / box sets grouped and shown with owned-vs-total progress.
- Custom user lists (e.g. "Must Watch") with rename and delete.
- Per-title **favourite hearts**; the posters and backdrops of favourited titles
  become the selectable profile photo and cover art in the Edit-profile modal.

### Browsing & discovery

- Live TMDB search with debounced input, and a read-only **preview** of a title
  before you add it to the library.
- Browsable **Explore** discovery rows, and a **What's Next** view combining
  *On the Horizon* (soon-airing) with *Up Next* (your next unwatched episodes),
  including rewatches in progress.
- **Virtualised, paginated poster grids** for Movies and Series: pages of 48
  titles, only the rows near the viewport in the DOM, and fetched pages plus
  scroll position cached per filter combination — so switching chips or coming
  back from a detail page never re-fetches or loses your place.
- Grid filters: All / Shelved / Watching / Plan to Watch / Paused / Dropped,
  plus **Owned** (owned on disc, any status) and, for movies, **Collections**;
  with **Genre** and **Sort** (Recently Added / Title A–Z / Rating) pickers.
  The Title and Rating sorts add section dividers, and Title A–Z adds an
  **A–Z letter strip** that jumps straight to a letter.
- **Person pages** (`/person/:id`): hero photo, birth date and place, a
  collapsible biography, and filmography rows split into *In your library*,
  *Also known for* and *Behind the camera*. You can upload your own photo for a
  person, swap the person, or remove them.
- The season screen is virtualised and paginated too, with shimmer placeholders
  for ranges not yet fetched and per-season scroll memory.

### Presentation & interaction

- **Shelf-style home screen** with animated DVD spines, disc art, watch-time
  stats, currently-watching cards and a potted-plant scene.
- **Back to the Shelf** — shuffle your *own* watched collection, rendered as a
  spinning disc, when you feel like rewatching something.
- **Dust It Off** — a mood / duration / rating / era picker that surfaces *new*
  titles to add.
- **Rate-O-Matic** — a quick-rating flow for everything still unrated.
- **The Wall** — one favourite film and one favourite series taped up either side
  of a framed portrait of your favourite person. Empty slots are "+" placeholders
  that open a picker; the tape and the ornate frame are inline SVG.
- **The Desk** — a wooden drawer that pulls open into your **cinema ticket**
  collection, above a thermal-printer widget that prints the **Monthly Rental
  Receipt**.
- **First-launch feature showcase** — a nine-page illustrated tour (CSS + inline
  SVG only) that opens once on the very first launch, with swipe, arrow keys,
  dots and Skip. The round **?** button at the top-left of the home cover reopens
  it any time.
- Haptics, confetti, and a **December-only snow effect** inside the home cover —
  both toggleable, and `prefers-reduced-motion` is respected throughout.

### Cinema tickets

- Toggling **Seen in cinema** on a movie's detail page mints a ticket — there is
  no separate "add ticket" flow.
- Every ticket is rendered from one shared component: a backdrop banner, the
  title, *ADMIT ONE* with a deterministic row/seat, a CSS-only barcode and an
  `SHF-nnnn` code.
- Date, time and **cinema name** are editable in place. The cinema field is a
  dropdown when `data/cinemas.txt` lists names and a free-text input otherwise
  (see [Data layout](#data-layout)).
- **My Tickets** (the desk drawer on Home) shows one ticket at a time with swipe
  or arrow navigation and a `1 / 27` position indicator, newest screening first.

### Monthly Rental Receipt

- A shareable wrap-up rendered as a 1990s thermal receipt: movies watched,
  each dated rewatch as its own line item, episodes grouped by series, total
  hours, top genre, a membership number and a closing line.
- A **month picker** rebuilds any past month exactly as it happened.
- Customisable background (solid colour, gradient presets, or a poster with
  optional blur) and a **Save as image** export that redraws the layout onto a
  1080×1920 canvas and downloads it as a JPEG.

### Metadata & artwork

- The Movie Database for metadata, posters, backdrops, cast, taglines and
  air dates.
- Optional Fanart.tv integration for clear logos and disc art (compressed to
  WebP on the server).
- On-disk and in-RAM image caches, warmed at boot with the highest-frequency
  images, with a Settings panel to scan cache size per folder, force a refresh
  of ongoing series, or wipe everything.
- **Self-imposed API budgets**: TMDB and Fanart.tv publish no monthly quota, so
  shelfIt meters its own metadata calls month by month against a cap you choose,
  shows how much of it you have used, and offers a session-only bypass.

### Languages & theming

- Full **English and Italian** UI, auto-detected from the browser on first run
  and switchable in Settings → General with no reload. Dates, numbers and
  plurals follow the chosen locale; your own notes stay as you typed them.
- A separate **metadata language** (Settings → Library) decides the language
  shelfIt asks TMDB for — titles, plots, taglines and episode names. Changing it
  re-downloads the metadata for every title you have, so the whole library
  switches over at once. English by default; an existing library keeps Italian
  until you choose otherwise.
- **System / dark / light** theme. *System* follows the OS preference live, and
  the browser theme colour follows along. A quick flip button on the home cover
  pins the opposite of whatever is currently showing.

### Kodi

- Connect one or more local Kodi instances (host, port, credentials stored
  server-side and encrypted at rest), pick an icon per instance, and test the
  connection from Settings.
- **Play on Kodi** starts playback of a title from its detail page.
- **Now Playing**: a pulsing chip in the header and a wavy progress ring around
  the home avatar while Kodi is playing. Tapping either opens a toast with the
  poster, title or `SxxExx` label and audio/subtitle info, plus a one-tap
  **Mark as watched** / **Add rewatch**.
- **Library sync over JSON-RPC** (distinct from the one-off XML import): runs
  daily at 22:00, or on demand from Settings. It is additive and never
  destructive — it only *advances* watch status and collects titles Kodi has that
  shelfIt does not, holding them as "pending review" so you approve each one in a
  review sheet before anything is written.
- **Kodi XML import** of an existing library from a `videodb.xml` export.

### Statistics

- Aggregate watch-time and counts on the home screen, computed from movie
  runtimes and per-episode series runtimes, including rewatches.

### PWA / offline

- Installable to the home screen (Android/Chromium and iOS) with a service
  worker; the *Install* row in Settings triggers the native prompt on Android and
  shows illustrated Share-sheet instructions on iOS.
- The home screen paints instantly from a durable local cache (name, avatar,
  cover, badge, stats, currently-watching posters — image bytes included, so an
  iOS PWA relaunch still has them) and revalidates from the network.
- Offline, **Plan to Watch** detail pages open read-only, **Up Next** cards and
  the whole **What's Next** payload still render (countdowns recomputed from
  absolute air dates), and **The Wall** keeps its three images inline.
- **Share target**: share a TMDB link from any other app straight into shelfIt
  and it opens that title; any other shared text pre-fills search.
- Web push notifications (VAPID, implemented with Node's built-in crypto — no
  extra dependency) for **newly aired episodes** of shows you are watching,
  either one per show or a digest when several air at once, plus a test
  notification from Settings.

### Import & backup

- TV Time CSV import and Kodi XML import, both rate-limited against TMDB.
- Full, portable **XML library export / import** (statuses, ratings, play counts,
  ownership, favourites, cinema fields, notes, watch dates, dated rewatches,
  per-episode progress, list memberships) with a SHA-256 integrity checksum.
  Import is **merge-only and never deletes**; older format versions still import,
  and the UI reports added / merged / unchanged counts plus any failures.
  Metadata is never exported — it is re-fetched from TMDB on import.

### Authentication & security

- Single app password, hashed with scrypt into the database; the server refuses
  to boot in production without one unless you explicitly opt out.
- Passwordless **magic-link** login for signing in on another device (tokens are
  redacted from the server logs).
- **Sign out of all devices** invalidates every session everywhere, including the
  current one.
- **Recent access** list built from a privacy-preserving log that stores only
  salted hashes of IP and user-agent, pruned after 90 days.
- Per-IP **rate limiting** on `/api/*` (with tighter ceilings on search, Explore,
  bulk imports and photo uploads) and stricter failed-attempt limits on login and
  magic-link redemption, with an escalating delay.
- Path-traversal guards on every filesystem path derived from a request, a tight
  default body limit, correct client-IP extraction behind a reverse proxy, and no
  stack-advertising response headers. Optional no-auth mode for trusted LAN-only
  deployments.

## Tech stack

| Layer | Technology | Version |
| --- | --- | --- |
| Runtime | Node.js | 22 |
| Backend | Fastify | ^4 |
| Database | SQLite via better-sqlite3 | ^9 |
| Frontend | Vanilla JavaScript (no framework) | — |
| Build / dev | Vite | ^5 |
| Metadata | The Movie Database (TMDB) API | v3 |
| Artwork (optional) | Fanart.tv API | v3 |
| Media control (optional) | Kodi JSON-RPC | — |
| Image tooling | cwebp (libwebp-tools) | runtime |
| Packaging | Docker (multi-stage, `node:22-alpine`) | — |
| Reverse proxy (optional) | Caddy | 2 |

There are **no runtime dependencies beyond the five in `package.json`** — push
notifications, the XML parser, the image pipeline and every visual effect are
built on Node and browser primitives.

## Prerequisites

- **Docker** and Docker Compose (the supported way to build and run).
- A free **TMDB API key** — required. Create an account at
  [themoviedb.org](https://www.themoviedb.org/) and request a v3 API key under
  Settings → API.
- _Optional_ **Fanart.tv API key** for higher-quality logos and disc art —
  [fanart.tv/get-an-api-key](https://fanart.tv/get-an-api-key/).
- _Optional_ **Kodi** instance on your LAN for remote playback and sync.
- _Optional_ **Tailscale** on the host and on every device that should reach the
  app, for setup B; or a **DDNS hostname** and a router that can forward ports
  80/443, for setup C.
- For local (non-Docker) development only: **Node.js 22** — the `better-sqlite3`
  native addon does not build cleanly on newer Node without the right toolchain.

## The `/shelfit/` base path (read this first)

Out of the box the client bundle is built with a **sub-path base of `/shelfit/`**
(`client/vite.config.js` → `base: '/shelfit/'`), while the Node server always
serves everything at its **own root** (`/`, `/api/*`, `/assets/*`). That split is
deliberate: it lets several self-hosted apps share one hostname, each under its
own `/prefix`, with a reverse proxy stripping the prefix before forwarding.

The practical consequence, and the single most common setup mistake:

> **As shipped, hitting the container's port directly does not work.** The HTML
> shell loads, but it asks for `/shelfit/static/index-<hash>.js`, the server has
> no such file, the SPA fallback answers with `index.html`, and the browser
> reports something like `Unexpected token '<'` — a blank page. This is not a
> bug; it means the app is being served at a path its bundle was not built for.

So you must pick one of these consistent arrangements:

| | Base path | Reached at | Reverse proxy | Edits needed |
| --- | --- | --- | --- | --- |
| **A** | `/` (root) | `http://<host>:3000/` | none | 5 files, once |
| **B** | `/shelfit/` (default) | `https://<machine>.<tailnet>.ts.net/shelfit/` and `http://localhost/shelfit/` | required | none |
| **C** | `/shelfit/` (default) | `https://<ddns>/shelfit/` and `http://localhost/shelfit/` | required | none |

Setup **A** is the shortest path to a working app on one machine or a home LAN.
Setup **B** is what this repository ships configured for: automatic HTTPS on
every device in your tailnet, nothing exposed to the internet, no router
configuration, and other apps beside shelfIt on the same hostname. Setup **C**
uses the same proxy but publishes it on a public DDNS address instead.

## Running shelfIt

Common to both setups:

```bash
git clone <your-repo-url> shelfit
cd shelfit
cp .env.example .env
```

Then edit `.env` and set at least:

```ini
TMDB_API_KEY=your_tmdb_v3_key
APP_PASSWORD=choose_a_strong_password
```

Everything else is optional — see [Configuration](#configuration).

---

### A. localhost / LAN only (no reverse proxy)

Serve the app at the root of a published port: `http://localhost:3000/`, and
`http://<lan-ip>:3000/` from any other device in the house.

#### A1. Set the base path to the root

The mount path lives in exactly **five** places. Change all five, or none — a
mismatch is what produces the blank page described above.

**1. `client/vite.config.js`** — the source of truth for the client:

```diff
-  base: '/shelfit/',
+  base: '/',
```

**2. `client/public/manifest.json`** — drop the prefix from `start_url`, `scope`,
the three icon `src` values and the share-target `action`:

```diff
-  "start_url": "/shelfit/",
-  "scope": "/shelfit/",
+  "start_url": "/",
+  "scope": "/",
   "icons": [
-    { "src": "/shelfit/icons/icon-192.png", ... },
-    { "src": "/shelfit/icons/icon-512.png", ... },
-    { "src": "/shelfit/icons/icon-512.png", ..., "purpose": "maskable" }
+    { "src": "/icons/icon-192.png", ... },
+    { "src": "/icons/icon-512.png", ... },
+    { "src": "/icons/icon-512.png", ..., "purpose": "maskable" }
   ],
   "share_target": {
-    "action": "/shelfit/share",
+    "action": "/share",
```

**3. `client/public/sw.js`** (near the top) — the service worker sees real,
browser-side paths, so it needs the prefix explicitly:

```diff
-const BASE = '/shelfit';
+const BASE = '';
```

**4. `server/auth.js`** — used only for URLs handed back to the browser (the
login redirect, the login page's own asset references, the session-cookie scope):

```diff
-const BASE = '/shelfit';
+const BASE = '';
```

**5. `server/routes/share.js`** — the share-target redirects:

```diff
-const BASE = '/shelfit';
+const BASE = '';
```

Nothing else needs touching: the client derives its prefix from Vite's `base`
(`client/src/basePath.js`), including the service-worker registration and scope.

#### A2. Publish the port

Replace `docker-compose.yml` with the standalone version — it publishes port 3000
and needs no shared Docker network:

```yaml
services:
  shelfit:
    build: .
    container_name: shelfit
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

(If you prefer to keep the shipped file, just uncomment its `ports:` block, and
either delete the `networks:` sections or run `docker network create webproxy`
once so the external network exists.)

#### A3. Build and start

```bash
docker compose up -d --build
```

Open **`http://localhost:3000/`**. From another device on the LAN, use the host's
address, e.g. `http://192.168.1.50:3000/`.

#### A4. Optional, for LAN devices

Set `PUBLIC_URL` in `.env` to the address other devices actually type, so
magic-link logins point at a host they can reach:

```ini
PUBLIC_URL=http://192.168.1.50:3000
```

No trailing slash, no sub-path. Restart with `docker compose up -d` afterwards.

> **Note:** browsers only allow home-screen installation, push notifications and
> some PWA behaviour over HTTPS or on `localhost`. Over plain HTTP to a LAN IP the
> app works, but "Add to Home Screen" and notifications may be unavailable — that
> is a browser rule, not a shelfIt limitation. If you want those on your phone,
> use setup B.

---

### B. Tailscale + HTTPS behind a reverse proxy (recommended)

Keep every default (base path `/shelfit/`, no published port), put Caddy in
front, and let [Tailscale](https://tailscale.com/) carry the traffic. You get,
with one configuration:

- `https://<machine>.<tailnet>.ts.net/shelfit/` on every device signed in to
  your tailnet, with a certificate Tailscale issues and renews;
- `http://localhost/shelfit/` on the host machine;
- nothing reachable from the internet or the LAN: no DDNS hostname and no router
  port forwarding;
- room for other apps beside shelfIt under their own prefixes.

The examples below use `myserver.tail1234.ts.net`; replace it with your host's
own Tailscale name (shown on the Machines page of the admin console).

#### B1. Prepare Tailscale

1. Install Tailscale on the host and on each phone, tablet or laptop that should
   reach the app, all signed in to the same tailnet.
2. In the Tailscale admin console, under **DNS**, enable **MagicDNS** and
   **HTTPS Certificates**. HTTPS is not optional here: home-screen installation,
   the service worker and push notifications all need a secure context.

#### B2. Create the shared Docker network (once)

```bash
docker network create webproxy
```

The shipped `docker-compose.yml` joins this external network and publishes **no**
host port, so shelfIt is reachable only through the proxy, by container name.

#### B3. Start shelfIt

```bash
docker compose up -d --build
```

#### B4. Add the reverse proxy

Create a **separate** compose project (e.g. `~/caddy/`) so the proxy can be
managed independently of any app it fronts.

`~/caddy/docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    container_name: caddy
    restart: unless-stopped
    # Loopback only: Tailscale (B5) is the one way in from other devices.
    ports:
      - "127.0.0.1:80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data:/data
      - ./config:/config
    networks:
      - webproxy

networks:
  webproxy:
    external: true
```

`~/caddy/Caddyfile`, the minimum that works:

```caddyfile
{
	servers {
		# Requests from `tailscale serve` arrive through Docker's port forward,
		# i.e. from a private address, carrying the real scheme (https) and the
		# device's Tailscale IP in X-Forwarded-* headers. Trust them. This is safe
		# only because Caddy listens on 127.0.0.1 alone, so nobody else can
		# forge those headers.
		trusted_proxies static private_ranges
		trusted_proxies_strict
	}
}

# Every entry carries http://: TLS is done by Tailscale, not by Caddy.
http://myserver.tail1234.ts.net, http://localhost, http://127.0.0.1 {

	# handle_path STRIPS /shelfit before forwarding, so the app still serves
	# everything at its own root, which is exactly what it expects.
	handle_path /shelfit/* {
		reverse_proxy shelfit:3000 {
			# Give shelfIt the device's Tailscale IP (rate limiting, access log)
			# instead of the Docker gateway Caddy would otherwise append last.
			header_up X-Forwarded-For {client_ip}
		}
	}

	# Bare path → trailing slash, so the PWA scope and the SPA router agree.
	redir /shelfit /shelfit/
}
```

Recommended additions — security headers and cache policy:

<details>
<summary>Fuller <code>handle_path</code> block (click to expand)</summary>

```caddyfile
	handle_path /shelfit/* {
		header {
			# Start in report-only: the shell and the login page each contain one
			# inline <script>, which a strict script-src would block. Externalise
			# or hash them before switching to the enforcing header name.
			Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
			X-Frame-Options "DENY"
			X-Content-Type-Options "nosniff"
			Referrer-Policy "strict-origin-when-cross-origin"
			Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()"
			Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
			-Server
			-X-Powered-By
		}

		# Vite output is content-hashed → cache forever.
		@static path /static/*
		header @static Cache-Control "public, max-age=31536000, immutable"
		# Stable but unhashed names → a week.
		@icons path /icons/*
		header @icons Cache-Control "public, max-age=604800"
		# Manifest may change on deploy → short TTL.
		@manifest path /manifest.json
		header @manifest Cache-Control "public, max-age=3600"
		# The service worker must always revalidate, so a new version ships at once.
		@sw path /sw.js
		header @sw Cache-Control "no-cache"

		# Do NOT set Cache-Control for /assets/* or /api/* here — the app already
		# sends the right headers per endpoint and `header` would clobber them.
		reverse_proxy shelfit:3000 {
			header_up X-Forwarded-For {client_ip}
		}
	}
```

Rate limiting is deliberately **not** done at the proxy: the `rate_limit`
directive ships in a third-party module the stock `caddy:2-alpine` image does not
include, so adding it would break `caddy validate` for every app behind the proxy.
shelfIt enforces its own per-IP limits instead.

</details>

Then start it and check the config:

```bash
docker compose up -d
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

#### B5. Publish it on your tailnet

On the host:

```bash
tailscale serve --bg http://127.0.0.1:80
```

Tailscale now answers on `https://myserver.tail1234.ts.net/` (port 443, tailnet
devices only), terminates TLS with its own certificate and forwards plain HTTP to
Caddy. The setting survives reboots. Check it with `tailscale serve status`;
remove it with `tailscale serve reset`. It touches only this machine's own node.

> **Several Tailscale accounts on one host?** `serve` belongs to the account that
> was active when you ran it, and answers only while that account is the active
> one. Switch the host to another tailnet and the app is unreachable until you
> switch back.

#### B6. Tell the app its public origin

```ini
PUBLIC_URL=https://myserver.tail1234.ts.net
```

**No trailing slash and no `/shelfit` suffix**: shelfIt appends the sub-path
itself. This value is used to build magic-link URLs that must work on your other
devices, and it is the one non-localhost origin allowed by CORS. Restart with
`docker compose up -d` after changing it.

Open **`https://myserver.tail1234.ts.net/shelfit/`** from any device with
Tailscale connected, or `http://localhost/shelfit/` on the host itself. Both
serve the same container.

#### Adding more apps later

Copy the `handle_path` block (with its `header_up` line), change the prefix,
container name and port, then reload Caddy, provided that app is also built for
its own sub-path. Tailscale needs no change: it forwards everything to Caddy.

---

### C. Dynamic DNS + port forwarding

The same reverse proxy as setup B, but facing the internet with its own Let's
Encrypt certificate instead of sitting behind Tailscale. Anyone can reach the
login page, so keep `APP_PASSWORD` strong.

1. Create a DDNS hostname (No-IP, DuckDNS, your router's built-in provider …) and
   let it track your home IP address, e.g. `yourname.ddns.net`.
2. On your router, **forward TCP 80 and 443** (and UDP 443 if you want HTTP/3) to
   the machine that will run Caddy. Port 80 must be reachable: Let's Encrypt uses
   it for the HTTP challenge. Give that machine a static or reserved LAN address,
   so the forward keeps pointing at it.
3. Follow B2 to B4 with three differences:
   - publish Caddy on every interface:
     ```yaml
         ports:
           - "80:80"        # ACME HTTP challenge + HTTP→HTTPS redirect
           - "443:443"      # HTTPS
           - "443:443/udp"  # HTTP/3 (QUIC)
     ```
   - drop the global `servers { trusted_proxies … }` block and the `header_up`
     lines: Caddy talks to browsers directly, so its own view of the client IP is
     already the right one, and trusting forwarded headers from the LAN would let
     anyone there fake their address;
   - name the DDNS host on the site line (no `http://`, so Caddy fetches a
     certificate for it), plus this machine's LAN address if other devices in the
     house should use plain HTTP:
     ```caddyfile
     yourname.ddns.net, http://localhost, http://127.0.0.1, http://192.168.1.50 {
     ```
4. Skip B5, and set `PUBLIC_URL=https://yourname.ddns.net` as in B6.

---

### Serving it under a different sub-path

Want `/library/` instead of `/shelfit/`? Change the same five places listed in
[A1](#a1-set-the-base-path-to-the-root), using `/library/` (and `'/library'` for
the two `const BASE` lines and the service worker), then change
`handle_path /shelfit/*` and `redir /shelfit /shelfit/` in the `Caddyfile` to
match. Rebuild afterwards — the prefix is baked into the client bundle.

## Configuration

All variables are read from `.env` at container startup. Only `TMDB_API_KEY` and
`APP_PASSWORD` are required for a normal deployment.

| Variable | Description | Required | Default |
| --- | --- | --- | --- |
| `TMDB_API_KEY` | TMDB v3 API key — powers all metadata and artwork. | **Yes** | — |
| `APP_PASSWORD` | Login password; hashed (scrypt) into the DB on first boot, then removable from `.env`. | **Yes** (unless `ALLOW_NO_AUTH`) | — |
| `APP_PASSWORD_RESET` | Set `true` together with a new `APP_PASSWORD` to change the stored password once, then remove both lines. | No | `false` |
| `ALLOW_NO_AUTH` | Run with no login gate (trusted LAN only). Without it the server refuses to start in production with no password. | No | `false` |
| `PORT` | Port the Node server listens on inside the container. | No | `3000` |
| `PUBLIC_URL` | External origin the app is reached at — no trailing slash, **no sub-path**. Used for magic-link URLs and as the only non-localhost CORS origin. | No | request host |
| `FANART_API_KEY` | Fanart.tv key for clear logos / disc art. | No | — |
| `CACHE_MAX_AGE_DAYS_MOVIES` | Days before cached movie metadata is refreshed. | No | `180` |
| `CACHE_MAX_AGE_DAYS_SHOWS` | Days before cached show metadata is refreshed. | No | `7` |
| `EXPLORE_TTL_MIN` | Minutes the Explore discovery rows are cached. | No | `90` |
| `VAPID_SUBJECT` | Contact address for web-push VAPID headers (the keypair itself is generated once and stored in the DB). | No | `mailto:shelfit@example.com` |

Not environment variables, but worth knowing they exist: the **mount path** (five
files, see [A1](#a1-set-the-base-path-to-the-root)), the **API budget caps** and
**Kodi instances** (both configured in Settings, stored in the database), and the
**cinema list** (`data/cinemas.txt`).

## Data layout

Everything persistent lives under `data/`, mounted into the container as
`/app/data`. Back up (or exclude, for a public repo) this whole directory.

| Path | Contents |
| --- | --- |
| `data/shelfit.db` | The SQLite database (library, progress, settings, Kodi instances, access log). Accompanied by `-wal` / `-shm` files while running. |
| `data/cache/` | Cached TMDB/Fanart metadata JSON and images. Regenerable; safe to wipe. |
| `data/badges/` | Collection badge images shown on the shelf. |
| `data/import/` | Drop-zone for import files (TV Time CSVs, Kodi `videodb.xml`). |
| `data/profile/` | The single user profile photo. |
| `data/cinemas.txt` | Optional, one cinema name per line — turns the ticket's cinema field into a dropdown. Re-read on every open, no restart needed; `#` comments and blank lines ignored. Copy `data/cinemas.example.txt` to start. |
| `data/kodi.key` | Key used to encrypt stored Kodi credentials at rest. |
| `data/backups/` | Manual database snapshots. |
| `data/caddy/` | Reverse-proxy state (certificates, ACME account) — only present when Caddy stores its data here. |

> **Public repository note:** `data/` contains private data (the database, cached
> artwork, imported personal history, TLS/ACME keys, and the Kodi encryption key).
> Keep it out of any public mirror. The default `.gitignore` ignores the
> regenerable `data/cache/` and `data/profile/`; a public clone should exclude the
> entire `data/` tree.

## Settings tour

Settings is a scrolling tab strip; the **Account** tab appears only when login is
enabled.

| Tab | Sections |
| --- | --- |
| **General** | *Appearance* — language, theme, snow effect, vibration. *Install* — Add to Home Screen. *Notifications* — enable, plus a test notification. |
| **Library** | *Metadata language* — the language TMDB metadata is fetched in (English / Italian). *Lists* — create / rename / delete custom lists. *Backup* — XML export and import. *Import from TV Time*. |
| **Kodi** | Instances (add, name, icon, test, activate), the master enable toggle, and **Sync now**. |
| **Advanced** | *API Usage* — monthly budget and usage per API, with a session-only bypass. *Cache* — scan size per folder, refresh ongoing series, clear all media cache (confirm-gated). |
| **Account** | Sign out, **Recent access**, **Sign out of all devices**, and **Magic Links**. |

## Import guides

### TV Time (CSV)

1. Request your data export from TV Time and unzip it.
2. Copy the relevant CSV files into `data/import/`.
3. In the app open **Settings → Library → Import from TV Time** and start the
   import. Titles are matched against TMDB (rate-limited) and added with their
   watch history.

### Kodi (XML)

1. Export your Kodi video library to a `videodb.xml`.
2. Place it in `data/import/`.
3. Open **Settings → Library** and run the Kodi import.

### Another shelfIt instance (XML)

Export from **Settings → Library → Backup** on the source instance and import the
file on the target. The merge is additive and never deletes; see
[Backup and restore](#backup-and-restore).

## Kodi integration

1. Enable the JSON-RPC / remote-control interface in Kodi
   (**Settings → Services → Control**), noting host, port, and any username /
   password.
2. In shelfIt open **Settings → Kodi** and add an instance; credentials are stored
   server-side and encrypted at rest (`data/kodi.key`), and passwords are never
   sent back to the browser. Use **Test** to verify, then make it active. The
   browser never talks to Kodi directly — all calls go through the server.
3. On a title's detail page, use **Play on Kodi** to start playback.
4. Leave the integration enabled and shelfIt will also **sync** once a day at
   22:00 (or on demand with **Sync now**): it advances watch status for titles it
   already knows and queues anything new for your review. It never downgrades a
   status and never deletes, and nothing is written until you confirm the review
   sheet.

> **Note:** playback works only for titles that have already been added to your
> **Kodi library** beforehand. The source does not matter — a local file or a
> streaming source played through Kodi both qualify — the title simply has to be
> present in Kodi's library so it can be matched and started.

## Updating the app

The client bundle is **baked into the Docker image**, so a plain restart only
picks up changes under `server/`.

```bash
# Server-only change:
docker compose up -d --build shelfit

# Client change (JS/CSS/HTML/icons): first bump the service-worker cache name in
# client/public/sw.js  →  const CACHE = 'shelfit-shell-v71';
# otherwise the cache-first service worker keeps serving the old shell.
docker compose up -d --build shelfit
```

Then reload the app once. In an installed PWA, close and reopen it.

## Backup and restore

- **Database:** the entire library lives in `data/shelfit.db`. To back up, stop
  the container and copy the file (together with any `-wal` / `-shm` files). To
  restore, put it back in `data/` and start the container again.
- **Portable export:** **Settings → Library → Backup** writes an XML file with all
  user-owned data (statuses, ratings, play counts, ownership, favourites, cinema
  fields, notes, watch dates, dated rewatches, per-episode progress, list
  memberships) and a SHA-256 checksum. Import **merges additively and never
  deletes**, resolving conflicts in favour of the more advanced status; metadata
  is re-fetched from TMDB, so the file stays small and portable across versions.
- **Artwork** in `data/cache/` is regenerable and does not need backing up.

## Development

Local development runs the Fastify server and the Vite dev server side by side.
Use **Node.js 22** so the `better-sqlite3` native addon builds.

```bash
npm install
npm run dev
```

Vite serves the client on **`http://localhost:5173/shelfit/`** and proxies `/api`,
`/assets` and `/badges` to Fastify on port 3000. The dev server honours the same
`base` as the build, so the sub-path behaves exactly as in production.

| Script | Action |
| --- | --- |
| `npm run dev` | Run server + Vite dev server concurrently. |
| `npm run build` | Build the client bundle into `client/dist`. |
| `npm start` | Run the server only (`node server/index.js`). |
| `npm run docker:build` | `docker compose build`. |
| `npm run docker:up` | `docker compose up -d`. |
| `npm run docker:logs` | Follow container logs. |

A one-time helper, `node scripts/download-icons.js`, refreshes the bundled Lucide
SVG icons; it is not part of the build.

One convention worth knowing before you write UI:

- **Every visible string needs an `it` and an `en` key** in
  `client/src/i18n.js`; `t()` must never be called at module level, since the
  language can change while the app is open.

## Troubleshooting

**Blank page, and the console shows `Unexpected token '<'` or 404s for
`/shelfit/static/…`.**
The base path and the URL disagree. Either you are hitting the container port
directly with the default `/shelfit/` build (use the proxy, or switch to
[setup A](#a-localhost--lan-only-no-reverse-proxy)), or only some of the five
files were changed. See [The `/shelfit/` base path](#the-shelfit-base-path-read-this-first).

**`502 Bad Gateway` from Caddy.**
The proxy cannot reach the container: make sure both are on the `webproxy`
network (`docker network create webproxy`, then recreate both projects) and that
the `reverse_proxy` target matches shelfIt's `container_name` and port.

**The `ts.net` address does not load (setup B).**
Check that the device has Tailscale connected, that `tailscale serve status` on
the host lists the proxy to `http://127.0.0.1:80`, and that the host is on the
tailnet you served from. The very first HTTPS request can take a few seconds
while Tailscale fetches the certificate. If HTTPS works but you get Caddy's empty
response, the `ts.net` name is missing from the `Caddyfile` site line.

**Every device shows up as the same address, or one bad login locks out all of
them (setup B).**
Caddy is passing the Docker gateway instead of the device IP: add the global
`trusted_proxies` block and the `header_up X-Forwarded-For {client_ip}` line from
B4.

**The site loads over HTTP but the certificate never appears (setup C).**
Ports 80 *and* 443 must be forwarded to the Caddy host and the DDNS name must
resolve to your current public IP. Check `docker compose logs caddy` for the ACME
error. Names that cannot be validated (`localhost`, bare IPs) must be listed with
an explicit `http://` scheme.

**Old UI after a rebuild.**
Bump `CACHE` in `client/public/sw.js` and rebuild; the service worker is
cache-first for the shell. As a last resort, clear site data for the origin.

**Server exits with "Refusing to start with authentication disabled".**
Set `APP_PASSWORD` in `.env`, or deliberately set `ALLOW_NO_AUTH=true` for a
LAN-only instance.

**A magic link opens the wrong address, or does not work on another device.**
Set `PUBLIC_URL` to the origin your devices use (the `ts.net` name in setup B),
with no trailing slash and no `/shelfit` suffix.

**Search finds nothing and titles will not add.**
`TMDB_API_KEY` is missing or wrong — the boot log warns about this explicitly.

**"Add to Home Screen" or notifications are missing.**
Browsers gate both on a secure context. Use HTTPS (setup B or C) or `localhost`; plain
HTTP to a LAN IP will not do.

**Play on Kodi says the title cannot be found.**
The title has to exist in Kodi's own library first — see
[Kodi integration](#kodi-integration).

**The feature tour does not appear.**
It shows itself only once, on a genuinely first launch. Reopen it any time with
the **?** button at the top-left of the home cover.

## Contributing

Contributions are welcome. For anything beyond a small fix, please open an issue
to discuss the change before sending a pull request, so the direction can be
agreed first. Keep changes focused, match the existing code style, add both
language keys for any new string, and remember that client changes ship through a
Docker rebuild with a service-worker cache bump.

## License

The **source code** of shelfIt is released under the [MIT License](LICENSE) —
take it, read it, fork it, modify it, ship it, build something else out of it.
Attribution is the only condition: keep the copyright and permission notice with
any substantial copy of the code. There is no obligation to open-source your
changes, and no warranty of any kind is given.

Contributions are accepted under the same terms: by opening a pull request you
agree that your contribution is licensed under MIT.

### Third-party assets and attribution

The MIT license covers the code **only**. Everything visual that shelfIt bundles,
downloads or displays belongs to its respective owner and is **not** relicensed
here. If you reuse this code, replace these assets or satisfy their terms
yourself.

| Asset | Owner / source | Terms |
| --- | --- | --- |
| Interface icons (`client/public/icons/lucide/`) | [Lucide](https://lucide.dev/) contributors | ISC License |
| Animated mood emoji (`client/public/icons/animated-genre/`) | **JoyPixels Animations** | JoyPixels' own license — free for **personal, non-commercial** use; a commercial license is required otherwise |
| Kodi logo and related marks | XBMC Foundation | Trademark of its owner; used for identification only |
| The DVD Video logo | DVD Format/Logo Licensing Corp. | Trademark of its owner; used decoratively for identification only |
| TMDB logo and all metadata, posters, backdrops, stills and cast photos | [The Movie Database](https://www.themoviedb.org/) and the respective studios and rights holders | TMDB API terms of use; artwork remains © its rights holders |
| Clear logos and disc art | [Fanart.tv](https://fanart.tv/) and the respective rights holders | Fanart.tv API terms of use |
| LZ compression helper (trimmed from `lz-string` 1.4.4, in `client/src/offlineCache.js`) | pieroxy | Public domain (WTFPL) |
| Screenshots in `brand/screenshot/` | Contain film and TV artwork © the respective studios | Shown for illustration only |

> This product uses the TMDB API but is **not** endorsed or certified by TMDB.
> shelfIt is not affiliated with, endorsed by, or sponsored by TMDB, Fanart.tv,
> JoyPixels, the XBMC Foundation, TV Time, or any studio or rights holder whose
> artwork it displays. All trademarks and artwork are the property of their
> respective owners.

### Personal, non-commercial use

shelfIt is a personal project, built to catalogue one household's own media
library, and it is meant to be used that way: **privately, for personal,
non-commercial purposes.** It is not a product, not a service, and not intended
to be sold, resold, hosted as a paid offering, or used to distribute or
redistribute copyrighted content. It stores no media — only your own notes about
what you own and what you have watched.

The MIT license deliberately does not restrict what you may do with the *code*.
The non-commercial expectation applies to this application as assembled here,
because of the third-party assets and APIs listed above. Run a commercial
service on top of this code and you take on the job of replacing those assets
and of complying with TMDB's, Fanart.tv's and JoyPixels' terms yourself.

## AI disclaimer

**This application was built entirely with the help of AI.** Every part of it —
the architecture, the server and client code, the database schema and migrations,
the visual design and illustrations, this README and the design-system guide —
was produced through AI-assisted development rather than written by hand.

That said, it was not generated and forgotten. Each feature was **continuously
exercised, tested and reviewed** on a real deployment with a real library before
being kept: behaviour verified in the browser and on a phone as an installed PWA,
edge cases probed, and the code read back with an eye on correctness, security
and good practice (parameterised SQL, hashed secrets and encrypted credentials at
rest, rate limiting and path-traversal guards, non-destructive imports and
merges, graceful offline and error paths, no unnecessary dependencies). Where the
first attempt was wrong, it was corrected and re-checked.

It remains, however, a personal single-user project rather than audited software.
It is offered as-is, with no warranty of any kind. If you expose your instance to
the internet, keep a password on it, keep backups of `data/`, and review the code
yourself before trusting it with anything you cannot afford to lose.
