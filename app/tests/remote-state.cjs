const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const babel=require('/usr/local/lib/node_modules/playwright/lib/transform/babelBundle.js'),file=path.join(__dirname,'../src/terrain/ui/OperationsUI.tsx');
const states=[],effects=[],pending=[];let i=0;
const hooks={useState:v=>{const k=i++;if(!(k in states))states[k]=v;return [states[k],x=>states[k]=typeof x==='function'?x(states[k]):x]},useRef:v=>{const k=i++;if(!(k in states))states[k]={current:v};return states[k]},useCallback:f=>f,useEffect:f=>effects.push(f)};
const mod={exports:{}},req=k=>k==='react'?hooks:k.includes('jsx-runtime')?{}:k==='../domain/response-checks'?{checkedResult:(_,value)=>value}:k==='../domain/core'?{csv:()=>''}:k==='./client'?{request:q=>new Promise((resolve,reject)=>pending.push({q,resolve,reject}))}:null;
vm.runInNewContext('(function(require,module,exports){'+babel.babelTransform(fs.readFileSync(file,'utf8'),file,false,[],undefined).code+'\n})',{setInterval:()=>0,clearInterval:()=>{},setTimeout,document:{visibilityState:'visible'}})(req,mod,mod.exports);
function render(query){i=0;effects.length=0;return mod.exports.useRemote(query)}
(async()=>{
 render('old-period');const cleanupOld=effects[0]();assert.equal(pending[0].q,'old-period');
 render('new-period');cleanupOld();const cleanupNew=effects[0]();assert.equal(pending[1].q,'new-period');
 pending[1].resolve({bonus:10000});await new Promise(setImmediate);assert.equal(states[0].bonus,10000);
 pending[0].resolve({bonus:90000});await new Promise(setImmediate);assert.equal(states[0].bonus,10000,'Old filter response must not overwrite new figures');
 const r=render('new-period');const a=r.reload(),b=r.reload();pending[3].resolve({bonus:20000});await b;pending[2].reject(new Error('stale network failure'));await a;assert.equal(states[0].bonus,20000);assert.equal(states[1],'');
 cleanupNew();const last=r.reload();pending[4].resolve({bonus:30000});await last;assert.equal(states[0].bonus,20000,'Unmounted views cannot update');
 console.log('PASS: stale period responses, superseded errors and unmounted fetches cannot overwrite displayed figures.');
})().catch(e=>{console.error(e);process.exit(1)});
