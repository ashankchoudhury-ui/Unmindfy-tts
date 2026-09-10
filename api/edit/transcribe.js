const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
function json(res, status, body) { return res.status(status).json(body); }
function parseSeconds(value) {
  const m = typeof value === 'string' ? value.match(/([0-9.]+)s/) : null;
  return m ? Number(m[1]) : null;
}
function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, '').trim();
}
function extractWordAnnotations(interaction) {
  const out = [];
  for (const step of interaction?.steps || []) for (const content of step?.content || []) for (const a of content?.annotations || []) {
    if (a?.type !== 'word_info') continue;
    const start = parseSeconds(a.start_offset), end = parseSeconds(a.end_offset), text = String(a.text || '').trim();
    if (text && Number.isFinite(start) && Number.isFinite(end) && end >= start) out.push({ text, start, end });
  }
  return out;
}
function alignScript(script, transcriptWords) {
  const target = String(script || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const t = transcriptWords.map(x => ({ ...x, key: normalizeToken(x.text) }));
  const aligned = [];
  let cursor = 0;
  for (const text of target) {
    const wanted = normalizeToken(text);
    let found = -1;
    for (let j = cursor; j < Math.min(t.length, cursor + 7); j += 1) if (t[j].key === wanted) { found = j; break; }
    if (found >= 0) { aligned.push({ text, start: t[found].start, end: t[found].end }); cursor = found + 1; }
    else aligned.push({ text, start: null, end: null });
  }
  const prevReal = i => { for (let j = i - 1; j >= 0; j -= 1) if (Number.isFinite(aligned[j].start)) return j; return -1; };
  const nextReal = i => { for (let j = i + 1; j < aligned.length; j += 1) if (Number.isFinite(aligned[j].start)) return j; return -1; };
  for (let i = 0; i < aligned.length; i += 1) {
    if (Number.isFinite(aligned[i].start)) continue;
    const pi = prevReal(i), ni = nextReal(i);
    if (pi >= 0 && ni >= 0 && aligned[ni].start > aligned[pi].end) {
      const gap = (aligned[ni].start - aligned[pi].end) / (ni - pi);
      aligned[i].start = aligned[pi].end + gap * (i - pi - 0.2);
      aligned[i].end = aligned[pi].end + gap * (i - pi + 0.2);
    } else if (pi >= 0) {
      aligned[i].start = aligned[pi].end;
      aligned[i].end = aligned[pi].end + 0.12;
    } else if (ni >= 0) {
      aligned[i].end = aligned[ni].start;
      aligned[i].start = Math.max(0, aligned[ni].start - 0.12);
    }
  }
  const matched = aligned.filter(x => Number.isFinite(x.start)).length;
  if (matched < Math.max(1, Math.floor(target.length * 0.85))) throw new Error(`Transcription alignment too weak: ${matched}/${target.length} words matched`);
  return aligned;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (req.headers.authorization !== `Bearer ${env('UNMINDY_CRON_SECRET')}`) return json(res, 401, { ok: false, error: 'Unauthorized' });
  try {
    const audioUrl = req.body?.audioUrl, script = req.body?.script;
    if (!audioUrl || !script) return json(res, 400, { ok: false, error: 'audioUrl and script are required' });
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) throw new Error(`Audio download failed: ${audioResponse.status}`);
    const bytes = Buffer.from(await audioResponse.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw new Error(`Audio too large for inline transcription: ${bytes.length}`);
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({
        model: TRANSCRIBE_MODEL,
        input: [
          { type: 'text', text: `Transcribe the narration verbatim with word-level timestamps. The intended transcript is exactly: ${script}` },
          { type: 'audio', data: bytes.toString('base64'), mime_type: 'audio/wav' }
        ],
        generation_config: { transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } } }
      })
    });
    const interaction = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gemini transcription ${response.status}: ${JSON.stringify(interaction)}`);
    const raw = extractWordAnnotations(interaction);
    if (!raw.length) throw new Error('Gemini transcription returned no word timestamps');
    return json(res, 200, { ok: true, model: TRANSCRIBE_MODEL, words: alignScript(script, raw) });
  } catch (error) {
    console.error('UNMINDY transcription error:', error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Transcription failed' });
  }
}
