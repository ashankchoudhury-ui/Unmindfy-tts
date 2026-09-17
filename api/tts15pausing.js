import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const RECORD_ID = 'b7d3c5e1-2a44-4f91-9c63-8e17a6d4b520';
const SCRIPT = `You could pause time. Imagine finding a moment you loved and never having to leave it. But if you could stop every moment… what would make any moment special?`;

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + pcm.length, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28); buffer.writeUInt16LE(blockAlign, 32); buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(pcm.length, 40); pcm.copy(buffer, 44); return buffer;
}

function tightenSilencePcm16(pcm, sampleRate = 24000) {
  const frameSamples = 120, frameBytes = frameSamples * 2, threshold = 500;
  const maxSilenceSamples = Math.floor(sampleRate * 0.10), out = [];
  let cursor = 0;
  const silent = (offset) => {
    const end = Math.min(offset + frameBytes, pcm.length); let sum = 0, count = 0;
    for (let p = offset; p + 1 < end; p += 2) { sum += Math.abs(pcm.readInt16LE(p)); count++; }
    return count > 0 && sum / count < threshold;
  };
  while (cursor < pcm.length) {
    if (!silent(cursor)) { out.push(pcm.subarray(cursor, Math.min(cursor + frameBytes, pcm.length))); cursor += frameBytes; continue; }
    const start = cursor;
    while (cursor < pcm.length && silent(cursor)) cursor += frameBytes;
    const end = Math.min(cursor, pcm.length), samples = Math.floor((end - start) / 2);
    out.push(samples <= maxSilenceSamples ? pcm.subarray(start, end) : pcm.subarray(start, start + maxSilenceSamples * 2));
  }
  return Buffer.concat(out);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!key || !process.env.GEMINI_API_KEY) throw new Error('Missing required environment variable');
    const supabase = createClient(SUPABASE_URL, key);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `UNMINDY REEL #15 — PAUSING TIME — FINAL TTS AUDIO ONLY

VOICE: Algieba.

Sound like a real person casually talking directly to one person. Naturally deep, calm, conversational, slightly dry/deadpan, subtly expressive, intimate, thoughtful without sounding intentionally “deep”. Aim for 55% dry/deadpan and 45% natural expression. Do not sound like a documentary, audiobook, motivational speaker, movie trailer, dramatic philosophical monologue, psychology explainer, inspirational TikTok narrator, or AI trying to sound emotional.

DELIVERY: Think the script, don't perform it. The emotional progression is subtle: possibility → warmth → realization. The first line is casual and direct. The second line is slightly warmer and imaginative. The third continues smoothly. The “But” marks a natural turn in thought, not an ominous shift. The final question is a genuine question and the ending should remain understated.

PACING: Compact and spontaneous. Short human pauses only, around 0.1–0.25 seconds between thought units. No long cinematic gaps. Do not pause after every word. Do not slow down unnaturally. Do not stretch vowels. Treat “and never having to leave it” as a continuation of the preceding thought, not a separate dramatic sentence. The ellipsis in “every moment…” is only a brief thinking pause. Keep the final question flowing naturally and leave only a tiny natural tail after “special”.

EMPHASIS: Extremely subtle extra weight on “pause time”, “moment you loved”, “every moment”, and “special”. Never punch the words. Let the contrast between “every moment” and “special” emerge naturally.

HUMAN EXPRESSION: Small natural pitch and rhythm variation, natural breath placement, and conversational timing. No fake fillers, stutters, extra breaths, whispering, vocal theatrics, exaggerated emotional drops, or over-pronunciation. Do not add any words.

AUDIO: clean narration only. No music, ambience, SFX, intro, outro, title, commentary, or extra words. Read the script exactly as written.

SCRIPT:
${SCRIPT}`;

    await supabase.from('content_pipeline').update({ tts_status: 'Generating', tts_attempts: 1, tts_started_at: new Date().toISOString() }).eq('id', RECORD_ID);
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Algieba' } } } }
    });
    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error('No audio returned by Gemini');
    const pcm = tightenSilencePcm16(Buffer.from(part.inlineData.data, 'base64'), 24000);
    const wav = pcmToWav(pcm);
    const path = `tts/${RECORD_ID}.wav`;
    const { error: uploadError } = await supabase.storage.from('tts-audio').upload(path, wav, { contentType: 'audio/wav', upsert: true, cacheControl: '0' });
    if (uploadError) throw uploadError;
    const { data: publicData } = supabase.storage.from('tts-audio').getPublicUrl(path);
    const url = `${publicData.publicUrl}?v=${Date.now()}`;
    const { error: updateError } = await supabase.from('content_pipeline').update({ tts_status: 'Ready', tts_audio_url: url, updated_at: new Date().toISOString() }).eq('id', RECORD_ID);
    if (updateError) throw updateError;
    return res.status(200).json({ ok: true, status: 'Ready', url });
  } catch (error) {
    console.error('UNMINDY Reel #15 Pausing Time TTS error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
