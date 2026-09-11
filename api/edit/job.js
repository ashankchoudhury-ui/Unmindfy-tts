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
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    if (req.headers.authorization !== `Bearer ${env('CRON_SECRET')}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const staleBefore = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();
    const candidates = await supabase(
      `content_pipeline?tts_status=eq.Ready&tts_audio_url=not.is.null&or=(edit_status.eq.Not%20Edited,edit_status.eq.Failed,edit_status.eq.Editing%26edit_started_at.lt.${encodeURIComponent(staleBefore)})&select=id,script,tts_audio_url,created_at,updated_at,edit_status,edit_attempts,edit_started_at&order=created_at.asc&limit=1`
    );

    if (!candidates?.length) return res.status(200).json({ ok: true, job: null });

    const candidate = candidates[0];
    const attempts = Number(candidate.edit_attempts || 0);
    const nextAttempts = attempts + 1;
    if (candidate.edit_status === 'Failed' && attempts >= MAX_EDIT_ATTEMPTS) {
      return res.status(200).json({ ok: true, job: null });
    }

    const now = new Date().toISOString();
    let predicate;
    if (candidate.edit_status === 'Not Edited') {
      predicate = `edit_status=eq.Not%20Edited&edit_attempts=eq.${attempts}`;
    } else if (candidate.edit_status === 'Failed') {
      predicate = `edit_status=eq.Failed&edit_attempts=eq.${attempts}`;
    } else {
      predicate = `edit_status=eq.Editing&edit_started_at=lt.${encodeURIComponent(staleBefore)}`;
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

    // The conditional PATCH is the claim. If another runner won the race,
    // Supabase returns no row and this runner must do nothing.
    if (!claimed?.length) return res.status(200).json({ ok: true, job: null });

    return res.status(200).json({ ok: true, job: claimed[0] });
  } catch (error) {
    console.error('UNMINDY edit job error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Edit queue request failed' });
  }
}
