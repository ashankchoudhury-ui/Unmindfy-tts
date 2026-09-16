import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iwpanewluzilghoitvxr.supabase.co';
const RECORD_ID = '7d740517-7f7a-49c6-9106-7aabf996a09d';

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
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });

    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseKey) throw new Error('Missing Supabase service key');
    const supabase = createClient(SUPABASE_URL, supabaseKey);

    const transcript = `If everyone you met liked you…\nWould being liked by anyone even mean anything?\n\nYou'd always be wanted.\nEveryone would choose you.\n\nSounds perfect.\n\nBut if everyone chose you,\nhow would you know when someone really chose you?\n\nMaybe being chosen only feels special\nwhen they could've chosen someone else.`;

    await supabase.from('content_pipeline').update({
      tts_status: 'Generating',
      tts_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', RECORD_ID);

    const prompt = `UNMINDY — REEL #13 FINAL TTS AUDIO

Generate ONLY the spoken TTS audio for the exact script below.
Voice identity: Algieba.

VOICE
Naturally deep, clear, present, human, calm, conversational, slightly dry, understated, thoughtful, intelligent, subtly expressive.
Aim for approximately 45% deadpan / 55% natural expression.
Sound like a real person having a strangely profound thought with a friend — NOT someone performing “deep” content.

AUDIO QUALITY
Every word must be clearly audible on normal phone speakers.
Keep the voice full, supported, and present throughout.
Never whisper, become breathy, mumble, or trail off at sentence endings.
Do not make the voice overly soft or cinematic.
Maintain consistent volume from the first word through the final word.
Natural breathing is fine only when it does not obscure words.

DELIVERY
The entire script should feel like one continuous thought unfolding naturally.
Do not make every line sound like a separate dramatic statement.
Line breaks show thought structure, not mandatory long pauses.
Use short natural conversational pauses where punctuation or a real thought transition suggests one.
Never use theatrical silence.
Never slow down just to sound philosophical.

CRITICAL OPENING REQUIREMENT
The first two lines are one connected opening thought.
“If everyone you met liked you…” MUST be spoken as ONE continuous sentence/thought.
Do NOT split it internally after “met”.
Keep “liked you” naturally connected to the rest of the sentence.
After the complete first line finishes, use one short natural pause before the second question.
The opening should feel immediate and conversational, like the thought suddenly occurred to you.

EMOTIONAL PROGRESSION
First line: curious, direct, slightly intriguing.
Second line: genuine questioning, not dramatic.
“You'd always be wanted.”: simple and matter-of-fact.
“Everyone would choose you.”: slight natural emphasis on “choose”.
“Sounds perfect.”: understated, almost casually agreeing with the obvious answer; do not turn it into a dramatic beat.
“But if everyone chose you…”: introduce the contradiction naturally.
“how would you know when someone really chose you?”: slightly slower and more thoughtful, but still conversational and fully audible.
Final two lines: quiet realization, not a dramatic conclusion.
“when they could've chosen someone else” should carry the emotional weight through meaning and subtle emphasis, NOT through a whispered or falling volume.

PACING
Target total duration: approximately 20–25 seconds.
Do not rush.
Do not artificially slow the delivery.
Use short pauses only where punctuation naturally suggests them.
Let “Sounds perfect.”, “But if everyone chose you…”, and the middle question breathe slightly.
Keep the overall rhythm tight enough for a Reel.

CRITICAL STYLE RULES
No exaggerated acting.
No movie-trailer voice.
No inspirational-speaker tone.
No sadness unless naturally implied.
No forced emotion.
No dramatic vocal drops.
No excessive pauses.
No robotic uniformity.
Do not make every sentence sound equally deep.
The realization should feel discovered rather than performed.

EXACT SCRIPT — READ WORD FOR WORD

${transcript}

DO NOT
Add words.
Remove words.
Rewrite any sentence.
Add an introduction or outro.
Say the title.
Explain anything.
Repeat any line.
Change the wording.

Generate ONLY the spoken TTS audio.`;

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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

    const path = `tts/${RECORD_ID}.wav`;
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
    }).eq('id', RECORD_ID);
    if (updateError) throw updateError;

    return res.status(200).json({ ok: true, status: 'Ready', url });
  } catch (error) {
    try {
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
      if (supabaseKey) {
        const supabase = createClient(SUPABASE_URL, supabaseKey);
        await supabase.from('content_pipeline').update({
          tts_status: 'Error',
          updated_at: new Date().toISOString()
        }).eq('id', RECORD_ID);
      }
    } catch {}
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
