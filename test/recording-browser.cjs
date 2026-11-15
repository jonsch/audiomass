// Local-only synthetic Web Audio test. Set PLAYWRIGHT_MODULE to an installed playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../src');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(bytes);
  });
});
const host = http.createServer((req,res) => {
 res.setHeader('Content-Type','text/html');
 res.end('<!doctype html><iframe style="width:100%;height:900px" allow="microphone; speaker-selection; autoplay" src="http://127.0.0.1:8788/index.html"></iframe>');
});
(async () => {
 await new Promise(resolve => server.listen(8788, '127.0.0.1', resolve));
 await new Promise(resolve => host.listen(5175, '127.0.0.1', resolve));
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH, args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8788/index.html?standalone=1&skipintro=1');
  await page.waitForFunction(() => window.PKAudioEditor?.multitrack);
  await page.evaluate(() => {
   const mt = PKAudioEditor.multitrack, ctx = mt.GetAudioContext();
   window.mt = mt; window.testStreams=[]; window.starts=[];
   const connect=AudioNode.prototype.connect;
   AudioNode.prototype.connect=function(destination,...args) {
    if (this instanceof ChannelMergerNode && destination===ctx.destination) {
     window.outputMeter=ctx.createAnalyser(); outputMeter.fftSize=2048;
     connect.call(this,outputMeter);
    }
    return connect.call(this,destination,...args);
   };
   window.outputRms=()=>{ const data=new Float32Array(outputMeter.fftSize); outputMeter.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length); };
   const start = AudioBufferSourceNode.prototype.start;
   AudioBufferSourceNode.prototype.start = function(...args) { starts.push(args); return start.apply(this,args); };
   const mic = ctx.createOscillator(); mic.frequency.value=997;
   const gain = ctx.createGain(); gain.gain.value=.15; mic.connect(gain); mic.start();
   navigator.mediaDevices.getUserMedia = async () => {
    const dest=ctx.createMediaStreamDestination(); gain.connect(dest); testStreams.push(dest.stream); return dest.stream;
   };
   window.syntheticMic = navigator.mediaDevices.getUserMedia;
   const backing=ctx.createBuffer(1,ctx.sampleRate*6,ctx.sampleRate);
   const data=backing.getChannelData(0); for(let i=0;i<data.length;i++) data[i]=.4*Math.sin(2*Math.PI*220*i/ctx.sampleRate);
   window.fixture = {tracks:[{id:'mt1',name:'Backing',vol:1},{id:'mt2',name:'Voice',rec:true,vol:1}],clips:[{id:'mc1',track:'mt1',start:0,in:0,out:6,name:'Backing 220Hz',buffer:backing}],cursor:1.25,marker:1.25};
   mt.LoadState(fixture);
  });
  await page.getByLabel('Playback while recording').selectOption('mix');
  await page.evaluate(() => mt.RecordStart());
  await page.waitForFunction(() => mt.IsPlaying());
  await page.waitForTimeout(1250);
  const running=await page.evaluate(() => ({recording:mt.IsRecording(),cursor:mt.GetCursor(),starts:starts.length,output:outputRms()}));
  assert.equal(running.recording,true); assert.ok(running.cursor>2); assert.equal(running.starts,1);
  assert.ok(running.output>.15, 'real Web Audio mix reaches the output graph');
  await page.screenshot({path:path.resolve(__dirname,'recording-local.png')});
  await page.evaluate(() => mt.RecordStop());
  await page.waitForFunction(() => !mt.IsRecording());
  const take=await page.evaluate(() => {
   const clip=mt.getState().clips.find(c=>c.name==='Recording');
   const data=clip.buffer.getChannelData(0), sr=clip.buffer.sampleRate;
   function amplitude(hz) { let re=0,im=0; for(let i=0;i<data.length;i++){re+=data[i]*Math.cos(2*Math.PI*hz*i/sr);im+=data[i]*Math.sin(2*Math.PI*hz*i/sr);} return 2*Math.hypot(re,im)/data.length; }
   return {start:clip.start,duration:clip.buffer.duration,mic:amplitude(997),backing:amplitude(220),playing:mt.IsPlaying(),ended:testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))};
  });
  assert.equal(take.start,1.25); assert.ok(take.duration>1 && take.duration<1.7); assert.ok(take.mic>.1); assert.ok(take.backing<.005); assert.equal(take.playing,false); assert.equal(take.ended,true);
  console.log('PASS full mix: transport advances, take at 1.25s, 997Hz mic captured, 220Hz backing absent',take);
  await page.getByLabel('Playback while recording').selectOption('isolated');
  await page.evaluate(() => { mt.LoadState(fixture); starts.length=0; mt.RecordStart(); });
  await page.waitForFunction(() => mt.IsPlaying()); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => starts.length),0);
  assert.ok(await page.evaluate(() => outputRms()<.0001));
  await page.getByRole('button',{name:'Cancel take',exact:true}).click();
  await page.waitForFunction(() => !mt.IsRecording());
  assert.equal(await page.evaluate(() => mt.getState().clips.length),1);
  console.log('PASS isolated capture and cancel: no backing sources, no saved take');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError')}; mt.RecordStart(); });
  await page.waitForFunction(() => !mt.IsRecording());
  assert.equal(await page.evaluate(() => mt.IsPlaying()),false);
  console.log('PASS denied microphone leaves transport stopped');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.grantMic=resolve); mt.RecordStart(); });
  await page.getByRole('button',{name:'Cancel take',exact:true}).click();
  await page.evaluate(async () => grantMic(await syntheticMic()));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => testStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  console.log('PASS cancelled pending permission releases late stream');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia=syntheticMic; mt.RecordStart(); });
  await page.waitForFunction(() => mt.IsPlaying()); await page.waitForTimeout(300);
  await page.evaluate(() => mt.LoadState(fixture));
  await page.waitForFunction(() => !mt.IsRecording());
  assert.equal(await page.evaluate(() => mt.getState().clips.length),1);
  console.log('PASS project replacement cancels in-flight take');
  await page.getByLabel('Playback while recording').selectOption('mix');
  await page.evaluate(() => { mt.LoadState(fixture); mt.RecordStart(); });
  await page.waitForFunction(() => mt.IsPlaying()); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => outputRms()>.15));
  await page.evaluate(() => mt.MixerSet('mt1','mute',true)); await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => outputRms()<.0001));
  await page.evaluate(() => { mt.MixerSet('mt1','mute',false); mt.MixerSet('mt2','solo',true); }); await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => outputRms()<.0001));
  await page.evaluate(() => { mt.MixerSet('mt2','solo',false); mt.MixerSet('mt1','vol',.25,true); }); await page.waitForTimeout(150);
  const quiet=await page.evaluate(() => outputRms()); assert.ok(quiet>.035 && quiet<.07);
  await page.evaluate(() => mt.Stop()); await page.waitForFunction(() => !mt.IsRecording());
  assert.equal(await page.evaluate(() => mt.IsPlaying()),false);
  console.log('PASS live mute, solo, gain and transport Stop (measured Web Audio output graph)');
  await page.evaluate(() => { mt.LoadState({...fixture,clips:[]}); mt.RecordStart(); });
  await page.waitForFunction(() => mt.IsPlaying()); await page.waitForTimeout(250);
  await page.evaluate(() => mt.RecordStop()); await page.waitForFunction(() => !mt.IsRecording());
  assert.equal(await page.evaluate(() => mt.getState().clips.length),1);
  console.log('PASS empty arrangement and repeated take');
  await page.evaluate(() => { mt.LoadState({...fixture,clips:[],cursor:29.9}); mt.RecordStart(); });
  await page.waitForFunction(() => mt.IsPlaying()); await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => mt.GetDuration()>30));
  await page.getByRole('button',{name:'Cancel take',exact:true}).click(); await page.waitForFunction(()=>!mt.IsRecording());
  console.log('PASS recording extends the timeline beyond existing content');
  await page.setViewportSize({width:390,height:844});
  const box=await page.getByLabel('Playback while recording').boundingBox(); assert.ok(box && box.y>0 && box.y+box.height<844);
  await page.screenshot({path:path.resolve(__dirname,'recording-mobile-local.png')});
  assert.deepEqual(errors,[]);
  const embedded=await browser.newPage();
  await embedded.goto('http://127.0.0.1:5175');
  const frame=embedded.frames().find(f=>f.url().includes(':8788'));
  await frame.waitForFunction(()=>window.PKAudioEditor?.multitrack);
  await frame.evaluate(()=>{
   const mt=PKAudioEditor.multitrack;
   mt.LoadState({tracks:[{id:'mt1',name:'Browser fake mic',rec:true}],clips:[],cursor:2});
   mt.RecordStart();
  });
  await frame.waitForFunction(()=>PKAudioEditor.multitrack.IsPlaying());
  await frame.waitForTimeout(600);
  await frame.evaluate(()=>PKAudioEditor.multitrack.RecordStop());
  await frame.waitForFunction(()=>!PKAudioEditor.multitrack.IsRecording());
  const embeddedTake=await frame.evaluate(()=>{
   const clip=PKAudioEditor.multitrack.getState().clips[0];
   return {start:clip.start,duration:clip.buffer.duration};
  });
  assert.equal(embeddedTake.start,2);assert.ok(embeddedTake.duration>.3);
  console.log('PASS cross-origin iframe using browser getUserMedia and Chromium fake microphone',embeddedTake);
  const saved=await embedded.evaluate(async()=>{
   const target=document.querySelector('iframe').contentWindow;
   function request(type,payload={}) { return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();const timeout=setTimeout(()=>reject(new Error(type+' timed out')),15000);
    function receive(event){if(event.source!==target || event.origin!=='http://127.0.0.1:8788' || event.data.id!==id) return;
     window.removeEventListener('message',receive);clearTimeout(timeout);
     if(event.data.payload.ok) resolve(event.data.payload.result);else reject(new Error(JSON.stringify(event.data.payload.error)));
    }
    window.addEventListener('message',receive);
    target.postMessage({ns:'switchbeats.studio-editor',v:1,type,id,payload},'http://127.0.0.1:8788');
   }); }
   await request('init',{storagePartition:'synthetic-test'});
   const snapshot=await request('snapshot');
   const audio=snapshot.newAudio[0];
   const sourceId=audio.sourceId,assetId='123e4567-e89b-42d3-a456-426614174000';
   await request('bind-sources',{bindings:[{sourceId,assetId}]});
   snapshot.manifest.sources=snapshot.manifest.sources.map(s=>s.id===sourceId?{id:sourceId,type:'asset',assetId}:s);
   const loaded=await request('load-project',{manifest:snapshot.manifest,sources:[{sourceId,name:audio.name,buffer:audio.buffer}]});
   return {kind:audio.kind,bytes:audio.buffer.byteLength,start:snapshot.manifest.tracks[0].clips[0].start,loaded};
  });
  assert.equal(saved.kind,'recording');assert.ok(saved.bytes>0);assert.equal(saved.start,2);
  assert.deepEqual(saved.loaded.missingSourceIds,[]);assert.deepEqual(saved.loaded.undecodableSourceIds,[]);
  console.log('PASS recording FLAC snapshot, source binding, and local bridge reload',saved);
 } finally { await browser.close(); server.close(); host.close(); }
})().catch(error=>{console.error(error);server.close();host.close();process.exitCode=1;});
