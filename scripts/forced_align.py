import json, sys, tempfile, urllib.request, os
import whisperx

audio_url=sys.argv[1]
script=' '.join(sys.argv[2:]).strip()
fd,path=tempfile.mkstemp(suffix='.wav'); os.close(fd)
try:
    urllib.request.urlretrieve(audio_url,path)
    audio=whisperx.load_audio(path)
    device='cpu'
    model_a, metadata=whisperx.load_align_model(language_code='en', device=device)
    duration=len(audio)/16000.0
    result=whisperx.align([{'start':0.0,'end':duration,'text':script}], model_a, metadata, audio, device, return_char_alignments=False)
    words=result.get('word_segments') or []
    target=[w for w in script.split() if w]
    if len(words) != len(target):
        raise RuntimeError(f'Forced alignment returned {len(words)} words for {len(target)} script words')
    out=[]
    for i,(txt,w) in enumerate(zip(target,words)):
        if w.get('start') is None or w.get('end') is None:
            raise RuntimeError(f'Missing forced timing at word {i+1}: {txt}')
        out.append({'text':txt,'start':float(w['start']),'end':float(w['end'])})
    print(json.dumps({'words':out}))
finally:
    try: os.remove(path)
    except OSError: pass
