const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function parseSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/([0-9.]+)s/);
  return match ? Number(match[1]) : null;
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9']+/gi, '')
    .trim();
}

function extractWordAnnotations(interaction) {
  const words = [];
  for (const step of interaction?.steps || []) {
    for (const content of step?.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.type !== 'word_info') continue;
        const text = String(annotation.text || '').trim();
        const start = parseSeconds(annotation.start_offset);
        const end = parseSeconds(annotation.end_offset);
        if (text && Number.isFinite(start) && Number.isFinite(end)) {
          words.push({ text, start, end });
        }
      }
    }
  }
  return words;
}

function alignScript(script, transcriptWords) {
  const target = String(script || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const normalizedTranscript = transcriptWords.map((word, index) => ({ ...word, index, key: normalizeToken(word.text) }));
  const aligned = [];
  let cursor = 0;

  for (let i = 0; i < target.length; i += 1) {
    const wanted = normalizeToken(target[i]);
    if (!wanted) continue;
    let found = -1;
    for (let j = cursor; j < Math.min(normalizedTranscript.length, cursor + 5); j += 1) {
      if (normalizedTranscript[j].key === wanted) { found = j; break; }
    }
    if (found >= 0) {
      const hit = normalizedTranscript[found];
      aligned.push({ text: target[i], start: hit.start, end: hit.end });
      cursor = found + 1;
    } else {
      aligned.push({ text: target[i], start: null, end: null });
    }
  }

  // Fill small alignment gaps from neighboring real timestamps so one missed ASR token
  // does not cause captions to jump or collapse.
  const real = aligned.map((x, i) => ({ ...x, i })).filter(x => Number.isFinite(x.start) && Number.isFinite(x.end));
  if (!real.length) return aligned;
  for (let i = 0; i < aligned.length; i += 1) {
    if (Number.isFinite(aligned[i].start)) continue;
    let prev = null, next = null;
    for (let p = i - 1; p >= 0; p -= 1) { if (Number.isFinite(aligned[p].end)) { prev = aligned[p]; break; } }
    for (let n = i + 1; n < aligned.length; n += 1) { if (Number.isFinite(aligned[n].start)) { next = aligned[n]; break; } }
    if (prev && next && next.start > prev.end) {
      const gap = (next.start - prev.end) / (i - (aligned.indexOf(prev)) + 1);
      const offset = gap * (i - aligned.indexOf(prev) - 0.5);
      aligned[i].start = prev.end + offset - gap * 0.35;
      aligned[i].end = prev.end + offset + gap * 0.35;
    } else if (prev) {
      aligned[i].start = prev.end;
      aligned[i].end = prev.end + 0.12;
    } else if (next) {
      aligned[i].end = next.start;
      aligned[i].start = Math.max(0, next.start - 0.12);
    }
  }
  return aligned;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (req.headers.authorization !== `Bearer ${env('CRON_SECRET')}`) return json(res, 401, { ok: false, error: 'Unauthorized' });

  try {
    const audioUrl = req.body?.audioUrl;
    const script = req.body?.script;
    if (!audioUrl || !script) return json(res, 400, { ok: false, error: 'audioUrl and script are required' });

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) throw new Error(`Audio download failed: ${audioResponse.status}`);
    const bytes = Buffer.from(await audioResponse.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw new Error(`Audio is too large for inline transcription: ${bytes.length} bytes`);

    const interactionResponse = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': env('GEMINI_API_KEY'),
        'Content-Type': 'application/json',
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify({
        model: TRANSCRIBE_MODEL,
        input: [
          { type: 'text', text: `Transcribe this narration verbatim. The intended transcript is below. Preserve every spoken word and punctuation as heard. TRANSCRIPT: ${script}` },
          { type: 'audio', data: bytes.toString('base64'), mime_type: 'audio/wav' }
        ],
        generation_config: {
          transcription_config: {
            mode: { type: 'verbatim', timestamp_granularities: ['word'] }
          }
        }
      })
    });

    const interaction = await interactionResponse.json().catch(() => ({}));
    if (!interactionResponse.ok) throw new Error(`Gemini transcription ${interactionResponse.status}: ${JSON.stringify(interaction)}`);

    const rawWords = extractWordAnnotations(interaction);
    if (!rawWords.length) throw new Error('Gemini transcription returned no word timestamps');
    const words = alignScript(script, rawWords);
    return json(res, 200, { ok: true, model: TRANSCRIBE_MODEL, words });
  } catch (error) {
    console.error('UNMINDY transcription error:', error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Transcription failed' });
  }
}
