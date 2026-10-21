(function ( w, d ) {
	
	function OneUp ( _text, _time, _clss ) {
		var el = d.createElement ('div');
		var cl = 'pk_oneup pk_noselect';

		el.style.cssText = 'margin-top:20px;opacity:0';
		if (_clss) cl = cl + ' ' + _clss;

		el.className = cl;
		// Messages can include file, clip, and session names: never parse as HTML.
		el.textContent = _text || '';

		d.body.appendChild ( el );
		setTimeout (function() {
			el.style.cssText = 'margin-top:0px;opacity:1';
			
			setTimeout (function() {
				el.style.cssText = 'margin-top:-20px;opacity:0';
				
				setTimeout (function() {
					el.parentNode.removeChild ( el );
					el = null;
				}, 330);
			}, _time || 720);
		}, 25);
	}

	function EscapeHtml ( value ) {
		return String (value === undefined || value === null ? '' : value)
			.replace (/&/g, '&amp;')
			.replace (/</g, '&lt;')
			.replace (/>/g, '&gt;')
			.replace (/"/g, '&quot;')
			.replace (/'/g, '&#39;');
	}

	w.OneUp = OneUp;
	w.PKEscapeHtml = EscapeHtml;
})( window, document );