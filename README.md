# Meta Ad Spy

A self-hosted tool for **scraping, browsing, and AI-analyzing the top-performing ads** that DTC (direct-to-consumer) brands run on Meta's Ad Library (Facebook & Instagram).

Add the brands you want to track, scrape their currently-running ads via [Apify](https://apify.com), and the app automatically keeps the **top 10 unique, highest-impression creatives per brand**. Browse them in a clean gallery, bookmark your favorites, and use **Google Gemini** to automatically tag each ad by its creative strategy (asset type, visual format, messaging angle, hook, and offer).

> Think of it as a competitor-research swipe file: see what's working for the brands you admire, understand *why* it works, and save the best for inspiration.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started (Local Setup)](#getting-started-local-setup)
- [Environment Variables](#environment-variables)
- [Using the App](#using-the-app)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [AI Tagging Taxonomy](#ai-tagging-taxonomy)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Brand management** — Add, edit, and delete brands by pasting their Meta Ad Library URL. The Facebook page ID is extracted automatically.
- **One-click scraping** — Scrape a single brand, or hit **Scrape All** to run every active brand sequentially. Powered by the Apify Meta Ad Library actor.
- **Smart deduplication** — Meta returns lots of duplicate creatives. A 3-pass dedupe (by ad ID → media URL → headline) keeps only genuinely unique ads, ranked by impressions, top 10 per brand.
- **Ad gallery** — A responsive grid of 9:16 ad cards with thumbnails, video/image badges, infinite scroll, and a detail modal showing full ad copy, CTA, and a deep link back to the Meta Ad Library.
- **Powerful filtering** — Filter by multiple brands, media type (video/image), and AI tags; sort by Top Ranked / Newest / Oldest. All filtering happens server-side so pagination stays correct.
- **Bookmarks** — Save favorite ads to a dedicated tab. Bookmarked ads are **never deleted on re-scrape**, even if they drop out of the top 10.
- **AI creative analysis** — Send any ad's image or video to Google Gemini, which classifies it across 5 strategic dimensions and writes a short summary.
- **Demo mode** — With no API keys and an empty database, the app serves mock brands and ads so you can explore the UI immediately.

---

## How It Works

```
┌──────────────┐     1. Add brand          ┌──────────────────┐
│              │  (Meta Ad Library URL)    │                  │
│   Browser    │ ────────────────────────► │  Express Server  │
│  (index.html)│                           │   (server.js)    │
│              │ ◄──────────────────────── │                  │
└──────────────┘     JSON responses        └────────┬─────────┘
                                                     │
                          2. Start scrape           │ stores brands,
                          ──────────────────────────┤ ads, jobs
                                                     ▼
                    ┌──────────────┐         ┌──────────────┐
                    │    Apify     │         │   SQLite     │
                    │ Ad Library   │         │  (db/app.db) │
                    │   actor      │         └──────────────┘
                    └──────┬───────┘
                           │ 3. raw ads
                           ▼
                  rank by impressions
                  → 3-pass dedupe
                  → keep top 10 / brand
                           │
                           ▼
                    ┌──────────────┐   4. analyze (on demand)
                    │ Google Gemini│ ◄─── image / video creative
                    │  2.5 Flash   │ ───► 5-dimension tags + summary
                    └──────────────┘
```

**The lifecycle of an ad:**

1. **You add a brand** by pasting its Meta Ad Library URL. The server pulls the `view_all_page_id` out of the URL and stores it.
2. **You click Scrape.** The server builds a clean Ad Library URL (sorted by total impressions) and starts an Apify actor run, recording a job in the `scrape_jobs` table. The browser polls the job until it completes.
3. **When the run finishes**, the server fetches the results, ranks them by impressions, runs the 3-pass dedupe, and saves the **top 10 unique ads** for that brand. Older ads are pruned — *except* bookmarked ones, which are always preserved.
4. **You browse and filter** the ads. Optionally, you click **Analyze** on an ad to send its creative to Gemini, which returns strategic tags that you can then filter by.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (18+) |
| Backend | Express.js |
| Database | SQLite via `better-sqlite3` (synchronous, file-based — zero setup) |
| Scraping | Apify (`apify-client`) — Meta Ad Library actor `JJghSZmShuco4j9gJ` |
| AI analysis | Google Gemini 2.5 Flash (`@google/generative-ai`) — multimodal image/video |
| Frontend | Single-page `index.html` — vanilla JavaScript + Tailwind CSS (via CDN, no build step) |
| Config | `dotenv` for local secrets |

There is **no build step** and **no frontend framework** — the entire UI is one HTML file.

---

## Prerequisites

- **Node.js 18 or newer** ([download](https://nodejs.org)). Check with `node --version`.
- **An Apify account + API token** (free tier available) — required to scrape ads.
  Get one at <https://console.apify.com/account/integrations>.
- **A Google Gemini API key** (free tier available) — required for AI analysis.
  Get one at <https://aistudio.google.com/app/apikey>.

> Both keys are **optional to *start* the app** — without them you'll see demo data and can explore the UI, but scraping and AI analysis will return a "not configured" error.

---

## Getting Started (Local Setup)

### 1. Clone the repository

```bash
git clone https://github.com/princy1862/Meta-Ad-Spy.git
cd Meta-Ad-Spy
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your environment variables

Copy the example file and fill in your keys:

```bash
cp .env.example .env
```

Then open `.env` in your editor and paste in your Apify token and Gemini key (see [Environment Variables](#environment-variables) below).

### 4. Start the server

```bash
npm start
```

You should see:

```
Meta Ad Library Scraper listening on port 3001
```

### 5. Open the app

Visit **<http://localhost:3001>** in your browser. 🎉

> The SQLite database (`db/app.db`) is created automatically on first run — no migrations to run manually.

---

## Environment Variables

Create a `.env` file in the project root (copy from `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port the server listens on. Defaults to **3001** if unset. |
| `APIFY_TOKEN` | For scraping | Apify API token. Without it, scrape endpoints return a "not configured" error. |
| `GEMINI_API_KEY` | For AI analysis | Google Gemini API key. Without it, the analyze endpoint returns a "not configured" error. |

Example `.env`:

```env
PORT=3001
APIFY_TOKEN=apify_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

> ⚠️ **Never commit your `.env` file.** It's already in `.gitignore`. The committed `.env.example` is a safe template with no real values.

---

## Using the App

1. **Go to the Brands tab** and click **Add Brand**.
   - Enter a name (e.g. "Glossier") and paste the brand's Meta Ad Library URL. To get one, search a brand on [Meta's Ad Library](https://www.facebook.com/ads/library/) and copy the URL — it must contain `view_all_page_id=...`.
2. **Click Scrape** on the brand row (or **Scrape All** to do every brand). A progress indicator shows the job running; it polls until Apify finishes.
3. **Switch to the Ads tab** to browse the scraped creatives. Use the brand filter, media-type filter, AI-tag filter, and sort dropdown to narrow things down.
4. **Click any ad card** to open its detail modal — full ad copy, CTA, media, and a link to view it live on Meta.
5. **Click the bookmark icon** on a card to save it. Bookmarked ads live in the **Bookmarks tab** and survive future re-scrapes.
6. **Click Analyze** in an ad's detail modal to run Gemini analysis. Once tagged, the ad becomes filterable by its AI tags.

---

## Project Structure

```
Meta-Ad-Spy/
├── server.js              # Entire backend: Express routes, SQLite setup,
│                          #   Apify scraping, dedupe logic, Gemini analysis
├── views/
│   └── index.html         # Entire frontend: single-page app (Tailwind + vanilla JS)
├── db/
│   ├── .gitkeep           # Keeps the db/ folder in git
│   └── app.db             # SQLite database (auto-created, gitignored)
├── .env                   # Your secrets (gitignored — create from .env.example)
├── .env.example           # Template documenting required env vars
├── package.json           # Dependencies and npm scripts
├── .gitignore             # Ignores node_modules, .env, *.db, backups
└── README.md              # You are here
```

---

## Database Schema

SQLite, created automatically on first run. Three tables:

**`brands`** — the DTC brands you track
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | Brand name |
| `facebook_page_id` | TEXT | Extracted from the Ad Library URL |
| `meta_ad_library_url` | TEXT UNIQUE | The URL used to scrape |
| `category` | TEXT | Optional |
| `is_active` | INTEGER | 1 = included in "Scrape All" |

**`ads`** — scraped (and deduped) ad creatives
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `brand_id` | INTEGER FK | Owning brand |
| `ad_library_id` | TEXT UNIQUE | Meta's ad archive ID (used for dedupe) |
| `page_name` | TEXT | |
| `ad_snapshot_url` | TEXT | Deep link to the ad on Meta |
| `ad_creative_bodies` / `..._link_titles` / `..._captions` / `..._descriptions` | TEXT | Ad copy fields |
| `media_type` | TEXT | `video` or `image` (for SQL-side filtering) |
| `is_bookmarked` | INTEGER | 1 = saved, never pruned on re-scrape |
| `ai_analysis` | TEXT | JSON blob of Gemini tags + summary |
| `raw_data` | TEXT | The full raw item from Apify |

**`scrape_jobs`** — tracks each scrape run's status, ads found/saved, and errors.

> The schema is forward-compatible: newer columns (`media_type`, `is_bookmarked`, `ai_analysis`, etc.) are added via idempotent `ALTER TABLE` migrations at startup, so old databases upgrade automatically.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | The single-page web app |
| `GET` | `/api/health` | Health check + whether Apify/Gemini are configured |
| `GET` | `/api/brands` | List all brands |
| `GET` | `/api/brands/:id` | Get one brand |
| `POST` | `/api/brands` | Create a brand (`name`, `meta_ad_library_url`) |
| `PUT` | `/api/brands/:id` | Update a brand |
| `DELETE` | `/api/brands/:id` | Delete a brand |
| `GET` | `/api/ads` | List ads (filter by `brand_id`, `media_type`, AI tags; `sort`, `limit`, `offset`) |
| `GET` | `/api/ads/bookmarked` | List bookmarked ads |
| `GET` | `/api/ads/:id` | Get one ad |
| `GET` | `/api/brands/:id/ads` | List a brand's ads |
| `POST` | `/api/ads/:id/bookmark` | Toggle bookmark on an ad |
| `POST` | `/api/ads/:id/analyze` | Run Gemini analysis on an ad |
| `POST` | `/api/brands/:id/scrape` | Start an Apify scrape job for a brand |
| `GET` | `/api/scrape-jobs` | List recent scrape jobs |
| `GET` | `/api/scrape-jobs/:id` | Get one scrape job's status |
| `POST` | `/api/scrape-jobs/:id/check` | Check a running job; save results when complete |

---

## AI Tagging Taxonomy

When you analyze an ad, Gemini classifies it into **exactly one value per dimension** (enforced via a constrained JSON schema), plus a 1–2 sentence summary:

| Dimension | Possible values |
|---|---|
| **Asset Type** | UGC · High Production · Static Image · Animation · Screen Recording · Stock Footage |
| **Visual Format** | Talking Head · Product Demo · Unboxing · Before/After · Lifestyle · Testimonial · Tutorial · Text Overlay · Split Screen |
| **Messaging Angle** | Problem/Solution · Social Proof · FOMO · Aspiration · Educational · Comparison · Emotional Story · Authority/Expert |
| **Hook Tactic** | Pattern Interrupt · Question · Bold Claim · Curiosity Gap · Call Out · Shocking Statement · Relatable Scenario |
| **Offer Type** | Percentage Off · Free Shipping · BOGO · Free Trial · Bundle Deal · Limited Time · No Offer |

These tags become filterable in the Ads tab, so you can answer questions like *"show me all the UGC testimonial ads using a FOMO angle."*

---

## Troubleshooting

**"Apify is not configured" / "Gemini API is not configured"**
Your `.env` is missing `APIFY_TOKEN` or `GEMINI_API_KEY`. Add them and restart the server.

**Port already in use**
Another process is on your port. Either stop it, or run on a different port: `PORT=8080 npm start`.

**Scrape returns no ads**
The brand may have no active ads, or the Meta Ad Library URL is missing `view_all_page_id`. Edit the brand and paste a URL copied directly from Meta's Ad Library.

**"Media too large for inline analysis"**
The ad's video exceeds the inline size cap (~18 MB) for Gemini. Try a different ad — most images and short videos analyze fine.

**Want a fresh start?**
Stop the server and delete `db/app.db`. It will be recreated empty on the next run.

---

## License

Personal / educational project. Respect Meta's and Apify's terms of service when scraping.
