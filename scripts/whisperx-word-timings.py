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
    result = model.transcribe(str(audio), language="en", batch_size=8)
    if not (result.get("segments") or []):
        raise RuntimeError("WhisperX returned no speech segments")

    # Use WhisperX's CTC forced aligner against the exact narration script. This
    # prevents ASR omissions of short words from destroying the word timeline.
    align_model, metadata = whisperx.load_align_model(language_code="en", device=device)
    audio_array = whisperx.load_audio(str(audio))
    duration = len(audio_array) / 16000.0
    aligned = whisperx.align(
        [{"start": 0.0, "end": duration, "text": " ".join(script)}],
        align_model,
        metadata,
        audio_array,
        device,
        return_char_alignments=False,
    )
    recognized = aligned.get("word_segments") or []
    if len(recognized) < len(script):
        raise RuntimeError(f"WhisperX script alignment returned only {len(recognized)}/{len(script)} words")

    out = []
    for i, (wanted, item) in enumerate(zip(script, recognized)):
        got = norm(item.get("word", ""))
        if got != norm(wanted):
            raise RuntimeError(
                f"WhisperX script alignment mismatch at word {i+1}/{len(script)}: "
                f"wanted={wanted!r} got={item.get('word')!r}"
            )
        start = float(item.get("start", -1))
        end = float(item.get("end", -1))
        if start < 0 or end <= start:
            raise RuntimeError(f"WhisperX returned invalid real timing for {wanted!r}: {item}")
        out.append({"text": wanted, "start": start, "end": end, "i": i, "group": i})

    prev = -1.0
    for i, item in enumerate(out):
        if item["start"] < prev:
            raise RuntimeError(f"Non-monotonic real word timing at {i+1}: {item}")
        if item["end"] <= item["start"]:
            raise RuntimeError(f"Collapsed word timing at {i+1}: {item}")
        prev = item["start"]

    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
