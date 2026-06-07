/**
 * Meta Ad Library Scraper
 *
 * A tool for scraping and analyzing top-performing ads from Meta's Ad Library
 * for DTC brands.
 *
 * CUSTOMIZATION GUIDE:
 * - Add brands in the Brands section below
 * - Scraping integration will be added via Apify
 * - Edit views/index.html to customize the UI
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ApifyClient } = require('apify-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
// Replit (and most hosts) inject PORT; fall back to 3001 for local dev.
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
// Serve the frontend (and any static assets) from the views folder
app.use(express.static(path.join(__dirname, 'views')));

// ============================================
// DATABASE SETUP
// ============================================
// Keep the SQLite file in a persistent db/ folder (committed via db/.gitkeep so
// it exists on Replit). Create the folder if it's missing, then open the DB.
const DB_DIR = path.join(__dirname, 'db');
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'app.db'));

function initDatabase() {
  db.exec(`
    -- Brands table: stores DTC brands to track
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      facebook_page_id TEXT,
      meta_ad_library_url TEXT NOT NULL UNIQUE,
      category TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Ads table: stores scraped ads from Meta Ad Library
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      ad_library_id TEXT UNIQUE,
      page_id TEXT,
      page_name TEXT,
      ad_snapshot_url TEXT,
      ad_creative_bodies TEXT,
      ad_creative_link_captions TEXT,
      ad_creative_link_titles TEXT,
      ad_creative_link_descriptions TEXT,
      is_active INTEGER,
      start_date TEXT,
      raw_data TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );

    -- Scrape jobs table: tracks scraping job status
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      apify_run_id TEXT,
      status TEXT DEFAULT 'pending',
      ads_found INTEGER DEFAULT 0,
      ads_saved INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
  `);
}

initDatabase();

// Add ai_analysis column if it doesn't exist
try {
  db.exec(`ALTER TABLE ads ADD COLUMN ai_analysis TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Add facebook_page_id column to brands if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE brands ADD COLUMN facebook_page_id TEXT`);
} catch (e) {
  // Column already exists, ignore
}

/**
 * Extract the Facebook page ID from a Meta Ad Library URL.
 * The page ID lives in the `view_all_page_id` query parameter, e.g.
 * https://www.facebook.com/ads/library/?...&view_all_page_id=183869772601
 * Returns null if no page ID can be found.
 */
function extractPageId(url) {
  if (!url) return null;
  const match = url.match(/view_all_page_id=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Build a Meta Ad Library URL for a given Facebook page ID. This is the
 * `startUrl` the Apify actor consumes — it scrapes every ad run by that page.
 */
function buildAdLibraryUrl(pageId) {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US` +
    `&is_targeted_country=false&media_type=all&search_type=page` +
    `&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=${pageId}`;
}

// ============================================
// SCRAPE RESULT HELPERS — ranking + 3-pass dedupe
// ============================================

// Parse an impressions string like "10K - 15K", "1,000", or "10M+" into a number.
// Returns null when no usable value is present (this actor often omits it).
function parseImpressions(text) {
  if (!text || typeof text !== 'string') return null;
  const tokens = text.replace(/,/g, '').match(/[\d.]+\s*[KMB]?/gi);
  if (!tokens) return null;
  const toNum = (s) => {
    const m = s.match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    const u = (m[2] || '').toUpperCase();
    if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
    return n;
  };
  // Use the upper bound of a range (the largest number present).
  return Math.max(...tokens.map(toNum));
}

// Stable identifiers/keys used by the dedupe passes.
function adArchiveId(item) {
  return item.adArchiveID || item.adArchiveId || item.adId || item.id || null;
}
function adPrimaryMediaUrl(item) {
  const c = item.snapshot?.cards?.[0] || {};
  return c.videoHdUrl || c.videoSdUrl || c.originalImageUrl || c.resizedImageUrl
    || item.snapshot?.videos?.[0]?.videoHdUrl || item.snapshot?.videos?.[0]?.videoSdUrl
    || item.snapshot?.images?.[0]?.originalImageUrl || item.snapshot?.images?.[0]?.resizedImageUrl
    || null;
}
function adHeadlineKey(item) {
  const c = item.snapshot?.cards?.[0] || {};
  return (c.title || item.snapshot?.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Rank by impressions (desc). When impressions are unavailable (common), fall
// back to Apify's own order — the scrape URL sorts by total_impressions desc,
// so the incoming order already reflects impression rank.
function rankByImpressions(items) {
  return items
    .map((item, idx) => ({ item, idx, imp: parseImpressions(item.impressionsWithIndex?.impressionsText) }))
    .sort((a, b) => {
      if (a.imp != null && b.imp != null && a.imp !== b.imp) return b.imp - a.imp;
      if (a.imp != null && b.imp == null) return -1;
      if (a.imp == null && b.imp != null) return 1;
      return a.idx - b.idx; // preserve Apify's impression-sorted order
    })
    .map((x) => x.item);
}

// 3-pass dedupe over an already-ranked list, keeping the highest-ranked of each
// group: (1) exact ad archive ID, (2) same media URL (same creative, new ad ID),
// (3) same headline (A/B test variations). Scoped per brand by the caller.
function dedupeAds(rankedItems) {
  const seenId = new Set();
  const seenMedia = new Set();
  const seenHeadline = new Set();
  const out = [];
  for (const item of rankedItems) {
    const id = adArchiveId(item);
    if (id && seenId.has(id)) continue;              // Pass 1: exact duplicate

    const media = adPrimaryMediaUrl(item);
    if (media && seenMedia.has(media)) continue;     // Pass 2: same creative

    const headline = adHeadlineKey(item);
    if (headline && seenHeadline.has(headline)) continue; // Pass 3: A/B variation

    if (id) seenId.add(id);
    if (media) seenMedia.add(media);
    if (headline) seenHeadline.add(headline);
    out.push(item);
  }
  return out;
}

// Backfill facebook_page_id for any existing brands that don't have one yet
try {
  const needsBackfill = db.prepare(
    `SELECT id, meta_ad_library_url FROM brands WHERE facebook_page_id IS NULL OR facebook_page_id = ''`
  ).all();
  const setPageId = db.prepare(`UPDATE brands SET facebook_page_id = ? WHERE id = ?`);
  for (const brand of needsBackfill) {
    const pageId = extractPageId(brand.meta_ad_library_url);
    if (pageId) setPageId.run(pageId, brand.id);
  }
} catch (e) {
  console.error('Brand page-id backfill error:', e.message);
}

// Add media_type column to ads if missing (lets us filter image/video in SQL,
// which is required for correct LIMIT/OFFSET pagination)
try {
  db.exec(`ALTER TABLE ads ADD COLUMN media_type TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Add is_bookmarked column to ads if missing. The bookmark feature reads/writes
// this column; on a fresh DB it isn't in CREATE TABLE, so add it here (no-op when
// it already exists, e.g. on the current database).
try {
  db.exec(`ALTER TABLE ads ADD COLUMN is_bookmarked INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Resolve an ad's primary media from its snapshot. Handles BOTH shapes the actor
// returns: card-based ads (snapshot.cards[0]) and single-media ads where media
// lives at the top level (snapshot.videos[0] / snapshot.images[0]).
function extractMedia(snapshot) {
  const card = snapshot?.cards?.[0] || {};
  const video = snapshot?.videos?.[0] || {};
  const image = snapshot?.images?.[0] || {};
  const videoUrl = card.videoSdUrl || card.videoHdUrl || video.videoSdUrl || video.videoHdUrl || null;
  const imageUrl = card.originalImageUrl || card.resizedImageUrl
    || image.originalImageUrl || image.resizedImageUrl
    || card.videoPreviewImageUrl || video.videoPreviewImageUrl || null;
  return { videoUrl, imageUrl, isVideo: !!videoUrl };
}

// Classify an ad's primary media as 'video' or 'image' from its raw_data
function classifyMedia(rawDataStr) {
  try {
    return extractMedia(JSON.parse(rawDataStr || '{}').snapshot).isVideo ? 'video' : 'image';
  } catch (e) {
    return 'image';
  }
}

// Backfill media_type for existing ads
try {
  const rows = db.prepare(`SELECT id, raw_data FROM ads WHERE media_type IS NULL OR media_type = ''`).all();
  const setMt = db.prepare(`UPDATE ads SET media_type = ? WHERE id = ?`);
  for (const r of rows) setMt.run(classifyMedia(r.raw_data), r.id);
} catch (e) {
  console.error('media_type backfill error:', e.message);
}

// ============================================
// CONFIGURATION
// ============================================
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'JJghSZmShuco4j9gJ';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 2.5 Pro has a free-tier quota of 0 (needs billing). 2.5 Flash is free, fast,
// and multimodal (image + video) — the right fit while staying at $0.
const GEMINI_MODEL = 'gemini-2.5-flash';

// Inline media is sent as base64 in the request body; the API caps total request
// size (~20MB). Skip media larger than this and fail with a clear message.
const MAX_INLINE_MEDIA_BYTES = 18 * 1024 * 1024;

// Initialize Apify client
const apifyClient = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

// Initialize Gemini client
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// The 5-dimension ad taxonomy. Each ad is classified into exactly one value per
// dimension. Kept as one source of truth for both the prompt and the JSON schema.
const AD_TAXONOMY = {
  asset_type: ['UGC', 'High Production', 'Static Image', 'Animation', 'Screen Recording', 'Stock Footage'],
  visual_format: ['Talking Head', 'Product Demo', 'Unboxing', 'Before/After', 'Lifestyle', 'Testimonial', 'Tutorial', 'Text Overlay', 'Split Screen'],
  messaging_angle: ['Problem/Solution', 'Social Proof', 'FOMO', 'Aspiration', 'Educational', 'Comparison', 'Emotional Story', 'Authority/Expert'],
  hook_tactic: ['Pattern Interrupt', 'Question', 'Bold Claim', 'Curiosity Gap', 'Call Out', 'Shocking Statement', 'Relatable Scenario'],
  offer_type: ['Percentage Off', 'Free Shipping', 'BOGO', 'Free Trial', 'Bundle Deal', 'Limited Time', 'No Offer'],
};
const AD_DIMENSIONS = Object.keys(AD_TAXONOMY);

// JSON schema (enum-constrained) so Gemini returns exactly one valid value per dimension.
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    asset_type: { type: 'string', enum: AD_TAXONOMY.asset_type },
    visual_format: { type: 'string', enum: AD_TAXONOMY.visual_format },
    messaging_angle: { type: 'string', enum: AD_TAXONOMY.messaging_angle },
    hook_tactic: { type: 'string', enum: AD_TAXONOMY.hook_tactic },
    offer_type: { type: 'string', enum: AD_TAXONOMY.offer_type },
    summary: { type: 'string' },
  },
  required: [...AD_DIMENSIONS, 'summary'],
};

// Append server-side AI-tag filters for any dimension present in the query.
// Dimension names come from AD_DIMENSIONS (trusted, hard-coded); values are bound
// as parameters. Tags live in the ai_analysis JSON at $.tags.<dimension>.
function applyAiTagFilters(query, sql, params) {
  for (const dim of AD_DIMENSIONS) {
    let vals = query[dim];
    if (!vals) continue;
    if (!Array.isArray(vals)) vals = [vals];
    vals = vals.filter(Boolean);
    if (!vals.length) continue;
    sql += ` AND json_extract(ads.ai_analysis, '$.tags.${dim}') IN (${vals.map(() => '?').join(', ')})`;
    params.push(...vals);
  }
  return sql;
}

// ============================================
// GEMINI AI ANALYSIS
// ============================================

/**
 * Fetch an image/video URL and convert to base64 for inline use with Gemini.
 * Throws if the media is missing or too large to send inline.
 */
async function fetchMediaAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INLINE_MEDIA_BYTES) {
    throw new Error(`Media too large for inline analysis (${(buffer.length / 1048576).toFixed(1)} MB)`);
  }
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  return { base64: buffer.toString('base64'), mimeType };
}

/**
 * Analyze an ad's creative (image or video) with Gemini, classifying it across
 * the 5-dimension AD_TAXONOMY. Returns enum-validated tags + a short summary.
 */
async function analyzeAdWithGemini(ad) {
  if (!genAI) {
    throw new Error('Gemini API key not configured');
  }

  // Pull media URLs from raw_data (handles card-based and single-media ads).
  // Prefer the SD video to stay under the inline request-size cap.
  const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
  const snapshot = rawData.snapshot || {};
  const card = snapshot.cards?.[0] || {};
  const { videoUrl, imageUrl, isVideo } = extractMedia(snapshot);
  const mediaUrl = videoUrl || imageUrl;
  if (!mediaUrl) {
    throw new Error('No media URL found for this ad');
  }

  // Text context for the model (card first, then snapshot-level fallbacks)
  const adText = ad.ad_creative_bodies || card.body || snapshot.body || '';
  const adTitle = ad.ad_creative_link_titles || card.title || snapshot.title || '';
  const brandName = ad.brand_name || ad.page_name || snapshot.pageName || 'this brand';

  const allowed = AD_DIMENSIONS
    .map((d) => `- ${d}: ${AD_TAXONOMY[d].join(' | ')}`)
    .join('\n');

  const prompt = [
    `You are an expert performance-marketing analyst. Classify this Meta (Facebook/Instagram) ${isVideo ? 'video' : 'image'} ad from ${brandName} across 5 dimensions.`,
    adTitle ? `Headline: ${adTitle}` : '',
    adText ? `Ad copy: ${adText}` : '',
    '',
    'Choose EXACTLY ONE value per dimension, picking the single best fit from these allowed values:',
    allowed,
    '',
    'Base your judgment primarily on the creative itself (what you see/hear), using the headline and copy as supporting context. For offer_type, use "No Offer" if no promotion is present. Also write a concise 1-2 sentence summary of the ad.',
    'Respond ONLY with JSON matching the requested schema.',
  ].filter(Boolean).join('\n');

  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
      },
    });
    const { base64, mimeType } = await fetchMediaAsBase64(mediaUrl);

    const result = await model.generateContent([
      { inlineData: { mimeType, data: base64 } },
      { text: prompt },
    ]);

    let parsed;
    try {
      parsed = JSON.parse(result.response.text());
    } catch (e) {
      throw new Error('Model did not return valid JSON');
    }

    // Split the validated dimensions out from the summary.
    const tags = {};
    for (const d of AD_DIMENSIONS) tags[d] = parsed[d] || null;

    return {
      tags,
      summary: parsed.summary || '',
      mediaType: isVideo ? 'video' : 'image',
      model: GEMINI_MODEL,
      analyzedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Gemini analysis error:', error);
    throw new Error(`Gemini analysis failed: ${error.message}`);
  }
}

// ============================================
// MOCK DATA FUNCTIONS
// ============================================

function getMockBrands() {
  return [
    { id: 1, name: 'Glossier', facebook_page_id: '183869772601', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=183869772601', category: 'Beauty', is_active: 1 },
    { id: 2, name: 'Warby Parker', facebook_page_id: '115496702', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=115496702', category: 'Fashion & Apparel', is_active: 1 },
    { id: 3, name: 'Allbirds', facebook_page_id: '1247829371897498', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=1247829371897498', category: 'Fashion & Apparel', is_active: 1 }
  ];
}

function getMockAds() {
  return [
    {
      id: 1,
      brand_id: 1,
      ad_library_id: 'mock_ad_001',
      page_name: 'Glossier',
      ad_creative_bodies: 'Discover our new skincare line. Clean beauty that works.',
      is_active: 1,
      start_date: '2024-01-15',
      scraped_at: new Date().toISOString()
    },
    {
      id: 2,
      brand_id: 1,
      ad_library_id: 'mock_ad_002',
      page_name: 'Glossier',
      ad_creative_bodies: 'The internet\'s favorite lip gloss. Now in 12 shades.',
      is_active: 1,
      start_date: '2024-01-20',
      scraped_at: new Date().toISOString()
    }
  ];
}

// ============================================
// ROUTES - PAGES
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// ============================================
// ROUTES - BRANDS API
// ============================================

// Get all brands
app.get('/api/brands', (req, res) => {
  try {
    const brands = db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();

    // Return mock data if database is empty (demo mode)
    if (brands.length === 0) {
      return res.json(getMockBrands());
    }

    res.json(brands);
  } catch (error) {
    console.error('Get brands error:', error);
    res.status(500).json({ error: 'Failed to get brands' });
  }
});

// Get single brand
app.get('/api/brands/:id', (req, res) => {
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json(brand);
  } catch (error) {
    console.error('Get brand error:', error);
    res.status(500).json({ error: 'Failed to get brand' });
  }
});

// Create brand
app.post('/api/brands', (req, res) => {
  try {
    const { name, meta_ad_library_url, category, facebook_page_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Brand name is required' });
    }

    if (!meta_ad_library_url) {
      return res.status(400).json({ error: 'Meta Ad Library URL is required' });
    }

    // Validate it's a Meta Ad Library URL
    if (!meta_ad_library_url.includes('facebook.com/ads/library')) {
      return res.status(400).json({ error: 'Please provide a valid Meta Ad Library URL' });
    }

    // Use an explicitly supplied page ID, otherwise derive it from the URL
    const pageId = facebook_page_id || extractPageId(meta_ad_library_url);

    const result = db.prepare(`
      INSERT INTO brands (name, facebook_page_id, meta_ad_library_url, category)
      VALUES (?, ?, ?, ?)
    `).run(name, pageId, meta_ad_library_url.trim(), category || null);

    res.json({
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    console.error('Create brand error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'A brand with this Meta Ad Library URL already exists' });
    }
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

// Update brand
app.put('/api/brands/:id', (req, res) => {
  try {
    const { name, meta_ad_library_url, category, is_active, facebook_page_id } = req.body;

    // Get existing brand to preserve values not being updated
    const existingBrand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    if (!existingBrand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Validate URL if provided
    const urlToSave = meta_ad_library_url?.trim() || existingBrand.meta_ad_library_url;
    if (meta_ad_library_url && !meta_ad_library_url.includes('facebook.com/ads/library')) {
      return res.status(400).json({ error: 'Please provide a valid Meta Ad Library URL' });
    }

    // Keep page ID in sync: explicit value wins, else re-derive from the URL being saved
    const pageIdToSave = facebook_page_id ?? extractPageId(urlToSave) ?? existingBrand.facebook_page_id;

    const result = db.prepare(`
      UPDATE brands
      SET name = ?, facebook_page_id = ?, meta_ad_library_url = ?, category = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name ?? existingBrand.name,
      pageIdToSave,
      urlToSave,
      category ?? existingBrand.category,
      is_active ?? existingBrand.is_active,
      req.params.id
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update brand error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'A brand with this Meta Ad Library URL already exists' });
    }
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// Delete brand
app.delete('/api/brands/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete brand error:', error);
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

// ============================================
// ROUTES - ADS API
// ============================================

// Get all ads (with optional filters)
app.get('/api/ads', (req, res) => {
  try {
    const { is_active, media_type, sort = 'newest' } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    // Handle multiple brand_id params (e.g., ?brand_id=1&brand_id=2)
    let brandIds = req.query.brand_id;
    if (brandIds && !Array.isArray(brandIds)) {
      brandIds = [brandIds];
    }

    let sql = 'SELECT ads.*, brands.name as brand_name FROM ads LEFT JOIN brands ON ads.brand_id = brands.id WHERE 1=1';
    const params = [];

    if (brandIds && brandIds.length > 0) {
      const placeholders = brandIds.map(() => '?').join(', ');
      sql += ` AND ads.brand_id IN (${placeholders})`;
      params.push(...brandIds);
    }

    if (is_active !== undefined) {
      sql += ' AND ads.is_active = ?';
      params.push(is_active);
    }

    // Media type now lives in a column, so we can filter in SQL (needed for paging)
    if (media_type === 'video' || media_type === 'image') {
      sql += ' AND ads.media_type = ?';
      params.push(media_type);
    }

    // AI-tag filters (server-side so pagination stays correct)
    sql = applyAiTagFilters(req.query, sql, params);

    // Determine sort order
    let orderClause;
    if (sort === 'top_ranked') {
      // For top ranked, we sort by the order they were scraped (which reflects impression rank)
      // Apify returns ads sorted by impressions, so lower id within same scrape = higher rank
      orderClause = 'ORDER BY ads.brand_id, ads.id ASC';
    } else if (sort === 'oldest') {
      orderClause = 'ORDER BY ads.start_date ASC, ads.id ASC';
    } else {
      // newest (default)
      orderClause = 'ORDER BY ads.start_date DESC, ads.id DESC';
    }

    sql += ` ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const ads = db.prepare(sql).all(...params);

    // Return mock data only for an unfiltered first page when the DB is empty (demo mode)
    const hasTagFilter = AD_DIMENSIONS.some((d) => req.query[d]);
    if (ads.length === 0 && offset === 0 && (!brandIds || brandIds.length === 0) && !media_type && !hasTagFilter) {
      return res.json(getMockAds());
    }

    res.json(ads);
  } catch (error) {
    console.error('Get ads error:', error);
    res.status(500).json({ error: 'Failed to get ads' });
  }
});

// Get bookmarked ads (must be before /api/ads/:id to avoid route conflict)
app.get('/api/ads/bookmarked', (req, res) => {
  try {
    const { media_type, sort = 'newest' } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // Determine sort order
    let orderClause;
    if (sort === 'top_ranked') {
      orderClause = 'ORDER BY ads.brand_id, ads.id ASC';
    } else if (sort === 'oldest') {
      orderClause = 'ORDER BY ads.start_date ASC, ads.id ASC';
    } else {
      orderClause = 'ORDER BY ads.start_date DESC, ads.id DESC';
    }

    let brandIds = req.query.brand_id;
    if (brandIds && !Array.isArray(brandIds)) brandIds = [brandIds];

    let sql = 'SELECT ads.*, brands.name as brand_name FROM ads LEFT JOIN brands ON ads.brand_id = brands.id WHERE ads.is_bookmarked = 1';
    const params = [];
    if (brandIds && brandIds.length > 0) {
      sql += ` AND ads.brand_id IN (${brandIds.map(() => '?').join(', ')})`;
      params.push(...brandIds);
    }
    if (media_type === 'video' || media_type === 'image') {
      sql += ' AND ads.media_type = ?';
      params.push(media_type);
    }
    sql = applyAiTagFilters(req.query, sql, params);
    sql += ` ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const ads = db.prepare(sql).all(...params);
    res.json(ads);
  } catch (error) {
    console.error('Get bookmarked ads error:', error);
    res.status(500).json({ error: 'Failed to get bookmarked ads' });
  }
});

// Get single ad
app.get('/api/ads/:id', (req, res) => {
  try {
    const ad = db.prepare(`
      SELECT ads.*, brands.name as brand_name
      FROM ads
      LEFT JOIN brands ON ads.brand_id = brands.id
      WHERE ads.id = ?
    `).get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    res.json(ad);
  } catch (error) {
    console.error('Get ad error:', error);
    res.status(500).json({ error: 'Failed to get ad' });
  }
});

// Get ads for a specific brand
app.get('/api/brands/:id/ads', (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const ads = db.prepare(`
      SELECT * FROM ads
      WHERE brand_id = ?
      ORDER BY scraped_at DESC
      LIMIT ?
    `).all(req.params.id, parseInt(limit));

    res.json(ads);
  } catch (error) {
    console.error('Get brand ads error:', error);
    res.status(500).json({ error: 'Failed to get brand ads' });
  }
});

// Toggle bookmark on an ad
app.post('/api/ads/:id/bookmark', (req, res) => {
  try {
    const ad = db.prepare('SELECT is_bookmarked FROM ads WHERE id = ?').get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const newBookmarkState = ad.is_bookmarked ? 0 : 1;
    db.prepare('UPDATE ads SET is_bookmarked = ? WHERE id = ?').run(newBookmarkState, req.params.id);

    res.json({ success: true, is_bookmarked: newBookmarkState });
  } catch (error) {
    console.error('Toggle bookmark error:', error);
    res.status(500).json({ error: 'Failed to toggle bookmark' });
  }
});

// Analyze an ad with Gemini AI
app.post('/api/ads/:id/analyze', async (req, res) => {
  try {
    if (!genAI) {
      return res.status(500).json({ error: 'Gemini API is not configured. Please set GEMINI_API_KEY environment variable.' });
    }

    const ad = db.prepare(`
      SELECT ads.*, brands.name as brand_name
      FROM ads
      LEFT JOIN brands ON ads.brand_id = brands.id
      WHERE ads.id = ?
    `).get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const result = await analyzeAdWithGemini(ad);

    // Save the analysis to the database
    db.prepare('UPDATE ads SET ai_analysis = ? WHERE id = ?').run(
      JSON.stringify(result),
      req.params.id
    );

    res.json(result);
  } catch (error) {
    console.error('Analyze ad error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze ad' });
  }
});

// ============================================
// ROUTES - SCRAPE JOBS API
// ============================================

// Get all scrape jobs
app.get('/api/scrape-jobs', (req, res) => {
  try {
    const jobs = db.prepare(`
      SELECT scrape_jobs.*, brands.name as brand_name
      FROM scrape_jobs
      LEFT JOIN brands ON scrape_jobs.brand_id = brands.id
      ORDER BY scrape_jobs.created_at DESC
      LIMIT 50
    `).all();

    res.json(jobs);
  } catch (error) {
    console.error('Get scrape jobs error:', error);
    res.status(500).json({ error: 'Failed to get scrape jobs' });
  }
});

// Get single scrape job status
app.get('/api/scrape-jobs/:id', (req, res) => {
  try {
    const job = db.prepare(`
      SELECT scrape_jobs.*, brands.name as brand_name
      FROM scrape_jobs
      LEFT JOIN brands ON scrape_jobs.brand_id = brands.id
      WHERE scrape_jobs.id = ?
    `).get(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Scrape job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Get scrape job error:', error);
    res.status(500).json({ error: 'Failed to get scrape job' });
  }
});

// Start a scrape job for a brand
app.post('/api/brands/:id/scrape', async (req, res) => {
  try {
    if (!apifyClient) {
      return res.status(500).json({ error: 'Apify is not configured. Please set APIFY_TOKEN environment variable.' });
    }

    const brandId = req.params.id;
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId);

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Resolve the Facebook page ID, then build the Ad Library URL the actor scrapes.
    // Prefer the stored page ID; fall back to deriving it from the saved URL.
    const pageId = brand.facebook_page_id || extractPageId(brand.meta_ad_library_url);
    if (!pageId) {
      return res.status(400).json({
        error: 'This brand has no Facebook page ID. Edit the brand and provide a Meta Ad Library URL containing view_all_page_id.'
      });
    }
    const scrapeUrl = buildAdLibraryUrl(pageId);
    const resultsLimit = parseInt(req.body?.resultsLimit) || 20;

    // Create a scrape job record
    const jobResult = db.prepare(`
      INSERT INTO scrape_jobs (brand_id, status, started_at)
      VALUES (?, 'running', CURRENT_TIMESTAMP)
    `).run(brandId);

    const jobId = jobResult.lastInsertRowid;

    // Start the Apify actor run (use start() instead of call() to return immediately)
    try {
      const run = await apifyClient.actor(APIFY_ACTOR_ID).start({
        startUrls: [{ url: scrapeUrl }],
        resultsLimit
      });

      // Update job with Apify run ID
      db.prepare('UPDATE scrape_jobs SET apify_run_id = ? WHERE id = ?').run(run.id, jobId);

      res.json({
        success: true,
        job_id: jobId,
        apify_run_id: run.id,
        page_id: pageId,
        message: 'Scrape job started'
      });
    } catch (apifyError) {
      // Update job with error status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(apifyError.message, jobId);

      throw apifyError;
    }
  } catch (error) {
    console.error('Start scrape error:', error);
    res.status(500).json({ error: 'Failed to start scrape: ' + error.message });
  }
});

// Check Apify run status and fetch results if complete
app.post('/api/scrape-jobs/:id/check', async (req, res) => {
  try {
    if (!apifyClient) {
      return res.status(500).json({ error: 'Apify is not configured' });
    }

    const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Scrape job not found' });
    }

    if (!job.apify_run_id) {
      return res.status(400).json({ error: 'No Apify run associated with this job' });
    }

    // Get the run status from Apify
    const run = await apifyClient.run(job.apify_run_id).get();

    if (run.status === 'SUCCEEDED') {
      // Fetch the results from the dataset
      const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

      // ── Rank by impressions, run the 3-pass dedupe, keep top 10 per brand ──
      const ranked = rankByImpressions(items);
      const unique = dedupeAds(ranked);
      const topAds = unique.slice(0, 10);

      // Insert in ranked order so /api/ads "top_ranked" (id ASC) reflects rank.
      // INSERT OR IGNORE preserves any already-saved ad (incl. bookmarks/analysis).
      let adsSaved = 0;
      const insertAd = db.prepare(`
        INSERT OR IGNORE INTO ads (
          brand_id, ad_library_id, page_id, page_name, ad_snapshot_url,
          ad_creative_bodies, ad_creative_link_captions, ad_creative_link_titles,
          ad_creative_link_descriptions, is_active, start_date, raw_data, media_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertTop = db.transaction((ads) => {
        for (const ad of ads) {
          const archiveId = adArchiveId(ad);
          const snapshot = ad.snapshot || {};
          const card = snapshot.cards?.[0] || {};

          // Format the start date from ISO string or timestamp
          let startDate = null;
          if (ad.startDateFormatted) {
            startDate = ad.startDateFormatted.split('T')[0];
          } else if (ad.startDate) {
            const timestamp = typeof ad.startDate === 'number' ? ad.startDate * 1000 : ad.startDate;
            startDate = new Date(timestamp).toISOString().split('T')[0];
          }

          // Proper deep link into the Meta Ad Library for this specific ad.
          const snapshotUrl = archiveId
            ? `https://www.facebook.com/ads/library/?id=${archiveId}`
            : null;

          const result = insertAd.run(
            job.brand_id,
            archiveId,
            ad.pageID || ad.pageId || null,
            snapshot.pageName || ad.pageInfo?.page?.name || null,
            snapshotUrl,
            card.body || snapshot.body || null,
            card.caption || snapshot.caption || null,
            card.title || snapshot.title || null,
            card.linkDescription || snapshot.linkDescription || null,
            ad.isActive === false ? 0 : 1,
            startDate,
            JSON.stringify(ad),
            extractMedia(snapshot).isVideo ? 'video' : 'image'
          );
          if (result.changes > 0) adsSaved++;
        }
      });
      insertTop(topAds);

      // Enforce "top 10 per brand": drop this brand's other ads, but never delete
      // bookmarked ones (those are user-saved creatives we must protect).
      let pruned = 0;
      const keepIds = topAds.map(adArchiveId).filter(Boolean);
      if (keepIds.length) {
        const placeholders = keepIds.map(() => '?').join(', ');
        pruned = db.prepare(
          `DELETE FROM ads WHERE brand_id = ? AND is_bookmarked = 0 AND ad_library_id NOT IN (${placeholders})`
        ).run(job.brand_id, ...keepIds).changes;
      }

      console.log(`Scrape ${job.id}: ${items.length} raw → ${unique.length} unique → kept ${topAds.length} (saved ${adsSaved} new, pruned ${pruned})`);

      // Update job status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'completed', ads_found = ?, ads_saved = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(items.length, adsSaved, job.id);

      res.json({
        status: 'completed',
        ads_found: items.length,
        ads_saved: adsSaved
      });
    } else if (run.status === 'FAILED' || run.status === 'ABORTED' || run.status === 'TIMED-OUT') {
      // Update job status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(`Apify run ${run.status}`, job.id);

      res.json({
        status: 'failed',
        error: `Apify run ${run.status}`
      });
    } else {
      // Still running
      res.json({
        status: 'running',
        apify_status: run.status
      });
    }
  } catch (error) {
    console.error('Check scrape job error:', error);
    res.status(500).json({ error: 'Failed to check scrape job: ' + error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apify_configured: !!APIFY_TOKEN,
    gemini_configured: !!GEMINI_API_KEY
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`Meta Ad Library Scraper listening on port ${PORT}`);
});
