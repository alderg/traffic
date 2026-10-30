/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Page of the traffic simulation. draw.io runs in the editor frame as the
 * editor of the road network. Once it is ready, js/roads.js and
 * js/simulation.js are loaded into the frame and attached to the editor, and
 * the controls of this page drive the simulation.
 *
 * Debug output is off unless ?dev=1 or ?test=1 is in the URL or the checkbox
 * turns it on, which does not change the URL. It logs all errors of the
 * page, the editor and the simulation with their stack, also the errors that
 * draw.io catches and shows, and makes the simulation write its state to the
 * console once a second. ?dev=1 or ?test=1 also passes test=1 to the editor
 * for its own debug messages and the Develop menu.
 *
 * ?city=<name> or ?osm=<type>/<id> loads the road network of that town from
 * OpenStreetMap at start instead of the example (js/osm.js), with roads=main,
 * collector or all and a section as circle=<lat>,<lon>,<m> or
 * bbox=<south>,<west>,<north>,<east>. Copy Link puts the loaded town there,
 * with trips=<mode> and through=<percent> if the trips of its page are not
 * the default (see TrafficSimulation.setTrips).
 * Towns show the map of OpenStreetMap behind their roads (js/map.js) with
 * the tiles of ?tiles=<url with {z}, {x} and {y}>, tileMaxZoom=<zoom> and
 * tileAttribution=<text>, by default tile.openstreetmap.org.
 */
(function()
{
	var examples = [
		{label: 'Town', name: 'town'},
		{label: 'Small, with a traffic light', name: 'small'},
		{label: 'Race', name: 'race'},
		{label: 'Axhausen', name: 'axhausen'},
		{label: 'Roundabout with five arms', name: 'roundabout'},
		{label: 'Grid with traffic lights', name: 'grid'},
		{label: 'Bottleneck with a bypass', name: 'bottleneck'}];
	var frame = document.getElementById('editor');
	var params = new URLSearchParams(window.location.search);
	var testMode = params.get('dev') == '1' || params.get('test') == '1';
	var debug = testMode;
	frame.src = frame.getAttribute('data-src') + ((testMode) ? '&test=1' : '');
	var startButton = document.getElementById('start');
	var stats = document.getElementById('stats');
	var ui = null;
	var sim = null;
	var roads = null;
	var updateSelection = null;
	var showSelection = null;
	var updateTrips = null;
	var statsShown = null;
	var town = null;
	var openingFile = false;
	// The last load that may replace the diagram, the changes of the diagram
	// so far and the open question to discard them (see confirmLoad)
	var lastLoad = null;
	var changes = 0;
	var question = null;
	var map = null;
	var legendBar = null;
	var legendStops = null;
	var faviconRunning = false;
	var tiles = getTiles();
	// Keys of the speed unit, the driving side and the regions chosen by hand
	// for towns in the local storage, and the region of the towns that open
	// (see initRegion)
	var unitsKey = 'traffic-units';
	var sideKey = 'traffic-side';
	var townRegionsKey = 'traffic-town-regions';
	var maxTownRegions = 100;
	var townRegion = null;
	var vehicleSection = document.getElementById('vehicle');
	var centerHint = document.getElementById('center-hint');
	var carsHint = document.getElementById('cars-hint');
	var vehicleRows = vehicleSection.querySelector('tbody');
	var logged = new WeakSet();
	var loading = initLoading();

	// The town of the URL shows its progress before the editor starts
	if (params.has('osm') || params.has('city'))
	{
		loading.show('Loading ' + (params.get('city') || params.get('osm')) + '…', 'Starting the editor…');
	}

	/**
	 * Logs the given error with its stack and the given context if debug
	 * output is on, once for errors that are thrown again. Errors without a
	 * stack, eg. responses of requests, are logged with the given stack where
	 * they were handled.
	 */
	function logError(e, context, handledAt)
	{
		if (debug && e != null && !logged.has(e))
		{
			if (typeof e == 'object')
			{
				logged.add(e);
			}

			var text = 'Traffic error' + ((context != null) ? ' in ' + context : '') + ': ';

			if (typeof e.stack == 'string' && e.stack.length > 0)
			{
				// The stack of Chrome starts with the message, the others do not
				console.error(text + ((e.message != null && e.stack.indexOf(e.message) < 0) ?
					e.name + ': ' + e.message + '\n' : '') + e.stack);
			}
			else
			{
				console.error(text, e, (handledAt != null) ? '\n' + handledAt : '');
			}
		}
	};

	/**
	 * Logs uncaught errors and rejections of the given window.
	 */
	function addErrorListeners(win, name)
	{
		win.addEventListener('error', function(evt)
		{
			logError((evt.error != null) ? evt.error : evt.message + ' (' + evt.filename +
				':' + evt.lineno + ':' + evt.colno + ')', name);
		});

		win.addEventListener('unhandledrejection', function(evt)
		{
			logError(evt.reason, name + ' promise');
		});
	};

	addErrorListeners(window, 'page');

	/**
	 * Keeps Safari on iOS from zooming the page with a pinch in the given
	 * document, as it ignores maximum-scale of the viewport for pinches,
	 * except in the diagram if isDiagram returns true for the target, where
	 * draw.io zooms with these events. Other browsers do not have them.
	 */
	function blockPageZoom(doc, isDiagram)
	{
		var prevent = function(evt)
		{
			if (isDiagram == null || !isDiagram(evt.target))
			{
				evt.preventDefault();
			}
		};

		doc.addEventListener('gesturestart', prevent);
		doc.addEventListener('gesturechange', prevent);
	};

	blockPageZoom(document);

	// The window of the editor is replaced when it loads
	frame.addEventListener('load', function()
	{
		addErrorListeners(frame.contentWindow, 'editor');
		frame.contentWindow.addEventListener('keydown', switchFocus, true);
		blockPageZoom(frame.contentDocument, function(target)
		{
			return ui != null && ui.editor.graph.container.contains(target);
		});
	});

	/**
	 * Logs the errors that draw.io catches and shows in a dialog with their
	 * stack. For uncaught errors, window.onerror of draw.io passes only the
	 * message, so the error comes from the error event that is dispatched.
	 */
	function logHandledErrors()
	{
		var handleError = ui.handleError;

		ui.handleError = function(resp, title)
		{
			if (debug && resp != null)
			{
				var e = (resp.error != null) ? resp.error : resp;
				var evt = frame.contentWindow.event;

				if (e.stack == null && evt != null && evt.type == 'error' && evt.error != null)
				{
					e = evt.error;
				}

				logError(e, 'editor, EditorUi.handleError' + ((title != null) ? ' (' + title + ')' : ''),
					(e.stack == null) ? new Error('Handled at').stack : null);
			}

			return handleError.apply(this, arguments);
		};
	};

	/**
	 * Returns the tiles of the maps: the template of their URL with {z},
	 * {x} and {y} of ?tiles, their largest zoom level and the attribution
	 * that the tile server asks for besides OpenStreetMap, by default the
	 * tiles of OpenStreetMap, which allow light use.
	 */
	function getTiles()
	{
		var url = params.get('tiles');
		var zoom = parseInt(params.get('tileMaxZoom'));

		if (url != null && !(/^https?:\/\//.test(url) && url.indexOf('{z}') >= 0 &&
			url.indexOf('{x}') >= 0 && url.indexOf('{y}') >= 0))
		{
			console.warn('Traffic: tiles must be an http(s) URL with {z}, {x} and {y}: ' + url);
			url = null;
		}

		return {tileUrl: url || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
			maxZoom: (zoom >= 0 && zoom <= 24) ? zoom : 19, attribution: params.get('tileAttribution')};
	};

	/**
	 * Returns the URL of the given tile.
	 */
	function getTileUrl(z, x, y)
	{
		return tiles.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a').replace('{r}', '');
	};

	/**
	 * Map background shows the map behind towns, which only they have. Map
	 * opacity fades it while it is shown, live while it is dragged, and is
	 * kept in localStorage across reloads, 100 % by default.
	 */
	function initMapControl()
	{
		var checkbox = document.getElementById('map');
		var hint = document.getElementById('map-hint');
		var opacity = document.getElementById('map-opacity');
		var opacityValue = document.getElementById('map-opacity-value');
		var opacityKey = 'traffic-map-opacity';
		checkbox.checked = map.isVisible();

		try
		{
			var stored = parseInt(window.localStorage.getItem(opacityKey));

			if (stored >= 0 && stored <= 100)
			{
				opacity.value = stored;
			}
		}
		catch (e)
		{
			// Starts opaque
		}

		// The value, the filled part of the track and the map
		function showOpacity()
		{
			opacityValue.textContent = opacity.value + ' %';
			opacity.setAttribute('aria-valuetext', opacity.value + ' %');
			opacity.style.setProperty('--fill', opacity.value + '%');
			map.setOpacity(parseInt(opacity.value) / 100);
		};

		// The vehicles get darker colors on the light map
		function update(available)
		{
			checkbox.disabled = !available;
			opacity.disabled = !available || !map.isVisible();
			hint.hidden = available;
			sim.setOption('mapBackground', available && map.isVisible());
		};

		checkbox.addEventListener('change', function()
		{
			map.setVisible(checkbox.checked);
			opacity.disabled = !map.isAvailable() || !map.isVisible();
			sim.setOption('mapBackground', map.isAvailable() && map.isVisible());
		});

		opacity.addEventListener('input', showOpacity);

		opacity.addEventListener('change', function()
		{
			showOpacity();

			try
			{
				window.localStorage.setItem(opacityKey, opacity.value);
			}
			catch (e)
			{
				// Keeps the opacity until the page reloads
			}
		});

		showOpacity();

		map.addListener(update);
		update(map.isAvailable());
	};

	/**
	 * Road opacity fades the roads and junctions, like Map opacity the map,
	 * live while it is dragged, without changing the diagram, and is kept in
	 * localStorage across reloads, 100 % by default. It is disabled while the
	 * roads are hidden.
	 */
	function initRoadOpacity()
	{
		var roadsBox = document.getElementById('roads');
		var opacity = document.getElementById('road-opacity');
		var opacityValue = document.getElementById('road-opacity-value');
		var opacityKey = 'traffic-road-opacity';

		try
		{
			var stored = parseInt(window.localStorage.getItem(opacityKey));

			if (stored >= 0 && stored <= 100)
			{
				opacity.value = stored;
			}
		}
		catch (e)
		{
			// Starts opaque
		}

		// The value, the filled part of the track and the roads
		function showOpacity()
		{
			opacityValue.textContent = opacity.value + ' %';
			opacity.setAttribute('aria-valuetext', opacity.value + ' %');
			opacity.style.setProperty('--fill', opacity.value + '%');
			sim.setOption('roadOpacity', parseInt(opacity.value) / 100);
		};

		opacity.addEventListener('input', showOpacity);

		opacity.addEventListener('change', function()
		{
			showOpacity();

			try
			{
				window.localStorage.setItem(opacityKey, opacity.value);
			}
			catch (e)
			{
				// Keeps the opacity until the page reloads
			}
		});

		roadsBox.addEventListener('change', function()
		{
			opacity.disabled = !roadsBox.checked;
		});

		opacity.disabled = !roadsBox.checked;
		showOpacity();
	};

	/**
	 * Writes the parameters to the URL of this page, so that reloads and
	 * links keep them, with / and , as they are for readable links.
	 */
	function writeParams()
	{
		var query = params.toString().replace(/%2F/gi, '/').replace(/%2C/gi, ',');
		window.history.replaceState(null, '', window.location.pathname +
			((query.length > 0) ? '?' + query : '') + window.location.hash);
	};

	/**
	 * Turns the debug output of this page and the simulation on or off, like
	 * the other display settings until the page reloads, without changing the
	 * URL.
	 */
	function setDebug(value)
	{
		debug = value;

		if (sim != null)
		{
			sim.setDebug(value);
		}

		console.info('Traffic debug output ' + ((value) ? 'on' : 'off'));
	};

	function addOptions(select, values, labels)
	{
		for (var i = 0; i < values.length; i++)
		{
			var option = document.createElement('option');
			option.value = values[i];
			option.textContent = labels[i];
			select.appendChild(option);
		}
	};

	/**
	 * Returns the setting of the page with the given key, or null.
	 */
	function readSetting(key)
	{
		try
		{
			return window.localStorage.getItem(key);
		}
		catch (e)
		{
			return null;
		}
	};

	/**
	 * Keeps the given setting of the page for the next visit.
	 */
	function writeSetting(key, value)
	{
		try
		{
			window.localStorage.setItem(key, value);
		}
		catch (e)
		{
			// Keeps the setting until the page reloads
		}
	};

	/**
	 * Shows the speed unit, the driving side and the region that sets both
	 * in the panel, changes them in the simulation and keeps them, and calls
	 * updateSpeeds with a new unit. A town that opens sets the region of its
	 * country (townRegion.open), unless one was chosen by hand while it was
	 * open, which is kept for it.
	 */
	function initRegion(updateSpeeds)
	{
		var config = sim.config;
		var regions = TrafficUnits.regions;
		var region = document.getElementById('region');
		var units = document.getElementById('units');
		var side = document.getElementById('side');
		var hint = document.getElementById('region-hint');
		var currentTown = null;
		addOptions(region, regions.map(function(r) { return r.name; }),
			regions.map(function(r) { return r.label; }));
		addOptions(units, TrafficUnits.units, TrafficUnits.units.map(TrafficUnits.getLabel));
		addOptions(side, ['right', 'left'], ['Right-hand traffic', 'Left-hand traffic']);

		function getRegion(name)
		{
			return regions.filter(function(r)
			{
				return r.name == name;
			})[0];
		};

		// Each region has another pair of unit and side
		function show()
		{
			units.value = config.units;
			side.value = (config.leftHand) ? 'left' : 'right';
			region.value = regions.filter(function(r)
			{
				return r.units == config.units && r.leftHand == config.leftHand;
			})[0].name;
		};

		function showHint(text)
		{
			hint.textContent = text || '';
			hint.hidden = text == null;
		};

		function setUnits(value)
		{
			if (value != config.units)
			{
				sim.setOption('units', value);
				writeSetting(unitsKey, value);
				updateSpeeds();

				if (showSelection != null)
				{
					showSelection();
				}
			}
		};

		// With next, for the diagram that opens next
		function setLeftHand(value, next)
		{
			if (value != config.leftHand)
			{
				sim.setOption('leftHand', value, next);
				writeSetting(sideKey, (value) ? 'left' : 'right');
			}
		};

		/**
		 * Returns the regions chosen by hand for towns by the keys of their
		 * places, the last chosen last.
		 */
		function readChoices()
		{
			try
			{
				var choices = JSON.parse(readSetting(townRegionsKey));

				return (choices != null && typeof choices == 'object') ? choices : {};
			}
			catch (e)
			{
				return {};
			}
		};

		// Keeps the region chosen by hand for the open town, and those of the
		// last towns
		function keepChoice()
		{
			show();

			if (currentTown != null)
			{
				var choices = readChoices();
				delete choices[currentTown.key];
				choices[currentTown.key] = region.value;
				var keys = Object.keys(choices);

				for (var i = 0; i < keys.length - maxTownRegions; i++)
				{
					delete choices[keys[i]];
				}

				writeSetting(townRegionsKey, JSON.stringify(choices));
				showHint('Kept for ' + currentTown.name + ' when it opens again.');
			}
		};

		units.addEventListener('change', function()
		{
			setUnits(units.value);
			keepChoice();
		});

		side.addEventListener('change', function()
		{
			setLeftHand(side.value == 'left');
			keepChoice();
		});

		region.addEventListener('change', function()
		{
			var r = getRegion(region.value);
			setUnits(r.units);
			setLeftHand(r.leftHand);
			keepChoice();
		});

		townRegion = {
			/**
			 * Sets the region of the given place of a town that is about to
			 * open: the one chosen by hand for it, else that of its country,
			 * else it keeps the region.
			 */
			open: function(place)
			{
				var code = TrafficUnits.getTerritory(place.countryCode, place.subdivisions);
				var choice = getRegion(readChoices()[place.key]);
				var r = choice || TrafficUnits.getRegion(code);
				currentTown = {key: place.key, name: place.name};

				if (r != null)
				{
					setUnits(r.units);
					setLeftHand(r.leftHand, true);
					show();
				}

				showHint((choice != null) ? 'As you chose for ' + place.name + '.' : ((r != null) ?
					'From the country of ' + place.name + ': ' + getCountryName(code, place.country) + '.' : null));
			},

			/**
			 * Forgets the town when another diagram opens.
			 */
			clear: function()
			{
				currentTown = null;
				showHint(null);
			}};

		show();
	};

	/**
	 * Returns the English name of the country or territory with the given
	 * ISO 3166-1 code, else the given name.
	 */
	function getCountryName(code, name)
	{
		try
		{
			return new Intl.DisplayNames(['en'], {type: 'region'}).of(code.toUpperCase());
		}
		catch (e)
		{
			return name || code.toUpperCase();
		}
	};

	/**
	 * Calls fn with the EditorUi of the frame once draw.io has started.
	 * Draw.loadPlugin is the supported way to get it.
	 */
	function waitForEditor(fn)
	{
		var win = frame.contentWindow;

		if (win != null && win.Draw != null)
		{
			win.Draw.loadPlugin(fn);
		}
		else
		{
			window.setTimeout(function()
			{
				waitForEditor(fn);
			}, 100);
		}
	};

	/**
	 * Loads the given scripts in order into the window of the editor and
	 * calls fn when all are loaded.
	 */
	function loadScripts(names, fn)
	{
		var win = frame.contentWindow;

		if (names.length == 0)
		{
			fn();
		}
		else
		{
			var script = win.document.createElement('script');
			script.src = new URL(names[0], document.baseURI).href;

			script.onload = function()
			{
				loadScripts(names.slice(1), fn);
			};

			win.document.head.appendChild(script);
		}
	};

	/**
	 * Loads the road elements and the simulation into the window of the
	 * editor, so that they use the classes of draw.io directly, and attaches
	 * them to the editor.
	 */
	function attach(editorUi)
	{
		var win = frame.contentWindow;

		loadScripts(['js/units.js', 'js/roads.js', 'js/simulation.js', 'js/map.js'], function()
		{
			ui = editorUi;
			logHandledErrors();

			ui.editor.graph.model.addListener(win.mxEvent.CHANGE, function()
			{
				changes++;
			});

			win.TrafficRoads.onError = logError;
			roads = win.TrafficRoads(ui);
			map = win.TrafficMap(ui, tiles);
			keepFormatPanelClosed();
			sim = win.TrafficSimulation(ui, update);
			initControls();
			initMapControl();
			initRoadOpacity();
			initSelection();
			town = initTown();

			// Files that draw.io opens itself, eg. with File > Open or New,
			// replace the town in the URL and in Copy Link, so that a reload
			// does not open the town again, and towns and examples that are
			// still loading
			ui.editor.addListener('fileLoaded', function()
			{
				if (!openingFile)
				{
					lastLoad = null;
					town.cancel();
					town.clear();
				}
			});

			sim.setDebug(debug);
			sim.start();

			if (params.has('osm') || params.has('city'))
			{
				town.loadFromUrl();
			}
			else if (ui.isDiagramEmpty())
			{
				openExample('town');
			}
		});
	};

	/**
	 * Keeps draw.io from opening the format panel when the editor gets wider
	 * than the limit for small screens, eg. when the panel of this page is
	 * hidden, unless draw.io closed it when the editor got narrower.
	 */
	function keepFormatPanelClosed()
	{
		var windowResized = ui.windowResized;
		var closedBySize = false;

		ui.windowResized = function()
		{
			var width = frame.contentWindow.innerWidth;
			var limit = frame.contentWindow.Editor.smallScreenWidth;
			var last = this.lastWindowWidth;

			if (last != null && last >= limit && width < limit)
			{
				closedBySize = this.isFormatPanelVisible();
			}
			else if (last != null && last < limit && width >= limit)
			{
				// Skips the opening in windowResized
				if (!closedBySize)
				{
					this.lastWindowWidth = width;
				}

				closedBySize = false;
			}

			windowResized.apply(this, arguments);
		};
	};

	/**
	 * Makes the titled sections of the panel (data-fold) fold and unfold with
	 * the button in their title, which controls their body (fold-body), by
	 * click and keyboard. Which sections are folded is kept in localStorage
	 * across reloads, with data-folded="true" as the default. Folded bodies
	 * are hidden, while everything in them keeps working and updating.
	 */
	function initFolding()
	{
		var key = 'traffic-folded';
		var stored = {};

		try
		{
			var value = JSON.parse(window.localStorage.getItem(key));
			stored = (value != null && typeof value == 'object') ? value : {};
		}
		catch (e)
		{
			// Starts with the defaults
		}

		Array.prototype.forEach.call(document.querySelectorAll('[data-fold]'), function(section)
		{
			var name = section.getAttribute('data-fold');
			var button = section.querySelector('.fold');

			setFolded(name, (typeof stored[name] == 'boolean') ? stored[name] :
				section.getAttribute('data-folded') == 'true');

			button.addEventListener('click', function()
			{
				stored[name] = button.getAttribute('aria-expanded') == 'true';
				setFolded(name, stored[name]);

				try
				{
					window.localStorage.setItem(key, JSON.stringify(stored));
				}
				catch (e)
				{
					// Keeps the state until the page reloads
				}
			});
		});
	};

	/**
	 * Folds or unfolds the section with the given name (data-fold) without
	 * keeping the state, eg. to show progress or errors in it.
	 */
	function setFolded(name, folded)
	{
		var section = document.querySelector('[data-fold="' + name + '"]');
		var button = (section != null) ? section.querySelector('.fold') : null;

		if (button != null)
		{
			button.setAttribute('aria-expanded', String(!folded));
			document.getElementById(button.getAttribute('aria-controls')).hidden = folded;
			section.classList.toggle('folded', folded);
		}
	};

	/**
	 * Shows the loading of a town in a card over the diagram, as the panel
	 * may be folded, scrolled or hidden: a spinner with the town and the step
	 * of the progress in the panel, with Cancel once there is a task to
	 * cancel, or the error with Dismiss. The card is in a live region that is
	 * always there, so that screen readers read it when it shows, but not the
	 * steps, which change every second and which the panel reads.
	 */
	function initLoading()
	{
		var card = document.getElementById('loading-card');
		var title = document.getElementById('loading-title');
		var detail = document.getElementById('loading-detail');
		var cancelButton = document.getElementById('loading-cancel');
		var dismissButton = document.getElementById('loading-dismiss');
		var onCancel = null;

		function show(failed, text, more)
		{
			card.classList.toggle('failed', failed);
			title.textContent = text;
			detail.textContent = more || '';
			detail.setAttribute('aria-hidden', String(!failed));
			cancelButton.hidden = failed || onCancel == null;
			dismissButton.hidden = !failed;
			card.hidden = false;
		};

		function hide()
		{
			// Keeps the keyboard focus in the page, on the diagram
			if (card.contains(document.activeElement))
			{
				frame.focus();

				if (ui != null)
				{
					ui.editor.graph.container.focus();
				}
			}

			card.hidden = true;
		};

		cancelButton.addEventListener('click', function()
		{
			onCancel();
		});

		dismissButton.addEventListener('click', hide);

		card.addEventListener('keydown', function(evt)
		{
			if (evt.key == 'Escape' && !dismissButton.hidden)
			{
				hide();
			}
		});

		return {
			show: function(text, step)
			{
				show(false, text, step);
			},
			setStep: function(step)
			{
				if (!card.hidden && !card.classList.contains('failed'))
				{
					detail.textContent = step;
				}
			},
			fail: function(text, reason)
			{
				show(true, text, reason);
			},
			hide: hide,
			setCancel: function(fn)
			{
				onCancel = fn;
			}};
	};

	var panelFocus = null;

	/**
	 * Alt+Shift+S moves the keyboard focus from the panel to the editor and
	 * back to where it was in the panel, as draw.io keeps Tab for itself.
	 * draw.io does not use Alt+Shift+S (its Alt+Shift keys are A, B, E, F, K,
	 * L, N, O, P, Q, R, T, V, W, X and Y).
	 */
	function switchFocus(evt)
	{
		if (evt.altKey && evt.shiftKey && !evt.ctrlKey && !evt.metaKey && evt.code == 'KeyS')
		{
			evt.preventDefault();
			evt.stopPropagation();
			var panel = document.getElementById('panel');
			var toEditor = panel.contains(document.activeElement);

			// After the handlers of draw.io, which keep the focus in the editor
			window.setTimeout(function()
			{
				if (toEditor)
				{
					frame.focus();

					if (ui != null)
					{
						ui.editor.graph.container.focus();
					}
				}
				else if (document.body.classList.contains('collapsed'))
				{
					window.focus();
					document.getElementById('toggle').focus();
				}
				else
				{
					window.focus();
					((panelFocus != null && panel.contains(panelFocus) && panelFocus.getClientRects().length > 0) ?
						panelFocus : document.getElementById('start')).focus();
				}
			}, 0);
		}
	};

	window.addEventListener('keydown', switchFocus, true);

	document.getElementById('panel').addEventListener('focusin', function(evt)
	{
		panelFocus = evt.target;
	});

	/**
	 * Shows or hides the panel of this page. The editor takes its space.
	 */
	function initPanelToggle()
	{
		var toggle = document.getElementById('toggle');

		toggle.addEventListener('click', function()
		{
			var collapsed = document.body.classList.toggle('collapsed');
			var label = (collapsed) ? 'Show the simulation panel' : 'Hide the simulation panel';
			toggle.setAttribute('aria-expanded', String(!collapsed));
			toggle.setAttribute('aria-label', label);
			toggle.title = label;
		});
	};

	function update(lines, running)
	{
		showStats(lines);
		startButton.textContent = (running) ? 'Pause' : 'Start';
		setFavicon(running);

		// The timing of a light follows from the network after changes and
		// the statistics of the selection change while cars drive
		if (updateSelection != null)
		{
			updateSelection();
		}

		updateVehicle();
		updateLegend();
		centerHint.hidden = sim == null || !sim.isCenterPaused();

		// The trips of the page follow file loads, page switches and undo
		if (updateTrips != null)
		{
			updateTrips();
		}

		updateCapacity();
	};

	/**
	 * Shows a hint below Cars if it is more than the network can hold (see
	 * TrafficSimulation.getCapacity), rounded to two digits.
	 */
	function updateCapacity()
	{
		var max = (sim != null) ? sim.getCapacity() : null;
		var over = max != null && sim.config.cars > max;
		var text = '';

		if (over)
		{
			var step = Math.pow(10, Math.max(0, Math.floor(Math.log(max) / Math.LN10) - 1));
			text = 'More than this network can hold (about ' +
				(Math.round(max / step) * step).toLocaleString('en-US') + ')';
		}

		if (carsHint.textContent != text)
		{
			carsHint.textContent = text;
		}

		carsHint.hidden = !over;
	};

	/**
	 * Shows the given lines of the statistics as rows of a name and a value
	 * in columns, with the line breaks and the colons of the text, so that it
	 * copies as text. Lines without a name take the whole row.
	 */
	function showStats(lines)
	{
		var html = lines.map(function(line)
		{
			var i = line.indexOf(': ');

			return (i > 0) ? '<div class="stat"><span class="name">' + escapeHtml(line.substring(0, i)) +
				'</span><span class="sep">: </span><span class="value">' + escapeHtml(line.substring(i + 2)) +
				'</span></div>' : '<div class="stat wide">' + escapeHtml(line) + '</div>';
		}).join('\n');

		if (html != statsShown)
		{
			statsShown = html;
			stats.innerHTML = html;
		}
	};

	function escapeHtml(text)
	{
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	};

	/**
	 * Shows the state of the simulation in the favicon of the page, which the
	 * editor in its frame does not change: a traffic light with the green lamp
	 * lit while the cars drive and the red one while they are paused. The SVG
	 * comes first in browsers that show it, else the PNG of 32 pixels.
	 */
	function setFavicon(running)
	{
		if (running !== faviconRunning)
		{
			var state = (running) ? 'running' : 'paused';
			faviconRunning = running;
			document.getElementById('favicon-png').href = 'img/favicon-' + state + '.png';
			document.getElementById('favicon-svg').href = 'img/favicon-' + state + '.svg';
		}
	};

	/**
	 * Shows the colors of the speeds that the vehicles have now, which depend
	 * on the color set, the theme of the editor, Adapt colors and the map
	 * background.
	 */
	function updateLegend()
	{
		var stops = (legendBar != null) ? sim.getSpeedStops().join(', ') : null;

		if (stops != null && stops != legendStops)
		{
			legendStops = stops;
			legendBar.style.background = 'linear-gradient(to right, ' + stops + ')';
		}
	};

	/**
	 * Shows the data of the vehicle that was clicked in the editor.
	 */
	function updateVehicle()
	{
		var info = (sim != null) ? sim.getVehicle() : null;
		vehicleSection.hidden = info == null;

		for (var i = 0; info != null && i < info.rows.length; i++)
		{
			var row = vehicleRows.rows[i] || vehicleRows.insertRow();

			while (row.cells.length < 2)
			{
				row.insertCell();
			}

			for (var j = 0; j < 2; j++)
			{
				if (row.cells[j].textContent != info.rows[i][j])
				{
					row.cells[j].textContent = info.rows[i][j];
				}
			}
		}

		while (vehicleRows.rows.length > ((info != null) ? info.rows.length : 0))
		{
			vehicleRows.deleteRow(-1);
		}
	};

	/**
	 * Shows the junctions and roads of the selection of the editor in the
	 * panel and changes them when the fields are changed.
	 */
	function initSelection()
	{
		var win = frame.contentWindow;
		var graph = ui.editor.graph;
		var hint = document.getElementById('selection-hint');
		var junctionFields = document.getElementById('junction-fields');
		var lightFields = document.getElementById('light-fields');
		var roadFields = document.getElementById('road-fields');
		var type = document.getElementById('junction-type');
		var green = document.getElementById('green');
		var cycle = document.getElementById('cycle');
		var lanes = document.getElementById('lanes');
		var direction = document.getElementById('direction');
		var maxSpeed = document.getElementById('max-speed');
		var maxSpeedUnit = document.getElementById('max-speed-unit');
		var ringFields = document.getElementById('ring-fields');
		var ringLanes = document.getElementById('ring-lanes');
		var laneFields = document.getElementById('lane-fields');
		var laneList = document.getElementById('lane-list');
		var lanesHint = document.getElementById('lanes-hint');
		var cellStats = document.getElementById('cell-stats');
		var statsHtml = '';
		var turnNames = {l: ['Left', '\u21b0'], s: ['Straight', '\u2191'], r: ['Right', '\u21b1']};
		var junctions = [];
		var edges = [];
		var plan = null;
		var spec = null;

		function count(n, name)
		{
			return n + ' ' + name + ((n == 1) ? '' : 's');
		};

		function updateCycle()
		{
			var light = (junctions.length > 0) ? sim.getLight(junctions[0].id) : null;
			var text = (light != null) ? 'Green ' + light.green + ' s, yellow ' + light.yellow +
				' s and red ' + (light.cycle - light.green - light.yellow) + ' s per approach, cycle ' +
				light.cycle + ' s.' : 'Connect roads to the traffic light.';

			if (cycle.textContent != text)
			{
				cycle.textContent = text;
			}
		};

		function format(value, digits, unit)
		{
			return (value == null) ? '\u2013' : value.toFixed(digits) + unit;
		};

		/**
		 * Shows the statistics of the first selected junction and road in a
		 * table with a column for the junction and each direction of the road.
		 */
		function showStats()
		{
			var columns = [];

			[junctions[0], edges[0]].forEach(function(cell)
			{
				var stats = (cell != null) ? sim.getStats(cell.id) : null;
				columns = columns.concat(stats || []);
			});

			var unit = sim.config.units;
			var rows = [['Cars now', 'cars', 0, ''], ['Expected', 'expected', 0, ''],
				['Entered', 'entered', 0, ''], ['Left', 'left', 0, ''], ['Speed', 'speed', 0, ' ' + TrafficUnits.getLabel(unit)],
				['Throughput', 'throughput', 0, '/h'], ['Waiting', 'wait', 1, ' s']];
			var html = '<tr><th></th>' + columns.map(function(c)
			{
				return '<th>' + c.name + '</th>';
			}).join('') + '</tr>';

			for (var i = 0; i < rows.length; i++)
			{
				html += '<tr><td>' + rows[i][0] + '</td>' + columns.map(function(c)
				{
					var value = c[rows[i][1]];

					// Speeds come in km/h
					return '<td>' + format((rows[i][1] == 'speed' && value != null) ?
						TrafficUnits.toUnit(value, unit) : value, rows[i][2], rows[i][3]) + '</td>';
				}).join('') + '</tr>';
			}

			html += '<tr><td>Queue</td>' + columns.map(function(c)
			{
				return '<td>' + c.queue + ((c.queue > 0) ? ' (' + c.queueLength.toFixed(0) + ' m)' : '') + '</td>';
			}).join('') + '</tr>';

			cellStats.hidden = columns.length == 0;

			if (html != statsHtml)
			{
				statsHtml = html;
				var table = cellStats.querySelector('table');
				table.tHead.innerHTML = html.substring(0, html.indexOf('</tr>') + 5);
				table.tBodies[0].innerHTML = html.substring(html.indexOf('</tr>') + 5);
			}
		};

		updateSelection = function()
		{
			if (junctions.length > 0)
			{
				updateCycle();
			}

			showStats();
		};

		/**
		 * Shows a row for each lane of the given lanes with its direction, the
		 * turns it allows and a button to remove it.
		 */
		function showLanes(lanePlan)
		{
			laneList.textContent = '';

			for (var i = 0; i < lanePlan.length; i++)
			{
				var row = document.createElement('div');
				row.className = 'lane';
				var name = document.createElement('span');
				name.className = 'name';
				name.textContent = i + 1;
				row.appendChild(name);

				var dir = document.createElement('select');
				dir.setAttribute('aria-label', 'Direction of lane ' + (i + 1));
				dir.innerHTML = '<option value="1">\u2192 Forward</option><option value="-1">\u2190 Backward</option>';
				dir.value = lanePlan[i].dir;
				dir.dataset.lane = i;
				row.appendChild(dir);

				for (var t in turnNames)
				{
					var label = document.createElement('label');
					label.title = turnNames[t][0];
					var box = document.createElement('input');
					box.type = 'checkbox';
					box.checked = lanePlan[i].turns == null || lanePlan[i].turns.indexOf(t) >= 0;
					box.dataset.lane = i;
					box.dataset.turn = t;
					box.setAttribute('aria-label', turnNames[t][0] + ' from lane ' + (i + 1));
					label.appendChild(box);
					label.appendChild(document.createTextNode(turnNames[t][1]));
					row.appendChild(label);
				}

				var remove = document.createElement('button');
				remove.type = 'button';
				remove.textContent = '\u00d7';
				remove.title = 'Remove lane ' + (i + 1);
				remove.setAttribute('aria-label', remove.title);
				remove.dataset.lane = i;
				remove.disabled = lanePlan.length == 1;
				row.appendChild(remove);
				laneList.appendChild(row);
			}
		};

		function show()
		{
			var cells = graph.getSelectionCells();
			junctions = [];
			edges = [];

			for (var i = 0; i < cells.length; i++)
			{
				if (graph.model.isVertex(cells[i]))
				{
					junctions.push(cells[i]);
				}
				else if (graph.model.isEdge(cells[i]))
				{
					edges.push(cells[i]);
				}
			}

			var names = [];

			if (junctions.length > 0)
			{
				names.push(count(junctions.length, 'junction'));
			}

			if (edges.length > 0)
			{
				names.push(count(edges.length, 'road'));
			}

			hint.textContent = (names.length > 0) ? names.join(', ') + ' selected.' :
				'Select a junction or a road to change it.';
			junctionFields.hidden = junctions.length == 0;
			roadFields.hidden = edges.length == 0;

			if (junctions.length > 0)
			{
				type.value = roads.getJunctionType(junctions[0]);
				lightFields.hidden = type.value != 'light';
				ringFields.hidden = type.value != 'roundabout';
				ringLanes.value = roads.getRingLanes(junctions[0]);

				if (document.activeElement != green)
				{
					green.value = roads.getGreen(junctions[0]) || '';
				}

				updateCycle();
			}

			showStats();

			if (edges.length > 0)
			{
				var road = roads.getRoad(edges[0]);
				lanes.value = Math.min(4, road.lanes);
				direction.value = road.dir;
				showMaxSpeed();
				plan = road.plan;
				laneFields.hidden = edges.length != 1;
				lanesHint.hidden = edges.length == 1;

				// Keeps the rows while their lanes do not change
				var current = win.TrafficRoads.getLaneSpec(plan);

				if (current != spec)
				{
					spec = current;
					showLanes(plan);
				}
			}
		};

		/**
		 * Shows the speed limit of the first selected road in the unit of the
		 * speeds, empty for none.
		 */
		function showMaxSpeed()
		{
			var unit = sim.config.units;
			maxSpeedUnit.textContent = TrafficUnits.getLabel(unit);
			maxSpeed.max = Math.round(TrafficUnits.toUnit(200, unit));

			if (document.activeElement != maxSpeed)
			{
				var kmh = roads.getMaxSpeed(edges[0]);
				maxSpeed.value = (kmh > 0) ? Math.round(TrafficUnits.toUnit(kmh, unit)) : '';
			}
		};

		/**
		 * Sets the lanes of the selected road.
		 */
		function setLanes(lanePlan)
		{
			if (edges.length == 1)
			{
				roads.setLanePlan(edges[0], lanePlan);
			}
		};

		show = win.TrafficRoads.guard(show, 'selection panel');
		showSelection = show;
		graph.getSelectionModel().addListener(win.mxEvent.CHANGE, show);
		graph.model.addListener(win.mxEvent.CHANGE, show);

		type.addEventListener('change', function()
		{
			roads.setJunctionType(junctions, type.value);
		});

		green.addEventListener('change', function()
		{
			var value = parseInt(green.value);

			if (!isNaN(value) && value > 0)
			{
				roads.setGreen(junctions, Math.min(600, value));
			}

			show();
		});

		lanes.addEventListener('change', function()
		{
			roads.setRoads(edges, parseInt(lanes.value), null);
		});

		direction.addEventListener('change', function()
		{
			roads.setRoads(edges, null, parseInt(direction.value));
		});

		ringLanes.addEventListener('change', function()
		{
			roads.setRingLanes(junctions, parseInt(ringLanes.value));
		});

		// In the unit of the speeds, which the style keeps, eg. 30 mph, empty
		// or 0 for none
		maxSpeed.addEventListener('change', function()
		{
			var unit = sim.config.units;
			var value = Math.round(parseFloat(maxSpeed.value));
			value = Math.min(value, Math.round(TrafficUnits.toUnit(200, unit)));
			roads.setMaxSpeed(edges, (value > 0) ? value + ((unit == 'mph') ? ' mph' : '') : null);
			maxSpeed.blur();
			show();
		});

		laneList.addEventListener('change', function(evt)
		{
			var i = parseInt(evt.target.dataset.lane);
			var lanePlan = plan.map(function(lane)
			{
				return {dir: lane.dir, turns: lane.turns};
			});

			if (evt.target.tagName == 'SELECT')
			{
				lanePlan[i].dir = parseInt(evt.target.value);
			}
			else
			{
				var boxes = evt.target.closest('.lane').querySelectorAll('input');
				var turns = '';

				for (var j = 0; j < boxes.length; j++)
				{
					turns += (boxes[j].checked) ? boxes[j].dataset.turn : '';
				}

				// Each lane allows at least one turn
				if (turns.length == 0)
				{
					evt.target.checked = true;

					return;
				}

				lanePlan[i].turns = (turns.length == 3) ? null : turns;
			}

			setLanes(lanePlan);
		});

		laneList.addEventListener('click', function(evt)
		{
			if (evt.target.tagName == 'BUTTON' && plan.length > 1)
			{
				var lanePlan = plan.slice();
				lanePlan.splice(parseInt(evt.target.dataset.lane), 1);
				setLanes(lanePlan);
			}
		});

		document.getElementById('add-lane').addEventListener('click', function()
		{
			if (plan != null && plan.length < 8)
			{
				setLanes(plan.concat([{dir: plan[plan.length - 1].dir, turns: null}]));
			}
		});

		show();
	};

	/**
	 * Loads the road network of a town from OpenStreetMap (js/osm.js): finds
	 * the town with suggestions while typing and a search on submit, shows
	 * its limits on a map where a click places a circle and a drag a
	 * rectangle as the section to load, estimates the size, and loads, builds
	 * and opens the network with progress and Cancel. Returns functions to
	 * load the town in the URL and to forget the loaded town when another
	 * network is opened.
	 */
	function initTown()
	{
		var osm = window.TrafficOsm;
		var form = document.getElementById('town-form');
		var query = document.getElementById('town-query');
		var matchList = document.getElementById('town-matches');
		var placeBox = document.getElementById('town-place');
		var nameText = document.getElementById('town-name');
		var kindText = document.getElementById('town-kind');
		var preview = document.getElementById('town-map');
		var level = document.getElementById('town-level');
		var sectionSelect = document.getElementById('town-section');
		var sizeText = document.getElementById('town-size');
		var loadButton = document.getElementById('town-load');
		var linkButton = document.getElementById('town-link');
		var progress = document.getElementById('town-progress');
		var statusText = document.getElementById('town-status');
		var errorText = document.getElementById('town-error');
		var infoText = document.getElementById('town-info');
		var svgNs = 'http://www.w3.org/2000/svg';
		var defaultRadius = 2000;
		var place = null;
		var section = null;
		var levelChosen = false;
		var tooLarge = false;
		var task = null;
		var suggesting = null;
		var suggestTimer = null;
		var view = null;
		var loaded = null;
		var estimateId = 0;

		function format(n)
		{
			return Math.round(n).toLocaleString('en-US');
		};

		function formatDate(iso)
		{
			return new Date(iso).toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric'});
		};

		function showError(text)
		{
			errorText.textContent = text || '';
			errorText.hidden = text == null;

			if (text != null)
			{
				setFolded('network', false);
			}
		};

		/**
		 * Shows why the town of the given name could not be loaded in the
		 * panel, after the given lead if any, and over the diagram.
		 */
		function showLoadError(name, reason, lead)
		{
			showError(((lead != null) ? lead + ': ' : '') + reason);
			loading.fail('Could not load ' + name, reason);
		};

		/**
		 * Shows the given step of the task in the panel, and over the diagram
		 * while a town loads.
		 */
		function setStatus(text)
		{
			statusText.textContent = text;
			loading.setStep(text);
		};

		/**
		 * Starts a task with progress and Cancel and returns its controller.
		 * A new task cancels the last one. Tasks that load a town also show
		 * the given title with their progress over the diagram.
		 */
		function startTask(text, title)
		{
			if (task != null)
			{
				task.abort();
			}

			task = new AbortController();
			showError(null);

			if (title != null)
			{
				loading.show(title, text);
			}
			else
			{
				loading.hide();
			}

			statusText.textContent = text;
			progress.hidden = false;
			setFolded('network', false);
			loadButton.disabled = true;

			return task;
		};

		function endTask(t)
		{
			if (task == t)
			{
				task = null;
				progress.hidden = true;
				loadButton.disabled = place == null || osm.getBounds(place, section) == null || tooLarge;
			}
		};

		function cancel()
		{
			var t = task;
			loading.hide();

			if (t != null)
			{
				t.abort();
				endTask(t);
				infoText.textContent = 'Cancelled.';
				infoText.hidden = false;
			}
		};

		document.getElementById('town-cancel').addEventListener('click', cancel);
		loading.setCancel(cancel);

		function getMessage(e)
		{
			return (e != null && e.message != null) ? e.message : String(e);
		};

		/**
		 * Shows the given places to pick from with the given note above.
		 */
		function showMatches(list, note)
		{
			matchList.textContent = '';

			if (note != null)
			{
				var li = document.createElement('li');
				li.className = 'note';
				li.textContent = note;
				matchList.appendChild(li);
			}

			list.forEach(function(match)
			{
				var li = document.createElement('li');
				var button = document.createElement('button');
				button.type = 'button';
				button.textContent = match.name;
				var detail = document.createElement('span');
				detail.className = 'detail';
				detail.textContent = getDetail(match);
				button.appendChild(detail);

				button.addEventListener('click', function()
				{
					pick(match);
				});

				li.appendChild(button);
				matchList.appendChild(li);
			});

			matchList.hidden = list.length == 0 && note == null;
		};

		/**
		 * Returns the kind and the region of the given place.
		 */
		function getDetail(p)
		{
			var region = (p.label || '').split(', ').filter(function(part, i)
			{
				return i > 0 || part != p.name;
			});

			return [(p.kind != null) ? p.kind.charAt(0).toUpperCase() + p.kind.slice(1).replace(/_/g, ' ') : null]
				.concat(region.slice(-3)).filter(Boolean).join(', ');
		};

		query.addEventListener('input', function()
		{
			window.clearTimeout(suggestTimer);

			if (suggesting != null)
			{
				suggesting.abort();
				suggesting = null;
			}

			var text = query.value.trim();

			if (text.length < 3)
			{
				showMatches([]);

				return;
			}

			// Photon allows suggestions while typing, Nominatim does not
			suggestTimer = window.setTimeout(function()
			{
				var ctrl = suggesting = new AbortController();

				osm.suggest(text, ctrl.signal).then(function(list)
				{
					if (suggesting == ctrl)
					{
						showMatches(list, (list.length == 0) ? 'No suggestions, press Enter to search.' : null);
					}
				})['catch'](function(e)
				{
					if (!ctrl.signal.aborted)
					{
						logError(e, 'town suggestions');
					}
				});
			}, 350);
		});

		query.addEventListener('keydown', function(evt)
		{
			var first = matchList.querySelector('button');

			if (evt.key == 'ArrowDown' && first != null)
			{
				evt.preventDefault();
				first.focus();
			}
		});

		matchList.addEventListener('keydown', function(evt)
		{
			var buttons = Array.prototype.slice.call(matchList.querySelectorAll('button'));
			var i = buttons.indexOf(document.activeElement);

			if (i >= 0 && (evt.key == 'ArrowDown' || evt.key == 'ArrowUp'))
			{
				evt.preventDefault();
				(buttons[i + ((evt.key == 'ArrowDown') ? 1 : -1)] || query).focus();
			}
		});

		form.addEventListener('submit', function(evt)
		{
			evt.preventDefault();
			var text = query.value.trim();
			window.clearTimeout(suggestTimer);

			if (suggesting != null)
			{
				suggesting.abort();
				suggesting = null;
			}

			if (text.length > 0)
			{
				var t = startTask('Searching for ' + text + '\u2026');

				osm.search(text, t.signal).then(function(list)
				{
					endTask(t);

					if (list.length == 1)
					{
						showMatches([]);
						pick(list[0]);
					}
					else
					{
						showMatches(list, (list.length == 0) ? 'No town or city named ' + text + ' found.' :
							'Pick the place you mean:');
					}
				})['catch'](function(e)
				{
					if (!t.signal.aborted)
					{
						endTask(t);
						showError('The search failed: ' + getMessage(e));
					}
				});
			}
		});

		document.getElementById('town-jump').addEventListener('click', function(evt)
		{
			evt.preventDefault();
			document.body.classList.remove('collapsed');
			setFolded('network', false);
			document.getElementById('town').scrollIntoView({block: 'start'});
			query.focus({preventScroll: true});
		});

		/**
		 * Gets the limits of the given match and shows it.
		 */
		function pick(match)
		{
			var t = startTask('Finding the limits of ' + match.name + '\u2026');
			showMatches([]);

			osm.lookup(match.key, t.signal).then(function(p)
			{
				endTask(t);
				choose(p, null, null);
				placeBox.scrollIntoView({block: 'nearest'});
			})['catch'](function(e)
			{
				if (!t.signal.aborted)
				{
					endTask(t);
					showError('Could not get ' + match.name + ': ' + getMessage(e));
				}
			});
		};

		/**
		 * Shows the given place with the given road level and section.
		 */
		function choose(p, roads, s)
		{
			place = p;
			section = s;
			levelChosen = roads != null;
			level.value = roads || getDefaultLevel();
			nameText.textContent = p.name;
			kindText.textContent = getDetail(p);
			placeBox.hidden = false;
			infoText.hidden = true;
			updateSectionSelect();
			drawMap();
			estimate();
		};

		/**
		 * Returns all streets for small towns, main and collector roads for
		 * cities and main roads where that is too large.
		 */
		function getDefaultLevel()
		{
			var est = osm.estimate(place, section);

			return (est.all <= 3000) ? 'all' : ((est.collector <= osm.limits.junctions) ? 'collector' : 'main');
		};

		function updateSectionSelect()
		{
			var rect = sectionSelect.querySelector('option[value="rect"]');
			rect.hidden = section == null || section.bbox == null;
			sectionSelect.value = (section == null) ? '' : ((section.bbox != null) ? 'rect' :
				((sectionSelect.querySelector('option[value="' + section.r + '"]') != null) ?
				String(section.r) : ''));

			if (sectionSelect.value == '' && section != null && section.r != null)
			{
				// Radius of a link that is not in the list
				var option = sectionSelect.querySelector('option[data-custom]') || document.createElement('option');
				option.setAttribute('data-custom', '1');
				option.value = String(section.r);
				option.textContent = 'Circle of ' + (section.r / 1000).toFixed(1) + ' km';
				sectionSelect.appendChild(option);
				sectionSelect.value = option.value;
			}
		};

		sectionSelect.addEventListener('change', function()
		{
			var r = parseInt(sectionSelect.value);

			if (sectionSelect.value == '')
			{
				section = null;
			}
			else if (!isNaN(r))
			{
				section = round((section != null && section.lat != null) ? {lat: section.lat, lon: section.lon, r: r} :
					{lat: place.lat, lon: place.lon, r: r});
			}

			drawSection();
			estimate();
		});

		level.addEventListener('change', function()
		{
			levelChosen = true;
			estimate();
		});

		function mercatorX(lon, z)
		{
			return (lon + 180) / 360 * 256 * Math.pow(2, z);
		};

		function mercatorY(lat, z)
		{
			var s = Math.sin(lat * Math.PI / 180);

			return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
		};

		function getLon(x, z)
		{
			return x / (256 * Math.pow(2, z)) * 360 - 180;
		};

		function getLat(y, z)
		{
			var n = Math.PI * (1 - 2 * y / (256 * Math.pow(2, z)));

			return Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI;
		};

		function createSvg(name, attrs)
		{
			var node = document.createElementNS(svgNs, name);

			for (var key in attrs)
			{
				node.setAttribute(key, attrs[key]);
			}

			return node;
		};

		/**
		 * Shows the tiles of OpenStreetMap around the town with its limits,
		 * or the circle that is loaded for places without limits, and the
		 * section.
		 */
		function drawMap()
		{
			var w = preview.clientWidth || 268;
			var h = preview.clientHeight || 200;
			var b = osm.getBounds(place, null);
			var zf = Math.log(Math.min((w - 16) / (mercatorX(b[3], 0) - mercatorX(b[1], 0)),
				(h - 16) / (mercatorY(b[0], 0) - mercatorY(b[2], 0)))) / Math.LN2;
			var z = Math.max(Math.min(1, tiles.maxZoom), Math.min(18, tiles.maxZoom, Math.ceil(zf)));
			var k = Math.pow(2, zf - z);
			var cx = (mercatorX(b[1], z) + mercatorX(b[3], z)) / 2;
			var cy = (mercatorY(b[0], z) + mercatorY(b[2], z)) / 2;
			view = {z: z, w: w / k, h: h / k};
			view.x = cx - view.w / 2;
			view.y = cy - view.h / 2;
			preview.setAttribute('viewBox', [view.x, view.y, view.w, view.h].join(' '));
			preview.textContent = '';

			var tileLayer = createSvg('g', {'class': 'tiles'});
			var n = Math.pow(2, z);

			for (var tx = Math.floor(view.x / 256); tx <= Math.floor((view.x + view.w) / 256); tx++)
			{
				for (var ty = Math.max(0, Math.floor(view.y / 256)); ty <= Math.min(n - 1,
					Math.floor((view.y + view.h) / 256)); ty++)
				{
					tileLayer.appendChild(createSvg('image', {href: getTileUrl(z, ((tx % n) + n) % n, ty),
						x: tx * 256, y: ty * 256, width: 256, height: 256}));
				}
			}

			preview.appendChild(tileLayer);

			if (place.rings != null)
			{
				var d = place.rings.map(function(ring)
				{
					return 'M' + ring.map(function(p)
					{
						return mercatorX(p[0], z).toFixed(1) + ' ' + mercatorY(p[1], z).toFixed(1);
					}).join('L') + 'Z';
				}).join('');

				preview.appendChild(createSvg('path', {'class': 'boundary', d: d}));
			}
			else
			{
				preview.appendChild(createSvg('circle', {'class': 'boundary radius', cx: mercatorX(place.lon, z),
					cy: mercatorY(place.lat, z), r: place.radius / getMetersPerUnit(place.lat)}));
			}

			preview.appendChild(createSvg('g', {'class': 'section-layer'}));
			drawSection();
		};

		function getMetersPerUnit(lat)
		{
			return 2 * Math.PI * 6371008.8 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, view.z));
		};

		/**
		 * Shows the given section or the current one on the preview.
		 */
		function drawSection(s)
		{
			var layer = preview.querySelector('.section-layer');
			s = (s !== undefined) ? s : section;

			if (layer != null)
			{
				layer.textContent = '';

				if (s != null && s.bbox != null)
				{
					var x = mercatorX(s.bbox[1], view.z);
					var y = mercatorY(s.bbox[2], view.z);
					layer.appendChild(createSvg('rect', {'class': 'section', x: x, y: y,
						width: mercatorX(s.bbox[3], view.z) - x, height: mercatorY(s.bbox[0], view.z) - y}));
				}
				else if (s != null)
				{
					layer.appendChild(createSvg('circle', {'class': 'section', cx: mercatorX(s.lon, view.z),
						cy: mercatorY(s.lat, view.z), r: s.r / getMetersPerUnit(s.lat)}));
				}
			}
		};

		/**
		 * Returns the map position of the given pointer event.
		 */
		function getMapPoint(evt)
		{
			var r = preview.getBoundingClientRect();
			var x = view.x + (evt.clientX - r.left) / r.width * view.w;
			var y = view.y + (evt.clientY - r.top) / r.height * view.h;

			return {x: x, y: y, px: evt.clientX, py: evt.clientY, lat: getLat(y, view.z), lon: getLon(x, view.z)};
		};

		function getRect(a, b)
		{
			return {bbox: [Math.min(a.lat, b.lat), Math.min(a.lon, b.lon), Math.max(a.lat, b.lat), Math.max(a.lon, b.lon)]};
		};

		/**
		 * Returns the given section as in links, so that links load the same.
		 */
		function round(s)
		{
			var text = osm.getSectionText(s);

			return (s.bbox != null) ? osm.parseSection(null, text) : osm.parseSection(text, null);
		};

		var down = null;
		var dragging = false;

		preview.addEventListener('pointerdown', function(evt)
		{
			if (view != null && evt.button == 0)
			{
				down = getMapPoint(evt);
				dragging = false;
				preview.setPointerCapture(evt.pointerId);
				evt.preventDefault();
			}
		});

		preview.addEventListener('pointermove', function(evt)
		{
			if (down != null)
			{
				var p = getMapPoint(evt);
				dragging = dragging || Math.abs(p.px - down.px) + Math.abs(p.py - down.py) > 6;

				if (dragging)
				{
					drawSection(getRect(down, p));
				}
			}
		});

		preview.addEventListener('pointerup', function(evt)
		{
			if (down != null)
			{
				var p = getMapPoint(evt);
				var r = parseInt(sectionSelect.value);
				section = round((dragging) ? getRect(down, p) : {lat: p.lat, lon: p.lon,
					r: (isNaN(r)) ? ((section != null && section.r != null) ? section.r : defaultRadius) : r});
				down = null;
				updateSectionSelect();
				drawSection();
				estimate();
			}
		});

		preview.addEventListener('pointercancel', function()
		{
			down = null;
			drawSection();
		});

		var resizeTimer = null;

		window.addEventListener('resize', function()
		{
			window.clearTimeout(resizeTimer);

			resizeTimer = window.setTimeout(function()
			{
				if (place != null && !placeBox.hidden && view != null && Math.abs(preview.clientWidth - view.w) > 1)
				{
					drawMap();
				}
			}, 200);
		});

		/**
		 * Shows the area and the estimated size of the network of the chosen
		 * level and section, or that it is cached. Networks of more than
		 * twice the limit are not loaded.
		 */
		function estimate()
		{
			var id = ++estimateId;
			var b = osm.getBounds(place, section);
			sizeText.classList.remove('warning');

			if (b == null)
			{
				sizeText.textContent = 'The section is outside of ' + place.name + '. Click the map inside it.';
				sizeText.classList.add('warning');
				loadButton.disabled = true;

				return;
			}

			if (!levelChosen)
			{
				level.value = getDefaultLevel();
			}

			var est = osm.estimate(place, section);
			var junctions = est[level.value];
			var max = osm.limits.junctions;
			var text = ((place.rings == null) ? 'OpenStreetMap has no limits of ' + place.name +
				', so the roads within ' + (place.radius / 1000).toFixed(1) + ' km of its center are loaded. ' : '') +
				((section != null) ? 'Section' : place.name) + ': ' + ((est.area < 10) ? est.area.toFixed(1) :
				format(est.area)) + ' km\u00b2, about ' + format(Math.max(1, Math.round(junctions / 10) * 10)) +
				' junctions' + ((junctions > 2 * max) ? ', too many to load: choose main roads or a section.' :
				((junctions > max) ? ', more than the ' + format(max) + ' that stay fast: choose main roads or a section.' :
				'.'));
			sizeText.textContent = text;
			sizeText.classList.toggle('warning', junctions > max);
			updateLink();
			tooLarge = junctions > 2 * max;
			loadButton.disabled = task != null || tooLarge;

			osm.findCached(place, level.value, section).then(function(entry)
			{
				if (id == estimateId && entry != null)
				{
					sizeText.textContent = text + ' Loaded on ' + formatDate(entry.date) + ', opens without a download.';
					tooLarge = false;
					loadButton.disabled = task != null;
				}
			});
		};

		loadButton.addEventListener('click', function()
		{
			var p = place;
			var l = level.value;
			var s = section;

			confirmLoad(function(confirmed)
			{
				load(confirmed, p, l, s, false);
			});
		});

		/**
		 * Returns the given town with the given trips of a link in the root of
		 * its page, where the simulation reads them, so that they come with the
		 * file: not as a change that marks it as modified and can be undone.
		 */
		function withTrips(xml, trips)
		{
			return (trips == null) ? xml : xml.replace('<mxCell id="0"/>', '<object id="0" trips="' + trips.mode +
				'" throughShare="' + Math.round(Math.max(0, Math.min(1, trips.through)) * 100) / 100 + '"><mxCell/></object>');
		};

		/**
		 * Loads, builds and opens the network of the given place, level and
		 * section for the given load of confirmLoad, from the cache unless
		 * fresh is true, with the given trips of a link, if any. The diagram
		 * stays as it is until the network is built.
		 */
		function load(confirmed, p, l, s, fresh, onError, trips)
		{
			var t = startTask('Loading the roads of ' + p.name + '\u2026', 'Loading ' + p.name + '\u2026');
			var start = Date.now();
			var last = null;
			infoText.hidden = true;

			function showStatus()
			{
				if (last != null && task == t)
				{
					var secs = Math.round((Date.now() - start) / 1000);
					var text = (last.pause > 0) ? 'All servers are busy, trying again\u2026' :
						'Loading the roads from ' + last.server + ((last.bytes > 0) ? ': ' +
						(last.bytes / 1e6).toFixed(1) + ' MB' : '') + '\u2026';

					if (last.errors.length > 0)
					{
						text = last.errors[last.errors.length - 1] + '. ' + text;
					}

					setStatus(text + ' ' + secs + ' s');
				}
			};

			var timer = window.setInterval(showStatus, 1000);

			osm.load(p, l, s, t.signal, function(status)
			{
				last = status;
				showStatus();
			}, fresh).then(function(entry)
			{
				window.clearInterval(timer);
				setStatus('Building the network\u2026');

				// Paints the status before the work
				return new Promise(function(resolve)
				{
					window.setTimeout(resolve, 30);
				}).then(function()
				{
					return {entry: entry, result: (t.signal.aborted) ? null :
						osm.build(entry.data, p, l, s, {date: entry.dataDate || entry.date})};
				});
			}).then(function(r)
			{
				if (t.signal.aborted)
				{
					return;
				}

				var st = r.result.stats;
				endTask(t);

				if (r.result.empty)
				{
					showLoadError(p.name, 'There are no ' + osm.levelNames[l].toLowerCase() + ' in ' +
						((s != null) ? 'this section of ' : '') + p.name + '. Choose more roads or another section.');
				}
				else if (r.result.tooLarge)
				{
					showLoadError(p.name, 'The network of ' + ((s != null) ? 'this section of ' : '') + p.name + ' has ' +
						format(st.junctions) + ' junctions and ' + format(st.roads) + ' roads, more than the ' +
						format(osm.limits.junctions) + ' junctions and ' + format(osm.limits.roads) +
						' roads that stay fast. Choose main roads or a section on the map and Load again, ' +
						'the roads are loaded already.');
					sizeText.classList.add('warning');
				}
				else
				{
					setStatus('Opening the network\u2026');
					// The town is drawn before the next paint, or the editor
					// first asks to discard changes made while it loaded
					loading.hide();

					openFile(withTrips(r.result.xml, trips), p.name + '.drawio', confirmed, function()
					{
						loaded = {place: p, level: l, section: s};
						updateLink();
						setUrl(trips);

						// Enough cars to see traffic on the roads
						var cars = Math.max(100, Math.min(1500, Math.round(st.laneKm / 15) * 10));
						sim.config.cars = cars;
						document.getElementById('cars').value = cars;

						showInfo(p, l, s, st, r.entry, cars);
					}, function()
					{
						// Painted and built for the driving side of its country
						townRegion.open(p);
					});
				}
			})['catch'](function(e)
			{
				window.clearInterval(timer);

				if (!t.signal.aborted)
				{
					endTask(t);
					logError(e, 'loading ' + p.name);
					showLoadError(p.name, getMessage(e) + ((e.busy) ?
						' Try again later, choose main roads or a smaller section.' : ''), 'Could not load ' + p.name);

					if (onError != null)
					{
						onError(e);
					}
				}
			});
		};

		/**
		 * Shows the size of the loaded network, where its data comes from
		 * and a button to load it again from OpenStreetMap.
		 */
		function showInfo(p, l, s, st, entry, cars)
		{
			infoText.textContent = '';

			function count(n, name)
			{
				return format(n) + ' ' + name + ((n == 1) ? '' : 's');
			};

			var parts = [count(st.junctions, 'junction'), count(st.roads, 'road')];

			if (st.lights > 0)
			{
				parts.push(count(st.lights, 'traffic light'));
			}

			if (st.roundabouts > 0)
			{
				parts.push(count(st.roundabouts, 'roundabout'));
			}

			var zones = st.zones != null && st.zones.homes + st.zones.jobs > 0;
			infoText.appendChild(document.createTextNode(osm.levelNames[l] + ' of ' + ((s != null) ?
				'a section of ' : '') + p.name + ': ' + parts.join(', ') + ' and ' + format(st.gates) +
				' entries and exits at the ' + ((s != null) ? 'section' : ((p.rings != null) ? 'town limits' :
				'circle')) + ((zones) ? ' for through traffic and commuters from outside. The trips of the ' +
				format(cars) + ' cars follow zones of homes and jobs from ' + count(st.zones.areas, 'land use area') +
				' and ' + count(st.zones.places, 'place') + ' (Trips).' : ', where half of the ' + format(cars) +
				' cars start or end.') + ' Roads of ' + formatDate(entry.dataDate || entry.date) +
				' from ' + entry.server + ((entry.cached) ? ', loaded on ' + formatDate(entry.date) + '. ' : '. ')));
			var reload = document.createElement('button');
			reload.type = 'button';
			reload.className = 'link';
			reload.textContent = 'Load again';
			reload.title = 'Load the roads again from OpenStreetMap';

			reload.addEventListener('click', function()
			{
				confirmLoad(function(confirmed)
				{
					choose(p, l, s);
					load(confirmed, p, l, s, true);
				});
			});

			if (entry.cached)
			{
				infoText.appendChild(reload);
			}

			infoText.hidden = false;
		};

		/**
		 * Copy Link copies the loaded town while the panel shows it.
		 */
		function updateLink()
		{
			linkButton.disabled = loaded == null || place == null || loaded.place.key != place.key ||
				loaded.level != level.value || osm.getSectionText(loaded.section) != osm.getSectionText(section);
		};

		/**
		 * Puts the loaded town into the URL with the given trips, if any.
		 */
		function setUrl(trips)
		{
			clearUrl();

			if (loaded != null)
			{
				params.set('city', loaded.place.name);
				params.set('osm', loaded.place.key);
				params.set('roads', loaded.level);

				if (loaded.section != null)
				{
					params.set((loaded.section.bbox != null) ? 'bbox' : 'circle', osm.getSectionText(loaded.section));
				}

				if (trips != null)
				{
					params.set('trips', trips.mode);
					params.set('through', Math.round(100 * trips.through));
				}
			}

			writeParams();
		};

		/**
		 * Returns the trips of the current page if they are not the default of
		 * a town, zones or else random with 25 % of through traffic, else null.
		 */
		function getTrips()
		{
			var t = sim.getTripModes();
			var zones = t.modes.some(function(m)
			{
				return m.value == 'zones' && m.available;
			});

			return (t.mode != ((zones) ? 'zones' : 'random') || Math.abs(t.through - 0.25) > 0.001) ?
				{mode: t.mode, through: t.through} : null;
		};

		function clearUrl()
		{
			['city', 'osm', 'roads', 'circle', 'bbox', 'trips', 'through'].forEach(function(key)
			{
				params['delete'](key);
			});
		};

		linkButton.addEventListener('click', function()
		{
			setUrl(getTrips());
			var url = window.location.href;

			function copied(ok)
			{
				linkButton.textContent = (ok) ? 'Copied' : 'Copy Link';

				if (ok)
				{
					window.setTimeout(function()
					{
						linkButton.textContent = 'Copy Link';
					}, 2000);
				}
				else
				{
					window.prompt('Link to this town', url);
				}
			};

			if (navigator.clipboard != null && navigator.clipboard.writeText != null)
			{
				navigator.clipboard.writeText(url).then(function()
				{
					copied(true);
				}, function()
				{
					copied(false);
				});
			}
			else
			{
				copied(false);
			}
		});

		linkButton.disabled = true;

		/**
		 * Loads the town of ?osm=<type>/<id> or ?city=<name>, with roads and
		 * the section of circle or bbox, after asking to discard the changes
		 * of the diagram, if any.
		 */
		function loadFromUrl()
		{
			// The card that shows the start of the editor would stay if the
			// changes are kept
			if (hasChanges())
			{
				loading.hide();
			}

			confirmLoad(findFromUrl);
		};

		/**
		 * Finds and loads the town of the URL for the given load of
		 * confirmLoad. Opens the example if that fails.
		 */
		function findFromUrl(confirmed)
		{
			var key = params.get('osm');
			var name = params.get('city');
			var roads = (osm.levels.indexOf(params.get('roads')) >= 0) ? params.get('roads') : null;
			var s = osm.parseSection(params.get('circle'), params.get('bbox'));
			var label = name || key;
			var through = parseFloat(params.get('through'));
			var trips = (sim.getTripModes().modes.some(function(m)
			{
				return m.value == params.get('trips');
			})) ? {mode: params.get('trips'), through: (through >= 0 && through <= 100) ? through / 100 : 0.25} : null;
			var t = startTask('Finding ' + label + '\u2026', 'Loading ' + label + '\u2026');
			query.value = name || '';

			function fail(e)
			{
				showLoadError(label, getMessage(e), 'Could not open ' + label + ' from the link');

				// Keeps the town in the URL to try again
				if (ui.isDiagramEmpty())
				{
					openExample('town', true);
				}
			};

			((key != null) ? osm.lookup(key, t.signal) : osm.search(name, t.signal, true).then(function(list)
			{
				if (list.length == 0)
				{
					throw new Error('OpenStreetMap has no town or city of this name.');
				}
				else if (list.length > 1)
				{
					showMatches(list.slice(1), 'Loads ' + getDetail(list[0]) + '. Other places of this name:');
				}

				return osm.lookup(list[0].key, t.signal);
			})).then(function(p)
			{
				label = p.name;
				endTask(t);
				choose(p, roads, s);

				// Links load no more than Load would, unless the town is cached
				return ((tooLarge) ? osm.findCached(p, level.value, s) : Promise.resolve(true)).then(function(entry)
				{
					if (entry != null)
					{
						load(confirmed, p, level.value, s, false, fail, trips);
					}
					else
					{
						fail(new Error('it is too large to load with ' + osm.levelNames[level.value].toLowerCase() +
							'. Choose main roads or a section.'));
					}
				});
			})['catch'](function(e)
			{
				if (!t.signal.aborted)
				{
					endTask(t);
					fail(e);
				}
			});
		};

		return {loadFromUrl: loadFromUrl, cancel: function()
		{
			var t = task;
			loading.hide();

			if (t != null)
			{
				t.abort();
				endTask(t);
			}
		}, clear: function()
		{
			loaded = null;
			townRegion.clear();
			linkButton.disabled = true;
			infoText.hidden = true;
			clearUrl();
			writeParams();
		}};
	};

	/**
	 * Fits the whole diagram into the window. Diagrams that need less than
	 * the smallest zoom step of draw.io, which rounds to 1 %, get the exact
	 * scale and are centered.
	 */
	function fitDiagram()
	{
		var graph = ui.editor.graph;
		var c = graph.container;
		ui.fitDiagramToWindow(null, null, false, true);
		var b = graph.getGraphBounds();

		if (b.width > c.clientWidth || b.height > c.clientHeight)
		{
			graph.view.setScale(graph.view.scale * Math.min((c.clientWidth - 20) / b.width,
				(c.clientHeight - 20) / b.height));
			b = graph.getGraphBounds();
			c.scrollLeft = b.x + (b.width - c.clientWidth) / 2;
			c.scrollTop = b.y + (b.height - c.clientHeight) / 2;
		}
	};

	/**
	 * Returns true if the diagram has changes that are not saved.
	 */
	function hasChanges()
	{
		var file = ui.getCurrentFile();

		return file != null && file.isModified();
	};

	/**
	 * Starts a load that replaces the diagram, eg. a town or an example, by
	 * calling fn with it before anything is loaded: at once if the diagram
	 * has no unsaved changes, else once the user agreed to discard them, and
	 * not if the user cancels. The diagram is replaced only by the last load
	 * that started and only once it has loaded (see openFile), so that loads
	 * that fail, time out or are cancelled keep the diagram with its changes
	 * and draw.io still knows them as unsaved. Loads that start while the
	 * question is open take the place of the one that it starts.
	 */
	function confirmLoad(fn)
	{
		function start(f)
		{
			lastLoad = {changes: changes};
			f(lastLoad);
		};

		if (question != null)
		{
			question.fn = fn;
		}
		else if (hasChanges())
		{
			var win = frame.contentWindow;
			var q = question = {fn: fn};

			// Ends the question when the dialog closes, also with Escape,
			// which is before its buttons run
			var close = function()
			{
				question = null;
			};

			ui.confirm(win.mxResources.get('allChangesLost'), close, function()
			{
				close();
				start(q.fn);
			}, win.mxResources.get('cancel'), win.mxResources.get('discardChanges'), null, close);
		}
		else
		{
			start(fn);
		}
	};

	/**
	 * Opens the given file of the given load of confirmLoad in the editor,
	 * unless a newer load started, also in the web app, where openLocalFile
	 * opens files in a new window if the diagram is not empty, and fits the
	 * whole diagram into the window. Asks again to discard the changes of
	 * the diagram only if it changed while the file loaded, but drops the
	 * file then if the question is open for a newer load. Calls onOpen just
	 * before it opens and onLoad after.
	 */
	function openFile(xml, name, load, onLoad, onOpen)
	{
		var win = frame.contentWindow;

		var fn = function()
		{
			if (onOpen != null)
			{
				onOpen();
			}

			drawOutsideDocument(function()
			{
				// Towns and examples set the URL themselves
				openingFile = true;

				try
				{
					ui.fileLoaded(new win.LocalFile(ui, xml, name, true));
				}
				finally
				{
					openingFile = false;
				}

				fitDiagram();
			});

			if (onLoad != null)
			{
				onLoad();
			}
		};

		// Files of loads that a newer one replaced are not opened
		if (load == lastLoad)
		{
			if (load.changes == changes)
			{
				fn();
			}
			// The diagram changed while the file loaded, unless the user is
			// asked already for a newer load
			else if (question == null)
			{
				confirmLoad(fn);
			}
		}
	};

	/**
	 * Calls fn, which opens or fits the diagram, with the shapes drawn outside
	 * of the document, and puts them into it at once after fn. A town draws
	 * more than 100,000 SVG elements in one task, twice with fitting it, and
	 * mutation observers get all changes of a task in one call: content
	 * scripts of browser extensions that watch pages failed with "Maximum
	 * call stack size exceeded" on the 230,000 changes of opening Northampton.
	 * Like the print preview of draw.io (mxPrintPreview.addGraphFragment), fn
	 * draws into a copy of the draw pane, here in an SVG of its own, as
	 * draw.io draws HTML instead of SVG into panes that are not in an SVG.
	 * Elements that draw.io adds to that SVG, eg. gradients, go to the SVG of
	 * the diagram after fn.
	 */
	function drawOutsideDocument(fn)
	{
		var view = ui.editor.graph.view;
		var pane = view.getDrawPane();
		var svg = pane.ownerSVGElement;

		if (svg == null)
		{
			fn();

			return;
		}

		var outside = svg.ownerDocument.createElementNS(svg.namespaceURI, 'svg');
		var copy = outside.appendChild(pane.cloneNode(false));

		// The size of the view and the scrolling apply to the SVG of the diagram
		Object.defineProperty(copy, 'ownerSVGElement', {value: svg, configurable: true});
		view.drawPane = copy;

		// The old shapes leave the document at once
		pane.textContent = '';

		try
		{
			fn();
		}
		finally
		{
			delete copy.ownerSVGElement;
			pane.parentNode.replaceChild(copy, pane);

			while (outside.firstChild != null)
			{
				svg.appendChild(outside.firstChild);
			}

			// Labels and curved edges are measured in the document, in the
			// graph bounds of the next validation
			view.states.visit(function(id, state)
			{
				if (state.text != null)
				{
					state.text.invalidateBoundingBox();
				}

				if (state.shape != null && state.shape.useSvgBoundingBox)
				{
					state.shape.invalidateBoundingBox();
				}
			});

			view.validate();
		}
	};

	/**
	 * Opens the example of the given name after asking to discard the
	 * changes of the diagram, if any (see confirmLoad), and stops a town
	 * that is still loading unless keepTown is true.
	 */
	function openExample(name, keepTown)
	{
		confirmLoad(function(confirmed)
		{
			if (town != null && !keepTown)
			{
				town.cancel();
			}

			fetch('data/' + name + '.drawio').then(function(response)
			{
				if (!response.ok)
				{
					throw new Error(response.status + ' ' + response.statusText);
				}

				return response.text();
			}).then(function(xml)
			{
				openFile(xml, name + '.drawio', confirmed, function()
				{
					if (town != null && !keepTown)
					{
						town.clear();
					}
				});
			})['catch'](function(e)
			{
				// Not for examples that a newer load replaced
				if (confirmed == lastLoad)
				{
					ui.handleError(e);
				}
			});
		});
	};

	function initControls()
	{
		var config = sim.config;

		var cars = document.getElementById('cars');
		cars.value = config.cars;

		cars.addEventListener('change', function()
		{
			var value = parseInt(cars.value);
			config.cars = (isNaN(value)) ? config.cars : Math.max(0, Math.min(20000, value));
			cars.value = config.cars;
			updateCapacity();
		});

		// The speed unit and the driving side that the page keeps, before the
		// speeds are shown and the network is built
		var storedUnits = readSetting(unitsKey);
		sim.setOption('units', (TrafficUnits.units.indexOf(storedUnits) >= 0) ? storedUnits : 'kmh');
		sim.setOption('leftHand', readSetting(sideKey) == 'left');

		// Cells per step in the unit of the speeds
		function formatCells(cells)
		{
			return TrafficUnits.format(cells * 27, config.units);
		};

		var vmaxValues = [1, 2, 3, 4, 5, 6];
		var selects = {
			speed: [[1, 2, 5, 10, 20, 50, 100], ['1x', '2x', '5x', '10x', '20x', '50x', '100x']],
			vmax: [vmaxValues, vmaxValues.map(formatCells)],
			noise: [[0, 0.1, 0.25, 0.5], ['0 %', '10 %', '25 %', '50 %']],
			trucks: [[0, 0.1, 0.2, 0.3, 0.5], ['0 %', '10 %', '20 %', '30 %', '50 %']],
			fast: [[0, 0.05, 0.1, 0.2, 0.3], ['0 %', '5 %', '10 %', '20 %', '30 %']]};
		var types = document.getElementById('types');
		var typeNames = [['truck', 'Trucks', -2], ['car', 'Cars', 0], ['fast', 'Fast cars', 1]];
		var typeSpeeds = [];
		var topSpeed = document.createElement('span');

		// Shapes of the vehicles as in the editor, in the same scale, so that
		// trucks are as much longer as they are, with their top speed and the
		// colors of the speeds
		var longest = Math.max.apply(Math, typeNames.map(function(type)
		{
			return sim.vehicleShapes[type[0]].length;
		}));

		typeNames.forEach(function(type)
		{
			var shape = sim.vehicleShapes[type[0]];
			var row = document.createElement('span');
			row.className = 'vehicle';
			var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', (-shape.length / 2 - 0.2) + ' -1.8 ' + (longest + 0.4) + ' 3.6');
			svg.setAttribute('width', Math.round(12 * (longest + 0.4) / 3.6));
			svg.setAttribute('height', 12);
			svg.setAttribute('aria-hidden', 'true');

			['body', 'windows'].forEach(function(part)
			{
				var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('d', shape[part]);
				path.setAttribute('class', part);
				svg.appendChild(path);
			});

			// The name with the shape in the column of the labels, the top
			// speed in the column of the controls
			var name = document.createElement('span');
			name.className = 'type';
			name.appendChild(svg);
			name.appendChild(document.createTextNode(type[1]));
			row.appendChild(name);
			var speed = document.createElement('span');
			speed.className = 'top';
			row.appendChild(speed);
			typeSpeeds.push(speed);
			types.appendChild(row);
		});

		var scale = document.createElement('span');
		scale.className = 'speed-scale';

		['Speed', '0'].forEach(function(text)
		{
			var span = document.createElement('span');
			span.textContent = text;
			scale.appendChild(span);
		});

		var bar = document.createElement('span');
		bar.className = 'bar';
		legendBar = bar;
		updateLegend();
		scale.appendChild(bar);
		scale.appendChild(topSpeed);
		types.appendChild(scale);

		// Trucks drive two cells per step slower, fast cars one faster
		function updateTypes()
		{
			for (var i = 0; i < typeNames.length; i++)
			{
				typeSpeeds[i].textContent = formatCells(Math.max(1, config.vmax + typeNames[i][2]));
			}

			topSpeed.textContent = formatCells(config.vmax + ((config.fast > 0) ? 1 : 0));
		};

		Object.keys(selects).forEach(function(key)
		{
			var select = document.getElementById(key);
			addOptions(select, selects[key][0], selects[key][1]);
			select.value = config[key];

			select.addEventListener('change', function()
			{
				sim.setOption(key, parseFloat(select.value));
				updateTypes();

				// The share of trucks changes how many vehicles fit
				updateCapacity();
			});
		});

		updateTypes();

		// A new speed unit relabels Max. speed and the legend
		initRegion(function()
		{
			var vmax = document.getElementById('vmax');

			for (var i = 0; i < vmax.options.length; i++)
			{
				vmax.options[i].textContent = formatCells(parseFloat(vmax.options[i].value));
			}

			updateTypes();
		});

		// Color sets of the speeds, which the legend shows at once
		var colors = document.getElementById('colors');
		var colorNames = Object.keys(sim.colorSets);
		addOptions(colors, colorNames, colorNames.map(function(name) { return sim.colorSets[name].label; }));
		colors.value = config.colors;

		colors.addEventListener('change', function()
		{
			sim.setOption('colors', colors.value);
			updateLegend();
		});

		// Trips of the page, which the diagram keeps, with the share of
		// through traffic for the modes that mix it in
		var trips = document.getElementById('trips');
		var through = document.getElementById('through');
		var throughRow = document.getElementById('through-row');
		var throughValue = document.getElementById('through-value');
		var tripModes = null;

		updateTrips = function()
		{
			var t = sim.getTripModes();
			var modes = t.modes.filter(function(m)
			{
				return m.available;
			});
			var key = modes.map(function(m)
			{
				return m.value;
			}).join(',');

			if (key != tripModes)
			{
				tripModes = key;
				trips.textContent = '';
				addOptions(trips, modes.map(function(m)
				{
					return m.value;
				}), modes.map(function(m)
				{
					return m.label;
				}));
			}

			if (trips.value != t.mode)
			{
				trips.value = t.mode;
			}

			throughRow.hidden = t.mode != 'mixed' && t.mode != 'zones';

			if (document.activeElement != through)
			{
				through.value = Math.round(100 * t.through);
			}

			showThrough();
		};

		// The value and the filled part of the track
		function showThrough()
		{
			throughValue.textContent = through.value + ' %';
			through.style.setProperty('--fill', through.value + '%');
		};

		trips.addEventListener('change', function()
		{
			sim.setTrips(trips.value, parseInt(through.value) / 100);
			updateTrips();
		});

		through.addEventListener('input', showThrough);

		through.addEventListener('change', function()
		{
			sim.setTrips(trips.value, parseInt(through.value) / 100);
			updateTrips();
		});

		updateTrips();

		var labelsHint = document.getElementById('labels-hint');

		['reroute', 'passEitherSide', 'passOncoming', 'roads', 'lights', 'vehicles', 'adaptive', 'density', 'zones',
			'labels', 'center'].forEach(function(key)
		{
			var checkbox = document.getElementById(key);
			checkbox.checked = config[key];

			checkbox.addEventListener('change', function()
			{
				sim.setOption(key, checkbox.checked);
				labelsHint.hidden = !config.labels;
			});
		});

		labelsHint.hidden = !config.labels;

		startButton.addEventListener('click', function()
		{
			sim.setRunning(!sim.isRunning());
		});

		document.getElementById('reset').addEventListener('click', function()
		{
			sim.reset();
		});

		var example = document.getElementById('example');
		addOptions(example, examples.map(function(e) { return e.name; }),
			examples.map(function(e) { return e.label; }));

		example.addEventListener('change', function()
		{
			if (example.value != '')
			{
				openExample(example.value);
				example.value = '';
			}
		});

		var file = document.getElementById('file');

		document.getElementById('import').addEventListener('click', function()
		{
			file.click();
		});

		file.addEventListener('change', function()
		{
			if (file.files.length > 0)
			{
				sim.importFile(file.files[0]);
			}

			file.value = '';
		});

		var controls = document.querySelectorAll('.panel [disabled]');

		for (var i = 0; i < controls.length; i++)
		{
			controls[i].disabled = false;
		}
	};

	// Earlier versions wrote dev=0 or test=0 into the URL to turn debug output
	// off, which is the default now
	if (params.get('dev') == '0' || params.get('test') == '0')
	{
		if (params.get('dev') == '0')
		{
			params['delete']('dev');
		}

		if (params.get('test') == '0')
		{
			params['delete']('test');
		}

		writeParams();
	}

	var debugBox = document.getElementById('debug');
	debugBox.checked = debug;

	debugBox.addEventListener('change', function()
	{
		setDebug(debugBox.checked);
	});

	if (debug)
	{
		console.info('Traffic debug output on' + ((testMode) ? ', editor with test=1' : ''));
	}

	initFolding();
	initPanelToggle();
	waitForEditor(attach);
})();
