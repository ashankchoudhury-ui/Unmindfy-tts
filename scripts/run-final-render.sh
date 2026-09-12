#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
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
    if a not in s: raise SystemExit(f'Expected renderer text not found at replacement {i}: {a[:80]}')
    s=s.replace(a,b,1)
p.write_text(s)
PY
sleep 30
node scripts/render-reel.mjs
