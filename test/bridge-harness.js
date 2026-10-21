// Development harness for the Studio Editor bridge (protocol v1). It plays the
// storefront's role from a different origin: serve this folder on one local
// port and the engine (`src/`) on another, then open
//   http://localhost:5174/test/bridge.html?engine=http://localhost:8787
(function () {
	'use strict';

	var NS = 'switchbeats.studio-editor';
	var engineUrl = new URLSearchParams (location.search).get ('engine') || 'http://localhost:8787';
	var engineOrigin = new URL (engineUrl).origin;
	var frame = document.getElementById ('engine');
	var logEl = document.getElementById ('log');
	var statusEl = document.getElementById ('status');
	var pending = new Map ();
	var events = [];
	var seq = 0;
	var ctx = new (window.AudioContext || window.webkitAudioContext) ();
	var library = {}; // sourceId -> bytes the "storefront" would fetch from R2
	window.__results = { events: events, steps: {}, failures: [] };

	function log ( text, ok ) {
		var line = document.createElement ('div');
		if (ok === true) line.className = 'ok';
		if (ok === false) line.className = 'bad';
		line.textContent = text;
		logEl.appendChild (line);
		logEl.scrollTop = logEl.scrollHeight;
	}
	function check ( condition, label, detail ) {
		log ((condition ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''), !!condition);
		if (!condition) window.__results.failures.push (label);
		return condition;
	}

	window.addEventListener ('message', function ( e ) {
		if (e.origin !== engineOrigin || e.source !== frame.contentWindow) return;
		var m = e.data;
		if (!m || m.ns !== NS || m.v !== 1) return;
		if (m.type === 'response') {
			var waiter = pending.get (m.id);
			if (!waiter) return;
			pending.delete (m.id);
			if (m.payload.ok) waiter.resolve (m.payload.result);
			else waiter.reject (Object.assign (new Error (m.payload.error.message), { code: m.payload.error.code }));
			return;
		}
		events.push ({ type: m.type, payload: m.payload });
		log ('event ' + m.type + ' ' + JSON.stringify (m.payload));
	});

	function request ( type, payload, transfer ) {
		var id = 'h' + (++seq);
		return new Promise (function ( resolve, reject ) {
			pending.set (id, { resolve: resolve, reject: reject });
			frame.contentWindow.postMessage ({ ns: NS, v: 1, type: type, id: id, payload: payload || {} }, engineOrigin, transfer || []);
			setTimeout (function () {
				if (!pending.has (id)) return;
				pending.delete (id);
				reject (new Error (type + ' timed out'));
			}, 60000);
		});
	}

	function sineWav ( seconds, freq ) {
		var rate = 44100, n = Math.floor (seconds * rate);
		var buffer = new ArrayBuffer (44 + n * 2), view = new DataView (buffer);
		function str ( off, s ) { for (var i = 0; i < s.length; ++i) view.setUint8 (off + i, s.charCodeAt (i)); }
		str (0, 'RIFF'); view.setUint32 (4, 36 + n * 2, true); str (8, 'WAVE'); str (12, 'fmt ');
		view.setUint32 (16, 16, true); view.setUint16 (20, 1, true); view.setUint16 (22, 1, true);
		view.setUint32 (24, rate, true); view.setUint32 (28, rate * 2, true); view.setUint16 (32, 2, true); view.setUint16 (34, 16, true);
		str (36, 'data'); view.setUint32 (40, n * 2, true);
		for (var i = 0; i < n; ++i) view.setInt16 (44 + i * 2, Math.sin (2 * Math.PI * freq * i / rate) * 12000, true);
		return buffer;
	}

	function decodeLocal ( bytes ) {
		return ctx.decodeAudioData (bytes.slice (0));
	}

	var ASSET_ID = '6f1c2b8e-4d1a-4c7e-9a55-0b8f7e2d3c41';
	var RENDER_ID = '0d5e6a77-1b2c-4d3e-8f90-a1b2c3d4e5f6';

	async function basic () {
		var info = await request ('init', { storagePartition: 'harness_user' });
		check (info.engine === 'audiomass' && info.protocol === 1, 'init returns engine info', JSON.stringify (info));
		await request ('new-project', { bpm: 96 });
		var beat = sineWav (2, 440), vox = sineWav (3, 660);
		var added1 = await request ('add-audio', { name: 'Neon Alley', buffer: beat, source: { type: 'catalog', productId: 'neon-alley', version: 3, assetId: 'full', name: 'Neon Alley' } }, [beat]);
		check (beat.byteLength === 0, 'catalog audio was transferred, not copied');
		var added2 = await request ('add-audio', { name: 'My vocal.wav', buffer: vox, source: { type: 'asset', assetId: ASSET_ID } }, [vox]);
		library[added1.sourceId] = sineWav (2, 440);
		library[added2.sourceId] = sineWav (3, 660);
		var snap = await request ('snapshot');
		window.__results.steps.basic = snap.manifest;
		check (snap.newAudio.length === 0, 'persisted sources are not re-uploaded', 'newAudio=' + snap.newAudio.length);
		check (snap.manifest.sources.length === 2, 'two sources', JSON.stringify (snap.manifest.sources));
		check (snap.manifest.sources.some (function ( s ) { return s.type === 'catalog' && s.productId === 'neon-alley'; }), 'catalog source kept');
		check (snap.manifest.sources.some (function ( s ) { return s.type === 'asset' && s.assetId === ASSET_ID; }), 'asset source kept');
		var clipCount = snap.manifest.tracks.reduce (function ( n, t ) { return n + t.clips.length; }, 0);
		check (clipCount === 2, 'two clips in the arrangement', 'clips=' + clipCount);
		check (snap.manifest.bpm === 96, 'bpm carried', String (snap.manifest.bpm));
		check (Math.abs (snap.manifest.durationSeconds - 3) < 0.01, 'duration is content length', String (snap.manifest.durationSeconds));
		check (JSON.stringify (snap.manifest).indexOf ('http') === -1, 'manifest contains no URLs');
		check (events.some (function ( e ) { return e.type === 'dirty' && e.payload.dirty; }), 'dirty event after edits');
		try { await request ('add-audio', { name: 'x', buffer: sineWav (1, 220), source: { type: 'url', url: 'https://example.com/a.wav' } }); check (false, 'rejects URL sources'); }
		catch (error) { check (error.code === 'invalid_source', 'rejects URL sources', error.code); }
		try { await request ('nope'); check (false, 'unknown request rejected'); }
		catch (error) { check (error.code === 'unknown_request', 'unknown request rejected', error.code); }
		frame.contentWindow.postMessage ({ ns: 'other', v: 1, type: 'new-project', id: 'zz' }, engineOrigin);
		log ('Basic flow done. Now select a clip in the editor, apply an effect (e.g. Effects → Reverse), then run step 2.');
	}

	async function renderRoundTrip () {
		var snap = await request ('snapshot');
		check (snap.newAudio.length >= 1, 'effect render reported as new audio', 'newAudio=' + snap.newAudio.length);
		var item = snap.newAudio[0];
		if (!item) return;
		check (item.kind === 'render' && item.contentType === 'audio/flac', 'render encoded as FLAC', item.kind + ' ' + item.contentType + ' ' + item.buffer.byteLength + ' bytes');
		var decoded = await decodeLocal (item.buffer);
		check (Math.abs (decoded.duration - item.durationSeconds) < 0.05, 'FLAC decodes to the same duration', decoded.duration.toFixed (3) + 's');
		var pendingSources = snap.manifest.sources.filter (function ( s ) { return s.type === 'pending'; });
		check (pendingSources.length === snap.newAudio.length, 'pending sources match new audio');
		// The storefront would upload, then rewrite pending sources and save.
		library[item.sourceId] = item.buffer.slice (0);
		await request ('bind-sources', { bindings: [{ sourceId: item.sourceId, assetId: RENDER_ID }] });
		var again = await request ('snapshot');
		check (again.newAudio.length === 0, 'bound audio is not reported again');
		var manifest = again.manifest;
		window.__results.steps.render = manifest;
		// Reload from scratch the way opening a saved project works.
		await request ('new-project');
		var payloadSources = manifest.sources.map (function ( s ) {
			return { sourceId: s.id, name: s.name || s.id, buffer: library[s.id].slice (0) };
		});
		var loaded = await request ('load-project', { manifest: manifest, sources: payloadSources }, payloadSources.map (function ( s ) { return s.buffer; }));
		check (loaded.missingSourceIds.length === 0 && loaded.undecodableSourceIds.length === 0, 'project reloads with every source', JSON.stringify (loaded));
		var reloaded = await request ('snapshot');
		window.__results.steps.reloaded = reloaded.manifest;
		check (reloaded.newAudio.length === 0, 'reloaded project has nothing new to upload');
		check (JSON.stringify (reloaded.manifest.tracks) === JSON.stringify (manifest.tracks), 'arrangement survives the round trip');
	}

	async function exportMixes () {
		for (var format of ['wav', 'mp3', 'flac']) {
			var mix = await request ('export-mix', { format: format });
			var decoded = await decodeLocal (mix.buffer);
			check (decoded.duration > 1, 'export ' + format + ' decodes', mix.contentType + ' ' + mix.buffer.byteLength + ' bytes, ' + decoded.duration.toFixed (2) + 's');
		}
		window.__results.done = true;
	}

	function wire ( id, fn ) {
		document.getElementById (id).onclick = function () {
			fn ().catch (function ( error ) { check (false, id + ' threw', error.message); });
		};
	}
	wire ('basic', basic);
	wire ('render', renderRoundTrip);
	wire ('export', exportMixes);
	window.__harness = { basic: basic, renderRoundTrip: renderRoundTrip, exportMixes: exportMixes, request: request };

	frame.onload = function () { statusEl.textContent = 'engine loaded from ' + engineOrigin; };
	frame.src = engineUrl + '/';
}) ();
