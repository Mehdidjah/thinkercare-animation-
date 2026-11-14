const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const babel=require('/usr/local/lib/node_modules/playwright/lib/transform/babelBundle.js'),root=path.resolve(__dirname,'../src/terrain'),cache={};
function load(name){if(cache[name])return cache[name];const mod={exports:{}};const code=babel.babelTransform(fs.readFileSync(path.join(root,name+'.ts'),'utf8'),name+'.ts',false,[],undefined).code;
vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{URLSearchParams,Response,Request,Uint8Array,File,crypto})(id=>id==='./QuickTools'?{compress:async file=>file}:load(id.replace('./','')),mod,mod.exports);return cache[name]=mod.exports;}
const {photoFormData}=load('api/body.server'),{checkedResult,photoPath}=load('domain/response-checks'),{selectPhotos}=load('ui/field-photo-client');
(async()=>{
 const form=new FormData();form.set('note_id','fixture');form.set('photo',new File([new Uint8Array([255,216,255,217])],'fixture.jpg',{type:'image/jpeg'}));
 const request=new Request('https://example.test/api/field-photos',{method:'POST',body:form});
 const parsed=await photoFormData(request);assert.equal(parsed.get('note_id'),'fixture');assert.equal(parsed.get('photo').size,4);
 let cancelled=false,index=0;const stream=new ReadableStream({pull(controller){index++;controller.enqueue(new Uint8Array(1000000))},cancel(){cancelled=true}});
 const oversized=new Request('https://example.test/api/field-photos',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=test'},body:stream,duplex:'half'});
 await assert.rejects(()=>photoFormData(oversized),e=>e.status===413);assert.equal(cancelled,true);
 await assert.rejects(()=>photoFormData(new Request('https://example.test',{method:'POST',body:'not multipart'})),e=>e.status===415);
 const id='11111111-1111-4111-8111-111111111111';assert.equal(photoPath(id),'/api/field-photos?id='+id);assert.throws(()=>photoPath('../other?token=example'));
 assert.throws(()=>checkedResult('action=performance',{totals:{tickets:1,revenue:100,bonus:5000,units:2},people:[]}));assert.throws(()=>checkedResult('action=field-notes',{notes:'bad'}));
 const figures={tickets:0,revenue:0,bonus:0};assert.ok(checkedResult('action=bonuses',{today:figures,month:figures,months:[],days:[]}));
 const jpeg=new File(['fixture'],'fixture.jpg',{type:'image/jpeg'});assert.equal(selectPhotos([jpeg]).length,1);assert.throws(()=>selectPhotos(new Array(6).fill(jpeg)));assert.throws(()=>selectPhotos([new File(['script'],'fixture.html',{type:'text/html'})]));assert.throws(()=>selectPhotos([new File([],'empty.jpg',{type:'image/jpeg'})]));
 console.log('PASS: actual streamed multipart limit without Content-Length; malformed form; response shape checks; photo URL IDs; allowed image selection and count.');
})().catch(error=>{console.error(error);process.exit(1)});
