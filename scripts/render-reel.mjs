import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://unmindfy-tts.vercel.app';
const SECRET = process.env.UNMINDY_CRON_SECRET;
const WORK = path.resolve('.render-work');
const FOOTAGE = path.join(WORK, 'footage');
const MUSIC = path.join(WORK, 'music');
const OUT = path.join(WORK, 'output.mp4');
const FOOTAGE_EXT = /\.(mp4|mov|mkv|webm|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const GENERATED_RE = /(reel-|reference-style|final(?:-|\.|_)?v\d|render(?:ed)?-|export(?:-|_)|instagram|tiktok)/i;

if (!SECRET) throw new Error('UNMINDY_CRON_SECRET is missing');

async function api(endpoint, options = {}) {
  const r = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${SECRET}`, ...(options.headers || {}) }
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`${endpoint}: ${r.status} ${text}`);
  return data;
}

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', x => { stdout += x; });
    p.stderr.on('data', x => { stderr += x; });
    p.on('error', reject);
    p.on('close', code => {
      if (code) reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-20000)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function duration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(r.stdout.trim());
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

async function probeVideo(file) {
  const data = await probe(file);
  return data.streams?.find(s => s.codec_type === 'video') || {};
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
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Drive list returned invalid JSON: ${text}`); }
    if (!r.ok) throw new Error(`Drive list ${r.status}: ${text}`);
    out.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function folderDescendants(token, id, maxDepth = 4) {
  const out = [];
  let frontier = [{ id, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const f of frontier) {
      const children = await driveList(token, `'${f.id}' in parents and trashed = false`);
      for (const x of children) {
        out.push(x);
        if (x.mimeType === 'application/vnd.google-apps.folder' && f.depth < maxDepth) next.push({ id: x.id, depth: f.depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

async function ensureFolder(token, name, parentId = null) {
  const escaped = name.replaceAll("'", "\\'");
  const prefix = parentId ? `'${parentId}' in parents and ` : '';
  const found = await driveList(token, `${prefix}name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (found[0]) return found[0];
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) })
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Drive folder create returned invalid JSON: ${text}`); }
  if (!r.ok) throw new Error(`Drive folder create ${r.status}: ${text}`);
  return data;
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
      if (bytesRead !== length) throw new Error(`Drive upload read truncated at ${offset}: ${bytesRead}/${length}`);

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
        await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
      if (!response || (!response.ok && response.status !== 308)) throw lastError || new Error('Drive chunk upload failed');

      if (response.status === 308) {
        const range = response.headers.get('range');
        const match = range?.match(/bytes=0-(\d+)/i);
        offset = match ? Number(match[1]) + 1 : offset + length;
      } else {
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Drive final upload returned invalid JSON: ${text}`); }
        if (!data.id) throw new Error(`Drive upload returned no file id: ${JSON.stringify(data)}`);
        return data;
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
  return cleanScript(s).split(/\s+/).filter(Boolean).map(w =>
    w.replace(/^[“”"']+|[“”"']+$/g, '').replace(/[\\/]/g, '')
  );
}

function layoutWords(words) {
  const MAX_CHARS = 22;
  const lines = [];
  let line = [];
  let length = 0;
  for (const word of words) {
    const need = line.length ? length + 1 + word.length : word.length;
    if (line.length && need > MAX_CHARS) {
      lines.push(line);
      line = [word];
      length = word.length;
    } else {
      line.push(word);
      length = need;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function captionPages(words) {
  const MAX_LINES = 3, TARGET_WORDS = 11, MIN_WORDS = 9, MAX_WORDS = 12;
  const pages = [];
  let page = [];
  let i = 0;
  while (i < words.length) {
    const candidate = [...page, words[i]];
    const overflow = layoutWords(candidate).length > MAX_LINES;
    if (page.length && (page.length >= MAX_WORDS || (page.length >= MIN_WORDS && (page.length >= TARGET_WORDS || overflow)))) {
      pages.push(page);
      page = [];
      continue;
    }
    page = candidate;
    i += 1;
  }
  if (page.length) pages.push(page);
  if (pages.length > 1 && pages.at(-1).length < MIN_WORDS) {
    const tail = pages.pop();
    const prev = pages.pop() || [];
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
  const spaces = Math.max(gaps, Math.min(22, letters + gaps + 3) - letters);
  const base = Math.floor(spaces / gaps), extra = spaces % gaps;
  let out = words[0];
  for (let i = 1; i < words.length; i += 1) out += ' '.repeat(base + (i - 1 < extra ? 1 : 0)) + words[i];
  return out;
}

function captionText(words) {
  return layoutWords(words).map((line, i, all) => justifyLine(line, i === all.length - 1)).join('\\N');
}

function assEscape(s) {
  return s.replaceAll('{', '\\{').replaceAll('}', '\\}');
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

async function wordTimings(script, audioUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const d = await api('/api/edit/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl, script })
      });
      if (!Array.isArray(d.words) || !d.words.length) throw new Error('Transcription returned no timings');
      const words = wordsOf(script);
      if (d.words.length !== words.length) throw new Error(`Transcription word count mismatch: timings=${d.words.length} script=${words.length}`);
      return d.words.map((w, i) => {
        const start = Math.max(0, Number(w.start) || 0);
        const end = Math.max(Number(w.end) || 0, start + 0.08);
        return { text: words[i], start, end, i };
      });
    } catch (error) {
      lastErr = error;
      if (attempt >= 2 || !/429|quota|too_many_requests/i.test(String(error?.message || error))) break;
      await new Promise(resolve => setTimeout(resolve, 8000));
    }
  }
  throw lastErr;
}

async function makeAssFromTimings(script, timings, out) {
  const words = wordsOf(script);
  if (timings.length !== words.length) throw new Error(`Caption word count mismatch: timings=${timings.length} script=${words.length}`);
  const pages = captionPages(words);
  const FONT_SIZE = 56, BOX_W = 780, SAFE_X = (1080 - BOX_W) / 2, TOP_Y = 96;
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 644', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Ref,Courier,${FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,3.2,2.4,7,0,0,0,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  let cursor = 0;
  for (const page of pages) {
    const shown = [];
    for (const word of page) {
      const timing = timings[cursor];
      const next = cursor + 1 < timings.length ? timings[cursor + 1] : null;
      shown.push(word);
      const end = next ? Math.max(timing.end + 0.08, next.start) : Math.max(timing.end + 0.25, timing.start + 0.4);
      ass.push(`Dialogue: 0,${assTime(timing.start)},${assTime(end)},Ref,,0,0,0,,{\\pos(${Math.round(SAFE_X)},${TOP_Y})}${assEscape(captionText(shown))}`);
      cursor += 1;
    }
  }
  await fs.writeFile(out, ass.join('\n') + '\n', 'utf8');
}

async function buildAmbientMusic(total, out) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=196:sample_rate=44100:duration=${total}`, '-f', 'lavfi', '-i', `sine=frequency=246.94:sample_rate=44100:duration=${total}`, '-filter_complex', '[0:a]volume=0.015[a0];[1:a]volume=0.010[a1];[a0][a1]amix=inputs=2:duration=longest,lowpass=f=850,loudnorm=I=-30:TP=-3:LRA=7[a]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', out]);
}

async function buildAudio(voice, music, total, out) {
  await run('ffmpeg', ['-y', '-i', voice, '-i', music, '-filter_complex', '[0:a]highpass=f=70,loudnorm=I=-10:TP=-1:LRA=7,aresample=44100,volume=1.32,asplit=2[v][sc];[1:a]highpass=f=70,lowpass=f=15000,loudnorm=I=-32:TP=-2:LRA=8,aresample=44100,volume=0.16[m];[m][sc]sidechaincompress=threshold=0.020:ratio=9:attack=8:release=280:makeup=1:mix=1[md];[v][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.90:level=disabled[a]', '-map', '[a]', '-t', String(total), '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2', out]);
}

async function renderFinal(footage, ass, audio, total, out) {
  const assPath = ass.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
  const source = await probeVideo(footage);
  const sw = Number(source.width) || 0, sh = Number(source.height) || 0;
  if (sw < 1080 || sh < 644) throw new Error(`Source footage is below final resolution: ${sw}x${sh}`);
  const resize = sw === 1080 && sh === 644
    ? 'setsar=1,format=yuv420p'
    : 'scale=1080:644:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:644:(in_w-1080)/2:(in_h-644)/2,setsar=1,format=yuv420p';
  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-i', footage, '-i', audio, '-t', String(total),
    '-vf', `${resize},subtitles='${assPath}':original_size=1080x644`, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '12', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-r', '30', '-fps_mode', 'cfr', '-x264-params', 'aq-mode=3:aq-strength=0.85:deblock=-1,-1:ref=5:bframes=6:me=umh:subme=10',
    '-maxrate', '16M', '-bufsize', '24M', '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-tag:v', 'avc1', out
  ]);
}

async function verify(file, expected) {
  const st = await fs.stat(file);
  if (st.size < 1_000_000) throw new Error(`Rendered video is suspiciously small: ${st.size} bytes`);
  const data = await probe(file);
  const video = data.streams?.find(s => s.codec_type === 'video');
  const audio = data.streams?.find(s => s.codec_type === 'audio');
  const d = Number(data.format?.duration || 0);
  if (!video || !audio) throw new Error('Final file is missing video or audio');
  if (Math.abs(d - expected) > 1) throw new Error(`Final duration mismatch: ${d} vs ${expected}`);
  if (Number(video.width) !== 1080 || Number(video.height) !== 644) throw new Error(`Unexpected final video size: ${video.width}x${video.height}`);
  if (video.pix_fmt !== 'yuv420p') throw new Error(`Unexpected pixel format: ${video.pix_fmt}`);
  if (!/^30\/1$/.test(String(video.avg_frame_rate || video.r_frame_rate))) throw new Error(`Unexpected frame rate: ${video.avg_frame_rate || video.r_frame_rate}`);
  if (Number(video.level || 0) > 40) throw new Error(`Unexpected H.264 level: ${video.level}`);
  if (String(video.codec_name) !== 'h264') throw new Error(`Unexpected video codec: ${video.codec_name}`);
  if (String(audio.codec_name) !== 'aac') throw new Error(`Unexpected audio codec: ${audio.codec_name}`);
  if (Number(audio.sample_rate) !== 44100 || Number(audio.channels) !== 2) throw new Error('Unexpected final audio format');
  if (Number(video.bit_rate || 0) < 5_000_000) throw new Error(`Final video bitrate is too low: ${video.bit_rate}`);

  // Decode the entire file. This catches corrupt/truncated containers that ffprobe alone can still inspect.
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  return { size: st.size, duration: d, video, audio };
}

function isGeneratedVideo(name) {
  return GENERATED_RE.test(name);
}

function sortVideoQuality(a, b) {
  const aW = Number(a.videoMediaMetadata?.width) || 0, aH = Number(a.videoMediaMetadata?.height) || 0;
  const bW = Number(b.videoMediaMetadata?.width) || 0, bH = Number(b.videoMediaMetadata?.height) || 0;
  return (bW * bH) - (aW * aH) || Number(b.size || 0) - Number(a.size || 0) || (Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
}

async function chooseAsset(allFiles, fileId, kind) {
  if (fileId) {
    const exact = allFiles.find(f => f.id === fileId);
    if (!exact) throw new Error(`Configured ${kind} file ID not found in the selected Drive folder: ${fileId}`);
    return exact;
  }
  return null;
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
    const footageFolder = await ensureFolder(token, 'Footage', root.id);
    const musicFolder = await ensureFolder(token, 'Music', root.id);
    const exportFolder = await ensureFolder(token, 'Exports', root.id);
    const footageFiles = await folderDescendants(token, footageFolder.id);
    const musicFiles = await folderDescendants(token, musicFolder.id);

    const eligibleVideos = footageFiles
      .filter(f => (FOOTAGE_EXT.test(f.name) || String(f.mimeType || '').startsWith('video/')) && !isGeneratedVideo(f.name))
      .sort(sortVideoQuality);
    const eligibleMusic = musicFiles
      .filter(f => (AUDIO_EXT.test(f.name) || String(f.mimeType || '').startsWith('audio/')) && !/(tts|voice|narration|speech|dialogue|mic)/i.test(f.name))
      .sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));

    const configuredFootage = await chooseAsset(footageFiles, job.render_footage_file_id, 'footage');
    const configuredMusic = await chooseAsset(musicFiles, job.render_music_file_id, 'music');
    const footage = configuredFootage || eligibleVideos[0];
    if (!footage) throw new Error('No original video footage found in UNMINDY/Footage. Add footage or set render_footage_file_id.');
    const music = configuredMusic || eligibleMusic[0] || null;

    console.log(`FOOTAGE: ${footage.name} (${footage.id})`);
    await downloadDriveFile(token, footage, path.join(FOOTAGE, footage.name));
    const sourcePath = path.join(FOOTAGE, footage.name);
    const sourceProbe = await probeVideo(sourcePath);
    if ((Number(sourceProbe.width) || 0) < 1080 || (Number(sourceProbe.height) || 0) < 644) throw new Error(`Source footage is below 1080x644: ${sourceProbe.width}x${sourceProbe.height}`);

    const voice = path.join(WORK, 'tts.wav');
    const rr = await fetch(job.tts_audio_url);
    if (!rr.ok || !rr.body) throw new Error(`TTS download failed: ${rr.status}`);
    await pipeline(rr.body, fsSync.createWriteStream(voice));
    const total = await duration(voice);
    if (!Number.isFinite(total) || total <= 1 || total > 900) throw new Error(`Invalid TTS duration: ${total}`);

    const musicPath = path.join(MUSIC, 'music.m4a');
    if (music) {
      console.log(`MUSIC: ${music.name} (${music.id})`);
      await downloadDriveFile(token, music, musicPath);
    } else {
      console.log('MUSIC: generated ambient bed');
      await buildAmbientMusic(total, musicPath);
    }

    const timings = await wordTimings(job.script, job.tts_audio_url);
    const ass = path.join(WORK, 'captions.ass');
    const audio = path.join(WORK, 'audio.m4a');
    const final = path.join(WORK, 'final.mp4');
    await makeAssFromTimings(job.script, timings, ass);
    await buildAudio(voice, musicPath, total, audio);
    await renderFinal(sourcePath, ass, audio, total, final);
    await fs.copyFile(final, OUT);

    const verified = await verify(OUT, total);
    console.log(`VERIFIED: ${(verified.size / 1048576).toFixed(2)} MB, ${verified.duration.toFixed(2)} s, ${verified.video.width}x${verified.video.height}, ${verified.video.avg_frame_rate}`);

    const filename = `reel-${job.id}-reference-style-final.mp4`;
    const uploaded = await uploadDriveFile(token, OUT, filename, exportFolder.id);
    const url = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

    // The completion endpoint only accepts the claim while it is still Editing.
    // This prevents stale/duplicate workers from publishing a late result over a newer state.
    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, status: 'Ready', export_drive_file_id: uploaded.id, export_drive_url: url })
    });
    console.log(`Exported: ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, status: 'Failed', edit_error: message })
    }).catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
