import { put } from '@vercel/blob';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.1-flash-tts-preview';
const TABLE = 'Content Pipeline';
const MAX_SCRIPT_CHARS = 12000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function json(res, status, body) { return res.status(status).json(body); }

async function airtableRequest(path, options = {}) {
  const response = await fetch(`${AIRTABLE_API}/${env('AIRTABLE_BASE_ID')}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${env('AIRTABLE_TOKEN')}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Airtable ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function updateRecord(recordId, fields) {
  return airtableRequest(`${encodeURIComponent(TABLE)}/${recordId}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
}

function base64ToBytes(base64) { return Uint8Array.from(Buffer.from(base64, 'base64')); }

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataLength = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataLength, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32); buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataLength, 40); Buffer.from(pcm).copy(buffer, 44);
  return buffer;
}

function getVoicePrompt(script) {
  return `Audio profile: a young, thoughtful male speaker.\nScene: casually explaining an interesting psychological idea to a friend.\nDirector's notes: natural conversational delivery; smooth and continuous around normal conversational speed; slight curiosity at the beginning, then a calm realization; understated and human; no announcer voice, no motivational-speaker energy, no exaggerated emotion, no forced pauses. Preserve the wording exactly.\n\nScript:\n${script}`;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { ok: true, service: 'unmindy-tts', model: MODEL });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const cronSecret = env('CRON_SECRET');
  if (req.headers.authorization !== `Bearer ${cronSecret}`) return json(res, 401, { ok: false, error: 'Unauthorized' });

  let recordId;
  try {
    recordId = req.body?.recordId;
    if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) return json(res, 400, { error: 'A valid Airtable recordId is required' });

    const record = await airtableRequest(`${encodeURIComponent(TABLE)}/${recordId}`);
    const script = record.fields?.Script;
    if (!script || typeof script !== 'string') throw new Error('Airtable Script field is empty');
    const cleanScript = script.trim();
    if (cleanScript.length > MAX_SCRIPT_CHARS) throw new Error(`Script is too long; maximum is ${MAX_SCRIPT_CHARS} characters`);

    await updateRecord(recordId, { 'TTS Status': 'Generating' });

    const geminiResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: getVoicePrompt(cleanScript), response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Kore' }] } })
    });
    const gemini = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) throw new Error(`Gemini ${geminiResponse.status}: ${JSON.stringify(gemini)}`);
    const audioBase64 = gemini?.output_audio?.data;
    if (!audioBase64) throw new Error('Gemini returned no audio data');

    const wav = pcmToWav(base64ToBytes(audioBase64));
    const blob = await put(`tts/${recordId}.wav`, wav, { access: 'public', contentType: 'audio/wav', addRandomSuffix: false, allowOverwrite: true, token: env('BLOB_READ_WRITE_TOKEN') });

    await updateRecord(recordId, { 'TTS Audio': [{ url: blob.url, filename: `unmindy-${recordId}.wav` }], 'TTS Status': 'Ready' });
    return json(res, 200, { ok: true, recordId, audioUrl: blob.url, model: MODEL });
  } catch (error) {
    if (recordId) { try { await updateRecord(recordId, { 'TTS Status': 'Error' }); } catch {} }
    console.error('UNMINDY TTS error:', error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'TTS generation failed' });
  }
}
