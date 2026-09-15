// UNMINDY TTS worker
// Generates Gemini TTS audio, converts PCM to WAV, and stores it in Supabase.

import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const REEL_6_ID = 'f7e3ecfb-8919-4da7-8d5e-09fc50f312ed';

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + pcm.length);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcm.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { recordId, force } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseKey) throw new Error('Missing Supabase service key');
    const supabase = createClient(SUPABASE_URL, supabaseKey);

    const { data: record, error: fetchError } = await supabase
      .from('content_pipeline')
      .select('*')
      .eq('id', recordId)
      .single();
    if (fetchError || !record) return res.status(404).json({ error: 'Record not found' });

    if (!force && record.tts_status === 'Ready' && record.tts_audio_url) {
      return res.status(200).json({ ok: true, status: 'Ready', url: record.tts_audio_url });
    }

    await supabase.from('content_pipeline').update({
      tts_status: 'Generating',
      tts_attempts: (record.tts_attempts || 0) + 1,
      tts_started_at: new Date().toISOString()
    }).eq('id', recordId);

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const transcript = record.tts_script || record.script || '';
    if (!transcript.trim()) throw new Error('No TTS script found');

    const prompt = recordId === REEL_6_ID
      ? `UNMINDY — MASTER TTS GENERATION PROMPT

Generate ONLY the TTS audio for the exact script provided below.

VOICE:
Use Gemini TTS voice: Algieba.

The voice should sound:
- Naturally deep
- Calm
- Conversational
- Intelligent
- Slightly dry
- Subtly expressive
- Mildly curious
- Understated
- Human and believable

DELIVERY:
Imagine someone casually explaining a thought to a close friend late at night.

Do NOT sound like:
- An AI voice
- A narrator
- A documentary voice
- A motivational speaker
- A news presenter
- A trailer voice
- A teacher reading a script

The delivery should be approximately:
55% deadpan / 45% natural expression.

Use natural pitch movement and subtle changes in emphasis.

Do not make every sentence dramatic.

Let emotional moments become slightly quieter or more deliberate instead of louder.

PACING:

Speak naturally and clearly.

Do not rush.

Do not drag sentences unnaturally.

Use short pauses between separate thoughts.

Use slightly longer pauses where the script contains:
"..."
or an intentional line break.

Pauses should feel like genuine thinking, not robotic timing.

EMPHASIS:

Naturally emphasize important words and phrases, but keep it subtle.

The opening should immediately feel interesting and conversational.

As the thought develops, gradually increase emotional involvement.

The final lines should feel like a genuine realization.

Do NOT turn the ending into a dramatic quote.

Keep the voice controlled and understated.

SCRIPT:

${transcript}

IMPORTANT:

Read the script EXACTLY as written.

Do not add, remove, rewrite, paraphrase, or improvise any words.

Do not add an introduction or outro.

Do not say the title.

Do not explain anything.

Generate only the spoken TTS audio.

TARGET:

Natural short-form narration for UNMINDY.

The finished audio should feel like a real person having a quiet, thoughtful conversation — not someone performing a script.`
      : `Read the following UNMINDY reel script as a young adult male casually explaining an observation to a friend. Voice: Algieba. Keep it naturally deep, calm, conversational, intelligent, slightly dry/deadpan, subtly expressive, mildly curious, and understated. Natural human rhythm. Do not sound like a narrator, announcer, documentary, YouTuber, motivational speaker, advertisement, audiobook, movie trailer, dramatic storyteller, emotionless AI, or psychology teacher. Do not add words. Read the script exactly as written. Generate only the spoken TTS audio.\n\nSCRIPT:\n${transcript}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Algieba' } } }
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error('No audio returned by Gemini');
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    const wav = pcmToWav(pcm, 24000, 1, 16);

    const path = `tts/${recordId}.wav`;
    const { error: uploadError } = await supabase.storage.from('tts-audio').upload(path, wav, {
      contentType: 'audio/wav',
      upsert: true,
      cacheControl: '0'
    });
    if (uploadError) throw uploadError;

    const { data: publicData } = supabase.storage.from('tts-audio').getPublicUrl(path);
    const url = `${publicData.publicUrl}?v=${Date.now()}`;

    const { error: updateError } = await supabase.from('content_pipeline').update({
      tts_status: 'Ready',
      tts_audio_url: url,
      updated_at: new Date().toISOString()
    }).eq('id', recordId);
    if (updateError) throw updateError;

    return res.status(200).json({ ok: true, status: 'Ready', url });
  } catch (error) {
    console.error('UNMINDY TTS worker error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
