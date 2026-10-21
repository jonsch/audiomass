# Third-party notices

The bundled third-party files keep their own licenses:

| Project | Files | License |
| --- | --- | --- |
| WaveSurfer.js 2.0.5 and regions plugin | `src/dist/wavesurfer.js`, `src/dist/plugin/wavesurfer.regions.js` | BSD-3-Clause |
| lamejs / LAME MP3 encoder | `src/lame.js` | LGPL |
| libFLAC 1.3.3 | `src/flac.js`, `src/flac.min.js`, `src/libflac.js`, `src/libflac.wasm` | Xiph/New BSD |
| RNNoise | `src/rnn_denoise.js`, `src/rnn_denoise.wasm` | BSD-3-Clause |
| lz4-wasm | `src/lzma.js`, `src/lz4-block-codec-wasm.js`, `src/lz4-block-codec.wasm` | BSD-2-Clause |

The hosted SwitchBeats Studio Editor serves these files unmodified and
unminified, with their original license headers. `src/lame.js` (LGPL) is served
as its own file so it can be replaced independently. Full license texts:
[BSD-3-Clause](https://opensource.org/license/bsd-3-clause),
[BSD-2-Clause](https://opensource.org/license/bsd-2-clause),
[Xiph/New BSD](https://xiph.org/flac/license.html), and
[LGPL-2.0-or-later](https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html).
