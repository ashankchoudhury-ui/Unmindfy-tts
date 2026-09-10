import { google } from 'googleapis';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function supabaseRequest(path) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getDriveClient() {
  const rows = await supabaseRequest('integration_credentials?provider=eq.google_drive&select=access_token,refresh_token,token_expiry,scope&limit=1');
  const saved = rows[0];
  if (!saved?.refresh_token) throw new Error('Google Drive is not connected. Open /api/drive/auth first.');

  const oauth2 = new google.auth.OAuth2(
    env('GOOGLE_CLIENT_ID'),
    env('GOOGLE_CLIENT_SECRET'),
    'https://unmindfy-tts.vercel.app/api/drive/callback'
  );
  oauth2.setCredentials({
    access_token: saved.access_token || undefined,
    refresh_token: saved.refresh_token,
    expiry_date: saved.token_expiry ? new Date(saved.token_expiry).getTime() : undefined
  });
  return google.drive({ version: 'v3', auth: oauth2 });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const cronSecret = env('CRON_SECRET');
    if (req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const drive = await getDriveClient();
    const response = await drive.files.list({
      pageSize: 100,
      q: 'trashed = false',
      fields: 'files(id,name,mimeType,size,modifiedTime,parents,webViewLink)',
      orderBy: 'folder,name'
    });

    return res.status(200).json({ ok: true, connected: true, files: response.data.files || [] });
  } catch (error) {
    console.error('UNMINDY Google Drive files error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Drive request failed' });
  }
}
