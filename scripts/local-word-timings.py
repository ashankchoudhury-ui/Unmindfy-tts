import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def norm(s):
    return re.sub(r"[^a-z0-9']+", "", str(s).lower().replace("’", "'"))


def prepare_audio(audio):
    src = Path(audio)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        dst = Path(f.name)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error", "-i", str(src),
                "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(dst)
            ],
            check=True,
        )
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: local-word-timings.py AUDIO SCRIPT")

    audio = sys.argv[1]
    script = sys.argv[2]
    target = [
        w.strip("\"'“”.,!?;:()[]{}…")
        for w in re.split(r"\s+", script.strip())
        if w.strip()
    ]

    if not target:
        raise SystemExit("script must contain at least one word")

    prepared = prepare_audio(audio)
    try:
        p = subprocess.run(
            [sys.executable, "-m", "pocketsphinx", "align", str(prepared), " ".join(target)],
            check=True,
            capture_output=True,
            text=True,
        )
        data = json.loads(p.stdout)
        raw = data.get("w") or data.get("words") or []
        recognized = []
        for item in raw:
            text = str(item.get("t") or item.get("word") or item.get("text") or "").strip()
            start = item.get("b", item.get("start"))
            dur = item.get("d", item.get("duration"))
            end_value = item.get("e", item.get("end"))
            if not text or start is None:
                continue
            start = float(start)
            end = float(end_value) if end_value is not None else start + float(dur) if dur is not None else start + 0.08
            recognized.append({"text": text, "start": start, "end": max(end, start + 0.08)})

        if len(recognized) < len(target):
            raise RuntimeError(f"Forced alignment returned {len(recognized)}/{len(target)} words")

        out = []
        j = 0
        for i, word in enumerate(target):
            k = norm(word)
            hit = None
            for pidx in range(j, min(len(recognized), j + 4)):
                if norm(recognized[pidx]["text"]) == k:
                    hit = pidx
                    break
            if hit is None:
                raise RuntimeError(
                    f"Forced alignment mismatch at word {i + 1}/{len(target)}: "
                    f"{word!r}; got {recognized[j:j + 4]}"
                )
            r = recognized[hit]
            out.append({"text": word, "start": r["start"], "end": r["end"], "i": i})
            j = hit + 1

        print(json.dumps(out, separators=(",", ":")))
    finally:
        prepared.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
