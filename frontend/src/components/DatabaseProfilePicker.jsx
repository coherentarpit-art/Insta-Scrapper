import { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api';

/**
 * @param {{ uriSet?: boolean, connected?: boolean } | null} [mongoInfo]  From GET /api/config/live — clarifies why the list is empty
 */
function DatabaseProfilePicker({ onSelect, disabled, mongoInfo = null }) {
  const [q, setQ] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mongoOk, setMongoOk] = useState(null);

  const load = useCallback(async (search) => {
    setLoading(true);
    try {
      const u = new URLSearchParams();
      u.set('limit', '150');
      if (search && search.trim()) u.set('q', search.trim());
      const res = await fetch(`${API_BASE}/profiles/db?${u}`, { cache: 'no-store' });
      const j = await res.json();
      setProfiles(Array.isArray(j.profiles) ? j.profiles : []);
      setMongoOk(j.mongo_connected === true);
    } catch {
      setProfiles([]);
      setMongoOk(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce all fetches: empty `q` = full list; any non-empty string filters in Mongo.
  useEffect(() => {
    const t = setTimeout(() => {
      load(q);
    }, 300);
    return () => clearTimeout(t);
  }, [q, load]);

  if (mongoOk === false) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-amber-900">
        <p>
          <span className="font-medium">Database list unavailable.</span>{' '}
          {mongoInfo?.uriSet && mongoInfo?.connected === false
            ? (
              <>
                The server has <code className="text-xs bg-amber-100/80 px-1 rounded">MONGO_URI</code> but
                <strong> failed to connect</strong> to MongoDB. Check the <strong>backend terminal</strong> for the error, Atlas
                network access, and that your password in the URI is <strong>URL-encoded</strong>.
              </>
            )
            : !mongoInfo?.uriSet
              ? (
                <>
                  Set <code className="text-xs bg-amber-100/80 px-1 rounded">MONGO_URI</code> in{' '}
                  <code className="text-xs bg-amber-100/80 px-1 rounded">backend/.env</code> and restart the API. If the
                  variable exists only in <code className="text-xs bg-amber-100/80 px-1">scraper/.env</code>, add the same
                  line to <code className="text-xs bg-amber-100/80 px-1">backend/.env</code> (env merge does not override existing keys).
                  You can still type a username and use <strong>Load saved</strong> or <strong>Refresh live</strong>.
                </>
              )
              : (
                <>
                  Could not load the database list. Try the username field above, or check the network connection to the API.
                </>
              )}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-3 py-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800">Profiles in database</h3>
        {loading && <span className="text-xs text-violet-600">Loading…</span>}
      </div>
      <div className="p-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
          placeholder="Filter by username (type to search, clear to show all)"
          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
        />
      </div>
      <ul className="max-h-64 overflow-y-auto px-1 pb-2 text-sm">
        {profiles.length === 0 && !loading && (
          <li className="px-2 py-3 text-center text-gray-400 text-xs">No profiles found</li>
        )}
        {profiles.map((p) => (
          <li key={p.username} className="border-b border-gray-50 last:border-0">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(p.username)}
              className="w-full flex items-center gap-2 text-left px-2 py-2 rounded-lg hover:bg-violet-50 disabled:opacity-50"
            >
              {p.profile_pic && (
                <img
                  src={p.profile_pic}
                  alt=""
                  className="w-8 h-8 rounded-full object-cover border border-gray-100"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-gray-900 truncate">@{p.username}</span>
                {p.full_name && <span className="block text-xs text-gray-500 truncate">{p.full_name}</span>}
                <span className="text-xs text-gray-400">
                  {(p.followers || 0).toLocaleString()} followers
                  {p.our_category ? ` · ${p.our_category}` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default DatabaseProfilePicker;
