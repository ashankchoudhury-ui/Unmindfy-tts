import json
import re
import sys
from pocketsphinx import AudioFile


def norm(s):
    return re.sub(r"[^a-z0-9']+", "", str(s).lower().replace("’", "'"))


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: local-word-timings.py AUDIO SCRIPT")
    audio, script = sys.argv[1], sys.argv[2]
    target = [w.strip("\"'“”.,!?;:()[]{}") for w in re.split(r"\s+", script.strip()) if w.strip()]
    recognized = []
    for phrase in AudioFile(audio_file=audio, no_search=True, frate=100):
        for seg in phrase.segments(detailed=True):
            word = str(seg.word)
            if word in {"<s>", "</s>", "<sil>", "<silence>"}:
                continue
            start = float(seg.start_frame) / 100.0
            end = float(seg.end_frame + 1) / 100.0
            recognized.append({"text": word, "start": start, "end": max(end, start + 0.08)})
    if not recognized:
        raise RuntimeError("Local ASR returned no word timings")
    # Sequentially align the known TTS script to the audio-derived recognition.
    out = []
    j = 0
    matched = 0
    for i, word in enumerate(target):
        k = norm(word)
        hit = None
        for p in range(j, min(len(recognized), j + 8)):
            if norm(recognized[p]["text"]) == k:
                hit = p
                break
        if hit is not None:
            r = recognized[hit]
            out.append({"text": word, "start": r["start"], "end": r["end"], "i": i})
            j = hit + 1
            matched += 1
        else:
            out.append({"text": word, "start": None, "end": None, "i": i})
    if matched < int(len(target) * 0.75):
        raise RuntimeError(f"Local ASR alignment too weak: {matched}/{len(target)}")
    for i, x in enumerate(out):
        if x["start"] is not None:
            continue
        p = i - 1
        while p >= 0 and out[p]["start"] is None:
            p -= 1
        n = i + 1
        while n < len(out) and out[n]["start"] is None:
            n += 1
        if p >= 0 and n < len(out):
            gap = max(0.08, (out[n]["start"] - out[p]["end"]) / (n - p))
            x["start"] = out[p]["end"] + gap * (i - p)
            x["end"] = min(out[n]["start"], x["start"] + max(0.08, gap * 0.7))
        elif p >= 0:
            x["start"] = out[p]["end"]
            x["end"] = x["start"] + 0.12
        elif n < len(out):
            x["end"] = out[n]["start"]
            x["start"] = max(0.0, x["end"] - 0.12)
        else:
            raise RuntimeError("Unable to recover missing word timing")
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
