import { google } from 'googleapis';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const REDIRECT_URI = 'https://unmindfy-tts.vercel.app/api/drive/callback';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function getSavedTokens() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/integration_credentials?provider=eq.google_drive&select=access_token,refresh_token,token_expiry&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  if (!data[0]?.refresh_token) throw new Error('Google Drive is not connected.');
  return data[0];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const cronSecret = env('CRON_SECRET');
    if (req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const saved = await getSavedTokens();
    const oauth2 = new google.auth.OAuth2(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), REDIRECT_URI);
    oauth2.setCredentials({
      access_token: saved.access_token || undefined,
      refresh_token: saved.refresh_token,
      expiry_date: saved.token_expiry ? new Date(saved.token_expiry).getTime() : undefined
    });

    const accessToken = (await oauth2.getAccessToken()).token;
    if (!accessToken) throw new Error('Google did not return an access token.');

    return res.status(200).json({ ok: true, access_token: accessToken, expires_in_seconds: 3600 });
  } catch (error) {
    console.error('UNMINDY Drive token error:', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Drive token request failed' });
  }
}
