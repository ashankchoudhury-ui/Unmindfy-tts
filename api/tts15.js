import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const RECORD_ID = '4241be87-6d8f-429b-ad0e-a734045a0d1a';
const SCRIPT = `Would you want to know your future? Every good thing. Every bad thing. Everything waiting for you. Until you learn something bad. Then knowing feels worse than wondering.`;

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
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!key || !process.env.GEMINI_API_KEY) throw new Error('Missing required environment variable');
    const supabase = createClient(SUPABASE_URL, key);
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `UNMINDY REEL #15 — FINAL TTS AUDIO ONLY\n\nVOICE: Algieba.\n\nSound like a real person casually talking directly to one person. Naturally deep, calm, conversational, slightly dry/deadpan, subtly expressive, intimate, thoughtful but not deliberately “deep”. Target roughly 55% dry/deadpan / 45% natural expression. Do not sound like a documentary narrator, motivational speaker, audiobook, movie trailer, inspirational TikTok voice, overly emotional storyteller, or AI explaining psychology.\n\nDELIVERY: Do not perform the script; think it. Emotional progression is subtle: curiosity → possibility → slight discomfort → realization. First line is a genuine question, not a dramatic hook. Middle is observational. Final line is a simple realization.\n\nPACING: Natural and compact. No long cinematic gaps. No exaggerated breaths. No robotic equal pauses. Do not make every sentence isolated. Let the narration flow as one continuous thought. Brief natural pause after the opening question. Short pauses between “Every good thing.” and “Every bad thing.” and a slightly longer natural thought separation before “Until you learn something bad.” Keep the final sentence smooth and reflective. Never stretch the runtime artificially.\n\nEMPHASIS: Subtle extra weight on future, good, bad, waiting, knowing, wondering. Especially the contrast between knowing and wondering, without punching the words. “Wondering” may carry a tiny bit more weight at the end. No exaggerated downward ending.\n\nNATURAL HUMAN VARIATION: tiny pitch changes, varied sentence rhythm, slight pacing variation, gentle emphasis, natural breath placement. No identical rhythms, robotic pacing, excessive vocal fry, artificial whispering, over-pronunciation, or fillers.\n\nAUDIO: clean TTS only. No music, ambience, SFX, intro, outro, title, commentary, or extra words. Read EXACTLY word for word.\n\nSCRIPT:\n${SCRIPT}`;

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
    console.error('UNMINDY Reel #15 TTS error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
