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

// Keep only tiny natural silences; never allow a generated gap to become dramatic.
function tightenSilencePcm16(pcm, sampleRate = 24000) {
  const frameSamples = 120; // 5 ms
  const frameBytes = frameSamples * 2;
  const threshold = 500;
  const maxSilenceSamples = Math.floor(sampleRate * 0.08); // hard cap: 80 ms
  const out = [];
  let cursor = 0;
  const silent = (offset) => {
    const end = Math.min(offset + frameBytes, pcm.length);
    let sum = 0, count = 0;
    for (let p = offset; p + 1 < end; p += 2) { sum += Math.abs(pcm.readInt16LE(p)); count++; }
    return count > 0 && sum / count < threshold;
  };
  while (cursor < pcm.length) {
    if (!silent(cursor)) {
      out.push(pcm.subarray(cursor, Math.min(cursor + frameBytes, pcm.length)));
      cursor += frameBytes;
      continue;
    }
    const start = cursor;
    while (cursor < pcm.length && silent(cursor)) cursor += frameBytes;
    const end = Math.min(cursor, pcm.length);
    const silentSamples = Math.floor((end - start) / 2);
    if (silentSamples <= maxSilenceSamples) out.push(pcm.subarray(start, end));
    else out.push(pcm.subarray(start, start + maxSilenceSamples * 2));
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

    const prompt = `UNMINDY REEL #14 — FINAL TTS AUDIO ONLY

VOICE: Algieba.
Sound like a real person casually talking, not a narrator: naturally deep, calm, natural, conversational, slightly dry, subtly expressive, intimate but not emotional. Aim for 55% dry/deadpan and 45% natural expression. The speaker sounds like he noticed something and is sharing the thought rather than explaining a fact.

PACING IS THE HIGHEST PRIORITY. Read the entire script as ONE continuous thought. The line breaks are visual/script rhythm only and MUST NOT become automatic pauses. Do not pause after every sentence or period. Never insert long empty gaps. Keep the read tight and conversational, approximately 20–25 seconds naturally; never artificially slow it to hit the target.

TIMING:
- “You used to get bored.”: natural, then about 0.35 sec.
- “Now the second there's nothing to do, you reach for your phone.”: ONE flowing sentence. No pause after “Now” or “second”. Then about 0.30 sec.
- “Eating. Walking. Showering.”: quick rhythmic observations. About 0.12 sec after Eating, 0.12 sec after Walking, 0.25 sec after Showering. Do not make them dramatic.
- “We've filled every quiet moment.”: start immediately after the short transition. Then about 0.30 sec.
- “Maybe that's why”: natural and slightly softer, with NO pause between “Maybe” and “that's”. Then about 0.15 sec.
- “our minds feel so full.”: final realization, only 5–8% slower than earlier speech, not dragged out. End with about 0.5 sec natural tail silence.

Use natural micro-pauses and connected speech. Never exceed about 0.5 sec anywhere except the final tail. Do not treat every period as a dramatic pause. “You used to get bored. Now…” must feel tightly connected. “Now the second there's nothing to do…” must flow without word-by-word spacing. The three examples should be quick and matter-of-fact. “We've filled every quiet moment.” is a subtle realization. The final line is quiet and reflective but NOT sad, inspirational, ominous, cinematic, or theatrical. The feeling should be “Wait… that's actually true,” not “the narrator is trying to make me feel something.”

AUDIO: clear, full, consistent speaking volume; every word intelligible. No artificial breaths, whispering, breathiness, mumbling, fading, trailing off, over-enunciation, music, sound effects, intro, outro, or commentary.

ABSOLUTE: Read EXACTLY word for word. Do not add, remove, rewrite, paraphrase, repeat, reorder, or improvise any words. Generate only the spoken TTS audio.

SCRIPT:
${SCRIPT}`;

    await supabase.from('content_pipeline').update({ tts_status: 'Generating', tts_attempts: 1, tts_started_at: new Date().toISOString() }).eq('id', RECORD_ID);
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
