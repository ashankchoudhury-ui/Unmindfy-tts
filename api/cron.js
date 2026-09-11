const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const TTS_MAX_ATTEMPTS = 3;
const TTS_STALE_MINUTES = 20;
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
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`Supabase returned invalid JSON: ${text}`); }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return data;
}

function eligible(record, staleBeforeMs) {
  const attempts = Number(record.tts_attempts || 0);
  if (!record.script || typeof record.script !== 'string' || !record.script.trim()) return false;
  if (record.tts_status === 'Not Generated') return true;
  if (record.tts_status === 'Error') return attempts < TTS_MAX_ATTEMPTS;
  if (record.tts_status === 'Generating') {
    const started = Date.parse(record.tts_started_at || record.updated_at || '');
    return Number.isFinite(started) && started < staleBeforeMs && attempts < TTS_MAX_ATTEMPTS;
  }
  return false;
}

async function claim(record, staleBeforeMs) {
  const attempts = Number(record.tts_attempts || 0);
  const nextAttempts = attempts + 1;
  const now = new Date().toISOString();
  let predicate = `tts_status=eq.${encodeURIComponent(record.tts_status)}`;
  if (record.tts_status === 'Not Generated' || record.tts_status === 'Error') {
    predicate += `&tts_attempts=eq.${attempts}`;
  } else {
    predicate += `&tts_started_at=lt.${encodeURIComponent(new Date(staleBeforeMs).toISOString())}`;
  }
  const rows = await supabaseRequest(
    `content_pipeline?id=eq.${encodeURIComponent(record.id)}&${predicate}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ tts_status: 'Generating', tts_attempts: nextAttempts, tts_started_at: now, updated_at: now })
    }
  );
  return rows?.[0] || null;
}

export default async function handler(req, res) {
  const cronSecret = env('CRON_SECRET');
  if (req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    const staleBeforeMs = Date.now() - TTS_STALE_MINUTES * 60 * 1000;
    const data = await supabaseRequest(
      'content_pipeline?select=id,script,tts_status,tts_audio_url,tts_attempts,tts_started_at,updated_at,created_at&order=created_at.asc&limit=25'
    );

    const candidates = (data || []).filter(record => eligible(record, staleBeforeMs)).slice(0, 3);
    const results = [];

    for (const candidate of candidates) {
      const claimed = await claim(candidate, staleBeforeMs);
      if (!claimed) {
        results.push({ recordId: candidate.id, status: 'skipped', reason: 'lost claim race' });
        continue;
      }

      try {
        const tts = await fetch(TTS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cronSecret}` },
          body: JSON.stringify({ recordId: candidate.id })
        });
        const body = await tts.json().catch(() => ({}));
        results.push({ recordId: candidate.id, status: tts.status, body });
      } catch (error) {
        results.push({ recordId: candidate.id, status: 'request_failed', error: error instanceof Error ? error.message : String(error) });
      }
    }

    return res.status(200).json({ ok: true, source: 'supabase', found: candidates.length, results });
  } catch (error) {
    console.error('UNMINDY TTS queue error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Queue failed' });
  }
}
