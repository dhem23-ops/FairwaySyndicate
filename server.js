const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── CACHE ──────────────────────────────────────────────────────────────
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const STALE_TTL = 60 * 60 * 1000; // 1 hour stale fallback
let cache = { data: null, fetchedAt: 0 };
// ───────────────────────────────────────────────────────────────────────

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

function parseScore(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const s = String(val).trim();
  if (s === 'E') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Convert raw strokes to score-to-par given the course par
function strokesToPar(strokes, par) {
  if (strokes === null || strokes === undefined) return null;
  const n = parseInt(strokes, 10);
  if (isNaN(n) || n <= 0) return null;
  return n - par;
}

function mapStatus(competitor) {
  const status = (competitor.status || '').toLowerCase();
  const pos = (competitor.position?.displayName || String(competitor.position || '')).toUpperCase();
  if (status === 'cut' || pos === 'CUT') return 'CUT';
  if (status === 'wd'  || pos === 'WD')  return 'WD';
  if (status === 'mdf' || pos === 'MDF') return 'MDF';
  if (status === 'dq'  || pos === 'DQ')  return 'DQ';
  return 'active';
}

app.get('/api/scores', async (req, res) => {
  const now = Date.now();
  const cacheAge = now - cache.fetchedAt;

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
      if (cache.data && cacheAge < STALE_TTL) return res.json({ ...cache.data, _stale: true });
      return res.status(resp.status).json({ error: 'Failed to fetch from ESPN.' });
    }

    const data = await resp.json();
    const events = data.events || [];

    if (!events.length) {
      const empty = { event: 'No Active Tournament', round: '—', status: 'Upcoming', full_field: [] };
      cache = { data: empty, fetchedAt: Date.now() };
      return res.json(empty);
    }

    const event = events[0];
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const compStatus = competition.status || {};
    const roundNum = compStatus.period || '?';
    const statusDetail = compStatus.type?.description || 'In Progress';

    // Get course par from competition if available, default 72
    const coursePar = competition.course?.par || event.course?.par || 72;

    const full_field = competitors.map(c => {
      const linescores = c.linescores || [];
      const statistics = c.statistics || [];

      // ESPN golf linescores[].value = raw stroke count for that round
      // We need to convert to score-to-par using coursePar
      const r1strokes = linescores[0]?.value ?? null;
      const r2strokes = linescores[1]?.value ?? null;
      const r3strokes = linescores[2]?.value ?? null;
      const r4strokes = linescores[3]?.value ?? null;

      const r1 = strokesToPar(r1strokes, coursePar);
      const r2 = strokesToPar(r2strokes, coursePar);
      const r3 = strokesToPar(r3strokes, coursePar);
      const r4 = strokesToPar(r4strokes, coursePar);

      // c.score = total score to par string (e.g. "-9", "E", "+2")
      const totalScore = parseScore(c.score);

      // today = current round score to par
      // ESPN statistics array has a "today" entry whose displayValue is already
      // a score-to-par string like "-7", "E", "+2" — use parseScore, NOT strokesToPar.
      // Fallback: the active linescore's displayValue (also score-to-par), then
      // compute from raw strokes only as a last resort.
      let todayScore = null;
      const todayStat = statistics.find(s =>
        s.name === 'today' || s.abbreviation === 'TOD' || s.label?.toLowerCase() === 'today'
      );
      if (todayStat) {
        // displayValue is already score-to-par ("−7", "E", "+2") — just parse it
        todayScore = parseScore(todayStat.displayValue ?? todayStat.value);
      } else {
        // Try the active linescore's displayValue first (score-to-par string)
        const activeLinescore = [...linescores].reverse().find(ls => ls.value != null && ls.value !== '');
        if (activeLinescore?.displayValue !== undefined && activeLinescore.displayValue !== '') {
          todayScore = parseScore(activeLinescore.displayValue);
        } else if (activeLinescore?.value != null) {
          // Raw strokes fallback — only use strokesToPar here
          todayScore = strokesToPar(activeLinescore.value, coursePar);
        }
      }

      // thru — ESPN nests this inside c.status.thru or directly on c.thru
      // Also check linescores for a "thru" indicator via the period field
      const thruRaw = c.status?.thru ?? c.thru ?? null;
      const thru = thruRaw !== null && thruRaw !== undefined ? String(thruRaw) : null;

      return {
        name: c.athlete?.displayName || c.athlete?.fullName || 'Unknown',
        score: totalScore,
        today: todayScore,
        thru,
        r1,
        r2,
        r3,
        r4,
        status: mapStatus(c)
      };
    });

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
    console.log(`Fetched fresh ESPN data: ${full_field.length} players, par ${coursePar}, event: ${responseData.event}`);

    res.json(responseData);

  } catch (err) {
    console.error('Proxy error:', err);
    if (cache.data && (Date.now() - cache.fetchedAt) < STALE_TTL) {
      return res.json({ ...cache.data, _stale: true });
    }
    res.status(500).json({ error: 'Internal proxy error.' });
  }
});

// Raw ESPN dump — use this to inspect exact field names if scores look wrong
app.get('/debug/espn', async (req, res) => {
  try {
    const resp = await fetch(`${ESPN_SCOREBOARD}?lang=en&region=us`);
    const data = await resp.json();
    // Return first competitor in full to inspect field shape
    const dbgComp = data.events?.[0]?.competitions?.[0] || {};
    const firstComp = dbgComp.competitors?.[0] || {};
    const topLevelKeys = Object.keys(firstComp);
    res.json({
      coursePar: dbgComp.course?.par || data.events?.[0]?.course?.par,
      totalCompetitors: dbgComp.competitors?.length,
      topLevelKeys,
      rawCompetitor: firstComp
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/debug/cache', (req, res) => {
  res.json({
    hasCachedData: !!cache.data,
    cacheAgeSeconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
    playerCount: cache.data?.full_field?.length || 0,
    event: cache.data?.event || null,
    samplePlayers: cache.data?.full_field?.slice(0, 3) || []
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Fairway Syndicate proxy running on port ${PORT}`));
