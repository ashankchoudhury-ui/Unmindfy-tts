import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from pocketsphinx import AudioFile


def norm(s):
    return re.sub(r"[^a-z0-9']+", "", str(s).lower().replace("’", "'"))


def prepare_audio(audio):
    src = Path(audio)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        dst = Path(f.name)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(dst)],
            check=True,
        )
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: local-word-timings.py AUDIO SCRIPT")
    audio, script = sys.argv[1], sys.argv[2]
    target = [w.strip("\"'“”.,!?;:()[]{}") for w in re.split(r"\s+", script.strip()) if w.strip()]
    prepared = prepare_audio(audio)
    try:
        recognized = []
        for phrase in AudioFile(audio_file=str(prepared), no_search=True, frate=100):
            for seg in phrase.segments(detailed=True):
                word = str(seg.word)
                if word in {"<s>", "</s>", "<sil>", "<silence>"}:
                    continue
                start = float(seg.start_frame) / 100.0
                end = float(seg.end_frame + 1) / 100.0
                recognized.append({"text": word, "start": start, "end": max(end, start + 0.08)})
        if not recognized:
            raise RuntimeError("Local ASR returned no word timings")

        out = []
        j = 0
        for i, word in enumerate(target):
            k = norm(word)
            hit = None
            for p in range(j, min(len(recognized), j + 8)):
                if norm(recognized[p]["text"]) == k:
                    hit = p
                    break
            if hit is None:
                raise RuntimeError(f"Local ASR could not produce a real timing for word {i+1}/{len(target)}: {word!r}")
            r = recognized[hit]
            out.append({"text": word, "start": r["start"], "end": r["end"], "i": i})
            j = hit + 1

        print(json.dumps(out, separators=(",", ":")))
    finally:
        prepared.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
