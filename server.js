const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
    const now = new Date();

    let activeTournament = null;

    if (!tournId) {
      // Find tournament where today falls between start and end
      activeTournament = tournaments.find(t => {
        const start = parseMongoDate(t.date?.start);
        const end = parseMongoDate(t.date?.end);
        // 1-day buffer on start to catch early rounds
        const bufferedStart = start ? new Date(start.getTime() - 86400000) : null;
        return bufferedStart && end && now >= bufferedStart && now <= end;
      });

      // If none in progress, find the most recently completed
      if (!activeTournament) {
        const past = tournaments.filter(t => {
          const end = parseMongoDate(t.date?.end);
          return end && end < now;
        });
        if (past.length) activeTournament = past[past.length - 1];
      }

      // If still nothing, find next upcoming
      if (!activeTournament) {
        activeTournament = tournaments.find(t => {
          const start = parseMongoDate(t.date?.start);
          return start && start > now;
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

    res.json({
      event: activeTournament?.name || leaderboardData.tournamentName || 'PGA Tour Event',
      round: `R${leaderboardData.roundId?.$numberInt || leaderboardData.roundId?.$numberLong || leaderboardData.roundId || '?'}`,
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
