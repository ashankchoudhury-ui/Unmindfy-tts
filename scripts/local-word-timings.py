import difflib
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
            ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(dst)],
            check=True,
        )
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise


def parse_words(stdout):
    data = json.loads(stdout.strip())
    raw = data.get("w") or data.get("words") or []
    out = []
    for item in raw:
        text = str(item.get("t") or item.get("word") or item.get("text") or "").strip()
        start = item.get("b", item.get("start"))
        dur = item.get("d", item.get("duration"))
        end_value = item.get("e", item.get("end"))
        if not text or start is None:
            continue
        start = float(start)
        end = float(end_value) if end_value is not None else start + float(dur) if dur is not None else start + 0.08
        if norm(text) and not norm(text).startswith("no"):
            out.append({"text": text, "start": start, "end": max(end, start + 0.08)})
    return out


def exact_align(target, recognized):
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
            raise RuntimeError(f"Forced alignment mismatch at word {i + 1}/{len(target)}: {word!r}; got {recognized[j:j + 4]}")
        r = recognized[hit]
        out.append({"text": word, "start": r["start"], "end": r["end"], "i": i})
        j = hit + 1
    return out


def recognition_map(target, recognized):
    """Map recognized word timings onto the known script using monotonic fuzzy matching."""
    a = [norm(x) for x in target]
    b = [norm(x["text"]) for x in recognized]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    matches = {}
    for ai, bi, n in sm.get_matching_blocks():
        for k in range(n):
            matches[ai + k] = bi + k

    # Add close fuzzy matches for words SequenceMatcher did not match exactly.
    used = set(matches.values())
    for ai, word in enumerate(a):
        if ai in matches or not word:
            continue
        best = None
        best_score = 0.0
        for bi, got in enumerate(b):
            if bi in used or not got:
                continue
            score = difflib.SequenceMatcher(None, word, got).ratio()
            if score > best_score:
                best_score, best = score, bi
        if best is not None and best_score >= 0.72:
            matches[ai] = best
            used.add(best)

    if len(matches) < max(1, int(len(target) * 0.55)):
        raise RuntimeError(f"Recognition fallback matched only {len(matches)}/{len(target)} script words")

    out = []
    matched_indices = sorted(matches)
    for i, word in enumerate(target):
        bi = matches.get(i)
        if bi is not None:
            r = recognized[bi]
            out.append({"text": word, "start": r["start"], "end": r["end"], "i": i})
            continue
        prev = next((j for j in reversed(matched_indices) if j < i), None)
        nxt = next((j for j in matched_indices if j > i), None)
        if prev is not None and nxt is not None:
            p = recognized[matches[prev]]
            n = recognized[matches[nxt]]
            frac = (i - prev) / (nxt - prev)
            t = p["end"] + (n["start"] - p["end"]) * frac
        elif prev is not None:
            p = recognized[matches[prev]]
            t = p["end"] + 0.08
        elif nxt is not None:
            n = recognized[matches[nxt]]
            t = max(0.0, n["start"] - 0.08)
        else:
            t = 0.0
        out.append({"text": word, "start": t, "end": t + 0.08, "i": i})
    return out


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
        try:
            p = subprocess.run(["pocketsphinx", "align", str(prepared), " ".join(target)], check=True, capture_output=True, text=True)
            print(json.dumps(exact_align(target, parse_words(p.stdout)), separators=(",", ":")))
            return
        except Exception:
            pass

        # Robust fallback: native PocketSphinx word segmentation, then monotonic mapping to the known script.
        p = subprocess.run(["pocketsphinx", "single", str(prepared)], check=True, capture_output=True, text=True)
        recognized = parse_words(p.stdout)
        if not recognized:
            raise RuntimeError("PocketSphinx returned no recognized words")
        print(json.dumps(recognition_map(target, recognized), separators=(",", ":")))
    finally:
        prepared.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
