/* Session-only device choices. No permission request happens on menu open. */
(function (w, d) {
	'use strict';

	function Devices (app) {
		var q = this;
		var media = navigator.mediaDevices;
		q.inputId = '';
		q.outputId = '';
		q.devices = [];
		q.busy = false;
		q.open = false;
		q.context = function () { return app.multitrack.GetAudioContext (); };
		q.recording = function () { return !!(app.rec && app.rec.isBusy ()); };
		q.canOutput = function () { return typeof q.context ().setSinkId === 'function'; };
		function available () {
			if (q.busy) throw new Error ('Wait for the current device request to finish.');
			if (q.recording ()) throw new Error ('Stop recording before changing audio devices.');
		}
		q.refresh = function () {
			if (!media || !media.enumerateDevices) return Promise.reject (new Error ('Device selection needs a secure connection and a supported browser.'));
			return media.enumerateDevices ().then (function (items) { q.devices = items; return items; });
		};
		q.setInput = function (id) {
			available ();
			q.inputId = id;
		};
		q.setOutput = function (id) {
			try { available (); } catch (e) { return Promise.reject (e); }
			if (!q.canOutput ()) return Promise.reject (new Error ('This browser cannot select an editor output. Use your system sound settings.'));
			q.busy = true;
			return Promise.resolve ().then (function () { return q.context ().setSinkId (id); }).then (function () {
				q.outputId = id;
			}).finally (function () { q.busy = false; });
		};
		q.enable = function () {
			try { available (); } catch (e) { return Promise.reject (e); }
			if (!media || !media.getUserMedia) return Promise.reject (new Error ('Microphone access is unavailable in this browser or connection.'));
			q.busy = true;
			return Promise.resolve ().then (function () { return media.getUserMedia ({audio: true, video: false}); }).then (function (stream) {
				// Permission discovery only: never connect this stream or keep its mic open.
				stream.getTracks ().forEach (function (track) { track.stop (); });
				return q.refresh ();
			}).finally (function () { q.busy = false; });
		};
		q.chooseOutput = function (stillOpen) {
			try { available (); } catch (e) { return Promise.reject (e); }
			if (!q.canOutput () || !media || !media.selectAudioOutput) return Promise.reject (new Error ('The browser output picker is unavailable. Choose a listed output or use system sound settings.'));
			q.busy = true;
			// Call directly from the button's user gesture, before any awaited work.
			var selection;
			try { selection = media.selectAudioOutput (); } catch (e) { q.busy = false; return Promise.reject (e); }
			return selection.then (function (device) {
				if (stillOpen && !stillOpen ()) return;
				return q.context ().setSinkId (device.deviceId).then (function () { q.outputId = device.deviceId; });
			}).finally (function () { q.busy = false; });
		};

		q.show = function () {
			if (q.open || !app.ui.InteractionHandler.checkAndSet ('audio-devices')) return;
			q.open = true;
			var alive = true, input, output, enable, picker, refresh, status, outputHelp;
			function errorText (error) {
				if (error && error.name === 'NotAllowedError') return 'Device access was not allowed or the picker was cancelled. Your choices have not changed.';
				if (error && error.name === 'NotFoundError') return 'That device is unavailable. Reconnect it, refresh the list, or choose System default.';
				return error && error.message || 'Could not change the audio device. Your previous choice is retained.';
			}
			function options (select, kind, selected) {
				select.textContent = '';
				var def = d.createElement ('option'); def.value = ''; def.textContent = 'System default'; select.appendChild (def);
				var found = !selected, index = 0;
				q.devices.forEach (function (device) {
					if (device.kind !== kind || !device.deviceId || device.deviceId === 'default') return;
					var option = d.createElement ('option'); option.value = device.deviceId;
					option.textContent = device.label || ((kind === 'audioinput' ? 'Microphone ' : 'Output ') + (++index));
					select.appendChild (option); if (device.deviceId === selected) found = true;
				});
				if (!found) {
					var missing = d.createElement ('option'); missing.value = selected; missing.textContent = 'Selected device unavailable — choose another'; select.appendChild (missing);
				}
				select.value = selected;
				return found;
			}
			function render (message) {
				if (!alive) return;
				var ready = !q.busy && !q.recording ();
				var inputFound = options (input, 'audioinput', q.inputId);
				var outputFound = options (output, 'audiooutput', q.outputId);
				input.disabled = !ready || !media || !media.getUserMedia;
				output.disabled = !ready || !q.canOutput ();
				enable.disabled = !ready || !media || !media.getUserMedia;
				picker.disabled = !ready || !q.canOutput () || !media || !media.selectAudioOutput;
				refresh.disabled = q.busy;
				outputHelp.textContent = q.canOutput () ? 'Output changes apply to editor playback. Only permitted devices appear; Enable device access can reveal more.' : 'Output switching is not supported in this browser. Playback uses the system output; change it in your system sound settings.';
				status.textContent = message || (q.busy ? 'Waiting for the browser device request…' : q.recording () ? 'Recording is active. Stop the take before changing devices.' : !inputFound || !outputFound ? 'A selected device is unavailable or permission was revoked. Reconnect it or choose System default. No replacement was selected automatically.' : 'Choices apply to this tab and survive project changes. Reloading returns to System default.');
			}
			function run (action, success) {
				var promise;
				try { promise = action (); } catch (e) { render (errorText (e)); return; }
				render ();
				Promise.resolve (promise).then (function () { render (success); }, function (e) { render (errorText (e)); });
			}
			function refreshList () { run (q.refresh); }
			function onRecording () { render (); }
			new w.PKSimpleModal ({
				title: 'Audio Preferences', cancelLabel: 'CLOSE', clss: 'sb_devices_modal', buttons: [],
				body: '<p>Choose where your voice comes from and where you hear the mix. Use headphones to avoid speaker bleed. Live mic monitoring stays off.</p>',
				setup: function (modal) {
					function select (labelText) {
						var label = d.createElement ('label'); label.textContent = labelText;
						var select = d.createElement ('select'); select.setAttribute ('aria-label', labelText); label.appendChild (select); modal.el_body.appendChild (label); return select;
					}
					function button (text, action) { var b = d.createElement ('button'); b.textContent = text; b.onclick = action; modal.el_body.appendChild (b); return b; }
					input = select ('Recording input (next take)');
					input.onchange = function () { var id = input.value; run (function () { q.setInput (id); }, 'Recording input selected for the next take.'); };
					output = select ('Playback output');
					output.onchange = function () { var id = output.value; run (function () { return q.setOutput (id); }, 'Playback output changed.'); };
					outputHelp = d.createElement ('p'); modal.el_body.appendChild (outputHelp);
					enable = button ('Enable device access', function () { run (q.enable, 'Device list refreshed. The temporary microphone stream has been stopped.'); });
					enable.title = 'Requests microphone permission briefly to reveal device names. Does not record a take.';
					picker = button ('Choose output in browser…', function () { run (function () { return q.chooseOutput (function () { return alive; }).then (q.refresh); }); });
					refresh = button ('Refresh devices', refreshList);
					var privacy = d.createElement ('p'); privacy.textContent = 'Enable device access briefly opens the microphone to reveal permitted devices, then immediately stops it. Opening this menu does not request permission.'; modal.el_body.appendChild (privacy);
					status = d.createElement ('p'); status.setAttribute ('role', 'status'); modal.el_body.appendChild (status);
					app.ui.KeyHandler.addCallback ('audio-devices', function () { modal.Destroy (); }, [27]);
					app.listenFor ('DidActionRecordStart', onRecording); app.listenFor ('DidActionRecordStop', onRecording);
					if (media && media.addEventListener) media.addEventListener ('devicechange', refreshList);
					refreshList ();
				},
				ondestroy: function () {
					alive = false; q.open = false; app.ui.InteractionHandler.on = false;
					app.ui.KeyHandler.removeCallback ('audio-devices');
					app.stopListeningFor ('DidActionRecordStart', onRecording); app.stopListeningFor ('DidActionRecordStop', onRecording);
					if (media && media.removeEventListener) media.removeEventListener ('devicechange', refreshList);
				}
			}).Show ();
		};
	}
	w.PKAudioDevices = { get: function (app) { return app.audioDevices || (app.audioDevices = new Devices (app)); } };
})(window, document);
