// UNMINDY Reel #14 dedicated TTS worker
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const RECORD_ID = 'cd1e9204-4b8f-4412-afcb-11e1d3e3a3e9';
const SCRIPT = `You used to get bored.
Now the second there's nothing to do,
you reach for your phone.
Eating.
Walking.
Showering.
We've filled every quiet moment.
Maybe that's why
our minds feel so full.`;

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

function tightenSilencePcm16(pcm, sampleRate = 24000) {
  const frameSamples = 240; // 10 ms
  const frameBytes = frameSamples * 2;
  const threshold = 420;
  const maxGapSamples = Math.floor(sampleRate * 0.16);
  const out = [];
  let cursor = 0;

  const frameSilent = (offset) => {
    const end = Math.min(offset + frameBytes, pcm.length);
    let sum = 0, count = 0;
    for (let p = offset; p + 1 < end; p += 2) {
      sum += Math.abs(pcm.readInt16LE(p)); count++;
    }
    return count > 0 && sum / count < threshold;
  };

  while (cursor < pcm.length) {
    if (!frameSilent(cursor)) {
      out.push(pcm.subarray(cursor, Math.min(cursor + frameBytes, pcm.length)));
      cursor += frameBytes;
      continue;
    }
    const start = cursor;
    while (cursor < pcm.length && frameSilent(cursor)) cursor += frameBytes;
    const end = Math.min(cursor, pcm.length);
    const silentSamples = Math.floor((end - start) / 2);
    if (silentSamples <= maxGapSamples) {
      out.push(pcm.subarray(start, end));
    } else {
      out.push(pcm.subarray(start, start + maxGapSamples * 2));
    }
  }
  return Buffer.concat(out);
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

VOICE: naturally deep, calm, conversational, slightly dry, subtly expressive, human, not an AI narrator. Roughly 55% dry/deadpan and 45% natural expression. Sound like someone casually noticing something about everyday life and thinking out loud.

DELIVERY: Make the entire script one continuous conversational thought. Keep gaps between lines SHORT and natural. Line breaks are for rhythm, NOT silence. Do not pause dramatically after every sentence. Keep sentence-to-sentence gaps generally around 0.05–0.15 seconds and never intentionally insert long silence. The opening “You used to get bored. Now…” must flow naturally and tightly as one thought. “Eating. Walking. Showering.” should be quick, rhythmic observations. Take only a slight natural pause before “We've filled every quiet moment.” The final three lines slow down slightly and become reflective, but remain connected and conversational.

PACING: Target approximately 25–30 seconds, but do not stretch to hit a duration. Prioritize natural flow, retention, conversational delivery, and clarity. Never stretch words to create drama.

PRONUNCIATION: Speak every word naturally in conversational English. Make “second there's nothing to do” fluid rather than word-by-word. Keep “quiet moment” natural and understated. Make “our minds feel so full” slightly reflective, not dramatic.

AUDIO: full, clear, present volume throughout. Every word intelligible on phone speakers. No whispering, mumbling, breathiness, trailing off, theatrical breaths, or fading at the end.

DO NOT sound sad, motivational, inspirational, mysterious, cinematic, documentary-like, theatrical, or like an audiobook/announcer. Do not over-enunciate. Do not add dramatic pauses, music, sound effects, intro, outro, or commentary.

READ EXACTLY — WORD FOR WORD. Do not add, remove, rewrite, repeat, or reorder anything.

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

    const pcm = tightenSilencePcm16(Buffer.from(part.inlineData.data, 'base64'), 24000);
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
    console.error('UNMINDY Reel #14 TTS worker error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
