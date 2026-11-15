const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(overrides={}) {
 const calls=[];let recording=false,stops=0;
 const ctx={setSinkId:async id=>calls.push(id)};
 const media={enumerateDevices:async()=>[{kind:'audioinput',deviceId:'mic-1',label:'USB mic'}],getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]}),selectAudioOutput:async()=>({deviceId:'speaker-1'}),...overrides};
 const app={rec:{isBusy:()=>recording},multitrack:{GetAudioContext:()=>ctx}};
 const scope={window:{},document:{},navigator:{mediaDevices:media}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/audio-devices.js'),'utf8'),scope);
 const devices=scope.window.PKAudioDevices.get(app);
 return {devices,app,ctx,media,calls,stops:()=>stops,recording:value=>recording=value};
}
test('enumeration does not request permission; input choice survives controller reopening',async()=>{
 let micCalls=0;const f=fixture({getUserMedia:async()=>{micCalls++;}});
 await f.devices.refresh();f.devices.setInput('mic-1');
 assert.equal(micCalls,0);assert.equal(f.devices.inputId,'mic-1');
});
test('permission discovery stops every temporary microphone track',async()=>{
 const f=fixture();await f.devices.enable();assert.equal(f.stops(),1);assert.equal(f.devices.busy,false);
});
test('permission denial clears busy and preserves choices',async()=>{
 const f=fixture({getUserMedia:async()=>{throw new Error('denied')}});f.devices.setInput('mic-1');
 await assert.rejects(f.devices.enable(),/denied/);assert.equal(f.devices.busy,false);assert.equal(f.devices.inputId,'mic-1');
});
test('output selection commits only on success, and system default uses empty sink id',async()=>{
 const f=fixture();await f.devices.setOutput('speaker-1');assert.equal(f.devices.outputId,'speaker-1');
 f.ctx.setSinkId=async()=>{throw new Error('unplugged')};
 await assert.rejects(f.devices.setOutput('speaker-2'),/unplugged/);assert.equal(f.devices.outputId,'speaker-1');
 f.ctx.setSinkId=async id=>f.calls.push(id);await f.devices.setOutput('');assert.equal(f.calls.at(-1),'');
});
test('input, output and permission changes are refused throughout recording',async()=>{
 const f=fixture();f.recording(true);
 assert.throws(()=>f.devices.setInput('mic-1'),/Stop recording/);
 await assert.rejects(f.devices.setOutput('speaker-1'),/Stop recording/);
 await assert.rejects(f.devices.enable(),/Stop recording/);
 await assert.rejects(f.devices.chooseOutput(),/Stop recording/);
 assert.deepEqual(f.calls,[]);
});
test('pending output requests serialize changes',async()=>{
 const f=fixture();let finish;f.ctx.setSinkId=()=>new Promise(r=>finish=r);
 const first=f.devices.setOutput('speaker-1');await Promise.resolve();
 assert.throws(()=>f.devices.setInput('mic-1'),/Wait/);
 await assert.rejects(f.devices.setOutput('speaker-2'),/Wait/);finish();await first;
 assert.equal(f.devices.busy,false);assert.equal(f.devices.outputId,'speaker-1');
});
test('closed picker does not apply a late choice; cancelled picker keeps old output',async()=>{
 const f=fixture();await f.devices.chooseOutput(()=>false);assert.deepEqual(f.calls,[]);
 f.media.selectAudioOutput=async()=>{throw new Error('cancelled')};
 await assert.rejects(f.devices.chooseOutput(),/cancelled/);assert.equal(f.devices.outputId,'');assert.equal(f.devices.busy,false);
});
test('unsupported output selection fails without changing the system route',async()=>{
 const f=fixture();delete f.ctx.setSinkId;
 assert.equal(f.devices.canOutput(),false);await assert.rejects(f.devices.setOutput('speaker-1'),/system sound/);
 assert.equal(f.devices.outputId,'');
});
test('device disappearance preserves explicit selections instead of choosing the wrong microphone',async()=>{
 const f=fixture();f.devices.setInput('mic-1');await f.devices.setOutput('speaker-1');
 f.media.enumerateDevices=async()=>[];await f.devices.refresh();
 assert.equal(f.devices.inputId,'mic-1');assert.equal(f.devices.outputId,'speaker-1');
});
