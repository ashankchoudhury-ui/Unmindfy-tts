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
    dst=Path(tempfile.mktemp(suffix='.wav'))
    try:
        subprocess.run(["ffmpeg","-y","-v","error","-i",audio,"-ac","1","-ar","16000","-sample_fmt","s16",str(dst)],check=True)
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise

def parse_words(stdout):
    data=json.loads(stdout.strip()); raw=data.get('w') or data.get('words') or []; out=[]
    for x in raw:
        text=str(x.get('t') or x.get('word') or x.get('text') or '').strip(); start=x.get('b',x.get('start')); dur=x.get('d',x.get('duration')); end=x.get('e',x.get('end'))
        if not text or start is None: continue
        start=float(start); end=float(end) if end is not None else start+float(dur) if dur is not None else start+.08
        out.append({'text':text,'start':start,'end':max(end,start+.08)})
    return out

def exact_align(target,recognized):
    out=[]; j=0
    for i,word in enumerate(target):
        k=norm(word); hit=None
        for p in range(j,min(len(recognized),j+5)):
            if norm(recognized[p]['text'])==k: hit=p; break
        if hit is None: raise RuntimeError(f'Forced alignment mismatch at word {i+1}/{len(target)}: {word!r}; got {recognized[j:j+5]}')
        r=recognized[hit]; out.append({'text':word,'start':r['start'],'end':r['end'],'i':i}); j=hit+1
    return out

def recognition_map(target,recognized):
    a=[norm(x) for x in target]; b=[norm(x['text']) for x in recognized]; matches={}
    for ai,bi,n in difflib.SequenceMatcher(a=a,b=b,autojunk=False).get_matching_blocks():
        for k in range(n): matches[ai+k]=bi+k
    used=set(matches.values())
    for ai,word in enumerate(a):
        if ai in matches or not word: continue
        best=None; score0=0
        for bi,got in enumerate(b):
            if bi in used or not got: continue
            score=difflib.SequenceMatcher(None,word,got).ratio()
            if score>score0: score0,best=score,bi
        if best is not None and score0>=.72: matches[ai]=best; used.add(best)
    if len(matches)<max(1,int(len(target)*.55)): raise RuntimeError(f'Recognition fallback matched only {len(matches)}/{len(target)} script words')
    matched=sorted(matches); out=[]
    for i,word in enumerate(target):
        bi=matches.get(i)
        if bi is not None:
            r=recognized[bi]; out.append({'text':word,'start':r['start'],'end':r['end'],'i':i}); continue
        prev=next((j for j in reversed(matched) if j<i),None); nxt=next((j for j in matched if j>i),None)
        if prev is not None and nxt is not None:
            p,n=recognized[matches[prev]],recognized[matches[nxt]]; frac=(i-prev)/(nxt-prev); t=p['end']+(n['start']-p['end'])*frac
        elif prev is not None: t=recognized[matches[prev]]['end']+.08
        elif nxt is not None: t=max(0,recognized[matches[nxt]]['start']-.08)
        else: t=0
        out.append({'text':word,'start':t,'end':t+.08,'i':i})
    fixed=[]; prev=-1
    for i,x in enumerate(out):
        s=max(float(x['start']),prev+0.001); e=max(float(x['end']),s+.08); fixed.append({'text':x['text'],'start':s,'end':e,'i':i}); prev=s
    return fixed

def main():
    if len(sys.argv)!=3: raise SystemExit('usage: local-word-timings.py AUDIO SCRIPT')
    target=[w.strip('"\'“”.,!?;:()[]{}…') for w in re.split(r'\s+',sys.argv[2].strip()) if w.strip()]
    if not target: raise SystemExit('script must contain at least one word')
    prepared=prepare_audio(sys.argv[1])
    try:
        try:
            p=subprocess.run(['pocketsphinx','align',str(prepared),' '.join(target)],check=True,capture_output=True,text=True)
            print(json.dumps(exact_align(target,parse_words(p.stdout)),separators=(',',':'))); return
        except Exception as align_error:
            print(f'PocketSphinx align failed; using recognition fallback: {align_error}',file=sys.stderr)
        p=subprocess.run(['pocketsphinx','single',str(prepared)],check=True,capture_output=True,text=True)
        recognized=parse_words(p.stdout)
        if not recognized: raise RuntimeError('PocketSphinx returned no recognized words')
        print(json.dumps(recognition_map(target,recognized),separators=(',',':')))
    finally: prepared.unlink(missing_ok=True)

if __name__=='__main__': main()
