import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://unmindfy-tts.vercel.app';
const CRON_SECRET = process.env.UNMINDY_CRON_SECRET;
const WORK = path.resolve('.render-work');
const FOOTAGE = path.join(WORK, 'footage');
const MUSIC = path.join(WORK, 'music');
const OUT = path.join(WORK, 'output.mp4');

if (!CRON_SECRET) throw new Error('UNMINDY_CRON_SECRET is missing');

async function api(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${text}`);
  return data;
}

async function getDriveToken() {
  const data = await api('/api/drive/token');
  return data.access_token;
}

async function driveList(token, q, fields = 'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)') {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('orderBy', 'name');
  url.searchParams.set('fields', fields);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(`Drive list ${response.status}: ${JSON.stringify(data)}`);
  return data.files || [];
}

async function createDriveFolder(token, name, parentId = null) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const response = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Drive folder create ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ensureFolder(token, name, parentId = null) {
  const parentQuery = parentId ? `'${parentId}' in parents and ` : '';
  const files = await driveList(token, `${parentQuery}name = '${name.replaceAll("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 'files(id,name,webViewLink)');
  return files[0] || createDriveFolder(token, name, parentId);
}

async function downloadDriveFile(token, file, destination) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new Error(`Drive download failed for ${file.name}: ${response.status}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await pipeline(response.body, (await import('node:fs')).createWriteStream(destination));
}

async function uploadDriveFile(token, filePath, name, parentId) {
  const stat = await fs.stat(filePath);
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType: 'video/mp4' });
  const boundary = `unmindy_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const preamble = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`);
  const ending = Buffer.from(`\r\n--${boundary}--`);
  const fileBuffer = await fs.readFile(filePath);
  const body = Buffer.concat([preamble, fileBuffer, ending]);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Drive upload ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}\n${stderr.slice(-6000)}`)));
  });
}

async function duration(file) {
  const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return Number.parseFloat(result.stdout.trim());
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function assEscape(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('\n', ' ');
}

function makeCaptionChunks(script) {
  const words = script.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += 7) chunks.push(words.slice(i, i + 7).join(' '));
  return chunks;
}

async function makeAss(script, totalDuration, file) {
  const chunks = makeCaptionChunks(script);
  const weights = chunks.map(x => Math.max(1, x.replace(/\s/g, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Unmindy,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,4,0,2,80,80,260,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  for (let i = 0; i < chunks.length; i++) {
    const slice = totalDuration * (weights[i] / totalWeight);
    const start = cursor;
    const end = i === chunks.length - 1 ? totalDuration : cursor + slice;
    cursor = end;
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Unmindy,,0,0,260,,${assEscape(chunks[i])}`);
  }
  await fs.writeFile(file, lines.join('\n'), 'utf8');
}

async function normalizeVideo(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', output]);
}

async function concatVideos(files, output, totalDuration) {
  const list = path.join(WORK, 'videos.txt');
  await fs.writeFile(list, files.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', String(totalDuration), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', output]);
}

async function makeBackground(output, totalDuration) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30', '-t', String(totalDuration), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]);
}

async function buildAudio(voiceFile, musicFiles, totalDuration, output) {
  if (!musicFiles.length) {
    await run('ffmpeg', ['-y', '-i', voiceFile, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k', output]);
    return;
  }
  const musicList = path.join(WORK, 'music.txt');
  await fs.writeFile(musicList, musicFiles.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
  const musicConcat = path.join(WORK, 'music-concat.m4a');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', musicList, '-t', String(totalDuration), '-vn', '-c:a', 'aac', '-b:a', '192k', musicConcat]);
  await run('ffmpeg', ['-y', '-i', voiceFile, '-i', musicConcat, '-filter_complex', '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[voice];[1:a]volume=0.10[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '[a]', '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k', output]);
}

async function render(job, token) {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(FOOTAGE, { recursive: true });
  await fs.mkdir(MUSIC, { recursive: true });

  const root = await ensureFolder(token, 'UNMINDY');
  const footageFolder = await ensureFolder(token, 'Footage', root.id);
  const musicFolder = await ensureFolder(token, 'Music', root.id);
  const exportsFolder = await ensureFolder(token, 'Exports', root.id);

  const videoFiles = await driveList(token, `'${footageFolder.id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,size,modifiedTime,webViewLink)');
  const musicFiles = await driveList(token, `'${musicFolder.id}' in parents and trashed = false and mimeType contains 'audio/'`, 'files(id,name,mimeType,size,modifiedTime,webViewLink)');
  const selectedVideos = videoFiles.slice(0, 12);
  const selectedMusic = musicFiles.slice(0, 4);

  const voiceFile = path.join(WORK, 'voice.wav');
  const voiceResponse = await fetch(job.tts_audio_url);
  if (!voiceResponse.ok || !voiceResponse.body) throw new Error(`TTS audio download failed: ${voiceResponse.status}`);
  await pipeline(voiceResponse.body, (await import('node:fs')).createWriteStream(voiceFile));
  const totalDuration = await duration(voiceFile);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) throw new Error('Could not determine TTS duration.');

  const normalized = [];
  for (let i = 0; i < selectedVideos.length; i++) {
    const source = path.join(FOOTAGE, `${String(i).padStart(2, '0')}-${selectedVideos[i].name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    const normalizedPath = path.join(FOOTAGE, `norm-${String(i).padStart(2, '0')}.mp4`);
    await downloadDriveFile(token, selectedVideos[i], source);
    await normalizeVideo(source, normalizedPath);
    normalized.push(normalizedPath);
  }

  const background = path.join(WORK, 'background.mp4');
  if (normalized.length) await concatVideos(normalized, background, totalDuration);
  else await makeBackground(background, totalDuration);

  const downloadedMusic = [];
  for (let i = 0; i < selectedMusic.length; i++) {
    const target = path.join(MUSIC, `${String(i).padStart(2, '0')}-${selectedMusic[i].name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    await downloadDriveFile(token, selectedMusic[i], target);
    downloadedMusic.push(target);
  }

  const audio = path.join(WORK, 'mix.m4a');
  await buildAudio(voiceFile, downloadedMusic, totalDuration, audio);

  const ass = path.join(WORK, 'captions.ass');
  await makeAss(job.script, totalDuration, ass);

  await run('ffmpeg', [
    '-y', '-i', background, '-i', audio,
    '-vf', `subtitles=${ass.replaceAll('\\', '/').replaceAll(':', '\\:')}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUT
  ]);

  const reelName = `UNMINDY-Reel-${job.id.slice(0, 8)}.mp4`;
  const uploaded = await uploadDriveFile(token, OUT, reelName, exportsFolder.id);
  return uploaded;
}

async function main() {
  const { job } = await api('/api/edit/job');
  if (!job) {
    console.log('No reel is waiting for automated editing.');
    return;
  }

  console.log(`Rendering reel ${job.id}...`);
  try {
    const token = await getDriveToken();
    const uploaded = await render(job, token);
    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: job.id,
        status: 'Ready',
        export_drive_file_id: uploaded.id,
        export_drive_url: uploaded.webViewLink || `https://drive.google.com/open?id=${uploaded.id}`
      })
    });
    console.log(`REEL_READY ${uploaded.webViewLink || uploaded.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    try {
      await api('/api/edit/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, status: 'Failed', error: message })
      });
    } catch (completionError) {
      console.error('Could not mark edit job failed:', completionError);
    }
    process.exitCode = 1;
  }
}

await main();
