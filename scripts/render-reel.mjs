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

async function api(endpoint, options = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${CRON_SECRET}`, ...(options.headers || {}) }
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
      : reject(new Error(`${command} exited ${code}\n${stderr.slice(-9000)}`)));
  });
}

async function duration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return Number.parseFloat(r.stdout.trim());
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

async function ensureFolder(token, name, parentId = null) {
  const parent = parentId ? `'${parentId}' in parents and ` : '';
  const safe = name.replaceAll("'", "\\'");
  const found = await driveList(token, `${parent}name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 'files(id,name,webViewLink)');
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
  return script.replace(/\s+/g, ' ').trim();
}

// The reference uses sentence-sized text blocks, then reveals the words one at a time.
function splitSentences(script) {
  const normalized = cleanScript(script);
  const pieces = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  return pieces.map(x => x.trim()).filter(Boolean);
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

// Match the reference's fixed-width typewriter look. Lines are spread across a
// roughly 470 px text box, creating the characteristic large word gaps.
function justifyLines(words, maxChars = 15) {
  const lines = [];
  let current = [];
  let chars = 0;
  for (const word of words) {
    const needed = chars ? chars + 1 + word.length : word.length;
    if (current.length && needed > maxChars) {
      lines.push(current);
      current = [word];
      chars = word.length;
    } else {
      current.push(word);
      chars = needed;
    }
  }
  if (current.length) lines.push(current);

  return lines.map((line, index) => {
    if (index === lines.length - 1 || line.length === 1) return line.join(' ');
    const letters = line.reduce((sum, word) => sum + word.length, 0);
    const slots = line.length - 1;
    const target = maxChars;
    const totalSpaces = Math.max(slots, target - letters);
    const base = Math.floor(totalSpaces / slots);
    let extra = totalSpaces % slots;
    const gaps = [];
    for (let i = 0; i < slots; i++) gaps.push(base + (extra-- > 0 ? 1 : 0));
    let out = line[0];
    for (let i = 1; i < line.length; i++) out += ' '.repeat(gaps[i - 1]) + line[i];
    return out;
  }).join('\\N');
}

async function makeAss(script, totalDuration, file) {
  const sentences = splitSentences(script);
  const wordsBySentence = sentences.map(s => s.replace(/\s+/g, ' ').split(' ').filter(Boolean).map(w => w.replace(/^[\u201c\"]+|[.,!?;:\u201d\"]+$/g, '')));
  const sentenceWeights = wordsBySentence.map(words => Math.max(1, words.join('').length));
  const totalWeight = sentenceWeights.reduce((a, b) => a + b, 0) || 1;

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 644',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Reference,Courier,60,&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,0,0,1,1,2,8,250,250,145,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  let cursor = 0;
  for (let s = 0; s < wordsBySentence.length; s++) {
    const words = wordsBySentence[s];
    const sentenceDuration = totalDuration * sentenceWeights[s] / totalWeight;
    const gap = Math.min(0.18, sentenceDuration * 0.06);
    const usable = Math.max(0.2, sentenceDuration - gap);
    const wordWeights = words.map(w => Math.max(1, w.replace(/[^A-Za-z0-9]/g, '').length));
    const sum = wordWeights.reduce((a, b) => a + b, 0) || 1;
    let local = cursor;
    const revealed = [];
    for (let i = 0; i < words.length; i++) {
      revealed.push(words[i]);
      const slice = usable * wordWeights[i] / sum;
      const end = i === words.length - 1 ? cursor + usable : local + slice;
      const text = justifyLines(revealed, 15);
      lines.push(`Dialogue: 0,${assTime(local)},${assTime(end)},Reference,,0,0,0,,${assEscape(text)}`);
      local = end;
    }
    cursor += sentenceDuration;
  }
  await fs.writeFile(file, lines.join('\n'), 'utf8');
}

async function makeBackground(footageFile, totalDuration, output) {
  const d = await duration(footageFile);
  const start = d > totalDuration + 3 ? Math.min(12, Math.max(0, d * 0.13)) : 0;
  // The reference is one continuous, slow-moving gameplay shot: no montage cuts.
  const filter = [
    'scale=1080:644:force_original_aspect_ratio=increase',
    'crop=1080:644:(in_w-1080)/2:(in_h-644)/2',
    'setsar=1',
    'fps=30',
    'eq=contrast=0.97:brightness=-0.018:saturation=0.90',
    'gblur=sigma=0.18',
    'vignette=PI/6'
  ].join(',');
  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-ss', String(start), '-i', footageFile,
    '-t', String(totalDuration), '-vf', filter, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', output
  ]);
}

async function buildAudio(voiceFile, musicFile, totalDuration, output) {
  if (!musicFile) {
    await run('ffmpeg', ['-y', '-i', voiceFile, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k', output]);
    return;
  }
  await run('ffmpeg', [
    '-y', '-i', voiceFile, '-stream_loop', '-1', '-i', musicFile,
    '-filter_complex',
    '[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[voice];[1:a]volume=0.055,lowpass=f=9000,afade=t=in:st=0:d=1.4,afade=t=out:st=99999:d=1.8[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]',
    '-map', '[a]', '-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k', output
  ]);
}

async function main() {
  const data = await api('/api/edit/job');
  const job = data.job;
  if (!job) {
    console.log('No pending edit job.');
    return;
  }

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

    const videoFiles = await driveList(token, `'${footageFolder.id}' in parents and trashed = false and mimeType contains 'video/'`, 'files(id,name,mimeType,size,modifiedTime,webViewLink)');
    const musicFiles = await driveList(token, `'${musicFolder.id}' in parents and trashed = false and mimeType contains 'audio/'`, 'files(id,name,mimeType,size,modifiedTime,webViewLink)');
    if (!videoFiles.length) throw new Error('No footage found in UNMINDY/Footage.');

    // Use one long continuous footage source, matching the reference instead of a montage.
    videoFiles.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
    musicFiles.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
    const footage = videoFiles[0];
    const music = musicFiles[0] || null;

    await downloadDriveFile(token, footage, path.join(FOOTAGE, footage.name));
    if (music) await downloadDriveFile(token, music, path.join(MUSIC, music.name));

    const sourceVoice = path.join(WORK, 'tts.wav');
    const response = await fetch(job.tts_audio_url);
    if (!response.ok || !response.body) throw new Error(`TTS download failed: ${response.status}`);
    await pipeline(response.body, (await import('node:fs')).createWriteStream(sourceVoice));
    const totalDuration = await duration(sourceVoice);
    if (!Number.isFinite(totalDuration) || totalDuration <= 1) throw new Error('Invalid TTS duration');

    const bg = path.join(WORK, 'background.mp4');
    const audio = path.join(WORK, 'audio.m4a');
    const ass = path.join(WORK, 'captions.ass');
    const visual = path.join(WORK, 'visual.mp4');

    await makeBackground(path.join(FOOTAGE, footage.name), totalDuration, bg);
    await makeAss(job.script, totalDuration, ass);
    await buildAudio(sourceVoice, music ? path.join(MUSIC, music.name) : null, totalDuration, audio);

    // Reference structure: continuous gameplay with a deliberate black editorial break
    // after the opening sentence, while the typewriter text continues over the black.
    const sentences = splitSentences(job.script);
    const firstWeight = Math.max(1, sentences[0]?.replace(/[^A-Za-z0-9]/g, '').length || 1);
    const totalWeight = sentences.reduce((sum, s) => sum + Math.max(1, s.replace(/[^A-Za-z0-9]/g, '').length), 0);
    const blackStart = totalDuration * firstWeight / totalWeight;
    const blackLength = Math.min(2.8, Math.max(1.8, totalDuration * 0.042));
    const blackEnd = Math.min(totalDuration, blackStart + blackLength);

    await run('ffmpeg', [
      '-y', '-i', bg, '-f', 'lavfi', '-i', 'color=c=black:s=1080x644:r=30',
      '-filter_complex', `[0:v]trim=start=0:end=${blackStart.toFixed(3)}[pre];[0:v]trim=start=${blackEnd.toFixed(3)}[post];[1:v]trim=duration=${(blackEnd - blackStart).toFixed(3)}[black];[pre][black][post]concat=n=3:v=1:a=0,format=yuv420p[base];[base]ass=${ass.replaceAll(':', '\\:')}[v]`,
      '-map', '[v]', '-t', String(totalDuration), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', visual
    ]);

    const exportName = `reel-${job.id}-reference-style.mp4`;
    await run('ffmpeg', ['-y', '-i', visual, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-t', String(totalDuration), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUT]);

    const uploaded = await uploadDriveFile(token, OUT, exportName, exportsFolder.id);
    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, status: 'Ready', export_drive_file_id: uploaded.id, export_drive_url: uploaded.webViewLink || null })
    });

    console.log(JSON.stringify({ ok: true, id: job.id, duration: totalDuration, footage: footage.name, music: music?.name || null, export: uploaded }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api('/api/edit/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, status: 'Failed', error: message })
    }).catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error('UNMINDY reference-style render failed:', error);
  process.exit(1);
});
