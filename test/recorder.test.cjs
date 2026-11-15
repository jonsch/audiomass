const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
test('worklet starts at the exact requested frame and flushes the final partial chunk once',()=>{
 let Processor; const messages=[];
 const context=vm.createContext({Float32Array, currentFrame:0, AudioWorkletProcessor:class {constructor(){this.port={postMessage:b=>messages.push(b)}}},registerProcessor:(name,c)=>Processor=c});
 vm.runInContext(read('recorder-worklet.js'),context);
 const p=new Processor({processorOptions:{size:128,startFrame:160}});
 p.process([[new Float32Array(128).fill(1)]]); assert.equal(messages.length,0);
 context.currentFrame=128; p.process([[new Float32Array(128).fill(2)]]); assert.equal(messages.length,0);
 context.currentFrame=256; p.process([[new Float32Array(128).fill(3)]]);
 assert.deepEqual(Array.from(messages[0]),[...Array(96).fill(2),...Array(32).fill(3)]);
 p.flush(); assert.equal(messages[1].length,96); assert.equal(messages[2],0); assert.equal(p.process([]),false);
});
function fixture({resume=Promise.resolve(),worklet=Promise.resolve()}={}) {
 let Recorder,resolveMic,stopped=0,nodes=0,constraints;
 const ctx={sampleRate:48000,currentTime:2,resume:()=>resume,audioWorklet:{addModule:()=>worklet},createMediaStreamSource:()=>({connect(){},disconnect(){}}),createGain:()=>({gain:{},connect(){},disconnect(){}})};
 const app={_deps:{},fireEvent(){}};
 const context={window:{AudioWorkletNode:class {constructor(){nodes++;this.port={}} connect(){} disconnect(){}},setTimeout},document:{},PKAudioEditor:app,navigator:{mediaDevices:{getUserMedia:c=>{constraints=c;return new Promise(r=>resolveMic=r)}}}};
 vm.runInNewContext(read('recorder.js'),context); Recorder=app._deps.rec;
 const rec=new Recorder(app),stream={getTracks:()=>[{stop:()=>stopped++}]};
 return {rec,ctx,app,grant:()=>resolveMic(stream),stopped:()=>stopped,nodes:()=>nodes,constraints:()=>constraints};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('cancel during worklet load cannot resurrect a recorder node',async()=>{
 let loaded; const f=fixture({worklet:new Promise(r=>loaded=r)});
 f.rec.startCapture({ctx:f.ctx,onstart:()=>assert.fail('stale start')}); f.grant(); await settle();
 f.rec.stopCapture(); loaded(); await settle(); assert.equal(f.stopped(),1);assert.equal(f.nodes(),0);
});
test('cancel before permission releases a late microphone stream',async()=>{
 const f=fixture(); f.rec.startCapture({ctx:f.ctx}); f.rec.stopCapture();f.grant();await settle();
 assert.equal(f.stopped(),1);assert.equal(f.nodes(),0);
});
test('resume rejection releases mic and never starts capture',async()=>{
 let error; const f=fixture({resume:Promise.reject(new Error('suspended'))});
 f.rec.startCapture({ctx:f.ctx,onerror:e=>error=e});f.grant();await settle();
 assert.equal(error.message,'suspended');assert.equal(f.stopped(),1);assert.equal(f.nodes(),0);
});
test('synchronized recording fails cleanly when the worklet cannot load',async()=>{
 let error; const f=fixture({worklet:Promise.reject(new Error('blocked module'))});
 f.rec.startCapture({ctx:f.ctx,requireWorklet:true,onerror:e=>error=e});f.grant();await settle();
 assert.match(error.message,/AudioWorklet/);assert.equal(f.stopped(),1);assert.equal(f.nodes(),0);
});
test('selected microphone uses an exact constraint; default leaves deviceId unset',()=>{
 const f=fixture();f.app.audioDevices={inputId:'usb-mic',busy:false};f.rec.startCapture({ctx:f.ctx});
 assert.equal(f.constraints().audio.deviceId.exact,'usb-mic');f.rec.stopCapture();
 f.app.audioDevices.inputId='';f.rec.startCapture({ctx:f.ctx});
 assert.equal(f.constraints().audio.deviceId,undefined);f.rec.stopCapture();
});
test('recording cannot start while a device change is pending',()=>{
 const f=fixture();let error;f.app.audioDevices={busy:true};
 assert.equal(f.rec.startCapture({ctx:f.ctx,onerror:e=>error=e}),false);
 assert.match(error.message,/device request/);assert.equal(f.constraints(),undefined);
});
