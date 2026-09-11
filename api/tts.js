// UNMINDY TTS production worker — Deadpan voice direction.
const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = 'gemini-3.1-flash-tts-preview';
const MAX_SCRIPT_CHARS = 12000;
const TTS_BUCKET = 'tts-audio';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function supabaseKey() {
  const value = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  return value;
}

function json(res, status, body) { return res.status(status).json(body); }

async function supabaseRequest(path, options = {}) {
  const key = supabaseKey();
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

async function uploadAudio(path, wav) {
  const key = supabaseKey();
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${TTS_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'audio/wav',
      'x-upsert': 'true'
    },
    body: wav
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Supabase Storage ${response.status}: ${JSON.stringify(data)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${TTS_BUCKET}/${path}`;
}

async function getRecord(recordId) {
  const rows = await supabaseRequest(
    `content_pipeline?id=eq.${encodeURIComponent(recordId)}&select=id,script,tts_status,tts_audio_url&limit=1`
  );
  return rows[0] || null;
}

async function updateRecord(recordId, fields) {
  await supabaseRequest(`content_pipeline?id=eq.${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() })
  });
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

function normalizeTranscript(script) {
  return script.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function getVoicePrompt(script) {
  return `Speak this transcript in a DRY DEADPAN style.

PERFORMANCE: The narrator is calm, restrained, matter-of-fact, and subtly dry. Keep pitch movement small and controlled. Keep emotional intensity low. Sound mildly amused and observant, not excited. Do not sound like a presenter, announcer, advertisement, motivational speaker, audiobook narrator, or dramatic storyteller. Do not perform the lines theatrically. Do not add hype, enthusiasm, vocal smiling, exaggerated emphasis, or dramatic pauses. Let the words carry the interest. Keep a natural conversational rhythm with short, organic pauses only where a person would naturally think.

VOICE: Young adult male, Algieba. Smooth, grounded, intimate, casual, and believable. The voice should feel like one person casually telling a friend an interesting realization. Keep the same restrained deadpan character from the first word to the last.

IMPORTANT: Synthesize ONLY the text inside TRANSCRIPT. Everything before TRANSCRIPT is performance direction and must NOT be spoken.

TRANSCRIPT:
${script}`;
}

function extractGeminiAudio(interaction) {
  if (interaction?.output_audio?.data) {
    return {
      data: interaction.output_audio.data,
      sampleRate: interaction.output_audio.sample_rate || 24000,
      channels: interaction.output_audio.channels || 1,
      mimeType: interaction.output_audio.mime_type || 'audio/l16'
    };
  }

  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const item = content[j];
      if (item?.type === 'audio' && item?.data) {
        return {
          data: item.data,
          sampleRate: item.sample_rate || 24000,
          channels: item.channels || 1,
          mimeType: item.mime_type || 'audio/l16'
        };
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { ok: true, service: 'unmindy-tts', model: MODEL, storage: 'supabase' });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const cronSecret = env('CRON_SECRET');
  if (req.headers.authorization !== `Bearer ${cronSecret}`) return json(res, 401, { ok: false, error: 'Unauthorized' });

  let recordId;
  try {
    recordId = req.body?.recordId;
    if (!recordId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId)) {
      return json(res, 400, { error: 'A valid Supabase UUID recordId is required' });
    }

    const record = await getRecord(recordId);
    if (!record) return json(res, 404, { ok: false, error: 'Content pipeline record not found' });
    if (record.tts_status === 'Ready' && record.tts_audio_url) {
      return json(res, 200, { ok: true, recordId, audioUrl: record.tts_audio_url, model: MODEL, alreadyReady: true });
    }

    const cleanScript = normalizeTranscript(String(record.script || ''));
    if (!cleanScript) throw new Error('Supabase script field is empty');
    if (cleanScript.length > MAX_SCRIPT_CHARS) throw new Error(`Script is too long; maximum is ${MAX_SCRIPT_CHARS} characters`);

    await updateRecord(recordId, { tts_status: 'Generating' });

    const geminiResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env('GEMINI_API_KEY'),
        'Content-Type': 'application/json',
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify({
        model: MODEL,
        input: getVoicePrompt(cleanScript),
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: 'Algieba' }] }
      })
    });

    const gemini = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) throw new Error(`Gemini ${geminiResponse.status}: ${JSON.stringify(gemini)}`);

    const audio = extractGeminiAudio(gemini);
    if (!audio?.data) {
      const stepTypes = Array.isArray(gemini?.steps) ? gemini.steps.map(step => step?.type).filter(Boolean) : [];
      throw new Error(`Gemini returned no audio data (steps: ${stepTypes.join(',') || 'none'})`);
    }

    const pcm = base64ToBytes(audio.data);
    const wav = pcmToWav(pcm, audio.sampleRate, audio.channels);
    const audioPath = `tts/${recordId}.wav`;
    const audioUrl = await uploadAudio(audioPath, wav);

    await updateRecord(recordId, { tts_audio_url: audioUrl, tts_status: 'Ready', tts_started_at: null });
    return json(res, 200, { ok: true, recordId, audioUrl, model: MODEL });
  } catch (error) {
    if (recordId) {
      try { await updateRecord(recordId, { tts_status: 'Error', tts_started_at: null }); } catch {}
    }
    console.error('UNMINDY TTS error:', error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'TTS generation failed' });
  }
}
