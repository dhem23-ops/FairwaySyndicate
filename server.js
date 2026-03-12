const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/scores', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { players } = req.body;
  if (!players || !Array.isArray(players)) {
    return res.status(400).json({ error: 'Missing players array in request body.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: `You are a golf scoring assistant. Return ONLY valid JSON (no markdown, no preamble) with this structure:
{"event":"event name","round":"R1/R2/R3/R4/Final","status":"In Progress/Completed/Upcoming","full_field":[{"name":"Player Name","score":-5,"today":-3,"thru":14,"r1":-2,"r2":-3,"r3":null,"r4":null,"status":"active"}]}
Include as many players as you know from the current or most recent PGA Tour event. status is active/CUT/WD/MDF. Scores are integers relative to par.`,
        messages: [{
          role: 'user',
          content: `Return the current PGA Tour leaderboard as JSON. These players are especially important to include: ${players.join(', ')}.`
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    // Extract text content from response
    let raw = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') raw += block.text;
    }

    // Parse the JSON from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ error: 'Could not parse scoring data from response.' });
    }

    const parsed = JSON.parse(match[0]);
    res.json(parsed);

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal proxy error.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Fairway Syndicate proxy running on port ${PORT}`));
