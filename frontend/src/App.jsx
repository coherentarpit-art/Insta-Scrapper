import { useState, useEffect } from 'react';
import ProfileHeader from './components/ProfileHeader';
import PlatformTabs from './components/PlatformTabs';
import StatsGrid from './components/StatsGrid';
import PostsGrid from './components/PostsGrid';

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

function App() {
  const [profile, setProfile] = useState(null);
  const [posts, setPosts] = useState([]);
  const [totalPosts, setTotalPosts] = useState(0);
  const [activeTab, setActiveTab] = useState('instagram');
  const [sortBy, setSortBy] = useState('date');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [username, setUsername] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return normalizeUsername(q.get('u') || q.get('username') || '');
  });
  const [searchDraft, setSearchDraft] = useState(username);
  const [dataSource, setDataSource] = useState('saved');
  const [livePostBuffer, setLivePostBuffer] = useState(null);
  /** Which flow last failed — so we show the right help text (Mongo vs live cookies). */
  const [errorKind, setErrorKind] = useState(null);

  const perPage = 8;

  // Load profile when username changes (?u= also supported via initial state)
  useEffect(() => {
    if (!username) {
      setProfile(null);
      setPosts([]);
      setTotalPosts(0);
      setError(null);
      setLoading(false);
      setDataSource('saved');
      setLivePostBuffer(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setErrorKind(null);
      setProfile(null);
      setLivePostBuffer(null);
      setDataSource('saved');
      try {
        const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(username)}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.message || j.error || 'Profile not found');
        }
        const data = await res.json();
        if (!cancelled) {
          setProfile(data);
          setPage(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setErrorKind('saved');
          setProfile(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
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

  const loadLiveFromInstagram = async () => {
    const u = normalizeUsername(username);
    if (!u) return;
    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      const res = await fetch(`${API_BASE}/profile/${encodeURIComponent(u)}/live`, {
        cache: 'no-store',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || j.error || 'Live fetch failed');
      const { recent_posts: recentPosts, ...rest } = j;
      setProfile(rest);
      setDataSource('live');
      setLivePostBuffer(Array.isArray(recentPosts) ? recentPosts : []);
      setPage(0);
    } catch (e) {
      setError(e.message);
      setErrorKind('live');
    } finally {
      setLoading(false);
    }
  };

  const searchBar = (
    <div className="max-w-2xl mx-auto flex flex-wrap items-center gap-2 px-4 py-3">
      <input
        type="text"
        value={searchDraft}
        onChange={(e) => setSearchDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && applySearch()}
        placeholder="Instagram username (no @)"
        className="flex-1 min-w-[140px] border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400"
      />
      <button
        type="button"
        onClick={applySearch}
        disabled={loading}
        className="shrink-0 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load saved'}
      </button>
      <button
        type="button"
        onClick={loadLiveFromInstagram}
        disabled={loading || !username}
        className="shrink-0 px-4 py-2 rounded-lg border border-pink-300 bg-pink-50 text-pink-800 text-sm font-medium hover:bg-pink-100 disabled:opacity-50"
        title={
          username
            ? 'Fetches current followers and likes from Instagram (not saved to Mongo)'
            : 'Load a profile first (Load saved)'
        }
      >
        Live from Instagram
      </button>
    </div>
  );

  if (!username) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 px-4">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Profile viewer</h1>
        <p className="text-gray-500 text-sm mb-4 text-center max-w-md">
          <strong>Load saved</strong> reads Mongo / files. <strong>Live from Instagram</strong> pulls current followers and likes (uses cookies in backend/.env; not saved to your DB).
        </p>
        {searchBar}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {searchBar}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-2 border-violet-600 border-t-transparent mx-auto mb-4"></div>
            <p className="text-gray-500">Loading @{username}…</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {searchBar}
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">Could not load @{username}</h2>
            <p className="text-gray-500 mb-4 text-sm">{error || 'No data'}</p>
            {errorKind === 'live' ? (
              <p className="text-gray-400 text-xs">
                Live uses the same Instagram HTTP layer as the queue worker (<code className="text-gray-500">scraper/ig-request.js</code>).
                Set <code className="text-gray-500">IG_ACC1_COOKIES</code> and <code className="text-gray-500">IG_ACC1_CSRF</code> in <strong>backend/.env</strong> (match your scraper session), then restart the backend. This path does not read Mongo.
              </p>
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
      <div className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur border-b border-gray-100">
        {searchBar}
      </div>
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
            <p className="text-sm text-pink-800 bg-pink-50 border border-pink-100 rounded-lg px-3 py-2">
              Live snapshot from Instagram (up to 12 posts in this view). Numbers are not written to Mongo — click &quot;Load saved&quot; to view last stored scrape.
            </p>
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
