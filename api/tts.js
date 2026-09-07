import { put } from '@vercel/blob';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.1-flash-tts-preview';
const TABLE = 'Content Pipeline';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function airtableRequest(path, options = {}) {
  const token = env('AIRTABLE_TOKEN');
  const response = await fetch(`${AIRTABLE_API}/${env('AIRTABLE_BASE_ID')}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Airtable ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function updateRecord(recordId, fields) {
  return airtableRequest(`${encodeURIComponent(TABLE)}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields })
  });
}

function base64ToBytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataLength = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  Buffer.from(pcm).copy(buffer, 44);
  return buffer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let recordId;
  try {
    recordId = req.body?.recordId;
    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    const record = await airtableRequest(`${encodeURIComponent(TABLE)}/${recordId}`);
    const script = record.fields?.Script;
    if (!script || typeof script !== 'string') throw new Error('Airtable Script field is empty');

    await updateRecord(recordId, { 'TTS Status': { name: 'Generating' } });

    const geminiResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env('GEMINI_API_KEY'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        input: `Natural conversational male voice, young and thoughtful. Speak like you are casually telling a friend about an interesting psychological idea. Smooth, continuous delivery around 0.95–1.0x speed. Slight curiosity at the start, then a calm realization. No announcer voice, no motivational-speaker energy, no exaggerated emotion, no forced pauses. Keep the wording exactly as provided.\n\n${script}`,
        response_format: { type: 'audio' },
        generation_config: {
          speech_config: [{ voice: 'Kore' }]
        }
      })
    });

    const gemini = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) throw new Error(`Gemini ${geminiResponse.status}: ${JSON.stringify(gemini)}`);

    const audioBase64 = gemini?.output_audio?.data;
    if (!audioBase64) throw new Error('Gemini returned no audio data');

    const wav = pcmToWav(base64ToBytes(audioBase64));
    const blob = await put(`tts/${recordId}-${Date.now()}.wav`, wav, {
      access: 'public',
      contentType: 'audio/wav',
      addRandomSuffix: false,
      token: env('BLOB_READ_WRITE_TOKEN')
    });

    await updateRecord(recordId, {
      'TTS Audio': [{ url: blob.url, filename: `unmindfy-${recordId}.wav` }],
      'TTS Status': { name: 'Ready' }
    });

    return res.status(200).json({ ok: true, recordId, audioUrl: blob.url });
  } catch (error) {
    if (recordId) {
      try { await updateRecord(recordId, { 'TTS Status': { name: 'Error' } }); } catch {}
    }
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'TTS generation failed' });
  }
}
