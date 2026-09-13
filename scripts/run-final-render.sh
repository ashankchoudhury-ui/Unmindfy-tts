#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re
p = Path('scripts/render-reel.mjs')
s = p.read_text()

s = re.sub(r'const OUTPUT_WIDTH = \d+;', 'const OUTPUT_WIDTH = 1280;', s, count=1)
s = re.sub(r'const OUTPUT_HEIGHT = \d+;', 'const OUTPUT_HEIGHT = 720;', s, count=1)
s = re.sub(r'const MAX = \d+, lines = \[\];', 'const MAX = 13, lines = [];', s, count=1)

pages = '''function captionPages(words) {
  const MAX_LINES = 4, TARGET = 10, MIN = 8, MAX = 12, pages = [];
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
}'''
s, n = re.subn(r'function captionPages\(words\) \{.*?\n\}', pages, s, count=1, flags=re.S)
if n != 1: raise SystemExit('captionPages patch target missing')

s = re.sub(
    r'const FONT = \d+, BOX_W = \d+, SAFE_X = \(OUTPUT_WIDTH - BOX_W\) / 2, CAPTION_Y = \d+;',
    'const FONT = 56, BOX_W = 560, SAFE_X = (OUTPUT_WIDTH - BOX_W) / 2, CAPTION_Y = 165;',
    s, count=1)

s = re.sub(
    r"'Style: Ref,Courier,\$\{FONT\},[^']*'",
    "'Style: Ref,Courier,${FONT},&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,0,0,0,0,100,100,0,0,1,1.2,0.8,7,0,0,0,1'",
    s, count=1)

static_reveal = '''function revealCaption(page, startIndex, timings, eventStart) {
  const lines = layoutWords(page).map(line => line.map(assEscape).join(' '));
  return { text: lines.join(String.fromCharCode(92) + 'N'), nextIndex: startIndex + page.length };
}'''
s, n = re.subn(r'function revealCaption\(page, startIndex, timings, eventStart\) \{.*?\n\}', lambda m: static_reveal, s, count=1, flags=re.S)
if n != 1: raise SystemExit('revealCaption patch target missing')

s = s.replace(
    "'-vf', `${resize},subtitles='${assPath}':original_size=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,",
    "'-vf', `${resize},eq=contrast=1.04:brightness=-0.025:saturation=0.84:gamma=0.98,subtitles='${assPath}':original_size=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,",
    1)

s = s.replace("if (!music) throw new Error('No music file found in UNMINDY/Music');", "if (!music) console.log('No music found; using generated ambient bed as fallback.');", 1)
s = s.replace("console.log(`Music: ${music.name}`);", "console.log(`Music: ${music?.name || 'generated ambient bed'}`);", 1)
s = s.replace("const musicPath = path.join(WORK, `music${path.extname(music.name) || '.mp3'}`);", "const musicPath = path.join(WORK, `music${path.extname(music?.name || 'ambient.m4a') || '.m4a'}`);", 1)
s = s.replace("await downloadDriveFile(token, music, musicPath);", "if (music) await downloadDriveFile(token, music, musicPath);", 1)
s = s.replace("await buildAudio(voicePath, musicPath, total, audioPath);", "await buildAudio(voicePath, music ? musicPath : ambientPath, total, audioPath);", 1)

forced = '''async function wordTimings(script, audioUrl) {
  const r = await run('/tmp/whisperx/bin/python', ['scripts/forced_align.py', audioUrl, script]);
  const lines = r.stdout.trim().split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean);
  let d;
  for (let i = lines.length - 1; i >= 0; i--) { try { d = JSON.parse(lines[i]); break; } catch {} }
  if (!d) throw new Error(`Forced alignment returned no JSON output. stdout=${r.stdout.slice(-1000)} stderr=${r.stderr.slice(-1000)}`);
  if (!Array.isArray(d.words) || !d.words.length) throw new Error('Forced alignment returned no word timings');
  const words = wordsOf(script);
  return validateTimings(d.words.map((w, i) => ({ text: words[i], start: Number(w.start), end: Number(w.end), i })), script);
}'''
s, n = re.subn(r'async function wordTimings\(script, audioUrl\) \{.*?\n\}', lambda m: forced, s, count=1, flags=re.S)
if n != 1: raise SystemExit('wordTimings patch target missing')

p.write_text(s)
PY
sleep 30
node scripts/render-reel.mjs
