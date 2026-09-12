import json
import re
import sys
from pathlib import Path


def norm(s):
    return re.sub(r"[^a-z0-9']+", "", str(s).lower().replace("’", "'"))


def words(s):
    return [re.sub(r"^[“”\"']+|[“”\"']+$", "", w).replace("/", "") for w in re.split(r"\s+", str(s).strip()) if w.strip()]


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: whisperx-word-timings.py AUDIO SCRIPT")
    audio = Path(sys.argv[1])
    script = words(sys.argv[2])
    if not audio.exists() or not script:
        raise SystemExit("audio and non-empty script are required")

    import whisperx

    device = "cpu"
    compute_type = "int8"
    model = whisperx.load_model("base", device=device, compute_type=compute_type, language="en")
    result = model.transcribe(str(audio), language="en", batch_size=8, initial_prompt=" ".join(script))
    segments = result.get("segments") or []
    if not segments:
        raise RuntimeError("WhisperX returned no speech segments")

    align_model, metadata = whisperx.load_align_model(language_code="en", device=device)
    aligned = whisperx.align(segments, align_model, metadata, str(audio), device, return_char_alignments=False)
    recognized = aligned.get("word_segments") or []
    if not recognized:
        raise RuntimeError("WhisperX alignment returned no word timestamps")

    target = [norm(x) for x in script]
    source = [norm(x.get("word", "")) for x in recognized]
    out = []
    cursor = 0
    for i, wanted in enumerate(target):
        hit = None
        for j in range(cursor, min(len(source), cursor + 10)):
            if source[j] == wanted:
                hit = j
                break
        if hit is None:
            raise RuntimeError(f"WhisperX could not align script word {i+1}/{len(script)}: {script[i]!r}; nearby={source[cursor:cursor+10]}")
        item = recognized[hit]
        start = float(item.get("start", -1))
        end = float(item.get("end", -1))
        if start < 0 or end <= start:
            raise RuntimeError(f"WhisperX returned invalid timing for {script[i]!r}: {item}")
        out.append({"text": script[i], "start": start, "end": end, "i": i})
        cursor = hit + 1

    prev = -1.0
    for i, item in enumerate(out):
        if item["start"] <= prev:
            raise RuntimeError(f"Non-monotonic real word timing at {i+1}: {item}")
        if item["end"] <= item["start"]:
            raise RuntimeError(f"Collapsed word timing at {i+1}: {item}")
        prev = item["start"]

    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
