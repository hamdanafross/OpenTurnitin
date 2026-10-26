(function(){
"use strict";

const $=id=>document.getElementById(id);
const T=window.turnitout;

let currentFile=null, currentFileName='', currentFileType='', cleanedExtension='';
let cleanedBlob=null, cleanedText='', originalText='';
let reviewFlags=[], cancelled=false, aiFailed=false;
let sidecarPort=null;

/* ===================== SETUP FLOW ===================== */

async function initSetup(){
  const status = await T.modelStatus();

  if (!status.sidecarAvailable) {
    showSetupError('The llama-server binary is missing. Run `npm run setup` on your build machine, then rebuild the app.');
    return;
  }

  if (status.installed) {
    // Already have a model — just start it
    showStarting();
    const res = await T.startSidecar();
    if (res.ok) { enterApp(res.port); }
    else { showSetupError('Could not start model:\n' + res.error); }
    return;
  }

  // Fresh install — offer choices
  renderChoices(status);
}

function renderChoices(status){
  const detected = $('setup-detected');
  detected.innerHTML = status.recommended
    ? `Detected <strong>${status.totalRamGB} GB RAM</strong>. Recommended for your machine: <strong>${status.recommended.label}</strong>.`
    : `<strong>Your machine has ${status.totalRamGB} GB RAM</strong>, below the minimum 8 GB. Use the rules-based cleaner instead.`;

  const choices = $('setup-choices');
  choices.innerHTML = '';

  const order = ['Q8_0','Q6_K','Q4_K_M','Q3_QAT','IQ2_XS_QAT'];
  const labels = {
    Q8_0:'Q8_0 — best quality (32 GB RAM)',
    Q6_K:'Q6_K — no measurable loss (16 GB RAM)',
    Q4_K_M:'Q4_K_M — recommended (14 GB RAM)',
    Q3_QAT:'Q3-QAT — small loss (12 GB RAM)',
    IQ2_XS_QAT:'2-bit — lowest quality (8 GB RAM)'
  };
  const sizes = {
    Q8_0:'12.7 GB', Q6_K:'10.0 GB', Q4_K_M:'7.6 GB', Q3_QAT:'5.6 GB', IQ2_XS_QAT:'3.9 GB'
  };

  // Show only the recommended one plus smaller, larger hidden by default
  const recKey = status.recommended?.key;
  for (const key of order) {
    const size = sizes[key];
    const isRec = key === recKey;
    const div = document.createElement('div');
    div.className = 'choice' + (isRec ? ' recommended' : '');
    div.innerHTML = `
      <div>
        <div class="label">${labels[key]}${isRec ? '<span class="rec">Recommended</span>' : ''}</div>
        <div class="meta">Download size: ${size}</div>
      </div>
      <button class="btn" style="padding:.5rem 1.2rem;font-size:.9rem">Download</button>
    `;
    div.querySelector('button').addEventListener('click', () => beginDownload(key));
    choices.appendChild(div);
  }
}

async function beginDownload(quantKey){
  $('setup-choices').classList.add('hidden');
  $('setup-downloading').classList.remove('hidden');
  $('dl-label').textContent = 'Downloading model…';

  const unsub = T.onModelProgress((p) => {
    if (p.verify) {
      $('dl-label').textContent = 'Verifying file…';
      $('dl-stats').textContent = '';
      return;
    }
    const pct = Math.round(p.percent * 100);
    $('dl-bar').style.width = pct + '%';
    $('dl-stats').textContent = `${formatBytes(p.received)} / ${formatBytes(p.total)} (${pct}%)`;
  });

  const res = await T.downloadModel(quantKey);
  unsub();

  if (!res.ok) {
    showSetupError('Download failed:\n' + res.error);
    return;
  }
  showStarting();
  const start = await T.startSidecar();
  if (start.ok) enterApp(start.port);
  else showSetupError('Model downloaded but failed to load:\n' + start.error);
}

function showStarting(){
  $('setup-choices').classList.add('hidden');
  $('setup-downloading').classList.add('hidden');
  $('setup-starting').classList.remove('hidden');
}
function showSetupError(msg){
  $('setup-choices').classList.add('hidden');
  $('setup-downloading').classList.add('hidden');
  $('setup-starting').classList.add('hidden');
  $('setup-error').classList.remove('hidden');
  $('setup-error-text').textContent = msg;
}

$('dl-cancel').addEventListener('click', () => T.cancelDownload());
$('setup-retry').addEventListener('click', () => { $('setup-error').classList.add('hidden'); initSetup(); });
$('use-rules-only').addEventListener('click', (e) => {
  e.preventDefault();
  enterApp(null); // null port → rules mode
});

function enterApp(port){
  sidecarPort = port;
  $('setup-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  const pill = $('model-pill');
  if (port) {
    pill.textContent = 'Model: ready';
    pill.className = 'status-pill';
  } else {
    pill.textContent = 'Rules only';
    pill.className = 'status-pill warn';
    aiFailed = true;
  }
  if (port) {
    T.onSidecarStopped(() => {
      pill.textContent = 'Model: stopped';
      pill.className = 'status-pill bad';
      aiFailed = true;
    });
  }
}

function formatBytes(n){
  if (n > 1e9) return (n/1e9).toFixed(2) + ' GB';
  if (n > 1e6) return (n/1e6).toFixed(1) + ' MB';
  if (n > 1e3) return (n/1e3).toFixed(0) + ' KB';
  return n + ' B';
}

/* ===================== CLEANING ENGINE ===================== */

const countWords = s => (s.trim().match(/\S+/g)||[]).length;
const cjkCount = s => (s.match(/[\u4e00-\u9fff]/g)||[]).length;

function cleanHiddenChars(text){
  return text.replace(/[\u200B-\u200D\uFEFF\u2060\u180E\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,'');
}

function numbersIn(s){
  return (s.match(/\d[\d.,]*/g)||[]).map(x=>x.replace(/[.,]+$/,'').replace(/,/g,'')).filter(x=>x.length);
}

function chunkText(text,max){
  const t=text.replace(/\s+/g,' ').trim();
  if(!t) return [];
  if(t.length<=max) return [t];
  const sents=t.match(/[^.!?]+[.!?]+["')\]]*|\S+$/g)||[t];
  const out=[]; let cur='';
  for(const raw of sents){
    const s=raw.trim(); if(!s) continue;
    if(cur && (cur+' '+s).length>max){ out.push(cur.trim()); cur=s; }
    else cur=cur?cur+' '+s:s;
  }
  if(cur.trim()) out.push(cur.trim());
  return out;
}

function redistribute(originals,newText){
  const total=originals.reduce((a,b)=>a+b.length,0);
  if(!total) return originals;
  const out=[]; let rem=newText;
  for(let i=0;i<originals.length;i++){
    if(i===originals.length-1){ out.push(rem); rem=''; break; }
    const len=Math.max(0,Math.round(newText.length*(originals[i].length/total)));
    out.push(rem.slice(0,len)); rem=rem.slice(len);
  }
  return out;
}

/* ---------- Rule-based fallback (same as before) ---------- */
const SYNONYMS={"utilize":["use"],"commence":["start","begin"],"terminate":["end","stop"],"demonstrate":["show"],"approximately":["about"],"additional":["extra","more"],"numerous":["many"],"furthermore":["also","plus"],"however":["but","yet"],"therefore":["so"],"consequently":["so"],"nevertheless":["still","even so"],"in order to":["to"],"due to the fact that":["because"],"a large number of":["many"],"it is important to note that":[""],"it should be noted that":[""],"in the event that":["if"],"at this point in time":["now"],"on a daily basis":["daily"],"in the near future":["soon"],"despite the fact that":["although"],"for the purpose of":["to"],"with regard to":["about"],"in relation to":["about"],"a majority of":["most"],"a number of":["some","many"],"have the ability to":["can"],"is able to":["can"],"make a decision":["decide"],"take into consideration":["consider"],"conduct an investigation":["investigate"],"provide assistance":["help"],"give rise to":["cause"],"in the process of":[""],"the majority of":["most"],"in spite of":["despite"],"as a result of":["because of"],"in the absence of":["without"],"prior to":["before"],"subsequent to":["after"],"in close proximity to":["near"],"a sufficient amount of":["enough"],"in the course of":["during"],"for the reason that":["because"],"by means of":["by"],"in a timely manner":["quickly"],"with the exception of":["except"],"on account of":["because of"],"in the vicinity of":["near"],"it is possible that":["maybe"],"there is a possibility that":["maybe"],"has the capacity to":["can"],"is capable of":["can"]};
let synonymQueues={};
function getSynonym(word){
  const k=word.toLowerCase();
  if(!SYNONYMS[k]) return word;
  if(!synonymQueues[k]) synonymQueues[k]=[...SYNONYMS[k]];
  const q=synonymQueues[k]; const rep=q.shift(); q.push(rep); return rep;
}
function applySynonymRules(text){
  let result=text;
  const phrases=Object.keys(SYNONYMS).sort((a,b)=>b.length-a.length);
  for(const phrase of phrases){
    const esc=phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp('\\b'+esc+'\\b','gi');
    result=result.replace(re,(match)=>{
      const rep=getSynonym(phrase); if(!rep) return '';
      return match[0]===match[0].toUpperCase()?rep.charAt(0).toUpperCase()+rep.slice(1):rep;
    });
  }
  return result.replace(/[ \t]{2,}/g,' ');
}
function shatterNgrams(text){
  const words=text.split(/(\s+)/);
  const toks=words.filter(w=>w.trim().length);
  if(toks.length<4) return text;
  const freq={};
  for(let i=0;i<toks.length-1;i++){ const bg=toks[i].toLowerCase()+' '+toks[i+1].toLowerCase(); freq[bg]=(freq[bg]||0)+1; }
  const out=[...toks]; const used=new Set();
  for(let i=0;i<toks.length-1;i++){
    const bg=toks[i].toLowerCase()+' '+toks[i+1].toLowerCase();
    if(freq[bg]>1&&!used.has(i)&&!used.has(i+1)){ const syn=getSynonym(toks[i+1]); if(syn!==toks[i+1]){ out[i+1]=syn; used.add(i); used.add(i+1); } }
  }
  let ti=0; return words.map(w=>w.trim().length?out[ti++]:w).join('');
}
function humanizeWithRules(text,strength){
  if(strength==='light') return applySynonymRules(text);
  let r=applySynonymRules(text); r=shatterNgrams(r); return r;
}

/* ---------- Local model client ---------- */
const PROMPT={
  instr:"Rewrite the text below so it reads like a person wrote it, not a language model.\n\nReorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\nthroat-clearing, and any sentence that only announces what comes next.\nPrefer the concrete word over the abstract one. It is fine to sound uneven.\n\nEvery fact, number, unit, date, name and quotation must survive unchanged.",
  sep:"\n\n### Rewritten:\n\n"
};
function buildPrompt(draft){
  return PROMPT.instr+"\n\n"+draft.replace(/^\s+/,'').replace(/\s+$/,'')+PROMPT.sep;
}

let chain=Promise.resolve();
function enqueue(fn){ const p=chain.then(fn); chain=p.catch(()=>{}); return p; }

async function callModel(draft){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),180000);
  try{
    const res=await fetch(`http://127.0.0.1:${sidecarPort}/completion`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        prompt:buildPrompt(draft),
        temperature:1.0, top_p:0.95, top_k:0, min_p:0, repeat_penalty:1.0,
        n_predict:2048, seed:Math.floor(Math.random()*1e9)
      }),
      signal:ctrl.signal
    });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const j=await res.json();
    const out=(j.content||'').trim();
    if(!out) throw new Error('empty response');
    return out;
  } finally { clearTimeout(timer); }
}

function verifyRewrite(original,out){
  const problems=[];
  if(!out||out.length<5) return ['empty output'];
  const origCount={}, outCount={};
  for(const n of numbersIn(original)) origCount[n]=(origCount[n]||0)+1;
  for(const n of numbersIn(out))      outCount[n]=(outCount[n]||0)+1;
  const missing=[];
  for(const n in origCount){ if((outCount[n]||0)<origCount[n]) missing.push(n); }
  if(missing.length) problems.push('missing number(s): '+missing.slice(0,6).join(', '));
  if(cjkCount(original)<2 && cjkCount(out)>5) problems.push('wrong language');
  if(cjkCount(original)>5 && cjkCount(out)===0) problems.push('wrong language');
  if(original.length>120){
    if(out.length<original.length*0.45) problems.push('output much shorter');
    if(out.length>original.length*2.2)  problems.push('output much longer');
  }
  return problems;
}

function recordFlag(reason,original,rewritten){
  reviewFlags.push({reason,original:original.slice(0,180),rewritten:rewritten.slice(0,180)});
}

async function rewriteSegment(text,opts){
  const rules=()=>({text:humanizeWithRules(text,opts.strength),flagged:false});
  if(!opts.useAI||aiFailed||!sidecarPort) return rules();
  if(countWords(text)<opts.minWords) return rules();

  let lastOut=null,lastProblems=[];
  for(let i=0;i<opts.attempts;i++){
    if(cancelled) return rules();
    let out;
    try { out=await enqueue(()=>callModel(text)); }
    catch(e){ aiFailed=true; return rules(); }
    const problems=verifyRewrite(text,out);
    if(problems.length===0) return {text:out,flagged:false};
    lastOut=out; lastProblems=problems; progress.tick();
  }
  recordFlag(lastProblems.join('; '),text,lastOut||'');
  return {text:lastOut||rules().text,flagged:true};
}

async function rewriteProse(text,opts){
  const chunks=chunkText(text,1200);
  const out=[];
  for(const c of chunks){
    if(cancelled){ out.push(c); continue; }
    const r=await rewriteSegment(c,opts);
    out.push(r.text); progress.tick();
  }
  return out.join(' ');
}

/* ---------- LaTeX ---------- */
const LATEX_PROTECTED=new RegExp(['\\$\\$[\\s\\S]*?\\$\\$','\\$[^$\\n]*?\\$','\\\\\\[[\\s\\S]*?\\\\\\]','\\\\\\([\\s\\S]*?\\\\\\)','\\\\begin\\{[^}]*\\}[\\s\\S]*?\\\\end\\{[^}]*\\}','\\\\cite[a-zA-Z]*\\{[^}]*\\}','\\\\ref\\{[^}]*\\}','\\\\eqref\\{[^}]*\\}','\\\\label\\{[^}]*\\}','\\\\url\\{[^}]*\\}','\\\\href\\{[^}]*\\}\\{[^}]*\\}','\\\\includegraphics(?:\\[[^\\]]*\\])?\\{[^}]*\\}','\\\\[a-zA-Z@]+\\*?(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})*'].join('|'),'g');

async function rewriteLatex(text,opts){
  const parts=[]; let last=0;
  for(const m of text.matchAll(LATEX_PROTECTED)){
    if(m.index>last) parts.push({prose:true,s:text.slice(last,m.index)});
    parts.push({prose:false,s:m[0]});
    last=m.index+m[0].length;
  }
  if(last<text.length) parts.push({prose:true,s:text.slice(last)});
  const out=[];
  for(const p of parts){
    if(!p.prose){ out.push(p.s); continue; }
    const trimmed=p.s.trim();
    if(!trimmed||countWords(trimmed)<opts.minWords||cancelled){ out.push(p.s); continue; }
    const r=await rewriteSegment(trimmed,opts);
    out.push(p.s.replace(trimmed,r.text));
    progress.tick();
  }
  return out.join('');
}

/* ---------- Code comments ---------- */
function scanComments(src,lang){
  const comments=[]; const n=src.length; let i=0;
  const pyLike=(lang==='python'||lang==='bash'||lang==='ruby'||lang==='yaml');
  const htmlLike=(lang==='html'||lang==='xml');
  function readString(q){ i++; while(i<n){ if(src[i]==='\\'){ i+=2; continue; } if(src[i]===q){ i++; return; } i++; } }
  function readTriple(q){ i+=3; while(i<n){ if(src[i]==='\\'){ i+=2; continue; } if(src.startsWith(q+q+q,i)){ i+=3; return; } i++; } }
  while(i<n){
    const c=src[i];
    if(c==='"'||c==="'"||c==='`'){ if(lang==='python'&&src.startsWith(c+c+c,i)){ readTriple(c); continue; } readString(c); continue; }
    if(htmlLike&&src.startsWith('<!--',i)){ const end=src.indexOf('-->',i+4); const stop=end===-1?n:end+3; comments.push({start:i,end:stop,prefix:'<!--',suffix:'-->',body:src.slice(i+4,end===-1?n:end)}); i=stop; continue; }
    if(pyLike&&c==='#'){ let end=src.indexOf('\n',i); if(end===-1) end=n; comments.push({start:i,end,prefix:'#',suffix:'',body:src.slice(i+1,end)}); i=end; continue; }
    if(!pyLike&&src.startsWith('/*',i)){ const end=src.indexOf('*/',i+2); const stop=end===-1?n:end+2; comments.push({start:i,end:stop,prefix:'/*',suffix:'*/',body:src.slice(i+2,end===-1?n:end)}); i=stop; continue; }
    if(!pyLike&&src.startsWith('//',i)){ let end=src.indexOf('\n',i); if(end===-1) end=n; comments.push({start:i,end,prefix:'//',suffix:'',body:src.slice(i+2,end)}); i=end; continue; }
    i++;
  }
  return comments;
}

async function rewriteCommentBody(body,opts){
  if(!body.includes('\n')){
    const trimmed=body.trim();
    if(!trimmed||countWords(trimmed)<opts.minWords||cancelled) return body;
    const r=await rewriteSegment(trimmed,opts);
    progress.tick();
    const lead=body.match(/^\s*/)[0], trail=body.match(/\s*$/)[0];
    return lead+r.text+trail;
  }
  const lines=body.split('\n');
  const metas=lines.map(l=>{ const m=l.match(/^(\s*(?:\*\s*)?)([\s\S]*)$/); return {prefix:m[1],content:m[2]}; });
  const joined=metas.map(m=>m.content.trim()).filter(Boolean).join(' ');
  if(!joined||countWords(joined)<opts.minWords||cancelled) return body;
  const r=await rewriteSegment(joined,opts);
  progress.tick();
  const redistributed=redistribute(metas.map(m=>m.content),r.text);
  return metas.map((m,idx)=>m.prefix+redistributed[idx]).join('\n');
}

async function rewriteCode(code,lang,opts){
  const comments=scanComments(code,lang);
  let out=code;
  for(let k=comments.length-1;k>=0;k--){
    const cm=comments[k];
    if(cancelled) break;
    const newBody=await rewriteCommentBody(cm.body,opts);
    if(newBody===cm.body) continue;
    out=out.slice(0,cm.start)+cm.prefix+newBody+cm.suffix+out.slice(cm.end);
  }
  return out;
}

/* ---------- DOCX ---------- */
const W_NS='http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function processDocx(arrayBuffer,opts){
  const zip=await JSZip.loadAsync(arrayBuffer);
  const docFile=zip.file('word/document.xml');
  if(!docFile) throw new Error('Not a valid .docx');
  const xml=await docFile.async('string');
  const parser=new DOMParser();
  const doc=parser.parseFromString(xml,'application/xml');

  const paragraphs=Array.from(doc.getElementsByTagNameNS(W_NS,'p'));
  for(const p of paragraphs){
    if(cancelled) break;
    const runs=Array.from(p.getElementsByTagNameNS(W_NS,'t'));
    if(!runs.length) continue;
    const original=runs.map(t=>t.textContent).join('');
    if(!original.trim()) continue;
    if(countWords(original)<opts.minWords){ progress.tick(); continue; }
    const rewritten=await rewriteProse(original,opts);
    const pieces=redistribute(runs.map(t=>t.textContent),rewritten);
    runs.forEach((t,idx)=>{ t.textContent=pieces[idx]||''; });
    progress.tick();
  }

  if($('opt-meta').checked){
    ['docProps/core.xml','docProps/app.xml','docProps/custom.xml','docProps/thumbnail.jpeg','docProps/thumbnail.jpg'].forEach(f=>zip.remove(f));
  }
  const newXml=new XMLSerializer().serializeToString(doc);
  zip.file('word/document.xml',newXml);
  const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',compression:'DEFLATE'});
  const previewDoc=parser.parseFromString(newXml,'application/xml');
  const previewText=Array.from(previewDoc.getElementsByTagNameNS(W_NS,'p')).map(p=>Array.from(p.getElementsByTagNameNS(W_NS,'t')).map(t=>t.textContent).join('')).join('\n');
  return {blob,previewText};
}

/* ---------- Progress + orchestration ---------- */
const progress={
  total:0, done:0,
  start(t){ this.total=Math.max(t,1); this.done=0; $('progress').classList.remove('hidden'); this.render(); },
  tick(){ this.done++; this.render(); },
  render(){ const pct=Math.min(100,Math.round(100*this.done/this.total)); $('progress').firstElementChild.style.width=pct+'%'; if(this.done>=this.total) setTimeout(()=>$('progress').classList.add('hidden'),400); },
  reset(){ this.total=0; this.done=0; $('progress').classList.add('hidden'); $('progress').firstElementChild.style.width='0'; }
};

function opts(){
  const strength=document.querySelector('input[name=strength]:checked').value;
  const useAI=!!sidecarPort && !aiFailed;
  return {
    strength, useAI,
    attempts: strength==='light'?1:strength==='medium'?2:3,
    minWords: useAI?8:0,
    hidden: $('opt-hidden').checked,
    rewrite: $('opt-rewrite').checked
  };
}

function getFileType(ext){
  if(ext==='docx') return 'docx';
  if(['tex','latex','sty'].includes(ext)) return 'tex';
  if(['py','js','ts','jsx','tsx','java','cpp','cc','c','h','hpp','cs','go','rs','rb','sh','bash','zsh','html','htm','xml','css','scss','json','yaml','yml','sql','php','swift','kt','toml','ini'].includes(ext)) return 'code';
  return 'text';
}
function getLanguage(ext){
  return ({py:'python',js:'javascript',ts:'typescript',jsx:'javascript',tsx:'typescript',java:'java',cpp:'cpp',cc:'cpp',c:'c',h:'c',hpp:'cpp',cs:'csharp',go:'go',rs:'rust',rb:'ruby',sh:'bash',bash:'bash',zsh:'bash',html:'html',htm:'html',xml:'xml',css:'css',scss:'css',json:'json',yaml:'yaml',yml:'yaml',sql:'sql',php:'php',swift:'swift',kt:'kotlin',toml:'generic',ini:'generic'})[ext]||'generic';
}

function renderFlags(){
  const box=$('flags'), list=$('flags-list');
  if(!reviewFlags.length){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  list.innerHTML='';
  reviewFlags.forEach(f=>{
    const li=document.createElement('li');
    li.textContent=f.reason;
    const o=document.createElement('span'); o.className='orig'; o.textContent='“'+f.original.replace(/\s+/g,' ')+'…”';
    li.appendChild(o); list.appendChild(li);
  });
}

async function run(){
  cancelled=false; aiFailed=!!(sidecarPort===null) ? aiFailed : false; reviewFlags=[];
  // Only reset aiFailed if the sidecar is actually running
  if (sidecarPort) aiFailed = false;

  const o=opts();
  const status=$('status');
  status.className='status'; status.textContent='';
  $('process-btn').disabled=true;
  $('cancel-btn').classList.remove('hidden');
  $('preview-section').classList.add('hidden');

  try{
    let inputText='', type='text', ext='txt', lang='generic', file=currentFile;

    if(file){
      ext=file.name.split('.').pop().toLowerCase();
      type=getFileType(ext);
      currentFileName=file.name;
      cleanedExtension=ext;
    }else{
      inputText=$('paste-input').value;
      if(!inputText.trim()){ alert('Please upload a file or paste some text.'); return; }
      currentFileName='pasted-text.txt'; cleanedExtension='txt';
      if(/\\documentclass|\\begin\{|\\section\{|\\cite\{/.test(inputText)) type='tex';
      else if(/^(?:\s*(?:\/\/|#|\/\*|"""|'''|<!))|\b(?:function|const|let|var|class|def|import|public|private)\b/m.test(inputText)) type='code';
      else type='text';
    }

    status.innerHTML='<span class="spinner"></span>Preparing…';
    progress.start(1);

    if(type==='docx'){
      const arrayBuffer=await file.arrayBuffer();
      originalText='[DOCX: '+file.name+']';
      $('original-preview').textContent=originalText;
      $('original-badge').textContent='DOCX';
      status.innerHTML='<span class="spinner"></span>Cleaning DOCX…';
      progress.total=Math.max(1,arrayBuffer.byteLength/2000);
      const {blob,previewText}=await processDocx(arrayBuffer,o);
      if(cancelled){ status.textContent='Cancelled.'; return; }
      cleanedBlob=blob; cleanedText=previewText;
      $('cleaned-badge').textContent='DOCX · formatting preserved';
    }else{
      if(!inputText) inputText=await file.text();
      originalText=inputText;
      $('original-preview').textContent=inputText;
      $('original-badge').textContent=ext.toUpperCase();
      let src=inputText;
      if(o.hidden) src=cleanHiddenChars(src);
      if(o.rewrite){
        if(type==='tex'){ status.innerHTML='<span class="spinner"></span>Rewriting LaTeX prose…'; cleanedText=await rewriteLatex(src,o); }
        else if(type==='code'){ status.innerHTML='<span class="spinner"></span>Rewriting comments…'; cleanedText=await rewriteCode(src,lang,o); }
        else{ status.innerHTML='<span class="spinner"></span>Rewriting text…'; cleanedText=await rewriteProse(src,o); }
      }else cleanedText=src;
      if(cancelled){ status.textContent='Cancelled.'; return; }
      cleanedBlob=new Blob([cleanedText],{type:'text/plain;charset=utf-8'});
      $('cleaned-badge').textContent=(type||'text').toUpperCase()+' · cleaned';
    }

    $('cleaned-preview').textContent=cleanedText;
    renderFlags();
    $('preview-section').classList.remove('hidden');
    status.className='status success';
    status.textContent = reviewFlags.length ? 'Done — '+reviewFlags.length+' segment(s) need a quick check (see below).' : 'Done.';
    $('preview-section').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){
    console.error(e);
    status.className='status error';
    status.textContent='Error: '+e.message;
  }finally{
    progress.reset();
    $('process-btn').disabled=false;
    $('cancel-btn').classList.add('hidden');
  }
}

/* ---------- Wiring ---------- */
$('process-btn').addEventListener('click',run);
$('cancel-btn').addEventListener('click',()=>{ cancelled=true; $('status').textContent='Cancelling…'; });

const fileInput=$('file-input'), fileNameEl=$('file-name'), dropZone=$('drop-zone');
function pickFile(file){
  if(!file) return;
  currentFile=file;
  fileNameEl.textContent='📎 '+file.name;
  fileNameEl.classList.remove('hidden');
  $('paste-input').value='';
}
fileInput.addEventListener('change',e=>pickFile(e.target.files[0]));
dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('dragover');});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragover');pickFile(e.dataTransfer.files[0]);});
$('paste-input').addEventListener('input',()=>{ if($('paste-input').value.trim()){ currentFile=null; fileNameEl.classList.add('hidden'); fileInput.value=''; } });

$('download-btn').addEventListener('click',()=>{
  if(!cleanedBlob) return;
  const base=currentFileName.replace(/\.[^.]+$/,'')||'document';
  const a=document.createElement('a');
  a.href=URL.createObjectURL(cleanedBlob);
  a.download=base+'_cleaned.'+(cleanedExtension||'txt');
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});

$('reset-btn').addEventListener('click',()=>{
  currentFile=null; currentFileName=''; currentFileType=''; cleanedExtension='';
  cleanedBlob=null; cleanedText=''; originalText=''; reviewFlags=[];
  cancelled=false; synonymQueues={};
  fileInput.value=''; $('paste-input').value='';
  fileNameEl.classList.add('hidden');
  $('preview-section').classList.add('hidden');
  $('status').textContent=''; $('status').className='status';
  progress.reset();
  window.scrollTo({top:0,behavior:'smooth'});
});

/* ---------- Boot ---------- */
initSetup();
})();