import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://unmindfy-tts.vercel.app';
const SECRET = process.env.UNMINDY_CRON_SECRET;
const WORK = path.resolve('.render-work');
const FOOTAGE = path.join(WORK, 'footage');
const MUSIC = path.join(WORK, 'music');
const OUT = path.join(WORK, 'output.mp4');
if (!SECRET) throw new Error('UNMINDY_CRON_SECRET is missing');

async function api(endpoint, options = {}) {
  const r = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${SECRET}`, ...(options.headers || {}) }
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${endpoint}: ${r.status} ${t}`);
  return d;
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', x => stdout += x);
    p.stderr.on('data', x => stderr += x);
    p.on('error', reject);
    p.on('close', code => code ? reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-18000)}`)) : resolve({ stdout, stderr }));
  });
}

async function duration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(r.stdout.trim());
}

async function probeVideo(file) {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,bit_rate,avg_frame_rate,profile', '-of', 'json', file]);
  const d = JSON.parse(r.stdout);
  return d.streams?.[0] || {};
}

async function driveList(token, q) {
  const out = [];
  let page;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('orderBy', 'modifiedTime desc');
    u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents,videoMediaMetadata)');
    if (page) u.searchParams.set('pageToken', page);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(`Drive list ${r.status}: ${JSON.stringify(d)}`);
    out.push(...(d.files || []));
    page = d.nextPageToken;
  } while (page);
  return out;
}

async function folderDescendants(token, id, maxDepth = 4) {
  const out = [];
  let frontier = [{ id, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const f of frontier) {
      for (const x of await driveList(token, `'${f.id}' in parents and trashed = false`)) {
        out.push(x);
        if (x.mimeType === 'application/vnd.google-apps.folder' && f.depth < maxDepth) next.push({ id: x.id, depth: f.depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

async function ensureFolder(token, name, parentId = null) {
  const p = parentId ? `'${parentId}' in parents and ` : '';
  const safe = name.replaceAll("'", "\\'");
  const found = await driveList(token, `${p}name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (found[0]) return found[0];
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Drive folder create ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

async function downloadDriveFile(token, file, dest) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok || !r.body) throw new Error(`Drive download failed for ${file.name}: ${r.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(r.body, (await import('node:fs')).createWriteStream(dest));
}

async function uploadDriveFile(token, filePath, name, parentId) {
  const size = (await fs.stat(filePath)).size;
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(size)
    },
    body: JSON.stringify({ name, parents: [parentId], mimeType: 'video/mp4' })
  });
  if (!init.ok) throw new Error(`Drive resumable init ${init.status}: ${await init.text()}`);
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Error('Drive resumable upload URL missing');
  const buf = await fs.readFile(filePath);
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}`, 'Content-Type': 'video/mp4' },
    body: buf
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

function cleanScript(s) { return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function wordsOf(s) { return cleanScript(s).split(/\s+/).filter(Boolean).map(w => w.replace(/^[“”"']+|[“”"']+$/g, '').replace(/[\\/]/g, '')); }

const FONT_SIZE = 56;
const MAX_CHARS = 22;
const MAX_LINES = 3;
const TARGET_WORDS = 11;
const MIN_WORDS = 9;
const MAX_WORDS = 12;
const BOX_W = 780;
const SAFE_X = (1080 - BOX_W) / 2;
const TOP_Y = 96;

function layoutWords(words) {
  const lines = [];
  let line = [];
  let n = 0;
  for (const w of words) {
    const need = line.length ? n + 1 + w.length : w.length;
    if (line.length && need > MAX_CHARS) { lines.push(line); line = [w]; n = w.length; }
    else { line.push(w); n = need; }
  }
  if (line.length) lines.push(line);
  return lines;
}

function captionPages(words) {
  const pages = [];
  let page = [];
  let i = 0;
  while (i < words.length) {
    const candidate = [...page, words[i]];
    const wouldOverflow = layoutWords(candidate).length > MAX_LINES;
    const reachedSoftTarget = page.length >= TARGET_WORDS;
    const reachedHardLimit = page.length >= MAX_WORDS;
    const canSplit = page.length >= MIN_WORDS;
    if (page.length && (reachedHardLimit || (canSplit && (reachedSoftTarget || wouldOverflow)))) {
      pages.push(page);
      page = [];
      continue;
    }
    page = candidate;
    i++;
  }
  if (page.length) pages.push(page);
  if (pages.length > 1 && pages.at(-1).length < MIN_WORDS) {
    const tail = pages.pop();
    let prev = pages.pop() || [];
    while (tail.length && prev.length < MAX_WORDS) prev.push(tail.shift());
    if (prev.length) pages.push(prev);
    if (tail.length) pages.push(tail);
  }
  return pages;
}

function justifyLine(words, last) {
  if (last || words.length < 2) return words.join(' ');
  const letters = words.reduce((n, w) => n + w.length, 0);
  const gaps = words.length - 1;
  const spaces = Math.max(gaps, Math.min(MAX_CHARS, letters + gaps + 3) - letters);
  const base = Math.floor(spaces / gaps), extra = spaces % gaps;
  let s = words[0];
  for (let i = 1; i < words.length; i++) s += ' '.repeat(base + (i - 1 < extra ? 1 : 0)) + words[i];
  return s;
}
function captionText(words) { const lines = layoutWords(words); return lines.map((line, i) => justifyLine(line, i === lines.length - 1)).join('\\N'); }
function assEscape(s) { return s.replaceAll('{', '\\{').replaceAll('}', '\\}'); }
function assTime(sec) { const cs = Math.max(0, Math.round(sec * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; }

async function wordTimings(script, audioUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const d = await api('/api/edit/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioUrl, script }) });
      if (!Array.isArray(d.words) || !d.words.length) throw new Error('Transcription returned no timings');
      return d.words.map((w, i) => ({ text: w.text, start: Math.max(0, Number(w.start) || 0), end: Math.max(Number(w.end) || 0, (Number(w.start) || 0) + 0.08), i }));
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await new Promise(r => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

async function makeAssFromTimings(script, timings, out) {
  const words = wordsOf(script);
  if (timings.length !== words.length) throw new Error(`Caption word count mismatch: timings=${timings.length} script=${words.length}`);
  const pages = captionPages(words);
  let cursor = 0;
  const ass = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 644', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding', `Style: Ref,Courier,${FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,3.2,2.4,7,0,0,0,1`, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  for (const page of pages) {
    let shown = [];
    for (const word of page) {
      const timing = timings[cursor];
      const nextTiming = cursor + 1 < timings.length ? timings[cursor + 1] : null;
      shown.push(word);
      const end = nextTiming ? Math.max(timing.end + 0.08, nextTiming.start) : Math.max(timing.end + 0.25, timing.start + 0.4);
      ass.push(`Dialogue: 0,${assTime(timing.start)},${assTime(end)},Ref,,0,0,0,,{\\pos(${Math.round(SAFE_X)},${TOP_Y})}${assEscape(captionText(shown))}`);
      cursor++;
    }
  }
  await fs.writeFile(out, ass.join('\n') + '\n', 'utf8');
  console.log(`Captioned ${pages.length} paragraphs; sizes=${pages.map(p => p.length).join(',')}`);
}

async function buildAmbientMusic(total, out) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=196:sample_rate=44100:duration=${total}`, '-f', 'lavfi', '-i', `sine=frequency=246.94:sample_rate=44100:duration=${total}`, '-filter_complex', '[0:a]volume=0.015[a0];[1:a]volume=0.010[a1];[a0][a1]amix=inputs=2:duration=longest,lowpass=f=850,loudnorm=I=-30:TP=-3:LRA=7[a]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', out]);
}

async function buildAudio(voice, music, total, out) {
  await run('ffmpeg', ['-y', '-i', voice, '-i', music, '-filter_complex', '[0:a]highpass=f=70,loudnorm=I=-10:TP=-1:LRA=7,aresample=44100,volume=1.32,asplit=2[v][sc];[1:a]highpass=f=70,lowpass=f=15000,loudnorm=I=-32:TP=-2:LRA=8,aresample=44100,volume=0.16[m];[m][sc]sidechaincompress=threshold=0.020:ratio=9:attack=8:release=280:makeup=1:mix=1[md];[v][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.90:level=disabled[a]', '-map', '[a]', '-t', String(total), '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', out]);
}

async function renderFinal(footage, ass, audio, total, out) {
  const ap = ass.replaceAll('\\', '/').replaceAll(':', '\\:');
  // Supersample, gently clean compression noise, restore edge definition, then downsample.
  // This does not invent content, but it avoids making an already-compressed source look
  // softer during the 1280->1080 crop and gives the Minecraft edges a cleaner finish.
  const vf = [
    'scale=2160:1288:force_original_aspect_ratio=increase:flags=lanczos',
    'crop=2160:1288:(in_w-2160)/2:(in_h-1288)/2',
    'setsar=1',
    'hqdn3d=0.8:0.8:1.6:1.6',
    'eq=brightness=-0.005:contrast=1.025:saturation=1.01',
    'unsharp=7:7:0.45:7:7:0.0',
    'scale=1080:644:flags=lanczos',
    'format=yuv420p',
    'fps=30',
    `subtitles='${ap}':original_size=1080x644`
  ].join(',');
  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-i', footage, '-i', audio, '-t', String(total),
    '-vf', vf, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '5',
    '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-r', '30', '-fps_mode', 'cfr',
    '-x264-params', 'aq-mode=3:aq-strength=0.75:deblock=-1,-1:ref=5:bframes=8:me=umh:subme=10',
    '-c:a', 'copy', '-movflags', '+faststart', '-tag:v', 'avc1', out
  ]);
}

async function verify(file, expected) {
  const st = await fs.stat(file), d = await duration(file), v = await probeVideo(file);
  if (st.size < 1000000) throw new Error(`Rendered video is suspiciously small: ${st.size}`);
  if (Math.abs(d - expected) > 1) throw new Error(`Final duration mismatch: ${d} vs ${expected}`);
  if (v.width !== 1080 || v.height !== 644) throw new Error(`Unexpected final video size: ${v.width}x${v.height}`);
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,bit_rate,profile,level', '-of', 'json', file]);
  if (!r.stdout.includes('video') || !r.stdout.includes('audio')) throw new Error('Final file missing video/audio');
  console.log(`VERIFIED ${(st.size / 1048576).toFixed(1)}MB ${d.toFixed(2)}s\n${r.stdout}`);
}

function isGeneratedVideo(name) {
  return /(reel-|reference-style|final(?:-|\.|_)?v\d|render(?:ed|ed)?-|export(?:-|_)|instagram|tiktok)/i.test(name);
}

async function main() {
  const { job } = await api('/api/edit/job');
  if (!job) { console.log('No pending edit job.'); return; }
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(FOOTAGE, { recursive: true });
  await fs.mkdir(MUSIC, { recursive: true });
  try {
    const token = (await api('/api/drive/token')).access_token;
    if (!token) throw new Error('Drive token endpoint returned no access token');
    const root = await ensureFolder(token, 'UNMINDY');
    const ff = await ensureFolder(token, 'Footage', root.id);
    const mf = await ensureFolder(token, 'Music', root.id);
    const ef = await ensureFolder(token, 'Exports', root.id);
    const allF = await folderDescendants(token, ff.id);
    const allM = await folderDescendants(token, mf.id);
    const vr = /\.(mp4|mov|mkv|webm|m4v)$/i;
    const ar = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
    const videos = allF
      .filter(f => (vr.test(f.name) || String(f.mimeType || '').startsWith('video/')) && !isGeneratedVideo(f.name))
      .sort((a, b) => {
        const aW = Number(a.videoMediaMetadata?.width) || 0, aH = Number(a.videoMediaMetadata?.height) || 0;
        const bW = Number(b.videoMediaMetadata?.width) || 0, bH = Number(b.videoMediaMetadata?.height) || 0;
        const aPixels = aW * aH, bPixels = bW * bH;
        const aSize = Number(a.size || 0), bSize = Number(b.size || 0);
        return bPixels - aPixels || bSize - aSize || (Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
      });
    const tracks = allM.filter(f => (ar.test(f.name) || String(f.mimeType || '').startsWith('audio/') || vr.test(f.name) || String(f.mimeType || '').startsWith('video/')) && !/(tts|voice|narration|speech|dialogue|mic)/i.test(f.name)).sort((a, b) => Number(b.modifiedTime ? Date.parse(b.modifiedTime) : 0) - Number(a.modifiedTime ? Date.parse(a.modifiedTime) : 0));
    if (!videos.length) throw new Error('No original video footage found in UNMINDY/Footage. Generated renders are intentionally excluded.');
    const footage = videos[0];
    console.log(`ORIGINAL FOOTAGE: ${footage.name} ${footage.videoMediaMetadata?.width || '?'}x${footage.videoMediaMetadata?.height || '?'} ${(Number(footage.size || 0) / 1048576).toFixed(1)}MB`);
    await downloadDriveFile(token, footage, path.join(FOOTAGE, footage.name));
    const sourcePath = path.join(FOOTAGE, footage.name);
    const sourceProbe = await probeVideo(sourcePath);
    console.log(`SOURCE PROBE: ${JSON.stringify(sourceProbe)}`);
    if ((Number(sourceProbe.width) || 0) < 900 || (Number(sourceProbe.height) || 0) < 500) throw new Error(`Source footage is too small/low-resolution: ${sourceProbe.width}x${sourceProbe.height}`);
    const voice = path.join(WORK, 'tts.wav');
    const rr = await fetch(job.tts_audio_url);
    if (!rr.ok || !rr.body) throw new Error(`TTS download failed: ${rr.status}`);
    await pipeline(rr.body, (await import('node:fs')).createWriteStream(voice));
    const total = await duration(voice);
    if (!Number.isFinite(total) || total <= 1) throw new Error(`Invalid TTS duration: ${total}`);
    const music = path.join(MUSIC, 'ambient.m4a');
    if (tracks.length) { const chosen = tracks[0]; console.log(`Music: ${chosen.name}`); await downloadDriveFile(token, chosen, music); }
    else { console.log('No music asset found; generating original ambient bed.'); await buildAmbientMusic(total, music); }
    const timings = await wordTimings(job.script, job.tts_audio_url);
    const ass = path.join(WORK, 'captions.ass'), audio = path.join(WORK, 'audio.m4a'), final = path.join(WORK, 'final.mp4');
    console.log(`Timed ${timings.length} words from Gemini transcription.`);
    await makeAssFromTimings(job.script, timings, ass);
    await buildAudio(voice, music, total, audio);
    await renderFinal(sourcePath, ass, audio, total, final);
    await fs.copyFile(final, OUT);
    await verify(OUT, total);
    const uploaded = await uploadDriveFile(token, OUT, `reel-${job.id}-reference-style-final-v20.mp4`, ef.id);
    const url = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
    await api('/api/edit/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, status: 'Ready', export_drive_file_id: uploaded.id, export_drive_url: url }) });
    console.log(`Exported: ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api('/api/edit/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, status: 'Failed', edit_error: message }) }).catch(() => {});
    throw error;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });