#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re
p=Path('scripts/render-reel.mjs')
s=p.read_text()
old_pages="""function captionPages(words) {
  const MAX_LINES = 3, TARGET = 11, MIN = 9, MAX = 12, pages = [];
  let page = [], i = 0;
  while (i < words.length) {
    const candidate = [...page, words[i]], overflow = layoutWords(candidate).length > MAX_LINES;
    if (page.length && (page.length >= MAX || (page.length >= MIN && (page.length >= TARGET || overflow)))) { pages.push(page); page = []; continue; }
    page = candidate; i++;
  }
  if (page.length) pages.push(page);
  if (pages.length > 1 && pages.at(-1).length < MIN) {
    const tail = pages.pop(), prev = pages.pop() || [];
    while (tail.length && prev.length < MAX) prev.push(tail.shift());
    if (prev.length) pages.push(prev);
    if (tail.length) pages.push(tail);
  }
  return pages;
}"""
new_pages="""function captionPages(words) {
  const MAX_LINES = 3, TARGET = 11, MIN = 9, MAX = 12, pages = [];
  let page = [], i = 0;
  while (i < words.length) {
    const candidate = [...page, words[i]], overflow = layoutWords(candidate).length > MAX_LINES;
    if (page.length && overflow) { pages.push(page); page = []; continue; }
    if (page.length && page.length >= MAX) { pages.push(page); page = []; continue; }
    page = candidate; i++;
  }
  if (page.length) pages.push(page);
  if (pages.length > 1 && pages.at(-1).length < MIN) {
    const tail = pages.pop(), prev = pages.pop() || [];
    while (tail.length && prev.length < MAX && layoutWords([...prev, tail[0]]).length <= MAX_LINES) prev.push(tail.shift());
    if (prev.length) pages.push(prev);
    if (tail.length) pages.push(tail);
  }
  return pages;
}"""
reps=[
("const OUTPUT_WIDTH = 1920;","const OUTPUT_WIDTH = 1280;"),
("const OUTPUT_HEIGHT = 1080;","const OUTPUT_HEIGHT = 720;"),
("const MAX = 22, lines = [];","const MAX = 13, lines = [];"),
("const FONT = 56, BOX_W = 780, SAFE_X = (OUTPUT_WIDTH - BOX_W) / 2, CAPTION_Y = 96;","const FONT = 56, BOX_W = 600, SAFE_X = (OUTPUT_WIDTH - BOX_W) / 2, CAPTION_Y = 145;"),
(old_pages,new_pages),
("    if (!music) throw new Error('No music file found in UNMINDY/Music');","    if (!music) console.log('No music found; using generated ambient bed as fallback.');"),
("    console.log(`Music: ${music.name}`);","    console.log(`Music: ${music?.name || 'generated ambient bed'}`);"),
("    const musicPath = path.join(WORK, `music${path.extname(music.name) || '.mp3'}`);","    const musicPath = path.join(WORK, `music${path.extname(music?.name || 'ambient.m4a') || '.m4a'}`);"),
("    await downloadDriveFile(token, music, musicPath);","    if (music) await downloadDriveFile(token, music, musicPath);"),
("    await buildAudio(voicePath, musicPath, total, audioPath);","    await buildAudio(voicePath, music ? musicPath : ambientPath, total, audioPath);"),
]
for i,(a,b) in enumerate(reps,1):
    if a not in s: raise SystemExit(f'Expected renderer text not found at replacement {i}')
    s=s.replace(a,b,1)
replacement="""async function wordTimings(script, audioUrl) {
  const r = await run('/tmp/whisperx/bin/python', ['scripts/forced_align.py', audioUrl, script]);
  const lines = r.stdout.trim().split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean);
  let d;
  for (let i = lines.length - 1; i >= 0; i--) { try { d = JSON.parse(lines[i]); break; } catch {} }
  if (!d) throw new Error(`Forced alignment returned no JSON output. stdout=${r.stdout.slice(-1000)} stderr=${r.stderr.slice(-1000)}`);
  if (!Array.isArray(d.words) || !d.words.length) throw new Error('Forced alignment returned no word timings');
  const words = wordsOf(script);
  return validateTimings(d.words.map((w, i) => ({ text: words[i], start: Number(w.start), end: Number(w.end), i })), script);
}"""
s2,n=re.subn(r"async function wordTimings\(script, audioUrl\) \{.*?\n\}\n\nfunction revealCaption",replacement+"\n\nfunction revealCaption",s,count=1,flags=re.S)
if n!=1: raise SystemExit('Could not replace wordTimings function')
p.write_text(s2)
PY
sleep 30
node scripts/render-reel.mjs
