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
 * bbox=<south>,<west>,<north>,<east>. Copy Link puts the loaded town there.
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
	var town = null;
	var map = null;
	var legendBar = null;
	var legendStops = null;
	var faviconRunning = false;
	var tiles = getTiles();
	var vehicleSection = document.getElementById('vehicle');
	var centerHint = document.getElementById('center-hint');
	var vehicleRows = vehicleSection.querySelector('tbody');
	var logged = new WeakSet();

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

	// The window of the editor is replaced when it loads
	frame.addEventListener('load', function()
	{
		addErrorListeners(frame.contentWindow, 'editor');
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
	 * Map background shows the map behind towns, which only they have.
	 */
	function initMapControl()
	{
		var checkbox = document.getElementById('map');
		var hint = document.getElementById('map-hint');
		checkbox.checked = map.isVisible();

		// The vehicles get darker colors on the light map
		function update(available)
		{
			checkbox.disabled = !available;
			hint.hidden = available;
			sim.setOption('mapBackground', available && map.isVisible());
		};

		checkbox.addEventListener('change', function()
		{
			map.setVisible(checkbox.checked);
			sim.setOption('mapBackground', map.isAvailable() && map.isVisible());
		});

		map.addListener(update);
		update(map.isAvailable());
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

		loadScripts(['js/roads.js', 'js/simulation.js', 'js/map.js'], function()
		{
			ui = editorUi;
			logHandledErrors();
			win.TrafficRoads.onError = logError;
			roads = win.TrafficRoads(ui);
			map = win.TrafficMap(ui, tiles);
			keepFormatPanelClosed();
			sim = win.TrafficSimulation(ui, update);
			initControls();
			initMapControl();
			initSelection();
			town = initTown();
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
		stats.textContent = lines.join('\n');
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

			var rows = [['Cars now', 'cars', 0, ''], ['Expected', 'expected', 0, ''],
				['Entered', 'entered', 0, ''], ['Left', 'left', 0, ''], ['Speed', 'speed', 0, ' km/h'],
				['Throughput', 'throughput', 0, '/h'], ['Waiting', 'wait', 1, ' s']];
			var html = '<tr><th></th>' + columns.map(function(c)
			{
				return '<th>' + c.name + '</th>';
			}).join('') + '</tr>';

			for (var i = 0; i < rows.length; i++)
			{
				html += '<tr><td>' + rows[i][0] + '</td>' + columns.map(function(c)
				{
					return '<td>' + format(c[rows[i][1]], rows[i][2], rows[i][3]) + '</td>';
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
		};

		/**
		 * Starts a task with progress and Cancel and returns its controller.
		 * A new task cancels the last one.
		 */
		function startTask(text)
		{
			if (task != null)
			{
				task.abort();
			}

			task = new AbortController();
			showError(null);
			statusText.textContent = text;
			progress.hidden = false;
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

		document.getElementById('town-cancel').addEventListener('click', function()
		{
			var t = task;

			if (t != null)
			{
				t.abort();
				endTask(t);
				infoText.textContent = 'Cancelled.';
				infoText.hidden = false;
			}
		});

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
			var z = Math.max(1, Math.min(18, Math.ceil(zf)));
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
			load(false);
		});

		/**
		 * Loads, builds and opens the network of the chosen place, level and
		 * section, from the cache unless fresh is true.
		 */
		function load(fresh, onError)
		{
			var p = place;
			var l = level.value;
			var s = section;
			var t = startTask('Loading the roads of ' + p.name + '\u2026');
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

					statusText.textContent = text + ' ' + secs + ' s';
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
				statusText.textContent = 'Building the network\u2026';

				// Paints the status before the work
				return new Promise(function(resolve)
				{
					window.setTimeout(resolve, 30);
				}).then(function()
				{
					return {entry: entry, result: osm.build(entry.data, p, l, s, {date: entry.dataDate || entry.date})};
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
					showError('There are no ' + osm.levelNames[l].toLowerCase() + ' in ' +
						((s != null) ? 'this section of ' : '') + p.name + '. Choose more roads or another section.');
				}
				else if (r.result.tooLarge)
				{
					showError('The network of ' + ((s != null) ? 'this section of ' : '') + p.name + ' has ' +
						format(st.junctions) + ' junctions and ' + format(st.roads) + ' roads, more than the ' +
						format(osm.limits.junctions) + ' junctions and ' + format(osm.limits.roads) +
						' roads that stay fast. Choose main roads or a section on the map and Load again, ' +
						'the roads are loaded already.');
					sizeText.classList.add('warning');
				}
				else
				{
					statusText.textContent = 'Opening the network\u2026';

					openFile(r.result.xml, p.name + '.drawio', function()
					{
						loaded = {place: p, level: l, section: s};
						updateLink();
						setUrl();

						// Enough cars to see traffic on the roads
						var cars = Math.max(100, Math.min(1500, Math.round(st.laneKm / 15) * 10));
						sim.config.cars = cars;
						document.getElementById('cars').value = cars;

						showInfo(p, l, s, st, r.entry, cars);
					});
				}
			})['catch'](function(e)
			{
				window.clearInterval(timer);

				if (!t.signal.aborted)
				{
					endTask(t);
					logError(e, 'loading ' + p.name);
					showError('Could not load ' + p.name + ': ' + getMessage(e) + ((e.busy) ?
						' Try again later, choose main roads or a smaller section.' : ''));

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

			infoText.appendChild(document.createTextNode(osm.levelNames[l] + ' of ' + ((s != null) ?
				'a section of ' : '') + p.name + ': ' + parts.join(', ') + ' and ' + format(st.gates) +
				' entries and exits at the ' + ((s != null) ? 'section' : ((p.rings != null) ? 'town limits' :
				'circle')) + ', where half of the ' +
				format(cars) + ' cars start or end. Roads of ' + formatDate(entry.dataDate || entry.date) +
				' from ' + entry.server + ((entry.cached) ? ', loaded on ' + formatDate(entry.date) + '. ' : '. ')));
			var reload = document.createElement('button');
			reload.type = 'button';
			reload.className = 'link';
			reload.textContent = 'Load again';
			reload.title = 'Load the roads again from OpenStreetMap';

			reload.addEventListener('click', function()
			{
				choose(p, l, s);
				load(true);
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
		 * Puts the loaded town into the URL.
		 */
		function setUrl()
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
			}

			writeParams();
		};

		function clearUrl()
		{
			['city', 'osm', 'roads', 'circle', 'bbox'].forEach(function(key)
			{
				params['delete'](key);
			});
		};

		linkButton.addEventListener('click', function()
		{
			setUrl();
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
		 * the section of circle or bbox. Opens the example if that fails.
		 */
		function loadFromUrl()
		{
			var key = params.get('osm');
			var name = params.get('city');
			var roads = (osm.levels.indexOf(params.get('roads')) >= 0) ? params.get('roads') : null;
			var s = osm.parseSection(params.get('circle'), params.get('bbox'));
			var label = name || key;
			var t = startTask('Finding ' + label + '\u2026');
			query.value = name || '';

			function fail(e)
			{
				showError('Could not open ' + label + ' from the link: ' + getMessage(e));

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
				endTask(t);
				choose(p, roads, s);
				load(false, fail);
			})['catch'](function(e)
			{
				if (!t.signal.aborted)
				{
					endTask(t);
					fail(e);
				}
			});
		};

		return {loadFromUrl: loadFromUrl, clear: function()
		{
			loaded = null;
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
	 * Opens the given file in the editor, also in the web app, where
	 * openLocalFile opens files in a new window if the diagram is not empty,
	 * and fits the whole diagram into the window.
	 */
	function openFile(xml, name, onLoad)
	{
		var win = frame.contentWindow;
		var file = ui.getCurrentFile();

		var fn = function()
		{
			ui.fileLoaded(new win.LocalFile(ui, xml, name, true));
			fitDiagram();

			if (onLoad != null)
			{
				onLoad();
			}
		};

		if (file != null && file.isModified())
		{
			ui.confirm(win.mxResources.get('allChangesLost'), null, fn,
				win.mxResources.get('cancel'), win.mxResources.get('discardChanges'));
		}
		else
		{
			fn();
		}
	};

	function openExample(name, keepTown)
	{
		fetch('data/' + name + '.drawio').then(function(response)
		{
			if (!response.ok)
			{
				throw new Error(response.status + ' ' + response.statusText);
			}

			return response.text();
		}).then(function(xml)
		{
			openFile(xml, name + '.drawio', function()
			{
				if (town != null && !keepTown)
				{
					town.clear();
				}
			});
		})['catch'](function(e)
		{
			ui.handleError(e);
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
			config.cars = (isNaN(value)) ? config.cars : Math.max(0, Math.min(10000, value));
			cars.value = config.cars;
		});

		var selects = {
			speed: [[1, 2, 5, 10, 20, 50, 100], ['1x', '2x', '5x', '10x', '20x', '50x', '100x']],
			vmax: [[1, 2, 3, 4, 5, 6], ['27 km/h', '54 km/h', '81 km/h', '108 km/h', '135 km/h', '162 km/h']],
			noise: [[0, 0.1, 0.25, 0.5], ['0 %', '10 %', '25 %', '50 %']],
			trucks: [[0, 0.1, 0.2, 0.3, 0.5], ['0 %', '10 %', '20 %', '30 %', '50 %']],
			fast: [[0, 0.05, 0.1, 0.2, 0.3], ['0 %', '5 %', '10 %', '20 %', '30 %']]};
		var types = document.getElementById('types');
		var typeNames = [['truck', 'Trucks', -2], ['car', 'Cars', 0], ['fast', 'Fast cars', 1]];
		var typeSpeeds = [];
		var topSpeed = document.createElement('span');

		// Shapes of the vehicles as in the editor with their top speed and
		// the colors of the speeds
		typeNames.forEach(function(type)
		{
			var shape = sim.vehicleShapes[type[0]];
			var row = document.createElement('span');
			row.className = 'vehicle';
			var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', (-shape.length / 2 - 0.2) + ' -1.8 ' + (shape.length + 0.4) + ' 3.6');
			svg.setAttribute('width', Math.round(12 * (shape.length + 0.4) / 3.6));
			svg.setAttribute('height', 12);
			svg.setAttribute('aria-hidden', 'true');

			['body', 'windows'].forEach(function(part)
			{
				var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('d', shape[part]);
				path.setAttribute('class', part);
				svg.appendChild(path);
			});

			row.appendChild(svg);
			var label = document.createElement('span');
			row.appendChild(label);
			typeSpeeds.push(label);
			types.appendChild(row);
		});

		var scale = document.createElement('span');
		scale.className = 'speed-scale';
		scale.appendChild(document.createTextNode('Speed 0'));
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
				typeSpeeds[i].textContent = typeNames[i][1] + ' ' +
					Math.max(1, config.vmax + typeNames[i][2]) * 27 + ' km/h';
			}

			topSpeed.textContent = (config.vmax + ((config.fast > 0) ? 1 : 0)) * 27 + ' km/h';
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
			});
		});

		updateTypes();

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

		var labelsHint = document.getElementById('labels-hint');

		['reroute', 'passEitherSide', 'roads', 'lights', 'vehicles', 'adaptive', 'density', 'labels', 'center'].forEach(function(key)
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

	initPanelToggle();
	waitForEditor(attach);
})();
