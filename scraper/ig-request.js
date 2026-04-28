/**
 * Shared Instagram HTTPS helpers — same headers as queue-crawler worker.
 * Used by queue-crawler.js and live-profile-fetch.js so /live and scraping hit IG identically.
 */

const https = require('https');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Read env on each access so loading after dotenv.config() still picks up IG_USER_AGENT. */
const IG_CONFIG = {};
Object.defineProperty(IG_CONFIG, 'userAgent', {
  enumerable: true,
  get() {
    return process.env.IG_USER_AGENT || DEFAULT_UA;
  },
});
Object.defineProperty(IG_CONFIG, 'igAppId', {
  enumerable: true,
  get() {
    return process.env.IG_APP_ID || '936619743392459';
  },
});

const DEFAULT_WWW_CLAIM = 'hmac.AR0si6YYQcCivXubfm_ml_WZ_kREfaxkrMM2Q2UsZFtgRW5R';

function httpGet(url, extraHeaders = {}, account) {
  if (!account?.cookies) {
    return Promise.reject(new Error('NO_IG_ACCOUNT'));
  }
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        cookie: account.cookies,
        'user-agent': IG_CONFIG.userAgent,
        'sec-fetch-mode': 'navigate',
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetJson(url, extraHeaders = {}, account) {
  if (!account?.cookies) {
    return Promise.reject(new Error('NO_IG_ACCOUNT'));
  }
  const claim = (process.env.IG_WWW_CLAIM || '').trim() || DEFAULT_WWW_CLAIM;
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lsd = (process.env.IG_LSD || process.env.IG_FBLSD || '').trim();
    const headers = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      cookie: account.cookies,
      'user-agent': IG_CONFIG.userAgent,
      'x-csrftoken': account.csrf,
      'x-ig-app-id': IG_CONFIG.igAppId,
      'x-asbd-id': process.env.IG_ASBD_ID || '359341',
      'x-ig-www-claim': claim,
      'x-requested-with': 'XMLHttpRequest',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: 'https://www.instagram.com/',
      ...extraHeaders,
    };
    if (lsd) headers['x-fb-lsd'] = lsd;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('AUTH_ERROR'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP_${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON_PARSE_ERROR'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { httpGet, httpGetJson, IG_CONFIG };
