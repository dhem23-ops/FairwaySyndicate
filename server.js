const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── CACHE ──────────────────────────────────────────────────────────────
// ESPN is free and has no keys, but we still cache to be respectful
// and to keep the app snappy. Stale cache is served on any fetch error.
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes fresh window
const STALE_TTL = 60 * 60 * 1000; // serve stale data for up to 1 hour on error
let cache = { data: null, fetchedAt: 0 };
// ───────────────────────────────────────────────────────────────────────

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

// ESPN returns scores as strings like "-10", "E", "+2"
function parseScore(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const s = String(val).trim();
  if (s === 'E') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// ESPN status: "cut", "wd", "active", "complete" etc.
function mapStatus(competitor) {
  const status = (competitor.status || '').toLowerCase();
  const pos = (competitor.position?.displayName || competitor.position || '').toUpperCase();
  if (status === 'cut' || pos === 'CUT') return 'CUT';
  if (status === 'wd'  || pos === 'WD')  return 'WD';
  if (status === 'mdf' || pos === 'MDF') return 'MDF';
  if (status === 'dq'  || pos === 'DQ')  return 'DQ';
  return 'active';
}

app.get('/api/scores', async (req, res) => {
  const now = Date.now();
  const cacheAge = now - cache.fetchedAt;

  // Serve fresh cache
  if (cache.data && cacheAge < CACHE_TTL) {
    console.log(`Serving cached response (${Math.round(cacheAge / 1000)}s old)`);
    return res.json(cache.data);
  }

  try {
    const resp = await fetch(`${ESPN_SCOREBOARD}?lang=en&region=us`, {
      headers: { 'Accept': 'application/json' }
    });

    if (!resp.ok) {
      console.warn(`ESPN fetch failed: ${resp.status}`);
      if (cache.data && cacheAge < STALE_TTL) {
        console.log('Serving stale cache due to ESPN error');
        return res.json({ ...cache.data, _stale: true });
      }
      return res.status(resp.status).json({ error: 'Failed to fetch from ESPN.' });
    }

    const data = await resp.json();

    // ESPN returns events[] — for golf there's typically one active event
    const events = data.events || [];
    if (!events.length) {
      // No active tournament — return empty but valid response
      const empty = { event: 'No Active Tournament', round: '—', status: 'Upcoming', full_field: [] };
      cache = { data: empty, fetchedAt: Date.now() };
      return res.json(empty);
    }

    // Pick the first (active) event
    const event = events[0];
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];

    // Round and status info lives in competition.status
    const compStatus = competition.status || {};
    const roundNum = compStatus.period || compStatus.displayClock || '?';
    const statusDetail = compStatus.type?.description || 'In Progress';

    const full_field = competitors.map(c => {
      const stats = c.statistics || [];

      // ESPN golf competitor shape:
      // c.athlete.displayName, c.score (total to par), c.linescores (per-round)
      // c.status, c.position, c.thru (holes completed today)

      const linescores = c.linescores || [];

      // linescores[i].value is the round score to par for that round
      const r1 = linescores[0] ? parseScore(linescores[0].value) : null;
      const r2 = linescores[1] ? parseScore(linescores[1].value) : null;
      const r3 = linescores[2] ? parseScore(linescores[2].value) : null;
      const r4 = linescores[3] ? parseScore(linescores[3].value) : null;

      // today = current round score to par
      const todayRaw = c.today ?? c.currentRoundScore ?? null;

      // thru = holes completed today; ESPN may return "F" for finished
      const thruRaw = c.thru ?? null;

      return {
        name: c.athlete?.displayName || c.athlete?.fullName || 'Unknown',
        score: parseScore(c.score),
        today: parseScore(todayRaw),
        thru: thruRaw !== null ? String(thruRaw) : null,
        r1,
        r2,
        r3,
        r4,
        status: mapStatus(c)
      };
    });

    // Sort by score ascending (cuts last)
    full_field.sort((a, b) => {
      if (a.status === 'CUT' && b.status !== 'CUT') return 1;
      if (b.status === 'CUT' && a.status !== 'CUT') return -1;
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return a.score - b.score;
    });

    const responseData = {
      event: event.name || event.shortName || 'PGA Tour Event',
      round: `R${roundNum}`,
      status: statusDetail,
      full_field
    };

    cache = { data: responseData, fetchedAt: Date.now() };
    console.log(`Fetched fresh data from ESPN: ${full_field.length} players, event: ${responseData.event}`);

    res.json(responseData);

  } catch (err) {
    console.error('Proxy error:', err);
    if (cache.data && (Date.now() - cache.fetchedAt) < STALE_TTL) {
      console.log('Serving stale cache due to unexpected error');
      return res.json({ ...cache.data, _stale: true });
    }
    res.status(500).json({ error: 'Internal proxy error.' });
  }
});

// Debug — see the raw ESPN response
app.get('/debug/espn', async (req, res) => {
  try {
    const resp = await fetch(`${ESPN_SCOREBOARD}?lang=en&region=us`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Cache status
app.get('/debug/cache', (req, res) => {
  res.json({
    hasCachedData: !!cache.data,
    cacheAgeSeconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
    playerCount: cache.data?.full_field?.length || 0,
    event: cache.data?.event || null
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Fairway Syndicate proxy running on port ${PORT}`));
