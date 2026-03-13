const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── CACHE ─────────────────────────────────────
// Stores the last successful response and timestamp.
// All requests within CACHE_TTL get the cached copy
// instead of hitting RapidAPI again.
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, fetchedAt: 0 };
// ──────────────────────────────────────────────

// Parse MongoDB-style $date/$numberLong timestamps
function parseMongoDate(dateObj) {
  if (!dateObj) return null;
  if (dateObj.$date && dateObj.$date.$numberLong) {
    return new Date(parseInt(dateObj.$date.$numberLong, 10));
  }
  if (dateObj.$date) return new Date(dateObj.$date);
  return new Date(dateObj);
}

app.get('/api/scores', async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RapidAPI key not configured on server.' });
  }

  // Serve cached response if still fresh
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL) {
    console.log(`Serving cached response (${Math.round((now - cache.fetchedAt) / 1000)}s old)`);
    return res.json(cache.data);
  }

  const orgId = req.query.orgId || '1';
  const tournId = req.query.tournId || '';

  try {
    const scheduleResp = await fetch(
      `https://live-golf-data.p.rapidapi.com/schedule?orgId=${orgId}&year=2026`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'live-golf-data.p.rapidapi.com'
        }
      }
    );

    if (!scheduleResp.ok) {
      return res.status(scheduleResp.status).json({ error: 'Failed to fetch schedule.' });
    }

    const scheduleData = await scheduleResp.json();
    const tournaments = scheduleData.schedule || scheduleData.tournaments || [];
    const nowDate = new Date();

    let activeTournament = null;

    if (!tournId) {
      activeTournament = tournaments.find(t => {
        const start = parseMongoDate(t.date?.start);
        const end = parseMongoDate(t.date?.end);
        const bufferedStart = start ? new Date(start.getTime() - 86400000) : null;
        return bufferedStart && end && nowDate >= bufferedStart && nowDate <= end;
      });

      if (!activeTournament) {
        const past = tournaments.filter(t => {
          const end = parseMongoDate(t.date?.end);
          return end && end < nowDate;
        });
        if (past.length) activeTournament = past[past.length - 1];
      }

      if (!activeTournament) {
        activeTournament = tournaments.find(t => {
          const start = parseMongoDate(t.date?.start);
          return start && start > nowDate;
        });
      }
    } else {
      activeTournament = tournaments.find(t => t.tournId === tournId);
    }

    const resolvedTournId = tournId || activeTournament?.tournId || '';

    if (!resolvedTournId) {
      return res.status(404).json({ error: 'No active tournament found.' });
    }

    const leaderboardResp = await fetch(
      `https://live-golf-data.p.rapidapi.com/leaderboard?orgId=${orgId}&tournId=${resolvedTournId}&year=2026`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'live-golf-data.p.rapidapi.com'
        }
      }
    );

    if (!leaderboardResp.ok) {
      return res.status(leaderboardResp.status).json({ error: 'Failed to fetch leaderboard.' });
    }

    const leaderboardData = await leaderboardResp.json();

    const full_field = (leaderboardData.leaderboardRows || []).map(p => {
      const rounds = p.rounds || [];
      return {
        name: `${p.firstName} ${p.lastName}`,
        score: parseScoreToPar(p.total),
        today: parseScoreToPar(p.currentRoundScore),
        thru: p.thru || '-',
        r1: rounds[0] ? parseScoreToPar(rounds[0].scoreToPar) : null,
        r2: rounds[1] ? parseScoreToPar(rounds[1].scoreToPar) : null,
        r3: rounds[2] ? parseScoreToPar(rounds[2].scoreToPar) : null,
        r4: rounds[3] ? parseScoreToPar(rounds[3].scoreToPar) : null,
        status: mapStatus(p.status, p.position)
      };
    });

    const responseData = {
      event: activeTournament?.name || leaderboardData.tournamentName || 'PGA Tour Event',
      round: `R${leaderboardData.roundId?.$numberInt || leaderboardData.roundId?.$numberLong || leaderboardData.roundId || '?'}`,
      status: leaderboardData.roundStatus === 'Official' ? 'Completed' : 'In Progress',
      full_field
    };

    // Store in cache
    cache = { data: responseData, fetchedAt: Date.now() };
    console.log('Fetched fresh data from RapidAPI and cached it.');

    res.json(responseData);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal proxy error.' });
  }
});

function parseScoreToPar(val) {
  if (val === null || val === undefined || val === '-') return null;
  if (val === 'E' || val === 'E ') return 0;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function mapStatus(status, position) {
  if (!status) return 'active';
  const s = status.toLowerCase();
  if (s === 'cut' || position === 'CUT') return 'CUT';
  if (s === 'wd' || position === 'WD') return 'WD';
  if (s === 'mdf' || position === 'MDF') return 'MDF';
  if (s === 'dq' || position === 'DQ') return 'DQ';
  return 'active';
}

// Debug endpoint — remove after confirming live data works
app.get('/debug/schedule', async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY;
  const scheduleResp = await fetch(
    'https://live-golf-data.p.rapidapi.com/schedule?orgId=1&year=2026',
    { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'live-golf-data.p.rapidapi.com' } }
  );
  const data = await scheduleResp.json();
  res.json(data);
});

app.get('/debug/leaderboard', async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY;
  const tournId = req.query.tournId || '011';
  const orgId = req.query.orgId || '1';
  const resp = await fetch(
    `https://live-golf-data.p.rapidapi.com/leaderboard?orgId=${orgId}&tournId=${tournId}&year=2026`,
    { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'live-golf-data.p.rapidapi.com' } }
  );
  const status = resp.status;
  const data = await resp.json();
  res.json({ status, data });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Fairway Syndicate proxy running on port ${PORT}`));
