/*
 * SwitchBeats Studio Editor bridge (protocol v1).
 *
 * The editor runs inside an iframe on https://creator.switchbeats.studio. The
 * storefront page (https://switchbeats.studio/studio/editor) owns sign-in,
 * storage, and every network request; it talks to this engine only through
 * origin-checked postMessage. Audio always arrives and leaves as transferred
 * ArrayBuffers, never URLs, and no message text is ever inserted as HTML.
 *
 * Protocol: docs/studio-editor-plan.md in jonsch/switchbeats.
 */
(function ( w, d ) {
	'use strict';

	var NS = 'switchbeats.studio-editor';
	var PROTOCOL = 1;
	var ENGINE_VERSION = 'audiomass-switchbeats-1';
	var PRODUCTION_PARENTS = ['https://switchbeats.studio', 'https://www.switchbeats.studio'];
	var MAX_NAME = 200;
	var MAX_TRACK_NAME = 120;
	var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	var SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
	var LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
	var CONTENT_TYPES = {
		'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
		'audio/flac': 'audio/flac', 'audio/x-flac': 'audio/flac',
		'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg',
		'audio/ogg': 'audio/ogg', 'audio/opus': 'audio/ogg',
		'audio/webm': 'audio/webm',
		'audio/mp4': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
		'audio/aac': 'audio/aac', 'audio/x-aac': 'audio/aac',
		'audio/aiff': 'audio/aiff', 'audio/x-aiff': 'audio/aiff'
	};
	var EXTENSIONS = {
		wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
		webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff'
	};
	var MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

	function isLocalHost ( host ) {
		return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
	}

	// Development harnesses may run on any local port, but only when the
	// engine itself is being served locally.
	function parentAllowed ( origin ) {
		if (PRODUCTION_PARENTS.indexOf ( origin ) !== -1) return true;
		if (!isLocalHost ( w.location.hostname )) return false;
		try {
			var url = new URL ( origin );
			return url.protocol === 'http:' && isLocalHost ( url.hostname );
		}
		catch (e) { return false; }
	}

	function plainText ( value, max, fallback ) {
		var text = String (value === undefined || value === null ? '' : value)
			.replace (/[\u0000-\u001f\u007f]/g, ' ')
			.trim ();
		if (!text) text = fallback || '';
		return text.length > max ? text.slice (0, max) : text;
	}

	function clamp ( value, min, max, fallback ) {
		var n = typeof value === 'number' && isFinite (value) ? value : fallback;
		return n < min ? min : (n > max ? max : n);
	}

	function round ( value ) {
		return Math.round (value * 1e6) / 1e6;
	}

	function fail ( code, message ) {
		var error = new Error ( message );
		error.code = code;
		return error;
	}

	// ── State ───────────────────────────────────────────────────────────────

	var app = null;
	var mt = null;
	var parentOrigin = null;
	var sourceSeq = 0;
	var dirty = false;
	var quiet = 0;
	var partition = null;
	// AudioBuffer -> { id, descriptor, persisted }
	var sources = new WeakMap ();
	// AudioBuffer -> original File for audio imported inside the engine.
	var imported = new WeakMap ();

	function nextSourceId () {
		return 's' + (++sourceSeq) + '_' + Math.random ().toString (36).slice (2, 8);
	}

	function post ( message, transfer ) {
		if (!parentOrigin) return ;
		message.ns = NS;
		message.v = PROTOCOL;
		w.parent.postMessage ( message, parentOrigin, transfer || [] );
	}

	function emit ( type, payload ) {
		post ({ type: type, payload: payload || {} });
	}

	function setDirty ( value ) {
		if (dirty === value) return ;
		dirty = value;
		emit ('dirty', { dirty: value });
	}

	function quietly ( work ) {
		++quiet;
		try { return work (); }
		finally { --quiet; }
	}

	function ensureMultitrack () {
		if (!mt.IsOn ()) mt.Toggle ( true );
	}

	function decode ( arrayBuffer ) {
		return new Promise (function ( resolve, reject ) {
			if (!(arrayBuffer instanceof ArrayBuffer) || !arrayBuffer.byteLength) {
				reject ( fail ('invalid_audio', 'Audio data is missing.') );
				return ;
			}
			mt.DecodeArrayBuffer ( arrayBuffer, resolve, function () {
				reject ( fail ('decode_failed', 'This audio file could not be decoded.') );
			});
		});
	}

	function cleanSource ( raw ) {
		if (!raw || typeof raw !== 'object') throw fail ('invalid_source', 'Audio source is missing.');
		var name = raw.name === undefined ? undefined : plainText ( raw.name, MAX_NAME );
		if (raw.type === 'catalog') {
			if (!SLUG.test (raw.productId) || !SLUG.test (raw.assetId) || !(raw.version >= 1) || raw.version % 1)
				throw fail ('invalid_source', 'Catalog source is invalid.');
			return name === undefined ?
				{ type: 'catalog', productId: raw.productId, version: raw.version, assetId: raw.assetId } :
				{ type: 'catalog', productId: raw.productId, version: raw.version, assetId: raw.assetId, name: name };
		}
		if (raw.type === 'asset') {
			if (!UUID.test (raw.assetId)) throw fail ('invalid_source', 'Asset source is invalid.');
			return name === undefined ?
				{ type: 'asset', assetId: raw.assetId.toLowerCase () } :
				{ type: 'asset', assetId: raw.assetId.toLowerCase (), name: name };
		}
		throw fail ('invalid_source', 'Audio source type is not supported.');
	}

	// ── Manifest conversion ─────────────────────────────────────────────────

	function signature ( sig ) {
		var parts = String (sig || '4/4').split ('/');
		var beats = parts[0] / 1, note = parts[1] / 1;
		return beats >= 1 && note >= 1 ? [beats, note] : [4, 4];
	}

	function clipOut ( clip ) {
		return clip.out === undefined ? clip.buffer.duration : clip.out;
	}

	function collect () {
		ensureMultitrack ();
		var st = mt.getState ();
		var entries = [];
		var byBuffer = new Map ();
		for (var i = 0; i < st.clips.length; ++i) {
			var clip = st.clips[i];
			if (!clip.buffer) continue;
			var entry = byBuffer.get ( clip.buffer );
			if (!entry) {
				var info = sources.get ( clip.buffer );
				if (!info) {
					info = { id: nextSourceId (), descriptor: null, persisted: false };
					sources.set ( clip.buffer, info );
				}
				entry = { buffer: clip.buffer, info: info, clips: [] };
				byBuffer.set ( clip.buffer, entry );
				entries.push ( entry );
			}
			entry.clips.push ( clip );
		}
		return { st: st, entries: entries, byBuffer: byBuffer };
	}

	function toManifest ( collected ) {
		var st = collected.st;
		var ctx = mt.GetAudioContext ();
		var end = 0;
		var markers = app.mrk ? app.mrk.serMt () : [];
		var manifest = {
			schemaVersion: 1,
			sampleRate: Math.round (ctx.sampleRate || 48000),
			durationSeconds: 0,
			bpm: clamp ( st.beat_bpm, 20, 400, 120 ),
			timeSignature: signature ( st.beat_sig ),
			master: { gain: round (clamp ( st.master_vol, 0, 4, 1 )) },
			sources: collected.entries.map (function ( entry ) {
				var info = entry.info;
				var base = { id: info.id };
				if (info.persisted && info.descriptor) {
					for (var key in info.descriptor) base[key] = info.descriptor[key];
					return base;
				}
				base.type = 'pending';
				base.name = plainText ( entry.clips[0] && entry.clips[0].name, MAX_NAME, 'Audio' );
				return base;
			}),
			tracks: st.tracks.map (function ( track ) {
				return {
					id: track.id,
					name: plainText ( track.name, MAX_TRACK_NAME, 'Channel' ),
					gain: round (clamp ( track.vol, 0, 4, 1 )),
					pan: round (clamp ( track.pan, -1, 1, 0 )),
					muted: !!track.mute,
					solo: !!track.solo,
					extra: { h: clamp ( track.h, 0.1, 10, 1 ) },
					clips: st.clips.filter (function ( clip ) {
						return clip.track === track.id && clip.buffer;
					}).map (function ( clip ) {
						var offset = Math.max (0, clip.in || 0);
						var duration = Math.max (0.001, clipOut ( clip ) - offset);
						end = Math.max (end, (clip.start || 0) + duration);
						return {
							id: clip.id,
							sourceId: collected.byBuffer.get ( clip.buffer ).info.id,
							start: round (Math.max (0, clip.start || 0)),
							offset: round (offset),
							duration: round (duration),
							name: plainText ( clip.name, MAX_NAME, 'Audio' ),
							fadeIn: round (clamp ( clip.fi, 0, duration, 0 )),
							fadeOut: round (clamp ( clip.fo, 0, duration, 0 ))
						};
					})
				};
			}),
			markers: markers.map (function ( m ) {
				return { time: round (Math.max (0, m.time || 0)), label: plainText ( m.name, 80 ) };
			}),
			engine: {
				name: 'audiomass',
				version: ENGINE_VERSION,
				state: {
					xfades: st.xfades || {},
					beatOn: !!st.beat_on,
					beatSnap: !!st.beat_snap,
					pxPerSec: clamp ( st.px_per_sec, 1, 100000, 86 ),
					rowH: clamp ( st.row_h, 10, 1000, 88 ),
					trackUid: st.track_uid || 1,
					clipUid: st.clip_uid || 1,
					cursor: round (Math.max (0, st.cursor || 0)),
					marker: round (Math.max (0, st.marker || 0)),
					markers: markers.map (function ( m ) {
						return { id: plainText ( m.id, 64 ), time: round (m.time || 0), name: plainText ( m.name, 80 ), color: plainText ( m.color, 16 ), loop: !!m.loop };
					})
				}
			}
		};
		manifest.durationSeconds = round (end);
		return manifest;
	}

	function fromManifest ( manifest, decoded ) {
		var state = manifest.engine && manifest.engine.name === 'audiomass' && manifest.engine.state || {};
		var missing = {};
		var tracks = [];
		var clips = [];
		(manifest.tracks || []).forEach (function ( track ) {
			if (!LOCAL_ID.test (track.id)) return ;
			tracks.push ({
				id: track.id,
				name: plainText ( track.name, MAX_TRACK_NAME, 'Channel' ),
				mute: !!track.muted,
				solo: !!track.solo,
				vol: clamp ( track.gain, 0, 4, 1 ),
				pan: clamp ( track.pan, -1, 1, 0 ),
				h: track.extra && track.extra.h || 1,
				rec: false
			});
			(track.clips || []).forEach (function ( clip ) {
				var buffer = decoded[clip.sourceId];
				if (!buffer) { missing[clip.sourceId] = 1; return ; }
				var offset = clamp ( clip.offset, 0, buffer.duration, 0 );
				clips.push ({
					id: clip.id,
					track: track.id,
					start: Math.max (0, clip.start || 0),
					in: offset,
					out: Math.min (buffer.duration, offset + Math.max (0.001, clip.duration || 0)),
					fi: clip.fadeIn || 0,
					fo: clip.fadeOut || 0,
					name: plainText ( clip.name, MAX_NAME, 'Audio' ),
					buffer: buffer
				});
			});
		});
		if (!tracks.length) tracks.push ({ id: 'mt1', name: 'Channel 1' });
		var sig = manifest.timeSignature || [4, 4];
		return {
			state: {
				tracks: tracks,
				clips: clips,
				track_uid: state.trackUid,
				clip_uid: state.clipUid,
				cursor: state.cursor || 0,
				marker: state.marker || 0,
				beat_on: !!state.beatOn,
				beat_snap: !!state.beatSnap,
				beat_bpm: manifest.bpm || 120,
				beat_sig: sig[0] + '/' + sig[1],
				px_per_sec: state.pxPerSec,
				row_h: state.rowH,
				master_vol: manifest.master ? manifest.master.gain : 1,
				xfades: state.xfades || {},
				markers: state.markers || (manifest.markers || []).map (function ( m ) {
					return { time: m.time, name: m.label || '' };
				})
			},
			missing: Object.keys ( missing )
		};
	}

	// ── Encoding ────────────────────────────────────────────────────────────

	var WORKERS = { flac: 'flac.js', mp3: 'lame.js', wav: 'wav.js' };
	var TYPES = { flac: 'audio/flac', mp3: 'audio/mpeg', wav: 'audio/wav' };

	function toInt16 ( data ) {
		var out = new Int16Array ( data.length );
		for (var i = 0; i < data.length; ++i) {
			var v = data[i] < 0 ? data[i] * 32768 : data[i] * 32767;
			out[i] = v < -32768 ? -32768 : (v > 32767 ? 32767 : v);
		}
		return out;
	}

	function encode ( buffer, format ) {
		return new Promise (function ( resolve, reject ) {
			var worker = new Worker ( WORKERS[format] );
			var channels = Math.min (2, buffer.numberOfChannels);
			var left = toInt16 ( buffer.getChannelData (0) );
			var right = channels > 1 ? toInt16 ( buffer.getChannelData (1) ) : null;
			worker.onmessage = function ( ev ) {
				if (ev.data && ev.data.percentage !== undefined) return ;
				worker.terminate ();
				if (ev.data instanceof Blob) resolve ( ev.data );
				else reject ( fail ('encode_failed', 'Audio could not be encoded.') );
			};
			worker.onerror = function () {
				worker.terminate ();
				reject ( fail ('encode_failed', 'Audio could not be encoded.') );
			};
			worker.postMessage ({
				sample_rate: buffer.sampleRate,
				kbps: 192,
				flac_compression: 5,
				channels: channels,
				bit_depth: 16,
				samples: left.length
			});
			worker.postMessage ( left.buffer, [left.buffer] );
			worker.postMessage ( right ? right.buffer : null, right ? [right.buffer] : [] );
		});
	}

	function importedType ( file ) {
		var type = CONTENT_TYPES[(file.type || '').toLowerCase ()];
		if (type) return type;
		var ext = (/\.([a-z0-9]+)$/i.exec (file.name || '') || [])[1];
		return ext ? EXTENSIONS[ext.toLowerCase ()] || null : null;
	}

	function newAudioFor ( entry ) {
		var buffer = entry.buffer;
		var clipName = plainText ( entry.clips[0] && entry.clips[0].name, MAX_NAME, 'Audio' );
		var meta = {
			sourceId: entry.info.id,
			durationSeconds: round (buffer.duration),
			sampleRate: buffer.sampleRate,
			channels: Math.min (2, buffer.numberOfChannels)
		};
		var file = imported.get ( buffer );
		var type = file && importedType ( file );
		if (file && type && file.size > 0 && file.size <= MAX_UPLOAD_BYTES) {
			return file.arrayBuffer ().then (function ( bytes ) {
				meta.kind = 'import';
				meta.name = plainText ( file.name, 255, clipName );
				meta.contentType = type;
				meta.buffer = bytes;
				return meta;
			});
		}
		var recording = entry.clips.some (function ( clip ) { return /^Recording/.test (clip.name || ''); });
		return encode ( buffer, 'flac' ).then (function ( blob ) {
			return blob.arrayBuffer ();
		}).then (function ( bytes ) {
			meta.kind = recording ? 'recording' : 'render';
			meta.name = plainText ( clipName.replace (/\.[a-z0-9]+$/i, ''), 249, 'Audio' ) + '.flac';
			meta.contentType = 'audio/flac';
			meta.buffer = bytes;
			return meta;
		});
	}

	// ── Requests ────────────────────────────────────────────────────────────

	var handlers = {
		'init': function ( payload ) {
			if (payload && payload.storagePartition !== undefined) {
				if (!LOCAL_ID.test (payload.storagePartition)) throw fail ('invalid_request', 'Invalid storage partition.');
				partition = payload.storagePartition;
			}
			return {
				engine: 'audiomass',
				engineVersion: ENGINE_VERSION,
				protocol: PROTOCOL,
				sampleRate: Math.round (mt.GetAudioContext ().sampleRate || 48000)
			};
		},

		'new-project': function ( payload ) {
			quietly (function () {
				mt.LoadState ({
					tracks: [{ id: 'mt1', name: 'Channel 1' }, { id: 'mt2', name: 'Channel 2' }],
					clips: [],
					track_uid: 3,
					clip_uid: 1,
					beat_bpm: clamp ( payload && payload.bpm, 20, 400, 120 )
				});
			});
			setDirty ( false );
			return {};
		},

		'load-project': function ( payload ) {
			var manifest = payload && payload.manifest;
			if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray (manifest.sources) || !Array.isArray (manifest.tracks))
				throw fail ('invalid_manifest', 'Project data is not a v1 manifest.');
			var descriptors = {};
			manifest.sources.forEach (function ( source ) {
				if (!source || !LOCAL_ID.test (source.id)) return ;
				try { descriptors[source.id] = cleanSource ( source ); } catch (e) {}
			});
			var decoded = {};
			var failed = [];
			var list = (payload.sources || []).filter (function ( item ) {
				return item && descriptors[item.sourceId];
			});
			// Decode one at a time to keep peak memory down on large projects.
			return list.reduce (function ( chain, item ) {
				return chain.then (function () {
					return decode ( item.buffer ).then (function ( buffer ) {
						decoded[item.sourceId] = buffer;
						sources.set ( buffer, { id: item.sourceId, descriptor: descriptors[item.sourceId], persisted: true });
					}, function () { failed.push ( item.sourceId ); });
				});
			}, Promise.resolve ()).then (function () {
				var built = fromManifest ( manifest, decoded );
				quietly (function () { mt.LoadState ( built.state ); });
				setDirty ( false );
				return { missingSourceIds: built.missing, undecodableSourceIds: failed };
			});
		},

		'add-audio': function ( payload ) {
			var descriptor = cleanSource ( payload && payload.source );
			var name = plainText ( payload.name, MAX_NAME, 'Audio' );
			return decode ( payload.buffer ).then (function ( buffer ) {
				var id = nextSourceId ();
				sources.set ( buffer, { id: id, descriptor: descriptor, persisted: true });
				var clip = mt.AddBuffer ( buffer, name, {
					placement: payload.placement === 'playhead' ? 'playhead' : 'new-track',
					trackName: name
				});
				if (!clip) throw fail ('add_failed', 'Audio could not be added.');
				return { sourceId: id };
			});
		},

		'snapshot': function () {
			var collected = collect ();
			var manifest = toManifest ( collected );
			var pending = collected.entries.filter (function ( entry ) { return !entry.info.persisted; });
			return pending.reduce (function ( chain, entry ) {
				return chain.then (function ( list ) {
					return newAudioFor ( entry ).then (function ( item ) {
						list.push ( item );
						return list;
					});
				});
			}, Promise.resolve ([])).then (function ( newAudio ) {
				return {
					result: { manifest: manifest, newAudio: newAudio },
					transfer: newAudio.map (function ( item ) { return item.buffer; })
				};
			});
		},

		'bind-sources': function ( payload ) {
			var bindings = {};
			((payload && payload.bindings) || []).forEach (function ( binding ) {
				if (binding && LOCAL_ID.test (binding.sourceId) && UUID.test (binding.assetId))
					bindings[binding.sourceId] = binding.assetId.toLowerCase ();
			});
			var st = mt.getState ();
			for (var i = 0; i < st.clips.length; ++i) {
				var info = st.clips[i].buffer && sources.get ( st.clips[i].buffer );
				if (info && bindings[info.id]) {
					info.descriptor = { type: 'asset', assetId: bindings[info.id] };
					info.persisted = true;
					imported.delete ( st.clips[i].buffer );
				}
			}
			setDirty ( false );
			return {};
		},

		'export-mix': function ( payload ) {
			var format = payload && WORKERS[payload.format] ? payload.format : 'wav';
			ensureMultitrack ();
			if (!mt.HasClips ()) throw fail ('empty_project', 'Add audio before exporting a mix.');
			return new Promise (function ( resolve, reject ) {
				mt.MixdownAsync ( null, function ( buffer ) {
					if (!buffer) { reject ( fail ('mixdown_failed', 'The mix could not be rendered.') ); return ; }
					encode ( buffer, format ).then (function ( blob ) {
						return blob.arrayBuffer ();
					}).then (function ( bytes ) {
						resolve ({
							result: { buffer: bytes, contentType: TYPES[format], durationSeconds: round (buffer.duration) },
							transfer: [bytes]
						});
					}, reject);
				});
			});
		},

		'clear-local': function () {
			partition = null;
			try { w.indexedDB && w.indexedDB.deleteDatabase ('audiomass'); } catch (e) {}
			try { w.localStorage && w.localStorage.clear (); } catch (e) {}
			return handlers['new-project']({});
		}
	};

	function respond ( id, outcome ) {
		Promise.resolve ().then (outcome).then (function ( value ) {
			var wrapped = value && value.transfer ? value : { result: value || {}, transfer: [] };
			post ({ type: 'response', id: id, payload: { ok: true, result: wrapped.result } }, wrapped.transfer);
		}, function ( error ) {
			post ({ type: 'response', id: id, payload: { ok: false, error: {
				code: (error && error.code) || 'engine_failed',
				message: (error && error.code && error.message) || 'The editor could not complete that request.'
			} } });
		});
	}

	function onMessage ( e ) {
		if (e.source !== w.parent || !parentAllowed ( e.origin )) return ;
		if (parentOrigin && e.origin !== parentOrigin) return ;
		var data = e.data;
		if (!data || data.ns !== NS || data.v !== PROTOCOL || typeof data.type !== 'string') return ;
		parentOrigin = e.origin;
		if (typeof data.id !== 'string' || data.id.length > 64) return ;
		var handler = handlers.hasOwnProperty (data.type) ? handlers[data.type] : null;
		if (!handler) {
			respond ( data.id, function () { throw fail ('unknown_request', 'Unknown request.'); });
			return ;
		}
		respond ( data.id, function () { return handler ( data.payload || {} ); });
	}

	// ── Boot ────────────────────────────────────────────────────────────────

	function attach ( editor ) {
		app = editor;
		mt = editor.multitrack;
		if (!mt || !mt.AddBuffer) return ;
		mt.onImportedBuffer = function ( buffer, file ) {
			if (buffer && file) imported.set ( buffer, file );
		};
		var touched = function () { if (!quiet) setDirty ( true ); };
		app.listenFor ('StateRequestPush', touched);
		app.listenFor ('DidUpdateMultitrack', touched);
		app.listenFor ('ShowError', function ( message ) {
			emit ('error', { code: 'engine_error', message: plainText ( message, 300, 'Editor error' ) });
		});
		w.addEventListener ('message', onMessage, false);

		// Announce readiness to the embedding page when its origin is known and
		// allowed; hosts may also simply send `init` once the frame loads.
		var referrer = '';
		try { referrer = d.referrer ? new URL ( d.referrer ).origin : ''; } catch (e) {}
		if (referrer && parentAllowed ( referrer )) {
			parentOrigin = referrer;
			emit ('ready', { engine: 'audiomass', engineVersion: ENGINE_VERSION, protocol: PROTOCOL });
		}
	}

	w.PKSwitchBeatsBridge = { attach: attach, parentAllowed: parentAllowed };
})( window, document );
