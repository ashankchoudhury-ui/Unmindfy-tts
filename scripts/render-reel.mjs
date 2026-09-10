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
  const response = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${SECRET}`, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${text}`);
  return data;
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}\n${stderr.slice(-16000)}`)));
  });
}

async function duration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return Number.parseFloat(r.stdout.trim());
}

async function streamTypes(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  return r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function driveList(token, q) {
  const files = [];
  let pageToken = null;
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents,shortcutDetails)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(`Drive list ${response.status}: ${JSON.stringify(data)}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function folderDescendants(token, folderId, maxDepth = 4) {
  const out = [];
  let frontier = [{ id: folderId, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const folder of frontier) {
      const children = await driveList(token, `'${folder.id}' in parents and trashed = false`);
      for (const child of children) {
        out.push(child);
        if (child.mimeType === 'application/vnd.google-apps.folder' && folder.depth < maxDepth) {
          next.push({ id: child.id, depth: folder.depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return out;
}

async function ensureFolder(token, name, parentId = null) {
  const parent = parentId ? `'${parentId}' in parents and ` : '';
  const safe = name.replaceAll("'", "\\'");
  const found = await driveList(token, `${parent}name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  if (found[0]) return found[0];
  const response = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Drive folder create ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function downloadDriveFile(token, file, destination) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok || !response.body) throw new Error(`Drive download failed for ${file.name}: ${response.status}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(response.body, (await import('node:fs')).createWriteStream(destination));
}

async function uploadDriveFile(token, filePath, name, parentId) {
  const fileBuffer = await fs.readFile(filePath);
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType: 'video/mp4' });
  const boundary = `unmindy_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const pre = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([pre, fileBuffer, end]);
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Drive upload ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function cleanScript(script) {
  return String(script || '')
    .replace(/\\[rn]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(script) {
  const normalized = cleanScript(script);
  return (normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized]).map(s => s.trim()).filter(Boolean);
}

function wordsOf(sentence) {
  return sentence.split(/\s+/).filter(Boolean).map(word => word.replace(/^[“”"']+|[“”"']+$/g, ''));
}

const FONT_SIZE = 58;
const CHAR_W = 34.8;
const MAX_CHARS = 13;
const BOX_W = MAX_CHARS * CHAR_W;
const CENTER_X = 540;
const TOP_Y = 128;

function layoutWords(words) {
  const lines = [];
  let line = [];
  let chars = 0;
  for (const word of words) {
    const safeWord = word.replace(/[\\/]/g, '');
    if (!safeWord) continue;
    const needed = line.length ? chars + 1 + safeWord.length : safeWord.length;
    if (line.length && needed > MAX_CHARS) {
      lines.push(line);
      line = [safeWord];
      chars = safeWord.length;
    } else {
      line.push(safeWord);
      chars = needed;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function justifyLine(words, isLast) {
  if (isLast || words.length < 2) return words.join(' ');
  const letters = words.reduce((n, w) => n + w.length, 0);
  const gaps = words.length - 1;
  const spaces = Math.max(gaps, MAX_CHARS - letters);
  const base = Math.floor(spaces / gaps);
  let extra = spaces % gaps;
  let result = words[0];
  for (let i = 1; i < words.length; i++) {
    result += ' '.repeat(base + (extra-- > 0 ? 1 : 0)) + words[i];
  }
  return result;
}

function captionText(revealed) {
  return layoutWords(revealed).map((line, i, all) => justifyLine(line, i === all.length - 1)).join('\\N');
}

function maxRenderedWidth(revealed) {
  const lines = layoutWords(revealed);
  return Math.min(BOX_W, Math.max(1, ...lines.map(line => line.join(' ').length * CHAR_W)));
}

function assEscape(text) {
  return text.replaceAll('{', '\\{').replaceAll('}', '\\}');
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

async function makeAss(script, totalDuration, file) {
  const sentences = splitSentences(script);
  const wordSets = sentences.map(wordsOf);
  const allWords = wordSets.flat();
  if (!allWords.length) throw new Error('Script contains no words');

  const sentenceGap = Math.min(0.12, totalDuration / Math.max(100, allWords.length * 10));
  const totalGap = sentenceGap * Math.max(0, wordSets.length - 1);
  const wordDuration = Math.max(0.22, (totalDuration - totalGap) / allWords.length);

  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 644', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Ref,Courier,${FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,0,0,1,1.0,1.0,7,0,0,0,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  let cursor = 0;
  for (let s = 0; s < wordSets.length; s++) {
    const words = wordSets[s];
    if (!words.length) continue;
    const revealed = [];
    for (const word of words) {
      revealed.push(word);
      const start = cursor;
      const end = Math.min(totalDuration, start + wordDuration);
      const width = maxRenderedWidth(revealed);
      const x = Math.round(CENTER_X - width / 2);
      ass.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Ref,,0,0,0,,{\\pos(${x},${TOP_Y})}${assEscape(captionText(revealed))}`);
      cursor = end;
    }
    if (s < wordSets.length - 1) cursor = Math.min(totalDuration, cursor + sentenceGap);
  }

  await fs.writeFile(file, `${ass.join('\n')}\n`, 'utf8');
}

async function makeBackground(source, totalDuration, firstSentenceDuration, output) {
  const sourceDuration = await duration(source);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Invalid footage duration');
  const start = sourceDuration > totalDuration + 2 ? Math.min(8, Math.max(0, sourceDuration * 0.08)) : 0;
  const blackLen = Math.min(2.7, Math.max(1.8, totalDuration * 0.06));
  const blackStart = Math.min(firstSentenceDuration, Math.max(0, totalDuration - blackLen - 0.5));
  const blackEnd = Math.min(totalDuration, blackStart + blackLen);
  const filter = [
    'scale=1080:644:force_original_aspect_ratio=increase:flags=lanczos',
    'crop=1080:644:(in_w-1080)/2:(in_h-644)/2',
    'setsar=1', 'fps=30',
    'eq=contrast=0.98:brightness=-0.01:saturation=0.92',
    'vignette=PI/10',
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,${blackStart.toFixed(3)},${blackEnd.toFixed(3)})'`
  ].join(',');
  await run('ffmpeg', [
    '-y', '-ss', String(start), '-stream_loop', '-1', '-i', source,
    '-t', String(totalDuration), '-vf', filter, '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-r', '30', '-fps_mode', 'cfr', output
  ]);
}

async function buildAudio(voice, music, totalDuration, output) {
  if (!music) throw new Error('No music track found in UNMINDY/Music or Drive.');
  await run('ffmpeg', [
    '-y', '-i', voice, '-stream_loop', '-1', '-i', music,
    '-filter_complex',
    '[0:a]loudnorm=I=-15:TP=-1.5:LRA=9,aresample=44100[voice];' +
    '[1:a]highpass=f=35,lowpass=f=12000,volume=0.20,afade=t=in:st=0:d=1.0,afade=t=out:st=' + Math.max(0, totalDuration - 1.5).toFixed(3) + ':d=1.5[music];' +
    '[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96:level=disabled[a]',
    '-map', '[a]', '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', '-ac', '2', output
  ]);
}

async function burnAndMux(background, captions, audio, totalDuration, output) {
  const captionPath = captions.replaceAll('\\', '/').replaceAll(':', '\\:');
  await run('ffmpeg', [
    '-y', '-i', background, '-i', audio,
    '-vf', `subtitles='${captionPath}':fontsdir=/usr/share/fonts/type1/texlive-fonts-recommended`,
    '-map', '0:v:0', '-map', '1:a:0', '-t', String(totalDuration),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', '-r', '30', '-fps_mode', 'cfr', output
  ]);
}

async function verifyOutput(file, expectedDuration) {
  const stat = await fs.stat(file);
  if (stat.size < 500000) throw new Error(`Rendered video is suspiciously small: ${stat.size} bytes`);
  const types = await streamTypes(file);
  if (!types.includes('video')) throw new Error('Final video has no video stream');
  if (!types.includes('audio')) throw new Error('Final video has no audio stream');
  const actual = await duration(file);
  if (!Number.isFinite(actual) || Math.abs(actual - expectedDuration) > 1.0) throw new Error(`Final duration mismatch: ${actual} vs ${expectedDuration}`);
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels', '-of', 'json', file]);
  console.log(`Verified output: ${(stat.size / 1048576).toFixed(1)} MB, ${actual.toFixed(2)}s, ${probe.stdout}`);
}

async function main() {
  const data = await api('/api/edit/job');
  const job = data.job;
  if (!job) { console.log('No pending edit job.'); return; }
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(FOOTAGE, { recursive: true });
  await fs.mkdir(MUSIC, { recursive: true });

  try {
    const tokenData = await api('/api/drive/token');
    const token = tokenData.access_token;
    if (!token) throw new Error('Drive token endpoint returned no access token');
    const root = await ensureFolder(token, 'UNMINDY');
    const footageFolder = await ensureFolder(token, 'Footage', root.id);
    const musicFolder = await ensureFolder(token, 'Music', root.id);
    const exportsFolder = await ensureFolder(token, 'Exports', root.id);

    const files = await folderDescendants(token, footageFolder.id);
    const musicFiles = await folderDescendants(token, musicFolder.id);
    const videoExt = /\.(mp4|mov|mkv|webm|m4v)$/i;
    const audioExt = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
    const videos = files.filter(f => videoExt.test(f.name) || String(f.mimeType || '').startsWith('video/'));
    const tracks = musicFiles.filter(f => audioExt.test(f.name) || String(f.mimeType || '').startsWith('audio/'));
    if (!videos.length) throw new Error('No video footage found in UNMINDY/Footage.');
    if (!tracks.length) {
      const allFiles = await driveList(token, 'trashed = false');
      const globalTracks = allFiles.filter(f => audioExt.test(f.name) || String(f.mimeType || '').startsWith('audio/'));
      if (globalTracks.length) {
        console.log(`No Music-folder audio found; using ${globalTracks[0].name} found elsewhere in Drive.`);
        tracks.push(...globalTracks);
      }
    }
    if (!tracks.length) throw new Error('No music file found in Drive or UNMINDY/Music.');

    videos.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
    tracks.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
    const footage = videos[0];
    const music = tracks[0];
    console.log(`Footage: ${footage.name}`);
    console.log(`Music: ${music.name}`);
    await downloadDriveFile(token, footage, path.join(FOOTAGE, footage.name));
    await downloadDriveFile(token, music, path.join(MUSIC, music.name));

    const voice = path.join(WORK, 'tts.wav');
    const response = await fetch(job.tts_audio_url);
    if (!response.ok || !response.body) throw new Error(`TTS download failed: ${response.status}`);
    await pipeline(response.body, (await import('node:fs')).createWriteStream(voice));

    const totalDuration = await duration(voice);
    if (!Number.isFinite(totalDuration) || totalDuration <= 1) throw new Error(`Invalid TTS duration: ${totalDuration}`);
    const sentenceWords = splitSentences(job.script).map(wordsOf);
    const firstSentenceDuration = totalDuration * (sentenceWords[0]?.length || 1) / (sentenceWords.flat().length || 1);

    const bg = path.join(WORK, 'background.mp4');
    const audio = path.join(WORK, 'audio.m4a');
    const ass = path.join(WORK, 'captions.ass');
    const final = path.join(WORK, 'final.mp4');

    await makeBackground(path.join(FOOTAGE, footage.name), totalDuration, firstSentenceDuration, bg);
    await makeAss(job.script, totalDuration, ass);
    await buildAudio(voice, path.join(MUSIC, music.name), totalDuration, audio);
    await burnAndMux(bg, ass, audio, totalDuration, final);
    await fs.copyFile(final, OUT);
    await verifyOutput(OUT, totalDuration);

    const uploaded = await uploadDriveFile(token, OUT, `reel-${job.id}-reference-style-v6.mp4`, exportsFolder.id);
    const exportUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
    await api('/api/edit/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, status: 'Ready', export_drive_file_id: uploaded.id, export_drive_url: exportUrl }) });
    console.log(`Exported: ${exportUrl}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    try {
      await api('/api/edit/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, status: 'Failed', error: message.slice(0, 4000) }) });
    } catch (updateError) {
      console.error(`Failed to report edit failure: ${updateError}`);
    }
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
