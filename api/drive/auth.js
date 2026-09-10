import crypto from 'node:crypto';

const REDIRECT_URI = 'https://unmindfy-tts.vercel.app/api/drive/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file'
];

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const state = base64url(crypto.randomBytes(32));
  const params = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES.join(' '),
    state
  });

  res.setHeader('Set-Cookie', `unmindy_drive_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
