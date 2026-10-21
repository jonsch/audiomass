/*
 * SwitchBeats Studio Editor entry point. Replaces the inline init script so the
 * page can run under a Content-Security-Policy without 'unsafe-inline' scripts.
 *
 * Inside the storefront iframe: multitrack mode plus the postMessage bridge.
 * Opened directly: a plain pointer to the storefront page (localhost may add
 * ?standalone=1 to run the plain editor for development).
 */
(function ( w, d ) {
	'use strict';

	var EDITOR_URL = 'https://switchbeats.studio/studio/editor';
	var framed = true;
	try { framed = w.self !== w.top; } catch (e) { framed = true; }
	var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test (w.location.hostname);

	if (!framed && !(local && /[?&]standalone=1\b/.test (w.location.search))) {
		var root = d.getElementById ('app');
		var wrap = d.createElement ('div');
		var title = d.createElement ('h1');
		var text = d.createElement ('p');
		var link = d.createElement ('a');
		wrap.className = 'sb_standalone';
		title.textContent = 'SwitchBeats Studio Editor';
		text.textContent = 'Studio Editor opens from your SwitchBeats account.';
		link.href = EDITOR_URL;
		link.textContent = 'Open Studio Editor';
		wrap.appendChild ( title );
		wrap.appendChild ( text );
		wrap.appendChild ( link );
		root.appendChild ( wrap );
		return ;
	}

	if (framed) w.PKSwitchBeatsEmbed = true;
	var editor = w.PKAudioEditor.init ('app');
	if (!editor) return ;
	if (editor.multitrack) editor.multitrack.Toggle ( true );
	if (framed && w.PKSwitchBeatsBridge) w.PKSwitchBeatsBridge.attach ( editor );
})( window, document );
