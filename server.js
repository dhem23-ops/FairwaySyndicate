const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/api/scores', async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RapidAPI key not configured on server.' });
  }

  // tournId and orgId can be overridden via query params, defaults to current season PGA
  const orgId = req.query.orgId || '1';
  const tournId = req.query.tournId || '';

  try {
    // First fetch the schedule to find the current/active tournament
    const scheduleResp = await fetch(
      `https://live-golf-data.p.rapidapi.com/schedule?orgId=${orgId}&year=2026`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'live-golf-data.p.rapidapi.com',
          'Content-Type': 'application/json'
        }
      }
    );

    if (!scheduleResp.ok) {
      return res.status(scheduleResp.status).json({ error: 'Failed to fetch schedule.' });
    }

    const scheduleData = await scheduleResp.json();

    // Find the active or most recent tournament
    let activeTournament = null;
    const now = new Date();

    if (scheduleData.tournaments) {
      // Try to find in-progress tournament first
      activeTournament = scheduleData.tournaments.find(t => t.status === 'In Progress');
      // Fall back to most recent completed
      if (!activeTournament) {
        const past = scheduleData.tournaments.filter(t => new Date(t.endDate) < now);
        if (past.length) activeTournament = past[past.length - 1];
      }
      // Fall back to next upcoming
      if (!activeTournament) {
        activeTournament = scheduleData.tournaments.find(t => new Date(t.startDate) >= now);
      }
    }

    const resolvedTournId = tournId || activeTournament?.tournId || activeTournament?.id || '';

    if (!resolvedTournId) {
      return res.status(404).json({ error: 'No active tournament found.' });
    }

    // Fetch leaderboard for that tournament
    const leaderboardResp = await fetch(
      `https://live-golf-data.p.rapidapi.com/leaderboard?orgId=${orgId}&tournId=${resolvedTournId}`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'live-golf-data.p.rapidapi.com',
          'Content-Type': 'application/json'
        }
      }
    );

    if (!leaderboardResp.ok) {
      return res.status(leaderboardResp.status).json({ error: 'Failed to fetch leaderboard.' });
    }

    const leaderboardData = await leaderboardResp.json();

    // Transform to the format your index.html expects
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

    res.json({
      event: activeTournament?.name || leaderboardData.tournamentName || 'PGA Tour Event',
      round: `R${leaderboardData.roundId || '?'}`,
      status: leaderboardData.roundStatus === 'Official' ? 'Completed' : 'In Progress',
      full_field
    });

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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/debug/schedule', async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY;
  const scheduleResp = await fetch(
    'https://live-golf-data.p.rapidapi.com/schedule?orgId=1&year=2026',
    { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'live-golf-data.p.rapidapi.com' } }
  );
  const data = await scheduleResp.json();
  res.json(data);
});

app.listen(PORT, () => console.log(`Fairway Syndicate proxy running on port ${PORT}`));
