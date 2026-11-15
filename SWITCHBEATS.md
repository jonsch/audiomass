# SwitchBeats Studio Editor engine

This branch (`switchbeats`) hosts AudioMass as the editor engine for
**SwitchBeats Studio Editor**. `production` keeps tracking upstream
(`pkalogiros/AudioMass`) so fixes can be merged in.

The storefront page `https://switchbeats.studio/studio/editor` embeds this
engine from `https://creator.switchbeats.studio` in an iframe. The storefront
owns sign-in, Studio Pro checks, storage, and every network request. The engine
holds no session or credentials and only exchanges audio and project data with
the storefront over an origin-checked `postMessage` bridge. Bridge protocol v1 is
specified in `docs/studio-editor-plan.md` in `jonsch/switchbeats`.

## What changed from upstream

| File | Change |
| --- | --- |
| `src/switchbeats-bridge.js` | Bridge protocol v1 (sources: `catalog`, `asset`, `kit`): `init`, `new-project`, `load-project`, `add-audio`, `snapshot`, `bind-sources`, `export-mix`, `clear-local`; events `ready`, `dirty`, `error`. |
| `src/switchbeats-boot.js` | Replaces the inline init script. In the iframe: multitrack mode + bridge. Opened directly: a link back to the storefront. |
| `src/multitrack.js` | Small public API for the bridge (`LoadState`, `AddBuffer`, `DecodeArrayBuffer`, `GetAudioContext`, `onImportedBuffer` hook); embedded empty-state copy; **Duplicate Channel** (header ⧉ button and lane right-click) copying settings, clips, fades, and crossfades; no "Beta" tag when embedded. |
| `src/oneup.js`, `src/ui.js` | Toasts and error dialogs render names as text, not HTML; drafts list escapes names; inline `onclick` handlers moved to script so the page runs under a strict CSP. |
| `src/ui.js` | When embedded, hides menu entries the storefront replaces (local drafts, load from URL, samples, offline version, welcome, upstream About/GitHub) and adds **About → About Studio Editor**, a dialog about SwitchBeats and SwitchCase Studios. |
| `src/licenses.html`, `src/img/` | Open-source license notices (AudioMass MIT text verbatim plus bundled libraries), linked from the About dialog; SwitchBeats and SwitchCase logos. |
| `src/welcome.js` | No welcome modal when embedded. |
| `src/index.html` | SwitchBeats title, `noindex`, no audiomass.co metadata, no PWA manifest or service worker. |
| `src/_headers`, `src/.assetsignore`, `wrangler.jsonc` | Cloudflare deploy: strict CSP with `frame-ancestors` limited to the storefront (plus local development), and server/offline/demo files excluded. |
| `test/bridge.html`, `test/bridge-harness.js` | Cross-origin harness that plays the storefront's role. |

The MIT license and copyright notice are unchanged in `LICENSE` and are served
verbatim at `/licenses`, linked from **About → About Studio Editor** as
"Open-source licenses". Keep that page when changing branding: MIT requires the
notice to accompany the distributed code.

## Deploy

Cloudflare Workers Static Assets, Worker `switchbeats-creator`, custom domain
`creator.switchbeats.studio` (declared in `wrangler.jsonc`; Cloudflare manages
the DNS record and certificate). Deploy from a checkout of `switchbeats`:

```bash
npx wrangler deploy
```

To deploy automatically on every push instead, connect the repository in
**Workers & Pages → switchbeats-creator → Settings → Build → Connect** with
production branch `switchbeats`, no build command, and deploy command
`npx wrangler deploy`.

Verify: opening `https://creator.switchbeats.studio` directly shows only the
"Open Studio Editor" link, and the response carries the
`Content-Security-Policy` from `src/_headers`.

## Develop and test

```bash
npx wrangler dev --port 8787 --ip 127.0.0.1        # engine, with _headers applied
python3 -m http.server 5174 --bind 127.0.0.1        # harness (from the repo root)
```

Open `http://localhost:5174/test/bridge.html?engine=http://127.0.0.1:8787` and run:

1. **Basic flow**: init, new project, add catalog and asset audio, snapshot,
   and rejection of URL sources and unknown requests.
2. **Render round-trip**: first select a clip and apply an effect in the
   editor. Then the new audio is FLAC-encoded, bound, and reloaded, and the
   arrangement must be identical.
3. **Export mixes**: WAV, MP3, and FLAC mixdowns decode.

The engine accepts local parent pages only when it is itself served from
`localhost`/`127.0.0.1`. Add `?standalone=1` on localhost to run the plain
editor without the bridge.

## Local recording playback

Arm the destination channel with **R**, place the playhead, then select
**While recording: Full mix** (default) or **Recording only** before pressing
Record. Full mix follows the existing mute/solo, gain, pan, fades and master
controls, including any old clips on the armed channel. Recording only silences
all backing clips. Both modes capture only the microphone; live microphone
monitoring is intentionally off. Use headphones to prevent acoustic speaker
bleed. To audition the take by itself afterwards, solo its channel.

Stop (or Record again) saves the take at its original playhead position and
returns the cursor there. **Cancel take** discards it. Recording ignores region
loop/end boundaries and extends the timeline as needed. Seeking is locked during
a take. New/load/clear/undo state changes discard an unfinished take rather than
attaching it to another project. Permission waits and cancellation release late
microphone streams; repeated takes use fresh capture sessions.

Multitrack recording requires AudioWorklet on HTTPS or localhost. Capture and
backing playback share a scheduled AudioContext boundary after permission and
worklet startup; there is no arbitrary four-chunk input discard. This does not
calibrate hardware input/output latency or Bluetooth delay. Real microphones,
headphones, speaker bleed, and physical timing still need device testing; manual
clip nudging remains available. The clock model follows the
[Web Audio specification](https://www.w3.org/TR/webaudio/).

Local tests (no backend/account credentials, no uploads):

```sh
node --test test/recorder.test.cjs test/audio-devices.test.cjs
# With Playwright installed, or PLAYWRIGHT_MODULE pointing to its package:
node test/recording-browser.cjs
```

The browser test serves only localhost ports 8788 and 5175, uses synthetic
oscillator input and Chromium's fake microphone, checks measured Web Audio
output and recorded spectra, stop/cancel/permission races, mute/solo/gain,
repeated takes, timeline growth, iframe recording and FLAC snapshot/reload.
Set `CHROMIUM_PATH` to use an installed Chromium binary. Screenshots go to
`test/recording-local.png` and `test/recording-mobile-local.png`. These checks do
not establish audible quality or physical latency. The engine has no package
build step; serve `src/` to exercise the actual edited JavaScript.

## Audio Preferences

Open **Edit → Audio Preferences**. Recording input applies to the next take;
an explicit selection uses an exact device constraint and fails visibly if
that microphone disappears, rather than switching to another microphone.
Playback output uses the shared editor AudioContext's `setSinkId` when available.
It changes playback routing only; it never feeds backing audio into capture.
System default clears the explicit selection. Choices belong to the tab, survive
project changes, and reset on reload. Device changes are locked during a take,
including startup/stop, and recording cannot begin during a pending device request.

Opening the dialog only enumerates already permitted devices. **Enable device
access** explicitly requests temporary microphone access to reveal device names,
then stops every track immediately. **Choose output in browser…** uses a native
output picker when available. Denial/cancellation retains the prior choice.
Unsupported output switching directs the user to system sound settings. The
storefront iframe and both serving policies delegate `speaker-selection` only
to the editor origin. Browser permission and device support are still required.

For integrated local validation, serve this engine on 127.0.0.1:8787, then start
the separate SwitchBeats frontend with `vite --config vite.studio-preview.config.ts`.
Open `http://127.0.0.1:5194/studio/editor/new`. This opt-in fixture renders the
actual StudioEditor component, CSS and cross-origin bridge with a local test
identity/status response. It does not use Clerk or a live API; cloud saving and
catalog operations are disabled. Its simplified preview header uses the real Logo
component; it is not the full signed-in production application shell.

Run `node test/audio-devices-browser.cjs` against those servers with Playwright.
The local headless Chromium build has a known speaker-selection policy defect:
native setSinkId rejects even though it exists, and the UI preserves the choice.
A separate `ENABLE_SPEAKER_SELECTION=1` run enables that Chromium test feature
and verifies native default/non-default synthetic sink changes. This flag is
test-only, not an application requirement or a user-browser settings change.
The test also covers exact fake microphone input, record locking, failure and
unsupported fallbacks, branded menus/About and retained license links.
It does not verify physical speaker routing or hardware latency.

References: [Chrome Web Audio output selection](https://developer.chrome.com/blog/audiocontext-setsinkid),
[audio output permissions specification](https://www.w3.org/TR/audio-output/),
[Chromium policy fix](https://chromium.googlesource.com/chromium/src/third_party/+/f54b0d1e2155a2a894091a1775b9acf3e2d76563).

## Merging upstream

```bash
git fetch upstream && git switch production && git merge --ff-only upstream/production
git switch switchbeats && git merge production
```

Conflicts are usually limited to `index.html`, `ui.js`, and `multitrack.js`.
