const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const MAX_EDIT_ATTEMPTS = 3;
const STALE_AFTER_MINUTES = 45;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function supabase(path, options = {}) {
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
  const attempts = Number(record.edit_attempts || 0);
  if (record.edit_status === 'Not Edited') return true;
  if (record.edit_status === 'Failed') return attempts < MAX_EDIT_ATTEMPTS;
  if (record.edit_status === 'Editing') {
    const started = Date.parse(record.edit_started_at || record.updated_at || '');
    return Number.isFinite(started) && started < staleBeforeMs;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    if (req.headers.authorization !== `Bearer ${env('CRON_SECRET')}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const staleBeforeMs = Date.now() - STALE_AFTER_MINUTES * 60 * 1000;
    const candidates = await supabase(
      'content_pipeline?tts_status=eq.Ready&tts_audio_url=not.is.null&select=id,script,tts_audio_url,created_at,updated_at,edit_status,edit_attempts,edit_started_at&order=created_at.asc&limit=25'
    );
    const candidate = (candidates || []).find(record => eligible(record, staleBeforeMs));
    if (!candidate) return res.status(200).json({ ok: true, job: null });

    const attempts = Number(candidate.edit_attempts || 0);
    const nextAttempts = attempts + 1;
    const now = new Date().toISOString();
    let predicate = `edit_status=eq.${encodeURIComponent(candidate.edit_status)}`;
    if (candidate.edit_status === 'Not Edited' || candidate.edit_status === 'Failed') {
      predicate += `&edit_attempts=eq.${attempts}`;
    } else {
      predicate += `&edit_started_at=lt.${encodeURIComponent(new Date(staleBeforeMs).toISOString())}`;
    }

    const claimed = await supabase(
      `content_pipeline?id=eq.${encodeURIComponent(candidate.id)}&tts_status=eq.Ready&${predicate}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          edit_status: 'Editing',
          edit_error: null,
          edit_attempts: nextAttempts,
          edit_started_at: now,
          updated_at: now
        })
      }
    );

    if (!claimed?.length) return res.status(200).json({ ok: true, job: null });
    return res.status(200).json({ ok: true, job: claimed[0] });
  } catch (error) {
    console.error('UNMINDY edit job error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Edit queue request failed' });
  }
}
