import { google } from 'googleapis';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const REDIRECT_URI = 'https://unmindfy-tts.vercel.app/api/drive/callback';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function saveTokens(tokens) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/integration_credentials`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      provider: 'google_drive',
      access_token: tokens.access_token || null,
      refresh_token: tokens.refresh_token || null,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope || null,
      updated_at: new Date().toISOString()
    })
  });
  const data = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${data}`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('GET only');

  try {
    const { code, state, error } = req.query || {};
    if (error) return res.status(400).send(`Google Drive authorization failed: ${error}`);

    const expectedState = getCookie(req, 'unmindy_drive_state');
    if (!state || !expectedState || state !== expectedState) {
      return res.status(400).send('Invalid OAuth state. Start the Google Drive connection again.');
    }
    if (!code) return res.status(400).send('Missing OAuth authorization code.');

    const oauth2 = new google.auth.OAuth2(
      env('GOOGLE_CLIENT_ID'),
      env('GOOGLE_CLIENT_SECRET'),
      REDIRECT_URI
    );

    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).send('Google did not return a refresh token. Start the connection again and approve access.');
    }

    await saveTokens(tokens);

    res.setHeader('Set-Cookie', 'unmindy_drive_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html><html><body style="font-family:system-ui;padding:40px"><h1>Google Drive connected ✅</h1><p>UNMINDY can now use your connected Drive account.</p><p>You can close this page.</p></body></html>`);
  } catch (error) {
    console.error('UNMINDY Google Drive OAuth error:', error);
    return res.status(500).send(`Google Drive connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
