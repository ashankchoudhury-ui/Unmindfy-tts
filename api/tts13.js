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

    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseKey) throw new Error('Missing Supabase service key');
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing Gemini API key');

    const supabase = createClient(SUPABASE_URL, supabaseKey);

    const prompt = `UNMINDY — REEL #13 FINAL TTS AUDIO

Generate ONLY the spoken TTS audio for the exact script below.
Voice identity: Algieba.

VOICE
Naturally deep, clear, present, human.
Calm and conversational.
Slightly dry and understated.
Thoughtful and intelligent without sounding like a narrator.
Subtly expressive, with natural emotional movement.
Approximately 45% deadpan / 55% natural expression.
Sound like a real person having a strangely profound thought, not someone performing “deep” content.

AUDIO QUALITY
Every word must be clearly audible on normal phone speakers.
Keep the voice full and present throughout.
Do NOT whisper.
Do NOT use breathy delivery.
Do NOT mumble.
Do NOT trail off at the ends of sentences.
Do NOT make the voice overly soft or cinematic.
Maintain consistent volume throughout.
Natural breathing is fine, but never let breaths obscure words.

DELIVERY
The script should feel like one continuous thought unfolding naturally.

IMPORTANT — FIRST LINE
The first two lines form ONE complete opening thought.
Deliver “If everyone you met liked you…” as ONE continuous sentence and thought.
Do NOT insert an unnatural pause anywhere inside that sentence.
Do NOT split “If everyone you met…” from “liked you…”.
The words “liked you” must remain naturally connected to the rest of the sentence.
After the first line finishes, give a short natural pause before “Would being liked by anyone even mean anything?”
The opening should feel immediate and conversational, as if the thought suddenly occurred to you.

EMOTIONAL PROGRESSION
First line: curious, direct, slightly intriguing.
Second line: genuine questioning, not dramatic.
“You'd always be wanted.”: simple and matter-of-fact.
“Everyone would choose you.”: slight emphasis on “choose”.
“Sounds perfect.”: understated, almost like agreeing with the obvious answer.
“But if everyone chose you…”: introduce the contradiction naturally.
“How would you know when someone really chose you?”: slower and more thoughtful, but still conversational.
Final two lines: quiet realization, not a dramatic conclusion.
“when they could've chosen someone else” carries the emotional weight of the ending, but stays controlled and natural.

PACING
Target total duration: approximately 20–25 seconds.
Do not rush.
Do not artificially slow the delivery to sound philosophical.
Use short pauses only where punctuation naturally suggests them.
Let “Sounds perfect.”, “But if everyone chose you…”, and “how would you know when someone really chose you?” breathe slightly.
Keep the overall rhythm tight enough for a Reel.
Line breaks show thought structure, not mandatory dramatic pauses.
Avoid long silences.
Do not stretch vowels or words.

CRITICAL STYLE RULES
No exaggerated acting.
No movie-trailer voice.
No inspirational-speaker tone.
No sadness unless naturally implied.
No forced emotion.
No dramatic vocal drops.
No excessive pauses.
No robotic uniformity.
Do not make every sentence sound equally “deep”.
The realization should feel discovered rather than performed.

MOST IMPORTANT PERFORMANCE NOTE
Think of this as a person casually talking through a strange idea with a friend. The curiosity is real, the contradiction is noticed in real time, and the ending is a quiet realization. Never “perform” philosophy. Never make the final lines sound like a quote being recited.

EXACT SCRIPT — READ WORD FOR WORD

${SCRIPT}

DO NOT
Add words.
Remove words.
Rewrite any sentence.
Add an introduction or outro.
Say the title.
Explain the script.
Add commentary.
Change the wording.
Repeat any line.

Generate ONLY the spoken TTS audio.`;

    await supabase.from('content_pipeline').update({
      tts_status: 'Generating',
      tts_started_at: new Date().toISOString()
    }).eq('id', RECORD_ID);

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
    console.error('UNMINDY Reel #13 TTS worker error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
