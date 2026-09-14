// UNMINDY TTS worker
// Generates Gemini TTS audio, converts PCM to WAV, and stores it in Supabase.

import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';

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

function speedUpPcm16(pcm, factor) {
  if (!Number.isFinite(factor) || factor <= 1) return pcm;
  const samples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.floor(samples / factor));
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.min(samples - 1, Math.floor(i * factor));
    out.writeInt16LE(pcm.readInt16LE(src * 2), i * 2);
  }
  return out;
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

    const prompt = `Read the following UNMINDY reel script as a young adult male casually explaining an observation to a friend. Voice: Algieba. Keep it naturally deep, calm, conversational, intelligent, slightly dry/deadpan, subtly expressive, mildly curious, and understated. Natural human rhythm, but this is a short social-media reel: speak at a brisk, comfortable pace. Keep sentence gaps very short and organic. Do not linger, stretch words, or add dramatic pauses. Ellipses in the script indicate only tiny hesitations. Do not sound like a narrator, announcer, documentary, YouTuber, motivational speaker, advertisement, audiobook, movie trailer, dramatic storyteller, emotionless AI, or psychology teacher. Do not add words.

Performance direction: Start extremely natural and casual. Slightly emphasize contrasts and questions, especially “then you hate it because of the ending,” “ten bad minutes,” and “the whole movie.” “But why?” should be very short and genuinely curious. Keep the explanation matter-of-fact. End with restrained weight on “But the movie in your head did,” as a quiet realization, not a dramatic quote.

SCRIPT:
${transcript}`;

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
    let pcm = Buffer.from(part.inlineData.data, 'base64');

    const speedFactor = recordId === '78fbca42-df48-43c7-8abb-671e94c7a6e3' ? 1.08 : 1.5;
    pcm = speedUpPcm16(pcm, speedFactor);
    const wav = pcmToWav(pcm, 24000, 1, 16);

    const path = `tts/${recordId}.wav`;
    const { error: uploadError } = await supabase.storage.from('tts-audio').upload(path, wav, {
      contentType: 'audio/wav',
      upsert: true
    });
    if (uploadError) throw uploadError;

    const { data: publicData } = supabase.storage.from('tts-audio').getPublicUrl(path);
    const url = publicData.publicUrl;

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
