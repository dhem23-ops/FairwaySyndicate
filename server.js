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

// ── MANUAL STATUS OVERRIDES ────────────────────────────────────────────
// Add players here when ESPN fails to reflect their correct status.
// Valid statuses: 'WD', 'CUT', 'MDF', 'DQ'
const STATUS_OVERRIDES = [
  { name: 'Collin Morikawa', status: 'WD' },
];
// ───────────────────────────────────────────────────────────────────────

function parseScore(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const s = String(val).trim();
  if (s === 'E') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

function strokesToPar(strokes, par) {
  if (strokes === null || strokes === undefined) return null;
  const n = parseInt(strokes, 10);
  if (isNaN(n) || n <= 0) return null;
  return n - par;
}

function mapStatus(competitor) {
  const score = String(competitor.score || '').toUpperCase().trim();
  if (score === 'CUT' || score === 'MC') return 'CUT';
  if (score === 'WD')  return 'WD';
  if (score === 'MDF') return 'MDF';
  if (score === 'DQ')  return 'DQ';
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

    const coursePar = competition.course?.par || event.course?.par || 72;

    const full_field = competitors.map(c => {
      const linescores = c.linescores || [];
      const statistics = c.statistics || [];

      // Parse a round linescore — displayValue is sometimes score-to-par ("-3", "E")
      // and sometimes raw strokes ("69"). If abs value <= 30 it's score-to-par.
      function parseRound(ls) {
        if (!ls || ls.value == null) return null;
        const disp = ls.displayValue;
        if (disp != null && disp !== '') {
          const parsed = parseScore(disp);
          if (parsed !== null && Math.abs(parsed) <= 30) return parsed;
        }
        return strokesToPar(ls.value, coursePar);
      }
      const r1 = parseRound(linescores[0]);
      const r2 = parseRound(linescores[1]);
      const r3 = parseRound(linescores[2]);
      const r4 = parseRound(linescores[3]);

      const totalScore = parseScore(c.score);

      // today = current round score-to-par
      let todayScore = null;
      const todayStat = statistics.find(s =>
        s.name === 'today' || s.abbreviation === 'TOD' || s.label?.toLowerCase() === 'today'
      );
      if (todayStat) {
        todayScore = parseScore(todayStat.displayValue ?? todayStat.value);
      } else {
        const activeLinescore = [...linescores].reverse().find(ls => ls.value != null && ls.value !== '');
        if (activeLinescore?.displayValue !== undefined && activeLinescore.displayValue !== '') {
          todayScore = parseScore(activeLinescore.displayValue);
        } else if (activeLinescore?.value != null) {
          todayScore = strokesToPar(activeLinescore.value, coursePar);
        }
      }

      // thru — count holes played from the active round's nested hole linescores
      let thru = null;
      const activeLS = [...linescores].reverse().find(ls => ls.value != null && ls.value !== '');
      if (activeLS) {
        const holeLinescores = activeLS.linescores || [];
        if (holeLinescores.length > 0) {
          const maxHole = Math.max(...holeLinescores.map(h => h.period || 0));
          thru = maxHole === 18 ? 'F' : String(maxHole);
        }
      }

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

    // Apply manual status overrides
    for (const player of full_field) {
      const override = STATUS_OVERRIDES.find(o =>
        player.name.toLowerCase().includes(o.name.toLowerCase())
      );
      if (override) player.status = override.status;
    }

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

// Debug — inspect a specific player's raw ESPN data
// Usage: /debug/espn or /debug/espn?player=Morikawa
app.get('/debug/espn', async (req, res) => {
  try {
    const resp = await fetch(`${ESPN_SCOREBOARD}?lang=en&region=us`);
    const data = await resp.json();
    const dbgComp = data.events?.[0]?.competitions?.[0] || {};

    const playerName = req.query.player || 'Morikawa';
    const comp = dbgComp.competitors?.find(c =>
      c.athlete?.displayName?.includes(playerName)
    ) || dbgComp.competitors?.[0] || {};

    res.json({
      searching_for: playerName,
      found: comp.athlete?.displayName || null,
      score_field: comp.score,
      top_level_keys: Object.keys(comp),
      linescores: comp.linescores,
      statistics: comp.statistics,
      raw: comp
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
