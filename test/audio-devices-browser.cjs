// Start the SwitchBeats vite.studio-preview.config.ts server and local engine first.
// The actual StudioEditor component/CSS/bridge run with isolated local identity/API fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(process.env.ENABLE_SPEAKER_SELECTION === '1' ? ['--enable-blink-features=SpeakerSelection'] : [])] });
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  // Defense in depth: no external accounts, APIs, analytics or assets in this test.
  await page.route('**/*',route=> /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:5194/studio/editor/new');
  await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.body.innerText.includes('Starting the editor'));
  const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:8787/'));
  assert.ok(frame,'actual storefront iframe present');
  await frame.waitForFunction(()=>window.PKSwitchBeatsEmbed && window.PKAudioEditor?.multitrack);
  assert.equal(await page.locator('iframe').getAttribute('allow'),'microphone; speaker-selection; autoplay; clipboard-write');
  assert.equal(await frame.getByText('SourceCode on Github',{exact:true}).count(),0);
  assert.equal(await frame.getByText('See Welcome Message',{exact:true}).count(),0);
  assert.equal(/audiomass/i.test(await frame.locator('body').innerText()),false);
  await frame.evaluate(()=>{
   window.mt=PKAudioEditor.multitrack; window.ctx=mt.GetAudioContext();
   window.nativeGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   window.micRequests=[]; window.micStreams=[];
   navigator.mediaDevices.getUserMedia=async constraints=>{
    micRequests.push(constraints);const stream=await nativeGetUserMedia(constraints);micStreams.push(stream);return stream;
   };
  });
  async function open() {
   await frame.getByText('Edit',{exact:true}).click();
   await frame.getByText('Audio Preferences',{exact:true}).click();
   await frame.getByLabel('Recording input (next take)').waitFor();
  }
  async function close() { await frame.locator('.sb_devices_modal').getByText('CLOSE',{exact:true}).click(); }
  await open();
  assert.equal(await frame.evaluate(()=>micRequests.length),0,'menu open never requests microphone');
  await frame.getByRole('button',{name:'Enable device access',exact:true}).click();
  await frame.getByText('Device list refreshed. The temporary microphone stream has been stopped.',{exact:true}).waitFor();
  assert.equal(await frame.evaluate(()=>micStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  const ids=await frame.evaluate(()=>({inputs:PKAudioEditor.audioDevices.devices.filter(d=>d.kind==='audioinput' && d.deviceId && d.deviceId!=='default').map(d=>d.deviceId), outputs:PKAudioEditor.audioDevices.devices.filter(d=>d.kind==='audiooutput' && d.deviceId && d.deviceId!=='default').map(d=>d.deviceId),canOutput:typeof ctx.setSinkId==='function',policy:document.featurePolicy.allowsFeature('speaker-selection')}));
  console.log('Native device capabilities',{inputs:ids.inputs.length,outputs:ids.outputs.length,canOutput:ids.canOutput,policy:ids.policy});
  assert.ok(ids.inputs.length); assert.equal(ids.canOutput,true);
  await frame.getByLabel('Recording input (next take)').selectOption(ids.inputs[0]);
  // Real Chromium default sink. Non-default headless sinks are not physical devices.
  await frame.getByLabel('Playback output',{exact:true}).selectOption('');
  await frame.waitForFunction(()=>!PKAudioEditor.audioDevices.busy);
  console.log('Native output status',await frame.locator('.sb_devices_modal [role="status"]').innerText());
  if (process.env.ENABLE_SPEAKER_SELECTION === '1') {
   assert.equal(ids.policy,true);
   await frame.getByText('Playback output changed.',{exact:true}).waitFor();
   if(ids.outputs.length) {
    await frame.getByLabel('Playback output',{exact:true}).selectOption(ids.outputs[0]);
    await frame.waitForFunction(id=>ctx.sinkId===id,ids.outputs[0]);
    await frame.getByLabel('Playback output',{exact:true}).selectOption('');
    await frame.waitForFunction(()=>ctx.sinkId==='');
   }
   console.log('PASS native setSinkId with Chromium SpeakerSelection test flag (synthetic devices only)');
  } else if (!ids.policy) {
   await frame.getByText('Device access was not allowed or the picker was cancelled. Your choices have not changed.',{exact:true}).waitFor();
   assert.equal(await frame.evaluate(()=>PKAudioEditor.audioDevices.outputId),'');
   console.log('PASS native policy rejection preserves output; this Chromium build does not recognize speaker-selection without its test flag');
  }
  assert.equal(await frame.evaluate(()=>ctx.sinkId),'');
  await page.screenshot({path:path.resolve(__dirname,'audio-preferences-integrated.png')});
  await close();
  await frame.evaluate(()=>{ mt.LoadState({tracks:[{id:'mt1',name:'Voice practice',rec:true}],clips:[],cursor:2}); mt.RecordStart(); });
  await frame.waitForFunction(()=>mt.IsPlaying());
  assert.equal(await frame.evaluate(()=>micRequests.at(-1).audio.deviceId.exact),ids.inputs[0]);
  await open();
  assert.equal(await frame.getByLabel('Recording input (next take)').isDisabled(),true);
  assert.equal(await frame.getByLabel('Playback output',{exact:true}).isDisabled(),true);
  await frame.waitForTimeout(400);
  await frame.evaluate(()=>mt.RecordStop());
  await frame.waitForFunction(()=>!mt.IsRecording());
  assert.equal(await frame.evaluate(()=>mt.getState().clips[0].start),2);
  await frame.getByLabel('Recording input (next take)').waitFor();
  assert.equal(await frame.getByLabel('Recording input (next take)').isEnabled(),true);
  assert.equal(await frame.getByLabel('Recording input (next take)').inputValue(),ids.inputs[0]);
  await close();
  console.log('PASS real branded StudioEditor component + cross-origin bridge; Edit > Audio Preferences; native fake-mic enumeration, exact input, iframe allow attribute, record lock, retained selection');
  // Failure/unsupported branches are mocked explicitly, separate from native fake-device checks above.
  await frame.evaluate(()=>{ window.originalSetSink=ctx.setSinkId.bind(ctx); window.mockSinks=[]; ctx.setSinkId=async id=>mockSinks.push(id); });
  await open();
  await frame.getByLabel('Playback output',{exact:true}).selectOption(ids.outputs[0]);
  await frame.getByText('Playback output changed.',{exact:true}).waitFor();
  assert.equal(await frame.evaluate(()=>mockSinks.at(-1)),ids.outputs[0]);
  await close();
  await frame.evaluate(()=>{ ctx.setSinkId=async()=>{throw new DOMException('denied','NotAllowedError')}; });
  await open();
  await frame.getByLabel('Playback output',{exact:true}).selectOption('');
  await frame.getByText('Device access was not allowed or the picker was cancelled. Your choices have not changed.',{exact:true}).waitFor();
  assert.equal(await frame.getByLabel('Playback output',{exact:true}).inputValue(),ids.outputs[0]);
  await close();
  await frame.evaluate(()=>{ctx.setSinkId=undefined;});
  await open();
  assert.equal(await frame.getByLabel('Playback output',{exact:true}).isDisabled(),true);
  await frame.getByText(/Output switching is not supported in this browser/).waitFor();
  await close();
  await frame.evaluate(()=>{ctx.setSinkId=originalSetSink;});
  await frame.getByText('About',{exact:true}).click();
  await frame.getByText('About Studio Editor',{exact:true}).click();
  await frame.getByText('SwitchBeats Studio Editor',{exact:true}).waitFor();
  assert.equal(await frame.getByRole('link',{name:'Open-source licenses'}).getAttribute('href'),'licenses');
  assert.equal(/audiomass/i.test(await frame.locator('body').innerText()),false);
  assert.deepEqual(errors,[]);
  console.log('PASS mocked denial/unsupported browser fallbacks; SwitchBeats About/branding/license link preserved; no page errors');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
