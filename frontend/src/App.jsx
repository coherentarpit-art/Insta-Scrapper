import { useState, useEffect, useRef } from 'react';
import ProfileHeader from './components/ProfileHeader';
import PlatformTabs from './components/PlatformTabs';
import StatsGrid from './components/StatsGrid';
import PostsGrid from './components/PostsGrid';
import DatabaseProfilePicker from './components/DatabaseProfilePicker';

const API_BASE = '/api';

// Proxy Instagram CDN images through our backend to avoid referrer blocking
const proxyImg = (url) => {
  if (!url) return '';
  if (url.includes('instagram') || url.includes('fbcdn')) {
    return `${API_BASE}/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
};

function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\s+/g, '');
}

function instaloaderBadgeLabel(c, { cookiesOk = false } = {}) {
  if (!c || c.fetch_error) return '· …';
  if (!c.use_instaloader) return '· off';
  if (c.instaloader_ready) return '· ready';
  const s = c.instaloader_status;
  // If browser cookies work, Instaloader is only needed for "Instaloader only" — don't alarm in Auto/Browser
  if (cookiesOk) {
    if (s === 'file_missing' || s === 'needs_creds') return '· not set (optional for Auto)';
  }
  if (s === 'file_missing') return '· no file at path';
  if (s === 'needs_creds') return '· set session or password';
  return '· incomplete';
}

function App() {
  const [profile, setProfile] = useState(null);
  const [posts, setPosts] = useState([]);
  const [totalPosts, setTotalPosts] = useState(0);
  const [activeTab, setActiveTab] = useState('instagram');
  const [sortBy, setSortBy] = useState('date');
  const [page, setPage] = useState(0);
  /** Initial GET /api/profile/:u (saved / Mongo) — only this uses full-page loading. */
  const [savedProfileLoading, setSavedProfileLoading] = useState(false);
  /** GET /api/profile/:u/live — inline only, does not hide the whole page. */
  const [liveLoading, setLiveLoading] = useState(false);
  const [error, setError] = useState(null);
  /** Live fetch failed but we still have a saved profile — show banner, not full-page error. */
  const [liveError, setLiveError] = useState(null);
  const [username, setUsername] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return normalizeUsername(q.get('u') || q.get('username') || '');
  });
  const [searchDraft, setSearchDraft] = useState(username);
  const [dataSource, setDataSource] = useState('saved');
  const [livePostBuffer, setLivePostBuffer] = useState(null);
  /** Which flow last failed — so we show the right help text (Mongo vs live cookies). */
  const [errorKind, setErrorKind] = useState(null);
  /** GET /api/profile/.../live?source= — auto | instaloader | cookies */
  const [liveFetchMode, setLiveFetchMode] = useState('auto');
  /** Usernames from API 404 (\"did you mean\" / contains match) */
  const [savedSuggestions, setSavedSuggestions] = useState([]);
  /** GET /api/config/live — which paths are configured (no secrets). */
  const [liveConfig, setLiveConfig] = useState(null);
  const profileRef = useRef(null);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const perPage = 8;

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/config/live`, { cache: 'no-store' });
        const j = await res.json().catch(() => ({}));
        if (ok) setLiveConfig(j);
      } catch {
        if (ok) setLiveConfig({ fetch_error: true });
      }
    })();
    return () => {
      ok = false;
    };
  }, []);

  // Load profile when username changes (?u= also supported via initial state)
  useEffect(() => {
    if (!username) {
      setProfile(null);
      setPosts([]);
      setTotalPosts(0);
      setError(null);
      setLiveError(null);
      setSavedProfileLoading(false);
      setLiveLoading(false);
      setDataSource('saved');
      setLivePostBuffer(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setSavedProfileLoading(true);
      setLiveLoading(false);
      setError(null);
      setLiveError(null);
      setErrorKind(null);
      setProfile(null);
      setLivePostBuffer(null);
      setDataSource('saved');
      setSavedSuggestions([]);
      try {
        const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(username)}`, {
          cache: 'no-store',
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSavedSuggestions(Array.isArray(j.suggestions) ? j.suggestions : []);
          throw new Error(j.message || j.error || 'Profile not found');
        }
        if (!cancelled) {
          setProfile(j);
          setPage(0);
        }
        if (!cancelled) setSavedSuggestions([]);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setErrorKind('saved');
          setProfile(null);
        }
      } finally {
        if (!cancelled) setSavedProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  // Load posts when sort or page changes (saved = API; live = slice buffer client-side)
  useEffect(() => {
    if (!profile || !username) return;

    if (dataSource === 'live' && livePostBuffer && livePostBuffer.length > 0) {
      const list = [...livePostBuffer];
      switch (sortBy) {
        case 'likes':
          list.sort((a, b) => (b.likes || 0) - (a.likes || 0));
          break;
        case 'comments':
          list.sort((a, b) => (b.comments || 0) - (a.comments || 0));
          break;
        case 'date':
        default:
          list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          break;
      }
      setPosts(list.slice(page * perPage, page * perPage + perPage));
      setTotalPosts(list.length);
      return;
    }

    if (dataSource === 'live') {
      setPosts([]);
      setTotalPosts(0);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/profile/${encodeURIComponent(username)}/posts?sort=${sortBy}&size=${perPage}&offset=${page * perPage}`,
          { cache: 'no-store' }
        );
        if (!res.ok) throw new Error('Failed to load posts');
        const data = await res.json();
        if (!cancelled) {
          setPosts(data.posts);
          setTotalPosts(data.total);
        }
      } catch (err) {
        console.error('Error loading posts:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sortBy, page, profile, username, dataSource, livePostBuffer]);

  const applySearch = () => {
    const u = normalizeUsername(searchDraft);
    setSearchDraft(u);
    if (!u) return;
    const url = new URL(window.location.href);
    url.searchParams.set('u', u);
    window.history.replaceState({}, '', url);
    setUsername(u);
  };

  const selectFromDatabase = (raw) => {
    const u = normalizeUsername(raw);
    if (!u) return;
    setSearchDraft(u);
    const url = new URL(window.location.href);
    url.searchParams.set('u', u);
    window.history.replaceState({}, '', url);
    setUsername(u);
  };

  const goHome = () => {
    setUsername('');
    setSearchDraft('');
    setProfile(null);
    setError(null);
    setLiveError(null);
    setErrorKind(null);
    setSavedSuggestions([]);
    setDataSource('saved');
    setLivePostBuffer(null);
    setPage(0);
    const url = new URL(window.location.href);
    url.searchParams.delete('u');
    url.searchParams.delete('username');
    window.history.replaceState({}, '', url);
  };

  const loadLiveFromInstagram = async () => {
    const u = normalizeUsername(username);
    if (!u) return;
    setLiveLoading(true);
    setError(null);
    setErrorKind(null);
    setLiveError(null);
    setSavedSuggestions([]);
    try {
      const qs = new URLSearchParams();
      qs.set('source', liveFetchMode);
      qs.set('maxPosts', '12');
      const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(u)}/live?${qs}`, {
        cache: 'no-store',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j.message || j.error || `Live fetch failed (${res.status})`;
        throw new Error(msg);
      }
      const { recent_posts: recentPosts, ...rest } = j;
      setProfile(rest);
      setDataSource('live');
      setLivePostBuffer(Array.isArray(recentPosts) ? recentPosts : []);
      setPage(0);
      setLiveError(null);
    } catch (e) {
      if (profileRef.current) {
        setLiveError(e.message || 'Live fetch failed');
      } else {
        setError(e.message || 'Live fetch failed');
        setErrorKind('live');
      }
    } finally {
      setLiveLoading(false);
    }
  };

  const appNav = () => {
    const onProfile = Boolean(username);
    return (
      <header className="flex items-center justify-between gap-2 border-b border-violet-100/90 bg-gradient-to-r from-violet-50/95 via-white to-rose-50/30 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
          {onProfile && (
            <button
              type="button"
              onClick={goHome}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-violet-200/80 bg-white/80 px-2 py-1.5 text-xs font-medium text-violet-800 shadow-sm transition hover:bg-violet-100/60 sm:gap-1.5 sm:px-2.5 sm:text-sm"
            >
              <span className="text-base leading-none" aria-hidden>
                ←
              </span>
              <span className="hidden sm:inline">All profiles</span>
              <span className="sm:hidden">Back</span>
            </button>
          )}
          {onProfile ? (
            <p className="min-w-0 truncate text-sm font-medium text-gray-800 sm:text-base" title={username}>
              <span className="text-gray-500">@</span>
              {username}
            </p>
          ) : (
            <h1 className="text-sm font-bold tracking-tight text-violet-900 sm:text-base">Profile viewer</h1>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {onProfile && (
            <button
              type="button"
              onClick={goHome}
              className="rounded-lg px-2 py-1.5 text-xs font-semibold text-violet-700 underline-offset-2 hover:bg-violet-100/50 hover:underline sm:px-3 sm:text-sm"
            >
              Home
            </button>
          )}
          <span className="hidden text-[10px] font-medium uppercase tracking-wider text-gray-400 sm:inline sm:text-xs">IG insights</span>
        </div>
      </header>
    );
  };

  const searchBar = (
    <div className="max-w-4xl mx-auto space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch sm:gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center">
          <input
            type="text"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            placeholder="username (no @)"
            className="min-w-0 flex-1 rounded-lg border border-gray-200/90 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
          />
          <button
            type="button"
            onClick={applySearch}
            disabled={savedProfileLoading}
            className="shrink-0 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savedProfileLoading ? 'Loading…' : 'Load saved'}
          </button>
        </div>
        <div className="h-px bg-gray-100 sm:hidden" aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-1.5 rounded-xl border border-rose-100/90 bg-rose-50/40 p-2.5 sm:min-w-[min(100%,300px)] sm:max-w-md sm:flex-initial">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-rose-900/80 sm:text-xs">Live fetch</span>
            <span className="text-[9px] text-rose-700/70 sm:text-[10px]">not saved to DB</span>
          </div>
          {liveConfig && !liveConfig.fetch_error && (() => {
            const ilOk = liveConfig.instaloader_ready;
            const useIl = liveConfig.use_instaloader;
            const cookiesOk = liveConfig.has_ig_cookies;
            const ilSoft = useIl && !ilOk && cookiesOk;
            return (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Server live configuration">
              {useIl && (
              <span
                className={`inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[9px] font-medium sm:text-[10px] ${
                  ilOk
                    ? 'bg-emerald-100/90 text-emerald-900'
                    : ilSoft
                      ? 'bg-slate-200/80 text-slate-600'
                      : useIl
                        ? 'bg-amber-100/90 text-amber-900'
                        : 'bg-gray-200/60 text-gray-600'
                }`}
                title={
                  ilSoft
                    ? 'Instaloader session file not on disk, but your browser cookies work — Auto and Browser will still fetch live. Fix this only if you use “Instaloader only”.'
                    : 'USE_INSTALOADER=1 plus INSTALOADER_SESSION_FILE (file must exist) or INSTALOADER_USER+PASSWORD. backend/.env and scraper/.env are both loaded.'
                }
              >
                Instaloader {instaloaderBadgeLabel(liveConfig, { cookiesOk })}
              </span>
              )}
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium sm:text-[10px] ${
                  liveConfig.has_ig_cookies ? 'bg-emerald-100/90 text-emerald-900' : 'bg-amber-100/90 text-amber-900'
                }`}
                title="IG_ACC1_COOKIES/IG_COOKIES + IG_ACC1_CSRF/IG_CSRF_TOKEN in backend or scraper .env"
              >
                Browser {liveConfig.has_ig_cookies ? '· session set' : '· cookies missing'}
              </span>
            </div>
            );
          })()}
          {/* No browser cookies: show full Instaloader setup (they may depend on Python) */}
          {liveConfig?.instaloader_status === 'file_missing' && liveConfig?.use_instaloader && !liveConfig.has_ig_cookies && (
            <p className="text-[9px] leading-snug text-amber-900/90 sm:text-[10px]">
              Instaloader: <code className="rounded bg-white/50 px-0.5">INSTALOADER_SESSION_FILE</code> must point to a real file. Run{' '}
              <code className="rounded bg-white/50 px-0.5">python -m instaloader --login YOUR_IG_USER</code>, set the path to the{' '}
              <code className="rounded bg-white/50 px-0.5">session-…</code> file, or <code className="rounded bg-white/50 px-0.5">USE_INSTALOADER=0</code>.
            </p>
          )}
          {liveConfig?.instaloader_status === 'needs_creds' && liveConfig?.use_instaloader && !liveConfig.has_ig_cookies && (
            <p className="text-[9px] leading-snug text-amber-900/90 sm:text-[10px]">
              Add <code className="rounded bg-white/50 px-0.5">INSTALOADER_SESSION_FILE</code> + <code className="rounded bg-white/50 px-0.5">INSTALOADER_SESSION_USER</code> (or user+password) and restart, or <code className="rounded bg-white/50 px-0.5">USE_INSTALOADER=0</code>.
            </p>
          )}
          {liveConfig && liveConfig.mongo_uri_set && !liveConfig.mongo_connected && (
            <p className="text-[9px] text-rose-800/90 sm:text-[10px]">
              Mongo: URI is set but the API is <strong>not connected</strong> (see backend logs). The profile list may stay empty until the connection works.
            </p>
          )}
          {liveConfig?.fetch_error && (
            <p className="text-[9px] text-amber-800 sm:text-[10px]">Could not read /api/config/live — is the backend running?</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={liveFetchMode}
              onChange={(e) => setLiveFetchMode(e.target.value)}
              className="w-full rounded-md border border-rose-200/80 bg-white px-2.5 py-2 text-xs text-gray-800 shadow-sm sm:min-w-[10rem] sm:max-w-[12rem] sm:text-[13px]"
              title="Instaloader and/or browser cookies in backend/.env"
            >
              <option value="auto">Auto (try Instaloader, else cookies)</option>
              <option value="instaloader">Instaloader only</option>
              <option value="cookies">Browser session only</option>
            </select>
            <button
              type="button"
              onClick={loadLiveFromInstagram}
              disabled={liveLoading || !username}
              className="w-full shrink-0 rounded-md border border-rose-300/90 bg-gradient-to-b from-rose-50 to-white px-3 py-2 text-xs font-semibold text-rose-900 shadow-sm transition hover:border-rose-400 hover:from-rose-100/60 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:whitespace-nowrap sm:px-4"
              title={username ? 'Fetches a live Instagram snapshot' : 'Enter or pick a profile first'}
            >
              {liveLoading ? 'Fetching…' : '↻ Refresh live'}
            </button>
          </div>
          {liveFetchMode === 'instaloader' && liveConfig?.use_instaloader && !liveConfig.instaloader_ready && liveConfig.has_ig_cookies && (
            <p className="text-[10px] leading-snug text-sky-900/95 sm:text-xs rounded-md border border-sky-200/90 bg-sky-50/90 px-2.5 py-2">
              <strong>Instaloader only</strong> needs a valid session file in .env. You already have <strong>Browser · session set</strong> — switch
              the dropdown to <strong>Auto</strong> or <strong>Browser session only</strong>, then <strong>↻ Refresh live</strong>. (Or create the session file with{' '}
              <code className="rounded bg-white/70 px-0.5 text-[9px]">python -m instaloader --login …</code> to use this mode.)
            </p>
          )}
          {liveFetchMode === 'instaloader' && liveConfig && !liveConfig.instaloader_ready && !liveConfig.has_ig_cookies && (
            <p className="text-[10px] leading-snug text-amber-900/90 sm:text-xs">
              <strong>Instaloader only</strong> will not work until the Instaloader badge is <strong>ready</strong> (session file) or you set browser cookies in .env and use <strong>Auto</strong>.
            </p>
          )}
          {liveFetchMode === 'cookies' && liveConfig && !liveConfig.has_ig_cookies && (
            <p className="text-[10px] leading-snug text-amber-900/90 sm:text-xs">
              Set <code className="rounded bg-white/60 px-0.5">IG_ACC1_COOKIES</code> / <code className="rounded bg-white/60 px-0.5">IG_COOKIES</code> and
              <code className="rounded bg-white/60 px-0.5">IG_ACC1_CSRF</code> / <code className="rounded bg-white/60 px-0.5">IG_CSRF_TOKEN</code> in <code className="rounded bg-white/60 px-0.5">backend/.env</code>, then restart the API.
            </p>
          )}
        </div>
      </div>
    </div>
  );

  if (!username) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {appNav()}
        <div className="px-4 py-6 sm:py-8">
          <p className="text-gray-500 text-sm mb-4 text-center max-w-2xl mx-auto">
            <strong>Load saved</strong> = Mongo/JSON from the worker. <strong>Refresh live</strong> = Instagram right now
            (nothing written to Mongo from this page). See status badges in <strong>Live fetch</strong> for Instaloader vs browser
            session.
          </p>
          {searchBar}
          <div className="max-w-4xl w-full mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            <DatabaseProfilePicker
              onSelect={selectFromDatabase}
              disabled={savedProfileLoading}
              mongoInfo={liveConfig && !liveConfig.fetch_error
                ? { uriSet: liveConfig.mongo_uri_set, connected: liveConfig.mongo_connected }
                : null}
            />
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/80 p-4 text-sm text-gray-600">
              <p className="font-medium text-gray-800 mb-2">Live mode</p>
              <ul className="list-disc pl-4 space-y-1 text-xs sm:text-sm">
                <li><strong>Auto</strong> — try Instaloader, then your saved browser cookies in .env</li>
                <li><strong>Instaloader</strong> — needs the <strong>ready</strong> badge; session file on disk and <code className="text-xs">USE_INSTALOADER=1</code></li>
                <li><strong>Browser</strong> — <code>IG_COOKIES</code> + <code>IG_CSRF_TOKEN</code> (or <code>IG_ACC1_*</code>) from DevTools</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (savedProfileLoading) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {appNav()}
        {searchBar}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-2 border-violet-600 border-t-transparent mx-auto mb-4"></div>
            <p className="text-gray-500">Loading saved data for @{username}…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {appNav()}
        {searchBar}
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">Could not load @{username}</h2>
            <p className="text-gray-500 mb-4 text-sm break-words text-left max-w-md mx-auto">{error || liveError || 'No data'}</p>
            {errorKind === 'live' ? (
              <div className="text-gray-500 text-xs text-left max-w-md mx-auto space-y-2">
                <p>
                  <strong>Browser / cookies</strong> — <code>IG_ACC1_COOKIES</code> + <code>IG_ACC1_CSRF</code> in <code>backend/.env</code> (or <code>scraper/.env</code> merge), then restart the API. Same as <code>scraper/ig-request.js</code>.
                </p>
                <p>
                  <strong>Instaloader</strong> — <code>USE_INSTALOADER=1</code>, <code>INSTALOADER_SESSION_FILE</code> + <code>INSTALOADER_SESSION_USER</code> (or user/password). If the error mentions “session check”, add <code>INSTALOADER_SKIP_TEST_LOGIN=1</code> in <code>scraper/.env</code> and restart.
                </p>
                <p>
                  Check the <strong>Live fetch</strong> badges in the bar above: Instaloader and Browser session should show <strong>ready / set</strong> for the mode you use.
                </p>
              </div>
            ) : (
              <p className="text-gray-400 text-xs">
                Load saved needs this profile in Mongo or <code className="text-gray-500">backend/data/&lt;user&gt;_complete.json</code>. Scrape with the queue worker first and set <code className="text-gray-500">MONGO_URI</code> in backend/.env if you use Atlas.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(totalPosts / perPage);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 border-b border-gray-100/90 bg-gray-50/95 backdrop-blur">
        {appNav()}
        {searchBar}
        <div className="max-w-4xl mx-auto px-4 pb-2">
          <details className="text-sm">
            <summary className="text-violet-600 cursor-pointer select-none font-medium">Pick another profile from database</summary>
            <div className="mt-2">
              <DatabaseProfilePicker
                onSelect={selectFromDatabase}
                disabled={savedProfileLoading}
                mongoInfo={liveConfig && !liveConfig.fetch_error
                  ? { uriSet: liveConfig.mongo_uri_set, connected: liveConfig.mongo_connected }
                  : null}
              />
            </div>
          </details>
        </div>
      </div>
      {liveError && (
        <div className="max-w-6xl mx-auto px-4 pt-4">
          <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50/95 px-3 py-2.5 text-sm text-red-900 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-words">
              <strong>Refresh live failed.</strong> {liveError}
              {(liveError.includes('Failed to fetch') || liveError.includes('NetworkError')) && (
                <span className="block mt-1 text-xs text-red-800/90">
                  Check that the backend is running (e.g. <code className="rounded bg-white/60 px-1">npm start</code> in <code className="rounded bg-white/60 px-1">backend/</code>) and the Vite dev server proxies to port 3001.
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => setLiveError(null)}
              className="shrink-0 self-end rounded-md border border-red-200/80 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100/50 sm:self-auto"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {/* Profile Header */}
      <div className="max-w-6xl mx-auto px-4 pt-6">
        <ProfileHeader profile={profile} proxyImg={proxyImg} />
      </div>

      {/* Platform Tabs */}
      <div className="max-w-6xl mx-auto px-4 mt-6">
        <div className="bg-white rounded-t-xl shadow-sm border border-gray-100 border-b-0">
          <PlatformTabs
            activeTab={activeTab}
            onTabChange={setActiveTab}
            profile={profile}
          />
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 pb-12">
        <div className="bg-white rounded-b-xl shadow-sm border border-gray-100 border-t-0 p-6 space-y-10">
          {profile.data_source === 'instagram_live' && (
            <div className="text-sm text-pink-800 bg-pink-50 border border-pink-100 rounded-lg px-3 py-2 space-y-1">
              <p>
                <strong>Live snapshot</strong> (up to 12 posts in this view). Not saved to Mongo — use <strong>Load saved</strong> to see the last
                database scrape.
              </p>
              {Array.isArray(profile.methods) && profile.methods.length > 0 && (
                <p className="text-xs text-pink-900/80">
                  Fetched with: {profile.methods.join(' · ')}
                  {profile.methods.includes('instaloader') && (
                    <span className="ml-1 inline-block rounded bg-white/80 border border-pink-200 px-1.5 py-0.5">Instaloader</span>
                  )}
                  {profile.live_source && (
                    <span className="ml-1">(request: {profile.live_source})</span>
                  )}
                </p>
              )}
            </div>
          )}
          {/* Stats */}
          <StatsGrid
            profile={profile}
            metrics={profile.engagement_metrics}
          />

          {/* Posts */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">
                Posts
                <span className="text-sm font-normal text-gray-400 ml-2">({totalPosts} total)</span>
              </h3>
              <div className="flex items-center gap-3">
                <select
                  value={sortBy}
                  onChange={(e) => { setSortBy(e.target.value); setPage(0); }}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 bg-white"
                >
                  <option value="date">Most recent</option>
                  <option value="likes">Most liked</option>
                  <option value="comments">Most commented</option>
                </select>
              </div>
            </div>

            <PostsGrid
              posts={posts}
              username={profile.username}
              profilePic={profile.profile_pic}
              proxyImg={proxyImg}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <button
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-500">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
