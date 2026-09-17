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

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseKey) throw new Error('Missing Supabase service key');
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing Gemini API key');
    const supabase = createClient(SUPABASE_URL, supabaseKey);

    const prompt = `Generate ONLY the spoken voice audio. Use Algieba.

PERFORMANCE: Naturally deep, clear, present, human. Calm, conversational, slightly dry and understated. Thoughtful and intelligent without narrator energy. Subtly expressive. Approximately 45% deadpan and 55% natural expression. Sound like a real person casually talking through a strange idea with a friend. Never perform “deep” content.

AUDIO: Full, present, consistent volume. Every word clear on phone speakers. Never whisper, breathe heavily, mumble, soften excessively, trail off, or become cinematic. Natural breathing is okay only when it does not obscure words.

RHYTHM: Tight conversational Reel pacing, approximately 20–25 seconds. Do not rush, but do not stretch. Use ONLY short natural conversational pauses. Line breaks are NOT instructions for silence. Never insert long gaps between lines or sentences. Punctuation can create brief pauses, but keep them compact. Do not add silence to make the piece sound philosophical.

OPENING: “If everyone you met liked you…” is ONE continuous sentence and one continuous thought. Keep “If everyone you met” naturally connected directly to “liked you”. Absolutely no pause inside that sentence. After the completed first sentence, use only a short natural pause, then immediately ask “Would being liked by anyone even mean anything?” The opening should feel immediate, curious, and conversational.

DELIVERY MAP:
- “If everyone you met liked you…” curious, direct, immediate; one uninterrupted thought.
- “Would being liked by anyone even mean anything?” genuine question, conversational, not dramatic.
- “You'd always be wanted.” simple and matter-of-fact.
- “Everyone would choose you.” slight natural emphasis on “choose”.
- “Sounds perfect.” understated, like agreeing with the obvious answer; only a brief pause afterward.
- “But if everyone chose you…” naturally introduce the contradiction; do not pause excessively.
- “how would you know when someone really chose you?” a little more thoughtful and slightly slower, but still conversational; no long silence around it.
- Final two lines are a quiet realization, controlled and natural. Give “when they could've chosen someone else” the emotional weight through subtle emphasis, NOT a dramatic voice or long pause.

CRITICAL: No exaggerated acting. No movie-trailer voice. No inspirational tone. No sadness unless naturally implied. No forced emotion. No dramatic vocal drops. No excessive pauses. No robotic uniformity. Do not make every sentence sound equally deep. The realization must feel discovered in real time, not performed as a quote.

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
    const pcm = Buffer.from(part.inlineData.data, 'base64');
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
