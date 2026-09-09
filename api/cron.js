const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const TTS_ENDPOINT = 'https://unmindfy-tts.vercel.app/api/tts';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function supabaseRequest(path, options = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  const cronSecret = env('CRON_SECRET');
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    const data = await supabaseRequest(
      'content_pipeline?select=id,script,tts_status,tts_audio_url,created_at&order=created_at.asc&limit=10'
    );

    const candidates = (data || []).filter((record) => {
      const script = record.script;
      return typeof script === 'string' && script.trim() && (!record.tts_status || record.tts_status === 'Not Generated');
    }).slice(0, 3);

    const results = await Promise.allSettled(candidates.map(async (record) => {
      const tts = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cronSecret}`
        },
        body: JSON.stringify({ recordId: record.id })
      });
      const body = await tts.json().catch(() => ({}));
      return { recordId: record.id, status: tts.status, body };
    }));

    return res.status(200).json({
      ok: true,
      source: 'supabase',
      found: candidates.length,
      results: results.map((r) => r.status === 'fulfilled' ? r.value : { error: String(r.reason) })
    });
  } catch (error) {
    console.error('UNMINDY TTS queue error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Queue failed' });
  }
}
