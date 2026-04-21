/**
 * One-off live fetch from Instagram (HTML + feed API). Does not write Mongo/Redis.
 * Used by backend GET /api/profile/:username/live — load credentials from process.env.
 *
 * Uses ./ig-request.js — same HTTPS headers and cookie handling as queue-crawler.js (real IG data).
 */

const { httpGet, httpGetJson } = require('./ig-request');

function loadAccountFromEnv() {
  const cookies = process.env.IG_ACC1_COOKIES || process.env.IG_COOKIES || '';
  const csrf = process.env.IG_ACC1_CSRF || process.env.IG_CSRF_TOKEN || '';
  const stripped = cookies.replace(/^["']|["']$/g, '');
  return { id: 1, cookies: stripped, csrf };
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

function parseMetaCount(str) {
  if (!str) return 0;
  str = String(str).replace(/,/g, '');
  const num = parseFloat(str);
  if (str.includes('B')) return Math.round(num * 1000000000);
  if (str.includes('M')) return Math.round(num * 1000000);
  if (str.includes('K')) return Math.round(num * 1000);
  return parseInt(str, 10) || 0;
}

function mapWebProfileUser(u, username) {
  if (!u) return null;
  return {
    username: u.username || username,
    pk: u.id != null ? String(u.id) : '',
    full_name: u.full_name || '',
    followers: u.edge_followed_by?.count ?? 0,
    following: u.edge_follow?.count ?? 0,
    posts_count: u.edge_owner_to_timeline_media?.count ?? 0,
    bio: u.biography || '',
    category: u.category_name || '',
    external_url: u.external_url || '',
    profile_pic: String(u.profile_pic_url_hd || u.profile_pic_url || '').replace(/&amp;/g, '&'),
    is_verified: !!u.is_verified,
    is_private: !!u.is_private,
  };
}

/** Same web_profile_info call the browser uses; referer variants for picky endpoints. */
async function fetchWebProfileInfo(username, acc) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const ref = { referer: `https://www.instagram.com/${encodeURIComponent(username)}/` };
  for (const extra of [ref, {}]) {
    try {
      const json = await httpGetJson(url, extra, acc);
      const mapped = mapWebProfileUser(json.data?.user, username);
      if (mapped) return mapped;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function scrapeProfileFromHtml(username, acc) {
  const response = await httpGet(
    `https://www.instagram.com/${encodeURIComponent(username)}/`,
    {},
    acc
  );
  if (response.status === 404) return null;
  if (response.status === 429) throw new Error('RATE_LIMITED');
  if (response.status === 400 || response.status === 403) return null;
  if (response.status !== 200) throw new Error(`HTTP_${response.status}`);

  const html = response.body;
  const profile = { username };

  const pkMatch =
    html.match(/"profilePage_(\d+)"/) ||
    html.match(/"user_id":"(\d+)"/) ||
    html.match(/"id":"(\d+)".*?"username":"[^"]*"/);
  if (pkMatch) profile.pk = pkMatch[1];

  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

  if (ogTitle) {
    const decoded = decodeHtmlEntities(ogTitle[1]);
    const nameMatch = decoded.match(/^(.+?)\s*\(@/);
    profile.full_name = nameMatch ? nameMatch[1].trim() : decoded;
  }

  if (ogDesc) {
    const desc = ogDesc[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    const followersMatch = desc.match(/([\d,.]+[MKB]?)\s*Followers/i);
    const followingMatch = desc.match(/([\d,.]+[MKB]?)\s*Following/i);
    const postsMatch = desc.match(/([\d,.]+[MKB]?)\s*Posts/i);
    profile.followers = parseMetaCount(followersMatch?.[1]);
    profile.following = parseMetaCount(followingMatch?.[1]);
    profile.posts_count = parseMetaCount(postsMatch?.[1]);
  }

  const bioJsonMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  if (bioJsonMatch && bioJsonMatch[1] !== '') {
    try {
      profile.bio = JSON.parse(`"${bioJsonMatch[1]}"`);
    } catch (e) {
      profile.bio = bioJsonMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }

  if (!profile.bio) {
    const metaDescIdx = html.indexOf('name="description"');
    if (metaDescIdx > -1) {
      const snippet = html.substring(Math.max(0, metaDescIdx - 1000), metaDescIdx + 50);
      const bioMatch = snippet.match(/on Instagram: &quot;([\s\S]+)&quot;/);
      if (bioMatch) profile.bio = decodeHtmlEntities(bioMatch[1]);
    }
  }

  const extUrlMatch = html.match(/"external_url":"((?:[^"\\]|\\.)*)"/);
  if (extUrlMatch && extUrlMatch[1] !== '') {
    try {
      profile.external_url = JSON.parse(`"${extUrlMatch[1]}"`);
    } catch (e) {
      profile.external_url = extUrlMatch[1];
    }
  }

  const categoryMatch = html.match(/"category_name":"((?:[^"\\]|\\.)*)"/);
  if (categoryMatch) profile.category = categoryMatch[1];

  if (ogImage) profile.profile_pic = ogImage[1].replace(/&amp;/g, '&');
  profile.is_verified = html.includes('is_verified":true') || html.includes('isVerified":true');
  profile.is_private = html.includes('is_private":true');

  return profile;
}

async function scrapeProfile(username, acc) {
  const u = String(username || '')
    .trim()
    .replace(/^@/, '');
  if (!u) return null;

  const viaApi = await fetchWebProfileInfo(u, acc);
  if (viaApi) return viaApi;

  return scrapeProfileFromHtml(u, acc);
}

async function fetchUserPosts(username, acc, maxPosts = 12) {
  const allPosts = [];
  let maxId = null;
  let pages = 0;
  let lastMaxId = null;

  while (allPosts.length < maxPosts && pages++ < 6) {
    let url = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`;
    if (maxId) url += `&max_id=${maxId}`;

    const json = await httpGetJson(
      url,
      { referer: `https://www.instagram.com/${encodeURIComponent(username)}/` },
      acc
    );
    const items = json?.items || [];
    if (items.length === 0) break;

    allPosts.push(...items);
    if (!json.more_available) break;
    if (maxId && maxId === lastMaxId) break;
    lastMaxId = maxId;
    maxId = json.next_max_id;
  }

  return allPosts.slice(0, maxPosts);
}

function parsePost(node, followers) {
  const captionText = node.caption?.text || '';
  const userTags = node.usertags?.in?.map((t) => t.user?.username).filter(Boolean) || [];
  const captionMentions = (captionText.match(/@[\w.]+/g) || []).map((m) => m.slice(1));
  const allMentions = [...new Set([...userTags, ...captionMentions])];
  const hashtags = (captionText.match(/#[\w]+/g) || []).map((h) => h.slice(1));
  const sponsorTags = (node.sponsor_tags || []).map((s) => s.username || s.name).filter(Boolean);
  const coauthors = (node.coauthor_producers || []).map((c) => c.username).filter(Boolean);

  const likeCount = node.like_count || 0;
  const commentCount = node.comment_count || 0;

  return {
    code: node.code,
    url: `https://www.instagram.com/p/${node.code}/`,
    caption: captionText,
    timestamp: node.taken_at,
    date: new Date(node.taken_at * 1000).toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
    }),
    likes: likeCount,
    comments: commentCount,
    views: node.view_count || node.play_count || 0,
    post_type: node.product_type === 'clips' ? 'Reel' : 'Post',
    media_type: node.media_type,
    is_paid_partnership: node.is_paid_partnership || false,
    mentions: allMentions,
    hashtags,
    sponsor_tags: sponsorTags,
    coauthors,
    carousel_count: node.carousel_media_count || null,
    image_url: node.image_versions2?.candidates?.[0]?.url || null,
    engagement_rate:
      followers > 0 ? parseFloat((((likeCount + commentCount) / followers) * 100).toFixed(4)) : 0,
  };
}

function buildLiveDocument(profile, rawPosts, methods) {
  const u = profile.username || '';
  const followers = profile.followers || 0;
  const parsed = rawPosts.map((node) => parsePost(node, followers || 1));
  const metrics = computeMetrics(parsed, followers);
  return {
    scraped_at: new Date().toISOString(),
    methods,
    data: {
      username: profile.username || u,
      full_name: profile.full_name || '',
      profile_pic: profile.profile_pic || '',
      is_verified: !!profile.is_verified,
      pk: profile.pk || '',
      followers,
      following: profile.following || 0,
      posts_count: profile.posts_count || 0,
      bio: profile.bio || '',
      category: profile.category || '',
      external_url: profile.external_url || '',
      engagement_metrics: metrics || {},
      post_types: metrics?.post_types || {},
      recent_posts: parsed,
    },
  };
}

function computeMetrics(posts, followers) {
  const count = posts.length;
  if (count === 0) return null;

  const totalLikes = posts.reduce((s, p) => s + p.likes, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalViews = posts.reduce((s, p) => s + p.views, 0);

  let postsPerWeek = 0;
  if (count >= 2) {
    const sorted = [...posts].sort((a, b) => a.timestamp - b.timestamp);
    const weeks = (sorted[count - 1].timestamp - sorted[0].timestamp) / (7 * 24 * 60 * 60);
    postsPerWeek = weeks > 0 ? parseFloat((count / weeks).toFixed(1)) : count;
  }

  const postTypes = {};
  posts.forEach((p) => {
    postTypes[p.post_type] = (postTypes[p.post_type] || 0) + 1;
  });

  return {
    posts_analyzed: count,
    total_likes: totalLikes,
    total_comments: totalComments,
    total_views: totalViews,
    avg_likes: Math.round(totalLikes / count),
    avg_comments: Math.round(totalComments / count),
    avg_views: Math.round(totalViews / count),
    engagement_rate:
      followers > 0
        ? parseFloat((((totalLikes + totalComments) / count / followers) * 100).toFixed(2))
        : 0,
    posts_per_week: postsPerWeek,
    partnership_posts: posts.filter((p) => p.is_paid_partnership).length,
    post_types: postTypes,
  };
}

/**
 * @returns {Promise<{ scraped_at: string, data: object } | null>}
 */
async function fetchLiveAsScrapedDoc(username, options = {}) {
  const maxPosts = options.maxPosts ?? 12;
  const u = String(username || '')
    .trim()
    .replace(/^@/, '');
  if (!u) return null;

  const { isInstaloaderEnabled, fetchInstaloaderProfileAndPosts } = require('./instaloader-bridge');
  if (isInstaloaderEnabled()) {
    const pack = await fetchInstaloaderProfileAndPosts(u, maxPosts);
    if (pack) {
      const { profile, items } = pack;
      if (profile.is_private) {
        return {
          scraped_at: new Date().toISOString(),
          data: { ...profile, username: u },
          _private: true,
        };
      }
      return buildLiveDocument(profile, items, ['instaloader', 'instagram_live']);
    }
  }

  const acc = loadAccountFromEnv();
  if (!acc.cookies || !acc.csrf) {
    throw new Error('Missing Instagram cookies: set IG_ACC1_COOKIES + IG_ACC1_CSRF (or IG_COOKIES + IG_CSRF_TOKEN) in backend/.env');
  }

  const profile = await scrapeProfile(u, acc);
  if (!profile) return null;
  if (profile.is_private) {
    return {
      scraped_at: new Date().toISOString(),
      data: { ...profile, username: u },
      _private: true,
    };
  }

  let rawPosts = [];
  try {
    rawPosts = await fetchUserPosts(u, acc, maxPosts);
  } catch (e) {
    rawPosts = [];
  }

  return buildLiveDocument(profile, rawPosts, [
    'instagram_live',
    'ig_request',
    'web_profile_info',
    'html_profile',
    'api_v1_feed',
  ]);
}

module.exports = { fetchLiveAsScrapedDoc, loadAccountFromEnv };
