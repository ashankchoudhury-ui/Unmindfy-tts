const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';

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

    const rows = await supabase(
      'content_pipeline?tts_status=eq.Ready&or=(edit_status.eq.Not%20Edited,edit_status.eq.Failed)&tts_audio_url=not.is.null&select=id,script,tts_audio_url,created_at&order=created_at.asc&limit=1'
    );

    if (!rows?.length) return res.status(200).json({ ok: true, job: null });

    const job = rows[0];
    await supabase(`content_pipeline?id=eq.${encodeURIComponent(job.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ edit_status: 'Editing', edit_error: null })
    });

    return res.status(200).json({ ok: true, job });
  } catch (error) {
    console.error('UNMINDY edit job error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Edit queue request failed' });
  }
}
