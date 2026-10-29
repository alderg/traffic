/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Page of the traffic simulation. draw.io runs in the editor frame as the
 * editor of the road network. Once it is ready, js/roads.js and
 * js/simulation.js are loaded into the frame and attached to the editor, and
 * the controls of this page drive the simulation.
 */
(function()
{
	var examples = [
		{label: 'Small, with a traffic light', name: 'small'},
		{label: 'Race', name: 'race'},
		{label: 'Axhausen', name: 'axhausen'},
		{label: 'Portland (4.1 MB)', name: 'portland'}];
	var frame = document.getElementById('editor');
	var startButton = document.getElementById('start');
	var stats = document.getElementById('stats');
	var ui = null;
	var sim = null;
	var roads = null;
	var updateCycle = null;

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

		loadScripts(['js/roads.js', 'js/simulation.js'], function()
		{
			ui = editorUi;
			roads = win.TrafficRoads(ui);
			keepFormatPanelClosed();
			sim = win.TrafficSimulation(ui, update);
			initControls();
			initSelection();
			sim.start();

			if (ui.isDiagramEmpty())
			{
				openExample('small');
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

		// The timing of a light follows from the network after changes
		if (updateCycle != null)
		{
			updateCycle();
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
		var turnNames = {l: ['Left', '\u21b0'], s: ['Straight', '\u2191'], r: ['Right', '\u21b1']};
		var junctions = [];
		var edges = [];
		var plan = null;
		var spec = null;

		function count(n, name)
		{
			return n + ' ' + name + ((n == 1) ? '' : 's');
		};

		updateCycle = function()
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
	 * Opens the given file in the editor, also in the web app, where
	 * openLocalFile opens files in a new window if the diagram is not empty.
	 */
	function openFile(xml, name)
	{
		var win = frame.contentWindow;
		var file = ui.getCurrentFile();

		var fn = function()
		{
			ui.fileLoaded(new win.LocalFile(ui, xml, name, true));
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

	function openExample(name)
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
			openFile(xml, name + '.drawio');
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
			noise: [[0, 0.1, 0.25, 0.5], ['0 %', '10 %', '25 %', '50 %']]};

		Object.keys(selects).forEach(function(key)
		{
			var select = document.getElementById(key);
			addOptions(select, selects[key][0], selects[key][1]);
			select.value = config[key];

			select.addEventListener('change', function()
			{
				sim.setOption(key, parseFloat(select.value));
			});
		});

		['reroute', 'density'].forEach(function(key)
		{
			var checkbox = document.getElementById(key);
			checkbox.checked = config[key];

			checkbox.addEventListener('change', function()
			{
				sim.setOption(key, checkbox.checked);
			});
		});

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

	initPanelToggle();
	waitForEditor(attach);
})();
