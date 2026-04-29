/**
 * Backend API Server
 *
 * Profile data: MongoDB first (same store as queue-crawler), else JSON in ../data/.
 * No scraping here — refresh data by re-running the scraper / queue worker.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Reuse Instaloader (Python) and other scraper-time vars if only scraper/.env is configured.
const scraperEnv = path.join(__dirname, '..', '..', 'scraper', '.env');
if (fs.existsSync(scraperEnv)) {
  require('dotenv').config({ path: scraperEnv, override: false });
}

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, '..', 'data');

app.use(cors());
app.use(express.json());

/** Avoid re-reading every *_complete.json on each list request (large data/ folders) */
const PROFILES_LIST_CACHE_MS = 30000;
let profilesListCache = { at: 0, payload: null };

/** Short-TTL cache: same user often hits /profile and /profile/.../posts back-to-back */
const PROFILE_RESOLVE_CACHE_MS = 12000;
const profileResolveCache = new Map();
const MAX_PROFILE_RESOLVE_CACHE = 80;

/** readdir for fuzzy file match (avoid readdirSync on every 404 path) */
let dataDirListCache = { at: 0, stems: null };
const DATA_DIR_LIST_CACHE_MS = 5000;

/**
 * In-memory sort cache for /posts: sorting thousands of posts per request is expensive.
 * Key: username:sort:scraped_at
 */
const POSTS_SORT_CACHE_MS = 20000;
const postSortCache = new Map();
const MAX_POSTS_SORT_CACHE = 60;

// ---------- MONGODB (optional) ----------

const MONGO_COLLECTION = process.env.MONGO_COLLECTION || 'insta_Profiles';
const profileSchema = new mongoose.Schema({}, { strict: false, collection: MONGO_COLLECTION });
const Profile =
  mongoose.models.ProfileApiDoc || mongoose.model('ProfileApiDoc', profileSchema);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 1) Exact (case-insensitive) match on data.username
 * 2) If that fails, at most one doc whose data.username is a prefix of the request (e.g. query "hiloni" → "hilonicakes" only)
 *    (If multiple usernames start with the search string, no auto-pick — caller may show suggestions)
 */
async function loadProfileFromMongo(username) {
  if (mongoose.connection.readyState !== 1) return null;
  const u = String(username || '').trim().replace(/^@/, '');
  if (!u) return null;
  try {
    const exact = await Profile.findOne({
      'data.username': new RegExp(`^${escapeRegex(u)}$`, 'i'),
    }).lean();
    if (exact && exact.data) return exact;

    if (u.length < 2) return null;
    const reStart = new RegExp('^' + escapeRegex(u), 'i');
    const prefixMatches = await Profile.find({ 'data.username': reStart })
      .limit(25)
      .lean();
    const ok = (prefixMatches || []).filter((d) => d && d.data && d.data.username);
    if (ok.length === 0) return null;
    if (ok.length === 1) return ok[0];
    const exact2 = ok.find((d) => d.data.username.toLowerCase() === u.toLowerCase());
    if (exact2) return exact2;
    // Ambiguous: e.g. both "hiloni" and "hilonicakes" in DB; do not guess
    return null;
  } catch (err) {
    console.warn('Mongo profile lookup:', err.message);
    return null;
  }
}

/** For 404 responses — "did you mean" */
async function suggestUsernamesForQuery(u) {
  if (mongoose.connection.readyState !== 1) return [];
  const t = String(u || '').trim().replace(/^@/, '');
  if (t.length < 2) return [];
  try {
    const re = new RegExp(escapeRegex(t), 'i');
    const rows = await Profile.find({ 'data.username': re })
      .select({ 'data.username': 1 })
      .limit(20)
      .lean();
    const out = new Set();
    (rows || []).forEach((r) => {
      if (r?.data?.username) out.add(r.data.username);
    });
    return Array.from(out).sort((a, b) => a.length - b.length);
  } catch {
    return [];
  }
}

// ---------- HELPERS ----------

function loadProfileData(username) {
  const filePath = path.join(DATA_DIR, `${username}_complete.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Stems of *_complete.json in data/ (with short cache).
 */
function getDataDirStems() {
  const now = Date.now();
  if (dataDirListCache.stems && now - dataDirListCache.at < DATA_DIR_LIST_CACHE_MS) {
    return dataDirListCache.stems;
  }
  if (!fs.existsSync(DATA_DIR)) {
    dataDirListCache = { at: now, stems: null };
    return null;
  }
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_complete.json'));
  const stems = files
    .map((f) => f.replace(/_complete\.json$/i, ''))
    .filter(Boolean);
  dataDirListCache = { at: now, stems };
  return stems;
}

/**
 * If exactly one *filename* in data/ is clearly the match for a short handle (e.g. hilonicakes_complete for "hiloni")
 */
function loadProfileDataFuzzyOrExact(username) {
  const u = String(username || '')
    .trim()
    .replace(/^@/, '');
  if (!u) return null;
  const direct = loadProfileData(u) || loadProfileData(u.toLowerCase());
  if (direct) return direct;
  if (u.length < 2) return null;
  const stems = getDataDirStems();
  if (!stems || stems.length === 0) return null;
  const reStart = new RegExp('^' + escapeRegex(u), 'i');
  const byPrefix = stems.filter((s) => reStart.test(s));
  if (byPrefix.length === 1) {
    return loadProfileData(byPrefix[0]) || loadProfileData(byPrefix[0].toLowerCase());
  }
  return null;
}

function evictMapOldest(m, maxSize) {
  if (m.size <= maxSize) return;
  const toDrop = m.size - maxSize;
  const iter = m.keys();
  for (let i = 0; i < toDrop; i += 1) {
    const k = iter.next().value;
    if (k != null) m.delete(k);
  }
}

/** Same shape as Mongo: full document with .data and .scraped_at */
async function resolveProfileDocument(username) {
  const u = String(username || '').trim().replace(/^@/, '');
  if (!u) return null;
  const now = Date.now();
  const cacheKey = u.toLowerCase();
  const hit = profileResolveCache.get(cacheKey);
  if (hit && now - hit.at < PROFILE_RESOLVE_CACHE_MS) {
    return hit.doc;
  }
  const fromMongo = await loadProfileFromMongo(u);
  if (fromMongo) {
    profileResolveCache.set(cacheKey, { at: now, doc: fromMongo });
    evictMapOldest(profileResolveCache, MAX_PROFILE_RESOLVE_CACHE);
    return fromMongo;
  }
  const fromDisk = loadProfileDataFuzzyOrExact(u);
  if (fromDisk) {
    profileResolveCache.set(cacheKey, { at: now, doc: fromDisk });
    evictMapOldest(profileResolveCache, MAX_PROFILE_RESOLVE_CACHE);
  }
  return fromDisk;
}

function computeMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One pass over posts for four median series (avoids repeated .map/.filter on large arrays). */
function collectEngagementSeriesForMedians(posts) {
  const likes = [];
  const comments = [];
  const engagements = [];
  const rates = [];
  for (let i = 0; i < posts.length; i += 1) {
    const p = posts[i];
    const l = p.likes || 0;
    const c = p.comments || 0;
    likes.push(l);
    comments.push(c);
    engagements.push(l + c);
    if (p.engagement_rate > 0) rates.push(p.engagement_rate);
  }
  return { likes, comments, engagements, rates };
}

function computeMonthlyStats(posts) {
  if (!posts || posts.length === 0) return [];

  const buckets = {};
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    const date = new Date(post.timestamp * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets[key]) {
      buckets[key] = {
        month: key,
        postCount: 0,
        totalLikes: 0,
        totalComments: 0,
        totalViews: 0,
        engagementRateSum: 0,
        engagementRateCount: 0,
      };
    }
    const b = buckets[key];
    b.postCount += 1;
    b.totalLikes += post.likes || 0;
    b.totalComments += post.comments || 0;
    b.totalViews += post.views || 0;
    if (post.engagement_rate > 0) {
      b.engagementRateSum += post.engagement_rate;
      b.engagementRateCount += 1;
    }
  }

  return Object.values(buckets)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(b => ({
      month: b.month,
      label: new Date(b.month + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      post_count: b.postCount,
      total_likes: b.totalLikes,
      total_comments: b.totalComments,
      total_views: b.totalViews,
      total_engagements: b.totalLikes + b.totalComments,
      avg_likes: Math.round(b.totalLikes / b.postCount),
      avg_comments: Math.round(b.totalComments / b.postCount),
      avg_engagement_rate: b.engagementRateCount > 0
        ? parseFloat((b.engagementRateSum / b.engagementRateCount).toFixed(4))
        : 0,
    }));
}

function computePartnershipDetails(posts, influencerUsername) {
  const paidPosts = (posts || []).filter(p => p.is_paid_partnership);
  if (paidPosts.length === 0) return [];

  const brandMap = {};

  paidPosts.forEach(post => {
    // Identify brand from: sponsor_tags > mentions > hashtags
    const brands = [];

    // 1. Sponsor tags (most reliable, from Instagram's API)
    if (post.sponsor_tags && post.sponsor_tags.length > 0) {
      brands.push(...post.sponsor_tags);
    }

    // 2. Coauthors
    if (post.coauthors && post.coauthors.length > 0) {
      brands.push(...post.coauthors);
    }

    // 3. Mentions (exclude self)
    if (post.mentions && post.mentions.length > 0) {
      const filtered = post.mentions
        .map(m => m.replace(/\.$/, ''))  // remove trailing dots
        .filter(m => m.toLowerCase() !== influencerUsername.toLowerCase());
      brands.push(...filtered);
    }

    // 4. If no brand found from above, extract from hashtags
    if (brands.length === 0 && post.hashtags && post.hashtags.length > 0) {
      brands.push(post.hashtags[0]);
    }

    // Deduplicate and normalize
    const uniqueBrands = [...new Set(brands.map(b => b.toLowerCase()))];
    if (uniqueBrands.length === 0) uniqueBrands.push('unknown');

    uniqueBrands.forEach(brand => {
      if (!brandMap[brand]) {
        brandMap[brand] = { brand, posts: [], total_likes: 0, total_comments: 0, hashtags: new Set() };
      }
      brandMap[brand].posts.push({
        code: post.code,
        url: post.url,
        date: post.date,
        likes: post.likes,
        comments: post.comments,
        caption: post.caption ? post.caption.substring(0, 120) : '',
        post_type: post.post_type,
        image_url: post.image_url,
      });
      brandMap[brand].total_likes += post.likes || 0;
      brandMap[brand].total_comments += post.comments || 0;

      // Collect hashtags from this post
      const postHashtags = (post.caption || '').match(/#[\w]+/g) || [];
      postHashtags.forEach(h => brandMap[brand].hashtags.add(h));
    });
  });

  return Object.values(brandMap)
    .map(b => ({
      brand: b.brand,
      post_count: b.posts.length,
      total_likes: b.total_likes,
      total_comments: b.total_comments,
      avg_likes: Math.round(b.total_likes / b.posts.length),
      avg_engagement: b.total_likes + b.total_comments,
      hashtags: [...b.hashtags],
      posts: b.posts,
    }))
    .sort((a, b) => b.post_count - a.post_count || b.avg_engagement - a.avg_engagement);
}

function buildProfileApiPayload(scraped, options = {}) {
  const data = scraped.data;
  const posts = data.recent_posts || [];
  const metrics = data.engagement_metrics || {};
  const med = collectEngagementSeriesForMedians(posts);
  const payload = {
    username: data.username,
    full_name: data.full_name,
    profile_pic: data.profile_pic,
    is_verified: data.is_verified,
    followers: data.followers,
    following: data.following,
    posts_count: data.posts_count,
    bio: data.bio || '',
    engagement_metrics: {
      ...metrics,
      median_likes: computeMedian(med.likes),
      median_comments: computeMedian(med.comments),
      median_engagements: computeMedian(med.engagements),
      median_engagement_rate: computeMedian(med.rates),
    },
    post_types: data.post_types,
    monthly_stats: computeMonthlyStats(posts),
    partnership_details: computePartnershipDetails(posts, data.username),
    scraped_at: scraped.scraped_at,
    methods: scraped.methods || [],
    total_posts_available: posts.length,
  };
  if (options.includeRecentPosts) payload.recent_posts = posts;
  return payload;
}

/**
 * Sort order for pagination; result is cached briefly so paging / sort toggles avoid re-sorting huge arrays.
 */
function getSortedPostRefs(scraped, sort) {
  const raw = scraped.data.recent_posts || [];
  const n = raw.length;
  if (n <= 1) return raw;
  const u = String(scraped.data?.username || '').toLowerCase();
  const sa = String(scraped.scraped_at || '');
  const key = `${u}:${sort}:${sa}`;
  const now = Date.now();
  const hit = postSortCache.get(key);
  if (hit && now - hit.at < POSTS_SORT_CACHE_MS) {
    return hit.posts;
  }
  const posts = raw.slice();
  switch (sort) {
    case 'likes':
      posts.sort((a, b) => (b.likes || 0) - (a.likes || 0));
      break;
    case 'comments':
      posts.sort((a, b) => (b.comments || 0) - (a.comments || 0));
      break;
    case 'date':
    default:
      posts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
  postSortCache.set(key, { at: now, posts });
  evictMapOldest(postSortCache, MAX_POSTS_SORT_CACHE);
  return posts;
}

// ---------- ROUTES ----------

/**
 * GET /api/config/live
 * Safe, non-secret flags for the UI (Instaloader + browser session readiness).
 */
app.get('/api/config/live', (req, res) => {
  const v = String(process.env.USE_INSTALOADER || '').toLowerCase();
  const useInstaloader = v === '1' || v === 'true' || v === 'yes';
  const cookies = String(process.env.IG_ACC1_COOKIES || process.env.IG_COOKIES || '').trim();
  const csrf = String(process.env.IG_ACC1_CSRF || process.env.IG_CSRF_TOKEN || '').trim();
  const hasIgCookies = Boolean(cookies && csrf);
  const sessionFile = String(process.env.INSTALOADER_SESSION_FILE || '').trim();
  let instaloaderSessionFileExists = false;
  if (sessionFile) {
    try {
      instaloaderSessionFileExists = fs.existsSync(sessionFile);
    } catch {
      instaloaderSessionFileExists = false;
    }
  }
  const ilUser = String(process.env.INSTALOADER_USER || '').trim();
  const ilPass = String(process.env.INSTALOADER_PASSWORD || process.env.INSTALOADER_PASS || '').trim();
  const hasInstaloaderPasswordLogin = Boolean(ilUser && ilPass);
  const instaloaderReady = useInstaloader && (instaloaderSessionFileExists || hasInstaloaderPasswordLogin);
  let instaloader_status = 'off';
  if (useInstaloader) {
    if (instaloaderReady) {
      instaloader_status = 'ready';
    } else if (sessionFile && !instaloaderSessionFileExists) {
      instaloader_status = 'file_missing';
    } else {
      instaloader_status = 'needs_creds';
    }
  }
  const mongoUriSet = Boolean(String(process.env.MONGO_URI || '').trim());
  return res.json({
    use_instaloader: useInstaloader,
    has_ig_cookies: hasIgCookies,
    instaloader_session_path_set: Boolean(sessionFile),
    instaloader_session_file_exists: instaloaderSessionFileExists,
    instaloader_has_password_login: hasInstaloaderPasswordLogin,
    instaloader_ready: instaloaderReady,
    instaloader_status,
    mongo_uri_set: mongoUriSet,
    mongo_connected: mongoose.connection.readyState === 1,
  });
});

/**
 * GET /api/profile/:username/live
 * Fetches current followers / post likes from Instagram (uses IG_* cookies in backend/.env).
 * Does not write MongoDB. Register before /api/profile/:username.
 */
app.get('/api/profile/:username/live', async (req, res) => {
  const livePath = path.join(__dirname, '..', '..', 'scraper', 'live-profile-fetch.js');
  let fetchLive;
  try {
    fetchLive = require(livePath);
  } catch (err) {
    return res.status(500).json({ error: 'live_module', message: err.message });
  }
  const src = String(req.query.source || 'auto').toLowerCase();
  if (!['auto', 'instaloader', 'cookies'].includes(src)) {
    return res.status(400).json({ error: 'bad_source', message: 'source must be auto, instaloader, or cookies' });
  }
  const maxPosts = Math.min(Math.max(parseInt(String(req.query.maxPosts), 10) || 12, 1), 50);
  try {
    const scraped = await fetchLive.fetchLiveAsScrapedDoc(req.params.username, {
      maxPosts,
      source: src,
    });
    if (!scraped) {
      return res.status(404).json({ error: 'Profile not found', message: 'Instagram returned no profile.' });
    }
    if (scraped._private) {
      return res.status(403).json({ error: 'private', message: 'This account is private.' });
    }
    const payload = buildProfileApiPayload(scraped, { includeRecentPosts: true });
    payload.data_source = 'instagram_live';
    payload.live_source = src;
    return res.json(payload);
  } catch (err) {
    if (err.code === 'INSTALOADER_FAILED' || err.code === 'INSTALOADER_DISABLED') {
      return res.status(503).json({
        error: err.code,
        message: err.message,
      });
    }
    if (err.code === 'PROFILE_EMPTY') {
      return res.status(404).json({ error: 'PROFILE_EMPTY', message: err.message });
    }
    const code = err.message;
    const status =
      code === 'RATE_LIMITED' ? 429 : code === 'AUTH_ERROR' ? 401 : code.startsWith('HTTP_') ? 502 : 502;
    return res.status(status).json({
      error: err.code || code,
      message:
        code === 'AUTH_ERROR'
          ? 'Invalid or expired Instagram session — refresh IG_COOKIES + IG_CSRF_TOKEN in backend/.env (copy from Chrome DevTools) and optional IG_LSD, then restart the API'
          : err.message,
    });
  }
});

/**
 * GET /api/profile/:username
 * Returns profile info + engagement metrics (Mongo / JSON, not live Instagram)
 */
app.get('/api/profile/:username', async (req, res) => {
  const { username } = req.params;
  let scraped;
  try {
    scraped = await resolveProfileDocument(username);
  } catch (err) {
    return res.status(500).json({ error: 'Lookup failed', message: err.message });
  }

  if (!scraped || !scraped.data) {
    const u = String(username || '')
      .trim()
      .replace(/^@/, '');
    const suggestions = await suggestUsernamesForQuery(u);
    return res.status(404).json({
      error: 'Profile not found',
      message: `No stored data for @${u} (Mongo / backend/data). Try a full handle from the list, or use "Refresh live" for a public account.`,
      username: u,
      suggestions,
    });
  }

  res.json({ ...buildProfileApiPayload(scraped), data_source: 'database' });
});

/**
 * GET /api/profile/:username/posts
 * Returns paginated posts
 *
 * Query params:
 *   sort   - "date" (default), "likes", "comments"
 *   size   - posts per page (default 8)
 *   offset - starting index (default 0)
 */
app.get('/api/profile/:username/posts', async (req, res) => {
  const { username } = req.params;
  const sort = req.query.sort || 'date';
  const size = Math.min(parseInt(req.query.size) || 8, 50);
  const offset = parseInt(req.query.offset) || 0;

  let scraped;
  try {
    scraped = await resolveProfileDocument(username);
  } catch (err) {
    return res.status(500).json({ error: 'Lookup failed', message: err.message });
  }

  if (!scraped || !scraped.data) {
    return res.status(404).json({
      error: 'Profile not found',
      message: `No data available for @${username}. Run the scraper first.`,
    });
  }

  const posts = getSortedPostRefs(scraped, sort);
  const total = posts.length;
  const paginatedPosts = posts.slice(offset, offset + size);

  res.json({
    posts: paginatedPosts,
    total,
    offset,
    size,
    sort,
    has_more: offset + size < total,
  });
});

/**
 * GET /api/profiles/db?q=&limit=
 * Profiles stored in MongoDB (same collection as queue-crawler) — for UI picker.
 */
app.get('/api/profiles/db', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.json({ profiles: [], mongo_connected: false });
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 200, 1), 500);
  const q = String(req.query.q || '').trim();
  let filter = {};
  if (q) {
    filter['data.username'] = { $regex: escapeRegex(q), $options: 'i' };
  } else {
    filter['data.username'] = { $exists: true, $nin: [null, ''] };
  }
  try {
    const rows = await Profile.find(filter)
      .select({ 'data.username': 1, 'data.full_name': 1, 'data.followers': 1, 'data.profile_pic': 1, scraped_at: 1 })
      .sort({ scraped_at: -1 })
      .limit(limit)
      .lean();
    const profiles = rows
      .map((row) => ({
        username: row.data?.username,
        full_name: row.data?.full_name || '',
        followers: row.data?.followers ?? 0,
        profile_pic: row.data?.profile_pic || '',
        scraped_at: row.scraped_at,
        our_category: row.data?.our_category || (row.crawl_info && row.crawl_info.our_category) || '',
      }))
      .filter((p) => p.username);
    return res.json({ profiles, mongo_connected: true, total: profiles.length });
  } catch (e) {
    return res.status(500).json({ error: e.message, profiles: [], mongo_connected: true });
  }
});

/** Parallel JSON reads for /api/profiles (I/O bound; small concurrency avoids thrashing). */
const PROFILES_READ_CONCURRENCY = 16;

/**
 * GET /api/profiles
 * Lists all available scraped profiles
 */
app.get('/api/profiles', async (req, res) => {
  const now = Date.now();
  if (profilesListCache.payload && now - profilesListCache.at < PROFILES_LIST_CACHE_MS) {
    return res.json(profilesListCache.payload);
  }

  if (!fs.existsSync(DATA_DIR)) {
    profilesListCache = { at: now, payload: { profiles: [] } };
    return res.json(profilesListCache.payload);
  }

  let files;
  try {
    const all = await fsp.readdir(DATA_DIR);
    files = all.filter((f) => f.endsWith('_complete.json'));
  } catch {
    profilesListCache = { at: now, payload: { profiles: [] } };
    return res.json(profilesListCache.payload);
  }

  const profiles = [];
  for (let i = 0; i < files.length; i += PROFILES_READ_CONCURRENCY) {
    const batch = files.slice(i, i + PROFILES_READ_CONCURRENCY);
    const chunk = await Promise.all(
      batch.map(async (f) => {
        const username = f.replace('_complete.json', '');
        const filePath = path.join(DATA_DIR, f);
        try {
          const raw = await fsp.readFile(filePath, 'utf8');
          const data = JSON.parse(raw);
          return {
            username: data?.data?.username || username,
            full_name: data?.data?.full_name || username,
            profile_pic: data?.data?.profile_pic || '',
            is_verified: data?.data?.is_verified || false,
            followers: data?.data?.followers || 0,
            posts_available: (data?.data?.recent_posts || []).length,
            scraped_at: data?.scraped_at || null,
          };
        } catch {
          return { username, error: 'Failed to load' };
        }
      })
    );
    for (let j = 0; j < chunk.length; j += 1) {
      profiles.push(chunk[j]);
    }
  }

  profilesListCache = { at: now, payload: { profiles } };
  res.json(profilesListCache.payload);
});

/**
 * GET /api/image-proxy
 * Proxies Instagram CDN images to avoid referrer-based blocking.
 * Query: ?url=<encoded instagram CDN url>
 */
app.get('/api/image-proxy', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const parsed = new URL(imageUrl);
    // Only allow Instagram CDN domains
    if (!parsed.hostname.includes('instagram') && !parsed.hostname.includes('fbcdn')) {
      return res.status(403).json({ error: 'Only Instagram image URLs allowed' });
    }

    https.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        return res.status(proxyRes.statusCode).end();
      }
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      proxyRes.pipe(res);
    }).on('error', () => {
      res.status(502).json({ error: 'Failed to fetch image' });
    });
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

// ---------- START ----------

async function start() {
  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        dbName: process.env.MONGO_DB || 'coherent2026_db',
      });
      console.log(`  MongoDB: connected (${MONGO_COLLECTION})`);
    } catch (err) {
      console.warn(`  MongoDB: not connected (${err.message}) — using JSON files only`);
    }
  } else {
    console.log('  MongoDB: MONGO_URI not set — using JSON files only');
  }

  app.listen(PORT, () => {
    console.log(`\n  Backend API running on http://localhost:${PORT}`);
    console.log(`  Data directory: ${DATA_DIR}\n`);
    console.log('  Endpoints:');
    console.log('    GET /api/profiles                     - List profiles (local JSON in data/)');
  console.log('    GET /api/profiles/db?q=               - List profiles in Mongo (for UI)');
  console.log('    GET /api/config/live                  - Instaloader + cookie flags (for UI, no secrets)');
  console.log('    GET /api/profile/:username/live         - Live Instagram (?source=auto|instaloader|cookies&maxPosts=12)');
  console.log('    GET /api/profile/:username             - Profile info + metrics (Mongo / JSON)');
  console.log('    GET /api/profile/:username/posts       - Paginated posts');
    console.log('        ?sort=date|likes|comments');
    console.log('        &size=8&offset=0\n');
  });
}

start();
