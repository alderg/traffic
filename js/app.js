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
		{label: 'Portland (3.5 MB)', name: 'portland'}];
	var frame = document.getElementById('editor');
	var startButton = document.getElementById('start');
	var stats = document.getElementById('stats');
	var ui = null;
	var sim = null;

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
			win.TrafficRoads(ui);
			keepFormatPanelClosed();
			sim = win.TrafficSimulation(ui, update);
			initControls();
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
