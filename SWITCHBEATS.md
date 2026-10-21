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
| `src/multitrack.js` | Small public API for the bridge (`LoadState`, `AddBuffer`, `DecodeArrayBuffer`, `GetAudioContext`, `onImportedBuffer` hook); embedded empty-state copy. |
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

## Merging upstream

```bash
git fetch upstream && git switch production && git merge --ff-only upstream/production
git switch switchbeats && git merge production
```

Conflicts are usually limited to `index.html`, `ui.js`, and `multitrack.js`.
