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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
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

// TTS gets a single flowing transcript. Normalize accidental editor line breaks
// so formatting does not become artificial pacing.
function normalizeTranscript(script) {
  return script
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function getVoicePrompt(script) {
  return `TTS the following transcript. Only speak the text under TRANSCRIPT. Do not read the headings or instructions aloud.

# AUDIO PROFILE
Young adult male narrator. Natural, intelligent, grounded, intimate and conversational. Sounds like a real person sharing an observation with one listener. Not an announcer, advertisement, motivational speaker or exaggerated storyteller.

## SCENE
A quiet, intimate conversation. The narrator is casually explaining an interesting psychological idea to a friend. The narrator is noticing something psychologically true rather than lecturing. The emotional atmosphere should match the topic of the transcript.

### DIRECTOR'S NOTES
Style: Natural, casual, thoughtful and human. Understated rather than theatrical.
Pacing: Smooth, continuous conversational pace suitable for a short-form Reel. Keep it moving without rushing. Use natural micro-pauses only where the thought changes.
Articulation: Clear and easy to understand without sounding commercial.
Emotion: Begin with natural curiosity or observation, build slightly toward recognition or tension when the idea calls for it, then let the final realization land simply and naturally.
Performance: Do not over-act. Do not make every sentence dramatic. Do not insert long pauses between short phrases. Do not over-emphasize individual words. Keep the narrator identity consistent.

### SAMPLE CONTEXT
A young person is casually talking to a friend about something they have noticed about their own thinking. It should sound spontaneous and conversational, as if the speaker is explaining an interesting realization rather than performing a written script. Keep the delivery naturally energetic enough for a short social-media video, but never rushed. The speaker is calm and confident at the beginning. As the idea develops, the delivery can become slightly more focused and thoughtful. The middle should have natural conversational rhythm, with small variations in pacing and emphasis rather than deliberate dramatic pauses. Near the end, the tension should disappear and the final thought should sound like the speaker casually realizing something simple and true. Do not sound like a motivational speaker, narrator, audiobook reader, advertisement, or dramatic storyteller.

#### TRANSCRIPT
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

    const script = record.script;
    if (!script || typeof script !== 'string') throw new Error('Supabase script field is empty');
    const cleanScript = normalizeTranscript(script);
    if (!cleanScript) throw new Error('Supabase script field is empty');
    if (cleanScript.length > MAX_SCRIPT_CHARS) throw new Error(`Script is too long; maximum is ${MAX_SCRIPT_CHARS} characters`);

    if (record.tts_status === 'Ready' && record.tts_audio_url) {
      return json(res, 200, { ok: true, recordId, audioUrl: record.tts_audio_url, model: MODEL, alreadyReady: true });
    }

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
      const stepTypes = Array.isArray(gemini?.steps) ? gemini.steps.map((step) => step?.type).filter(Boolean) : [];
      throw new Error(`Gemini returned no audio data (steps: ${stepTypes.join(',') || 'none'})`);
    }

    const pcm = base64ToBytes(audio.data);
    const wav = pcmToWav(pcm, audio.sampleRate, audio.channels);
    const audioPath = `tts/${recordId}.wav`;
    const audioUrl = await uploadAudio(audioPath, wav);

    await updateRecord(recordId, { tts_audio_url: audioUrl, tts_status: 'Ready' });
    return json(res, 200, { ok: true, recordId, audioUrl, model: MODEL });
  } catch (error) {
    if (recordId) { try { await updateRecord(recordId, { tts_status: 'Error' }); } catch {} }
    console.error('UNMINDY TTS error:', error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'TTS generation failed' });
  }
}
