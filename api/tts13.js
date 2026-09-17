// UNMINDY Reel #13 dedicated TTS worker
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const RECORD_ID = '7d740517-7f7a-49c6-9106-7aabf996a09d';
const SCRIPT = `If everyone you met liked you…
Would being liked by anyone even mean anything?

You'd always be wanted.
Everyone would choose you.

Sounds perfect.

But if everyone chose you,
how would you know when someone really chose you?

Maybe being chosen only feels special
when they could've chosen someone else.`;

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + pcm.length, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28); buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34); buffer.write('data', 36); buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44); return buffer;
}

function speedUpPcm16(pcm, factor) {
  const samples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.floor(samples / factor));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.min(samples - 1, Math.floor(i * factor));
    pcm.copy(out, i * 2, src * 2, src * 2 + 2);
  }
  return out;
}

// Gemini sometimes inserts very long silences around line breaks. Keep tiny natural
// pauses, but cap obvious gaps so the Reel stays compact and conversational.
function tightenSilencePcm16(pcm, sampleRate = 24000) {
  const bytesPerSample = 2;
  const frameSamples = 240; // 10 ms
  const frameBytes = frameSamples * bytesPerSample;
  const threshold = 420;
  const maxGapMs = 180;
  const keepSamples = Math.floor(sampleRate * maxGapMs / 1000);
  const chunks = [];
  let silenceStart = -1;

  function frameSilent(offset) {
    const end = Math.min(offset + frameBytes, pcm.length);
    let sum = 0;
    let count = 0;
    for (let p = offset; p + 1 < end; p += 2) {
      const s = pcm.readInt16LE(p);
      sum += Math.abs(s);
      count++;
    }
    return count > 0 && sum / count < threshold;
  }

  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const silent = frameSilent(offset);
    if (silent && silenceStart < 0) silenceStart = offset;
    if (!silent && silenceStart >= 0) {
      const gapSamples = Math.floor((offset - silenceStart) / 2);
      if (gapSamples > keepSamples) {
        chunks.push(pcm.subarray(silenceStart, silenceStart + keepSamples * 2));
        chunks.push(pcm.subarray(offset));
        const prefix = pcm.subarray(0, silenceStart);
        return Buffer.concat([prefix, ...chunks]);
      }
      silenceStart = -1;
    }
  }

  if (silenceStart >= 0) {
    const gapSamples = Math.floor((pcm.length - silenceStart) / 2);
    if (gapSamples > keepSamples) {
      return Buffer.concat([pcm.subarray(0, silenceStart), pcm.subarray(silenceStart, silenceStart + keepSamples * 2)]);
    }
  }
  return pcm;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseKey) throw new Error('Missing Supabase service key');
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing Gemini API key');
    const supabase = createClient(SUPABASE_URL, supabaseKey);

    const prompt = `Generate ONLY the spoken voice audio. Use Algieba.

VOICE: naturally deep, clear, present, human, calm, conversational, slightly dry, understated, thoughtful, intelligent, subtly expressive. Roughly 45% deadpan and 55% natural expression. Never sound like a narrator or perform a “deep” quote.

IMPORTANT RHYTHM: Make this a SHORT, TIGHT conversational Reel. Target about 17–21 seconds. Speak at a natural brisk conversational pace. Do NOT stretch words. Do NOT add dramatic silence. Line breaks are NOT pauses. Keep sentence-to-sentence gaps very short, generally around 0.05–0.15 seconds. Never insert a gap longer than about 0.2 seconds unless absolutely required by punctuation. The whole thought should flow continuously.

OPENING: “If everyone you met liked you…” is ONE uninterrupted sentence/thought. No pause inside it. After it, take only a tiny conversational breath, then immediately continue with “Would being liked by anyone even mean anything?”

DELIVERY: “You'd always be wanted.” matter-of-fact. “Everyone would choose you.” slight emphasis on “choose”. “Sounds perfect.” understated and quick. “But if everyone chose you…” immediate contradiction, no dramatic gap. The question that follows can be a touch more thoughtful, but keep it moving. The final two lines should be a quiet realization with subtle emphasis, NOT a slow dramatic ending.

AUDIO: full clear volume throughout. Never whisper, mumble, trail off, become breathy, or fade at the end. Every word must remain intelligible on phone speakers.

NO: cinematic delivery, narrator voice, motivational tone, audiobook pacing, theatrical pauses, suspense, exaggerated emotion, overacting, artificial deepening, long breaths, or line-by-line dramatic reading.

READ EXACTLY — WORD FOR WORD. Do not add, remove, rewrite, repeat, introduce, explain, title, or comment.

${SCRIPT}

Generate ONLY the spoken TTS audio.`;

    await supabase.from('content_pipeline').update({ tts_status: 'Generating', tts_started_at: new Date().toISOString() }).eq('id', RECORD_ID);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Algieba' } } } }
    });
    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error('No audio returned by Gemini');

    let pcm = Buffer.from(part.inlineData.data, 'base64');
    pcm = tightenSilencePcm16(pcm, 24000);
    pcm = speedUpPcm16(pcm, 1.10);

    const wav = pcmToWav(pcm, 24000, 1, 16);
    const path = `tts/${RECORD_ID}.wav`;
    const { error: uploadError } = await supabase.storage.from('tts-audio').upload(path, wav, { contentType: 'audio/wav', upsert: true, cacheControl: '0' });
    if (uploadError) throw uploadError;
    const { data: publicData } = supabase.storage.from('tts-audio').getPublicUrl(path);
    const url = `${publicData.publicUrl}?v=${Date.now()}`;
    const { error: updateError } = await supabase.from('content_pipeline').update({ tts_status: 'Ready', tts_audio_url: url, updated_at: new Date().toISOString() }).eq('id', RECORD_ID);
    if (updateError) throw updateError;
    return res.status(200).json({ ok: true, status: 'Ready', url });
  } catch (error) {
    console.error('UNMINDY Reel #13 TTS worker error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
