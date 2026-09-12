// v18: Gemini word timestamps with resilient script/audio alignment.
const TRANSCRIBE_MODEL='gemini-3.5-transcribe';
const API='https://generativelanguage.googleapis.com';
function env(n){const v=process.env[n];if(!v)throw new Error(`Missing environment variable: ${n}`);return v}
function keys(){return ['GEMINI_API_KEY_1','GEMINI_API_KEY_2','GEMINI_API_KEY_3','GEMINI_API_KEY'].map(n=>process.env[n]).filter(Boolean)}
function out(res,s,b){return res.status(s).json(b)}
function sec(v){const m=String(v??'').match(/^([0-9.]+)s$/);return m?Number(m[1]):NaN}
function norm(v){return String(v||'').toLowerCase().replace(/[’']/g,"'").replace(/[^a-z0-9']+/g,'').trim()}
function annotations(data){const a=[];for(const step of data?.steps||[])for(const content of step?.content||[])for(const x of content?.annotations||[])if(x?.type==='word_info'){const s=sec(x.start_offset),e=sec(x.end_offset),t=String(x.text||'').trim();if(t&&Number.isFinite(s)&&Number.isFinite(e)&&e>=s)a.push({text:t,start:s,end:e})}return a}
function similarity(a,b){const x=norm(a),y=norm(b);if(!x||!y)return 0;if(x===y)return 1;if(x.replace(/'/g,'')===y.replace(/'/g,''))return 1;const m=x.length,n=y.length,dp=Array.from({length:m+1},(_,i)=>{const r=new Array(n+1);r[0]=i;return r});for(let j=1;j<=n;j++)dp[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(x[i-1]===y[j-1]?0:1));const d=dp[m][n];return 1-d/Math.max(m,n)}
function align(script,raw){
  const target=String(script).replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
  const r=raw.map(x=>({...x,k:norm(x.text)}));
  const n=target.length,m=r.length;
  const NEG=-1e9;
  const dp=Array.from({length:n+1},()=>new Array(m+1).fill(NEG));
  const back=Array.from({length:n+1},()=>new Array(m+1).fill(null));
  dp[0][0]=0;
  for(let i=0;i<=n;i++)for(let j=0;j<=m;j++){
    if(i<n && j<m){const sim=similarity(target[i],r[j].text);const score=sim>=0.62?sim*3.2:NEG;if(score>NEG/2 && dp[i][j]+score>dp[i+1][j+1]){dp[i+1][j+1]=dp[i][j]+score;back[i+1][j+1]=['match',i,j]}}
    if(j<m && dp[i][j]-0.55>dp[i][j+1]){dp[i][j+1]=dp[i][j]-0.55;back[i][j+1]=['skip_raw',i,j]}
    if(i<n && dp[i][j]-1.35>dp[i+1][j]){dp[i+1][j]=dp[i][j]-1.35;back[i+1][j]=['skip_target',i,j]}
  }
  const matched=new Array(n).fill(null);let i=n,j=m;
  while(i>0||j>0){const b=back[i][j];if(!b)break;const [kind,pi,pj]=b;if(kind==='match')matched[pi]=r[pj];i=pi;j=pj}
  let matchedCount=matched.filter(Boolean).length;
  if(matchedCount<Math.max(1,Math.floor(n*0.80))) throw new Error(`Gemini alignment matched only ${matchedCount}/${n} script words`);
  let prevEnd=0;
  for(let k=0;k<n;k++)if(matched[k])prevEnd=matched[k].end;
  for(let k=0;k<n;k++){
    if(matched[k])continue;
    let left=k-1;while(left>=0&&!matched[left])left--;
    let right=k+1;while(right<n&&!matched[right])right++;
    const start=left>=0?matched[left].end:0;
    const end=right<n?matched[right].start:start+0.12;
    const count=Math.max(1,right-left-1);
    const span=Math.max(0.12,end-start);
    const idx=k-(left+1)+1;
    const s=start+span*(idx-1)/count;
    const e=start+span*idx/count;
    matched[k]={text:target[k],start:s,end:Math.max(e,s+0.06),interpolated:true};
  }
  const ans=matched.map((x,k)=>({text:target[k],start:Number(x.start),end:Number(x.end),interpolated:Boolean(x.interpolated)}));
  let last=0;for(const x of ans){x.start=Math.max(last,x.start);x.end=Math.max(x.start+0.06,x.end);last=x.end}
  return ans;
}
async function uploadFile(bytes,mime,key){const start=await fetch(`${API}/upload/v1beta/files`,{method:'POST',headers:{'x-goog-api-key':key,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(bytes.length),'X-Goog-Upload-Header-Content-Type':mime,'Content-Type':'application/json'},body:JSON.stringify({file:{display_name:`unmindy-tts-${Date.now()}.wav`}})});const startText=await start.text();if(!start.ok){const e=new Error(`Gemini Files start ${start.status}: ${startText}`);e.status=start.status;throw e}const uploadUrl=start.headers.get('x-goog-upload-url');if(!uploadUrl)throw new Error('Gemini Files API returned no upload URL');const finish=await fetch(uploadUrl,{method:'POST',headers:{'Content-Length':String(bytes.length),'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body:bytes});const d=await finish.json().catch(()=>({}));if(!finish.ok){const e=new Error(`Gemini Files upload ${finish.status}: ${JSON.stringify(d)}`);e.status=finish.status;throw e}const uri=d?.file?.uri;if(!uri)throw new Error(`Gemini Files upload returned no URI: ${JSON.stringify(d)}`);return {uri,name:d?.file?.name}}
async function deleteFile(name,key){if(!name)return;await fetch(`${API}/v1beta/${name}`,{method:'DELETE',headers:{'x-goog-api-key':key}}).catch(()=>{})}
async function transcribeWithKey(bytes,audioUrl,script,key){let uploaded;try{uploaded=await uploadFile(bytes,'audio/wav',key);const gr=await fetch(`${API}/v1beta/interactions`,{method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({model:TRANSCRIBE_MODEL,input:[{type:'audio',uri:uploaded.uri,mime_type:'audio/wav'}],generation_config:{transcription_config:{mode:{type:'verbatim',timestamp_granularities:['word']},language_codes:['en-IN']}}})});const data=await gr.json().catch(()=>({}));if(!gr.ok){const e=new Error(`Gemini transcription ${gr.status}: ${JSON.stringify(data)}`);e.status=gr.status;throw e}const raw=annotations(data);if(!raw.length)throw new Error(`Gemini returned no word timestamps: ${JSON.stringify(data).slice(0,4000)}`);const words=align(script,raw);const expected=String(script).replace(/\s+/g,' ').trim().split(' ').filter(Boolean).length;if(words.length!==expected)throw new Error(`Transcription word count mismatch: timings=${words.length} script=${expected}`);return {words,key}}finally{if(uploaded?.name)await deleteFile(uploaded.name,key)}}
export default async function handler(req,res){try{if(req.method!=='POST')return out(res,405,{error:'POST only'});if(req.headers.authorization!==`Bearer ${env('CRON_SECRET')}`)return out(res,401,{ok:false,error:'Unauthorized'});const {audioUrl,script}=req.body||{};if(!audioUrl||!script)return out(res,400,{ok:false,error:'audioUrl and script are required'});const ar=await fetch(audioUrl);if(!ar.ok)throw new Error(`Audio download failed: ${ar.status}`);const bytes=Buffer.from(await ar.arrayBuffer());if(bytes.length>25*1024*1024)throw new Error(`Audio too large: ${bytes.length}`);const configured=keys();if(!configured.length)throw new Error('No Gemini API key configured. Add GEMINI_API_KEY_1, GEMINI_API_KEY_2, or GEMINI_API_KEY_3.');const failures=[];for(let i=0;i<configured.length;i++){try{const result=await transcribeWithKey(bytes,audioUrl,script,configured[i]);return out(res,200,{ok:true,model:TRANSCRIBE_MODEL,words:result.words,key_slot:i+1})}catch(e){const status=e?.status;failures.push(`key${i+1}: ${e instanceof Error?e.message:String(e)}`);if(status===429||status===403||status===401)continue;throw e}}throw new Error(`All configured Gemini API keys failed. ${failures.join(' | ')}`)}catch(e){console.error(e);return out(res,500,{ok:false,error:e instanceof Error?e.message:String(e)})}}