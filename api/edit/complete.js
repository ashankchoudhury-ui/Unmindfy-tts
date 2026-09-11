const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    if (req.headers.authorization !== `Bearer ${env('CRON_SECRET')}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { id, status, export_drive_file_id, export_drive_url, error, edit_error } = req.body || {};
    if (!id || !['Ready', 'Failed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'id and status (Ready|Failed) are required' });
    }

    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');

    const fields = {
      edit_status: status,
      edit_error: status === 'Failed' ? String(edit_error || error || 'Unknown rendering error').slice(0, 4000) : null,
      edit_started_at: null,
      export_drive_file_id: status === 'Ready' ? (export_drive_file_id || null) : null,
      export_drive_url: status === 'Ready' ? (export_drive_url || null) : null,
      rendered_at: status === 'Ready' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/content_pipeline?id=eq.${encodeURIComponent(id)}&edit_status=eq.Editing`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(fields)
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('UNMINDY edit completion error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Edit completion failed' });
  }
}
