const AIRTABLE_API = 'https://api.airtable.com/v0';
const TABLE = 'Content Pipeline';
const TTS_ENDPOINT = 'https://unmindfy-tts.vercel.app/api/tts';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export default async function handler(req, res) {
  const cronSecret = env('CRON_SECRET');
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const response = await fetch(`${AIRTABLE_API}/${env('AIRTABLE_BASE_ID')}/${encodeURIComponent(TABLE)}?maxRecords=10`, {
      headers: { Authorization: `Bearer ${env('AIRTABLE_TOKEN')}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Airtable ${response.status}: ${JSON.stringify(data)}`);

    const candidates = (data.records || []).filter((record) => {
      const script = record.fields?.Script;
      const status = record.fields?.['TTS Status'];
      const statusName = typeof status === 'string' ? status : status?.name;
      return typeof script === 'string' && script.trim() && (!statusName || statusName === 'Not Generated');
    }).slice(0, 3);

    const results = await Promise.allSettled(candidates.map(async (record) => {
      const tts = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: record.id })
      });
      const body = await tts.json().catch(() => ({}));
      return { recordId: record.id, status: tts.status, body };
    }));

    return res.status(200).json({
      ok: true,
      found: candidates.length,
      results: results.map((r) => r.status === 'fulfilled' ? r.value : { error: String(r.reason) })
    });
  } catch (error) {
    console.error('UNMINDY TTS queue error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Queue failed' });
  }
}
