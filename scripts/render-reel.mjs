import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://unmindfy-tts.vercel.app';
const SECRET = process.env.UNMINDY_CRON_SECRET;
const WORK = path.resolve('.render-work');
const OUT = path.join(WORK, 'output.mp4');
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const TARGET_ASPECT = OUTPUT_WIDTH / OUTPUT_HEIGHT;
const FOOTAGE_EXT = /\.(mp4|mov|mkv|webm|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const GENERATED_RE = /(reel-|reference-style|final(?:-|\.|_)?v\d|render(?:ed)?-|export(?:-|_)|instagram|tiktok)/i;

if (!SECRET) throw new Error('UNMINDY_CRON_SECRET is missing');

async function api(endpoint, options = {}) {
  const r = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      ...(options.headers || {})
    }
  });
  const t = await r.text();
  let d;
  try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${endpoint}: ${r.status} ${t}`);
  return d;
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', x => o += x);
    p.stderr.on('data', x => e += x);
    p.on('error', reject);
    p.on('close', c => c
      ? reject(new Error(`${cmd} exited ${c}\n${e.slice(-20000)}`))
      : resolve({ stdout: o, stderr: e }));
  });
}

async function probe(file) {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height,pix_fmt,bit_rate,avg_frame_rate,r_frame_rate,profile,level,sample_rate,channels,channel_layout',
    '-of', 'json', file
  ]);
  return JSON.parse(r.stdout);
}

async function driveList(token, q) {
  const out = [];
  let pageToken;
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('orderBy', 'modifiedTime desc');
    u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents,videoMediaMetadata)');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const t = await r.text();
    if (!r.ok) throw new Error(`Drive list ${r.status}: ${t}`);
    const d = JSON.parse(t);
    out.push(...(d.files || []));
    pageToken = d.nextPageToken;
  } while (pageToken);
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
        if (x.mimeType === 'application/vnd.google-apps.folder' && f.depth < maxDepth) {
          next.push({ id: x.id, depth: f.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return out;
}

async function ensureFolder(token, name, parentId = null) {
  const esc = name.replaceAll("'", "\\'");
  const prefix = parentId ? `'${parentId}' in parents and ` : '';
  const found = await driveList(token, `${prefix}name = '${esc}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (found[0]) return found[0];
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    })
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Drive folder create ${r.status}: ${t}`);
  return JSON.parse(t);
}

async function downloadDriveFile(token, file, dest) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok || !r.body) throw new Error(`Drive download failed for ${file.name}: ${r.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(r.body, fsSync.createWriteStream(dest));
}

async function uploadDriveFile(token, filePath, name, parentId) {
  const size = (await fs.stat(filePath)).size;
  if (!size) throw new Error('Refusing to upload an empty output file');

  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size,mimeType', {
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

  const CHUNK = 8 * 1024 * 1024;
  const handle = await fs.open(filePath, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error(`Drive upload read truncated at ${offset}`);

      let response = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(length),
              'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
              'Content-Type': 'video/mp4'
            },
            body: buffer
          });
          if (response.ok || response.status === 308) break;
          lastError = new Error(`Drive chunk ${response.status}: ${await response.text()}`);
        } catch (e) {
          lastError = e;
        }
        await new Promise(r => setTimeout(r, attempt * 1500));
      }

      if (!response || (!response.ok && response.status !== 308)) {
        throw lastError || new Error('Drive chunk upload failed');
      }

      if (response.status === 308) {
        const m = response.headers.get('range')?.match(/bytes=0-(\d+)/i);
        offset = m ? Number(m[1]) + 1 : offset + length;
      } else {
        const t = await response.text();
        const d = t ? JSON.parse(t) : {};
        if (!d.id) throw new Error(`Drive upload returned no file id: ${t}`);
        return d;
      }
    }
  } finally {
    await handle.close();
  }
  throw new Error('Drive upload ended without a final response');
}

function cleanScript(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordsOf(s) {
  return cleanScript(s)
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.replace(/^[“”"']+|[“”"']+$/g, '').replace(/[\\/]/g, ''));
}

function layoutWords(words) {
  const MAX = 22;
  const lines = [];
  let line = [], n = 0;
  for (const w of words) {
    const need = line.length ? n + 1 + w.length : w.length;
    if (line.length && need > MAX) {
      lines.push(line);
      line = [w];
      n = w.length;
    } else {
      line.push(w);
      n = need;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function captionPages(words) {
  const MAX_LINES = 3, TARGET = 11, MIN = 9, MAX = 12;
  const pages = [];
  let page = [], i = 0;
  while (i < words.length) {
    const candidate = [...page, words[i]];
    const overflow = layoutWords(candidate).length > MAX_LINES;
    if (page.length && (page.length >= MAX || (page.length >= MIN && (page.length >= TARGET || overflow)))) {
      pages.push(page);
      page = [];
      continue;
    }
    page = candidate;
    i++;
  }
  if (page.length) pages.push(page);

  if (pages.length > 1 && pages.at(-1).length < MIN) {
    const tail = pages.pop();
    const prev = pages.pop() || [];
    while (tail.length && prev.length < MAX) prev.push(tail.shift());
    if (prev.length) pages.push(prev);
    if (tail.length) pages.push(tail);
  }
  return pages;
}

function assEscape(s) {
  return s.replaceAll('{', '\\{').replaceAll('}', '\\}');
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function validateTimings(timings, script) {
  const words = wordsOf(script);
  if (timings.length !== words.length) {
    throw new Error(`Caption word count mismatch: timings=${timings.length} script=${words.length}`);
  }
  let prev = -1;
  for (let i = 0; i < timings.length; i++) {
    const s = Number(timings[i].start), e = Number(timings[i].end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      throw new Error(`Invalid word timing at ${i + 1}: ${JSON.stringify(timings[i])}`);
    }
    if (i > 0 && s <= prev) {
      throw new Error(`Non-increasing real word timing at ${i + 1}: ${s} <= ${prev}`);
    }
    prev = s;
  }
  return timings;
}

async function wordTimings(script, audioUrl) {
  const d = await api('/api/edit/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioUrl, script })
  });
  if (!Array.isArray(d.words) || !d.words.length) throw new Error('Transcription returned no timings');
  const words = wordsOf(script);
  return validateTimings(
    d.words.map((w, i) => ({ text: words[i], start: Number(w.start), end: Number(w.end), i })),
    script
  );
}

function revealCaption(page, startIndex, timings, eventStart) {
  let idx = startIndex;
  const out = [];
  for (const line of layoutWords(page)) {
    const parts = [];
    for (const word of line) {
      const t = timings[idx];
      const relStart = Math.max(0, Math.round((t.start - eventStart) * 1000));
      const relEnd = Math.max(relStart + 35, Math.round((Math.min(t.end, t.start + 0.12) - eventStart) * 1000));
      parts.push(`{\\alpha&HFF&\\t(${relStart},${relEnd},\\alpha&H00&)}` + assEscape(word));
      idx++;
    }
    out.push(parts.join(' '));
  }
  return { text: out.join('\\N'), nextIndex: idx };
}

async function makeAss(script, timings, out) {
  validateTimings(timings, script);
  const words = wordsOf(script);
  const pages = captionPages(words);
  const FONT = 56;
  const BOX_W = 780;
  const SAFE_X = (OUTPUT_WIDTH - BOX_W) / 2;
  const CAPTION_Y = 96;

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${OUTPUT_WIDTH}`,
    `PlayResY: ${OUTPUT_HEIGHT}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Ref,Courier,${FONT},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,3.2,2.4,7,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  let cursor = 0;
  for (const page of pages) {
    const first = timings[cursor];
    const last = timings[cursor + page.length - 1];
    if (!first || !last) throw new Error('Caption page timing lookup failed');
    const eventStart = first.start;
    const eventEnd = Math.max(last.end + 0.28, eventStart + 0.45);
    const revealed = revealCaption(page, cursor, timings, eventStart);
    ass.push(`Dialogue: 0,${assTime(eventStart)},${assTime(eventEnd)},Ref,,0,0,0,,{\\pos(${Math.round(SAFE_X)},${CAPTION_Y})}${revealed.text}`);
    cursor = revealed.nextIndex;
  }

  await fs.writeFile(out, ass.join('\n') + '\n', 'utf8');
}

async function buildAmbient(total, out) {
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `sine=frequency=196:sample_rate=44100:duration=${total}`,
    '-f', 'lavfi', '-i', `sine=frequency=246.94:sample_rate=44100:duration=${total}`,
    '-filter_complex', '[0:a]volume=0.015[a0];[1:a]volume=0.010[a1];[a0][a1]amix=inputs=2:duration=longest,lowpass=f=850,loudnorm=I=-30:TP=-3:LRA=7[a]',
    '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', out
  ]);
}

async function buildAudio(voice, music, total, out) {
  await run('ffmpeg', [
    '-y', '-i', voice, '-i', music,
    '-filter_complex', '[0:a]highpass=f=70,loudnorm=I=-10:TP=-1:LRA=7,aresample=44100,volume=1.32,asplit=2[v][sc];[1:a]highpass=f=70,lowpass=f=15000,loudnorm=I=-32:TP=-2:LRA=8,aresample=44100,volume=0.16[m];[m][sc]sidechaincompress=threshold=0.020:ratio=9:attack=8:release=280:makeup=1:mix=1[md];[v][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.90:level=disabled[a]',
    '-map', '[a]', '-t', String(total), '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2', out
  ]);
}

function parseRate(value) {
  const m = String(value || '').match(/^(\d+)\/(\d+)$/);
  if (!m || Number(m[2]) === 0) return 0;
  return Number(m[1]) / Number(m[2]);
}

function sourceRank(file) {
  const w = Number(file.videoMediaMetadata?.width) || 0;
  const h = Number(file.videoMediaMetadata?.height) || 0;
  if (!w || !h) return -1;
  if (w < OUTPUT_WIDTH || h < OUTPUT_HEIGHT) return -1e15;
  const aspectPenalty = Math.abs(Math.log((w / h) / TARGET_ASPECT));
  return -aspectPenalty * 1e12 + w * h;
}

async function renderFinal(footage, ass, audio, total, out) {
  const src = (await probe(footage)).streams?.find(s => s.codec_type === 'video') || {};
  const sw = Number(src.width) || 0;
  const sh = Number(src.height) || 0;
  const sourceFps = parseRate(src.avg_frame_rate) || parseRate(src.r_frame_rate);

  if (sw < OUTPUT_WIDTH || sh < OUTPUT_HEIGHT) {
    throw new Error(`Source footage is below required ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT} vertical resolution: ${sw}x${sh}`);
  }

  if (!sourceFps || sourceFps < 1 || sourceFps > 120) {
    throw new Error(`Source footage has an invalid frame rate: ${src.avg_frame_rate || src.r_frame_rate || 'unknown'}`);
  }

  const resize = sw === OUTPUT_WIDTH && sh === OUTPUT_HEIGHT
    ? 'setsar=1,format=yuv420p'
    : `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(in_w-${OUTPUT_WIDTH})/2:(in_h-${OUTPUT_HEIGHT})/2,setsar=1,format=yuv420p`;

  const assPath = ass.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");

  console.log(`Rendering ${sw}x${sh} -> ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}; source FPS ${sourceFps.toFixed(3)}; no artificial bitrate ceiling`);

  await run('ffmpeg', [
    '-y',
    '-stream_loop', '-1', '-i', footage,
    '-i', audio,
    '-t', String(total),
    '-vf', `${resize},subtitles='${assPath}':original_size=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryslow',
    '-crf', '10',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-fps_mode', 'passthrough',
    '-x264-params', 'aq-mode=3:aq-strength=0.85:deblock=-1,-1:ref=5:bframes=6:me=umh:subme=10',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-tag:v', 'avc1',
    out
  ]);
}

async function verify(file, expected, sourceFps) {
  const st = await fs.stat(file);
  if (st.size < 1e6) throw new Error(`Rendered video is suspiciously small: ${st.size}`);

  const d = await probe(file);
  const v = d.streams?.find(s => s.codec_type === 'video');
  const a = d.streams?.find(s => s.codec_type === 'audio');
  if (!v || !a) throw new Error('Final file is missing video or audio');

  const actualDuration = Number(d.format?.duration || 0);
  if (Math.abs(actualDuration - expected) > 1) throw new Error(`Final duration mismatch: ${actualDuration} vs ${expected}`);

  if (Number(v.width) !== OUTPUT_WIDTH || Number(v.height) !== OUTPUT_HEIGHT) {
    throw new Error(`Unexpected final video size: ${v.width}x${v.height}; expected ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`);
  }

  if (Math.abs((Number(v.width) / Number(v.height)) - TARGET_ASPECT) > 0.0001) {
    throw new Error(`Unexpected final aspect ratio: ${v.width}x${v.height}`);
  }

  if (v.pix_fmt !== 'yuv420p' || String(v.codec_name) !== 'h264') {
    throw new Error(`Unexpected final video format: ${v.codec_name}/${v.pix_fmt}`);
  }

  const actualFps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (!actualFps || Math.abs(actualFps - sourceFps) > 0.05) {
    throw new Error(`Frame rate changed unexpectedly: source=${sourceFps} final=${v.avg_frame_rate || v.r_frame_rate}`);
  }

  if (String(a.codec_name) !== 'aac' || Number(a.sample_rate) !== 44100 || Number(a.channels) !== 2) {
    throw new Error('Unexpected final audio format');
  }

  const bitrate = Number(v.bit_rate || 0);
  if (bitrate && bitrate < 5e6) {
    throw new Error(`Final video bitrate is too low for a high-quality Reel: ${bitrate}`);
  }

  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  return { size: st.size, duration: actualDuration, video: v, audio: a };
}

function isGenerated(name) {
  return GENERATED_RE.test(String(name || ''));
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });

  const jobResponse = await api('/api/edit/job');
  const job = jobResponse?.job;
  if (!job) {
    console.log('No editable job is currently queued.');
    return;
  }

  console.log(`Rendering job ${job.id} (${job.reel || 'untitled'})`);

  try {
    const tokenResponse = await api('/api/drive/token');
    const token = tokenResponse?.access_token;
    if (!token) throw new Error('Drive token endpoint returned no access token');

    const root = await ensureFolder(token, 'UNMINDY');
    const footageFolder = await ensureFolder(token, 'Footage', root.id);
    const musicFolder = await ensureFolder(token, 'Music', root.id);
    const exportsFolder = await ensureFolder(token, 'Exports', root.id);

    const footageFiles = (await folderDescendants(token, footageFolder.id))
      .filter(f => (FOOTAGE_EXT.test(f.name) || String(f.mimeType || '').startsWith('video/')) && !isGenerated(f.name));
    const musicFiles = (await folderDescendants(token, musicFolder.id))
      .filter(f => (AUDIO_EXT.test(f.name) || String(f.mimeType || '').startsWith('audio/')) && !isGenerated(f.name));

    let footage = null;
    if (job.render_footage_file_id) {
      footage = footageFiles.find(f => f.id === job.render_footage_file_id);
      if (!footage) throw new Error(`Configured footage file ${job.render_footage_file_id} was not found in UNMINDY/Footage`);
    } else {
      footage = [...footageFiles].sort((a, b) => sourceRank(b) - sourceRank(a) || Number(b.size || 0) - Number(a.size || 0) || Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0))[0];
    }

    if (!footage) throw new Error('No eligible footage found in UNMINDY/Footage');

    let music = null;
    if (job.render_music_file_id) {
      music = musicFiles.find(f => f.id === job.render_music_file_id);
      if (!music) throw new Error(`Configured music file ${job.render_music_file_id} was not found in UNMINDY/Music`);
    } else {
      music = musicFiles[0] || null;
    }

    const footagePath = path.join(WORK, `footage${path.extname(footage.name).toLowerCase() || '.mp4'}`);
    const musicPath = path.join(WORK, `music${path.extname(music?.name || '').toLowerCase() || '.m4a'}`);
    const voicePath = path.join(WORK, 'voice.wav');
    const audioPath = path.join(WORK, 'mix.m4a');
    const assPath = path.join(WORK, 'captions.ass');

    console.log(`Selected footage: ${footage.name} (${footage.videoMediaMetadata?.width || '?'}x${footage.videoMediaMetadata?.height || '?'})`);
    await downloadDriveFile(token, footage, footagePath);

    const voiceUrl = job.tts_audio_url;
    if (!voiceUrl) throw new Error('Job has no TTS audio URL');
    const voiceResponse = await fetch(voiceUrl);
    if (!voiceResponse.ok || !voiceResponse.body) throw new Error(`TTS audio download failed: ${voiceResponse.status}`);
    await pipeline(voiceResponse.body, fsSync.createWriteStream(voicePath));

    const voiceDurationProbe = await probe(voicePath);
    const total = Number(voiceDurationProbe.format?.duration || 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error('TTS audio has invalid duration');

    const timings = await wordTimings(job.script, voiceUrl);
    await makeAss(job.script, timings, assPath);

    if (music) {
      await downloadDriveFile(token, music, musicPath);
      await buildAudio(voicePath, musicPath, total, audioPath);
    } else {
      await buildAmbient(total, audioPath);
    }

    const sourceProbe = await probe(footagePath);
    const sourceVideo = sourceProbe.streams?.find(s => s.codec_type === 'video') || {};
    const sourceFps = parseRate(sourceVideo.avg_frame_rate) || parseRate(sourceVideo.r_frame_rate);
    if (Number(sourceVideo.width) < OUTPUT_WIDTH || Number(sourceVideo.height) < OUTPUT_HEIGHT) {
      throw new Error(`Selected footage ${footage.name} is ${sourceVideo.width}x${sourceVideo.height}; a true 1080x1920 Reel requires at least 1080x1920 source footage. No upscaling will be used.`);
    }

    await renderFinal(footagePath, assPath, audioPath, total, OUT);
    const result = await verify(OUT, total, sourceFps);

    console.log(`Verified output: ${result.video.width}x${result.video.height}, ${result.video.codec_name}, ${result.video.pix_fmt}, ${result.video.avg_frame_rate}, ${Math.round(result.size / 1024 / 1024)} MiB`);

    const uploaded = await uploadDriveFile(
      token,
      OUT,
      `reel-${job.id}-reference-style-final.mp4`,
      exportsFolder.id
    );

    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: job.id,
        status: 'Ready',
        export_drive_file_id: uploaded.id,
        export_drive_url: uploaded.webViewLink || null
      })
    });

    console.log(`Export complete: ${uploaded.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Render failed for ${job.id}: ${message}`);
    try {
      await api('/api/edit/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, status: 'Failed', edit_error: message })
      });
    } catch (completeError) {
      console.error(`Failed to report render error: ${completeError instanceof Error ? completeError.message : String(completeError)}`);
    }
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
