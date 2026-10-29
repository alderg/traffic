/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * OpenStreetMap layer of towns in the editor. This script runs in the
 * window of the editor after js/roads.js. TrafficMap(ui, options) shows the
 * notice "© OpenStreetMap contributors" with the ODbL in the bottom right
 * corner of the diagram while the current page is a town that js/osm.js
 * built, which has the text with the id osm-attribution, at all zoom levels
 * and scroll positions.
 *
 * Towns have the Mercator meters of the origin of the diagram and their
 * scale in the mercator attribute of that text (x = (X - ox) * k, y =
 * (oy - Y) * k), so that the map tiles (Web Mercator, 256 pixels) can be
 * placed under the roads. The map is a layer behind the diagram container,
 * whose background is then transparent, so that the roads and junctions,
 * the traffic lights and the vehicles above it show and work as without it,
 * each as the simulation shows them (roads, lights and vehicles in its
 * config). Each change of the scale, the
 * translate, the scroll, the pan and the zoom preview of draw.io places the
 * tiles again: of the zoom level with the size that is nearest to the
 * scale, only those in view, with the tiles of the last level below until
 * the new ones are loaded. Tiles are only kept as the browser caches them.
 * In dark mode the tiles are inverted. The opacity of the tiles (1 by
 * default) fades the map into the background that draw.io gives the
 * diagram, in both modes, without loading the tiles again.
 *
 * options.tileUrl is the template of the tiles with {z}, {x} and {y},
 * options.maxZoom their largest zoom level and options.attribution the text
 * that the tile server asks for besides OpenStreetMap.
 */
window.TrafficMap = function(ui, options)
{
	options = options || {};
	var graph = ui.editor.graph;
	var container = graph.container;
	var parent = container.parentNode;
	var copyrightUrl = 'https://www.openstreetmap.org/copyright';
	var licenseUrl = 'https://opendatacommons.org/licenses/odbl/';
	var tileUrl = options.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
	var maxZoom = (options.maxZoom != null) ? options.maxZoom : 19;
	var size = 256;
	var world = 2 * Math.PI * 6378137;
	var darkFilter = 'invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9)';
	var visible = true;
	var geo = null;
	var shown = false;
	var town = false;
	var tiles = new Map();
	var zoom = null;
	var listeners = [];

	var style = document.createElement('style');
	style.textContent = 'div.geDiagramContainer.trafficMapShown,div.geDiagramContainer.trafficMapShown>svg{' +
		'background-color:transparent !important;background-image:none !important;}';
	document.head.appendChild(style);

	// Behind the diagram container, which comes later, with the background of
	// the diagram below the tiles
	var layer = document.createElement('div');
	layer.className = 'trafficMap';
	layer.style.cssText = 'position:absolute;z-index:0;display:none;overflow:hidden;pointer-events:none;';
	parent.insertBefore(layer, container);

	// The tiles in their order, with the filter of dark mode and the opacity
	var pane = document.createElement('div');
	pane.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
	layer.appendChild(pane);

	var notice = document.createElement('div');
	notice.className = 'trafficMapNotice';
	notice.style.cssText = 'position:absolute;z-index:3;display:none;padding:2px 6px;border-radius:4px;' +
		'font:11px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;' +
		'transform:translate(-100%,-100%);pointer-events:auto;';
	parent.appendChild(notice);

	function getNotice()
	{
		return '© <a href="' + copyrightUrl + '" target="_blank" rel="noopener">OpenStreetMap ' +
			'contributors</a>, <a href="' + licenseUrl + '" target="_blank" rel="noopener">ODbL</a>' +
			((shown && options.attribution) ? ' | ' + mxUtils.htmlEntities(options.attribution) : '');
	};

	/**
	 * Returns true if the current page is a town of OpenStreetMap.
	 */
	function isTown()
	{
		return graph.model.getCell('osm-attribution') != null;
	};

	/**
	 * Returns the Mercator meters of the origin and the scale of the town on
	 * the current page or null.
	 */
	function getGeo()
	{
		var cell = graph.model.getCell('osm-attribution');
		var value = (cell != null && cell.value != null && typeof cell.value.getAttribute === 'function') ?
			cell.value.getAttribute('mercator') : null;
		var v = (value != null) ? String(value).split(',').map(parseFloat) : [];

		return (v.length == 3 && v.every(isFinite) && v[2] > 0) ? {ox: v[0], oy: v[1], k: v[2]} : null;
	};

	function getUrl(z, x, y)
	{
		return tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a').replace('{r}', '');
	};

	function removeTile(key)
	{
		var tile = tiles.get(key);

		if (tile != null)
		{
			tile.img.onload = null;
			tile.img.onerror = null;

			if (tile.img.parentNode != null)
			{
				tile.img.parentNode.removeChild(tile.img);
			}

			tiles['delete'](key);
		}
	};

	function clearTiles()
	{
		Array.from(tiles.keys()).forEach(removeTile);
	};

	function hasOldTiles()
	{
		var result = false;

		tiles.forEach(function(tile)
		{
			result = result || tile.z != zoom;
		});

		return result;
	};

	/**
	 * Returns the background color that draw.io gives the diagram, which the
	 * map covers, on the canvas or, with the page view, on the container.
	 */
	function getBackground()
	{
		var svg = graph.view.canvas.ownerSVGElement;

		return ((svg != null) ? svg.style.backgroundColor : '') || container.style.backgroundColor;
	};

	/**
	 * Returns the view of the tiles: the client pixels of Mercator meters
	 * in the diagram container, with the zoom preview of draw.io, which
	 * scales the canvas (in model coordinates, else the draw pane) around a
	 * point of its content until the zoom is done.
	 */
	function getView()
	{
		var s = graph.view.scale;
		var t = graph.view.translate;
		var pane = (graph.view.modelCoordinates) ? graph.view.getCanvas() : graph.view.getDrawPane();
		var f = 1;
		var cx = 0;
		var cy = 0;
		var m = /scale\(([^)]+)\)/.exec(pane.style.transform || '');

		if (m != null && isFinite(parseFloat(m[1])))
		{
			var origin = (pane.style.transformOrigin || '').split(' ');
			f = parseFloat(m[1]);
			cx = parseFloat(origin[0]) || 0;
			cy = parseFloat(origin[1]) || 0;
		}

		var a = s * f * geo.k;

		return {a: a, bx: (t.x * s - cx) * f + cx - container.scrollLeft + (graph.panDx || 0) - geo.ox * a,
			by: (t.y * s - cy) * f + cy - container.scrollTop + (graph.panDy || 0) + geo.oy * a};
	};

	/**
	 * Places the tiles in view of the zoom level for the current scale.
	 */
	function placeTiles(w, h)
	{
		var v = getView();
		var z = Math.max(0, Math.min(maxZoom, Math.ceil(Math.log(v.a * world / size) / Math.LN2 - 0.25)));
		var n = Math.pow(2, z);
		var unit = world / (size * n);
		zoom = z;

		// Client pixels of the edges of the tile, rounded so that tiles meet,
		// and true if it is in view
		function place(tile)
		{
			var u = world / (size * Math.pow(2, tile.z));
			var x0 = Math.round((tile.x * size * u - world / 2) * v.a + v.bx);
			var x1 = Math.round(((tile.x + 1) * size * u - world / 2) * v.a + v.bx);
			var y0 = Math.round((tile.y * size * u - world / 2) * v.a + v.by);
			var y1 = Math.round(((tile.y + 1) * size * u - world / 2) * v.a + v.by);
			tile.img.style.left = x0 + 'px';
			tile.img.style.top = y0 + 'px';
			tile.img.style.width = (x1 - x0) + 'px';
			tile.img.style.height = (y1 - y0) + 'px';
			tile.img.style.zIndex = (tile.z == z) ? '2' : '1';

			return x1 > 0 && x0 < w && y1 > 0 && y0 < h;
		};

		var tx0 = Math.floor(((0 - v.bx) / v.a + world / 2) / unit / size);
		var tx1 = Math.floor(((w - v.bx) / v.a + world / 2) / unit / size);
		var ty0 = Math.max(0, Math.floor((world / 2 - (0 - v.by) / -v.a) / unit / size));
		var ty1 = Math.min(n - 1, Math.floor((world / 2 - (h - v.by) / -v.a) / unit / size));
		var needed = new Set();
		var complete = true;

		for (var ty = ty0; ty <= ty1; ty++)
		{
			for (var tx = tx0; tx <= tx1 && tx - tx0 < 64; tx++)
			{
				var key = z + '/' + tx + '/' + ty;
				var tile = tiles.get(key);

				if (tile == null)
				{
					tile = {z: z, x: tx, y: ty, img: document.createElement('img'), loaded: false};
					tile.img.alt = '';
					tile.img.draggable = false;
					tile.img.decoding = 'async';
					tile.img.style.cssText = 'position:absolute;display:block;max-width:none;user-select:none;';
					tile.img.onload = tile.img.onerror = function(t)
					{
						return function()
						{
							t.loaded = true;

							// Removes the tiles of the last zoom level
							if (t.z == zoom && hasOldTiles())
							{
								update();
							}
						};
					}(tile);
					tile.img.src = getUrl(z, ((tx % n) + n) % n, ty);
					tiles.set(key, tile);
					pane.appendChild(tile.img);
				}

				place(tile);
				needed.add(key);
				complete = complete && tile.loaded;
			}
		}

		Array.from(tiles.keys()).forEach(function(key)
		{
			var tile = tiles.get(key);

			if (!needed.has(key) && (tile.z == z || complete || !tile.loaded || !place(tile)))
			{
				removeTile(key);
			}
		});
	};

	/**
	 * Shows or hides the notice and the map and places them over the visible
	 * area of the diagram, inside the scrollbars.
	 */
	function update()
	{
		var lastGeo = geo;
		geo = getGeo();
		town = geo != null || isTown();
		var nowShown = visible && geo != null;
		var available = geo != null;

		if (nowShown != shown)
		{
			shown = nowShown;
			container.classList.toggle('trafficMapShown', shown);
			layer.style.display = (shown) ? '' : 'none';
			notice.innerHTML = '';
		}

		if (!shown || (lastGeo != null && geo != null && (lastGeo.ox != geo.ox ||
			lastGeo.oy != geo.oy || lastGeo.k != geo.k)))
		{
			clearTiles();
		}

		var c = container.getBoundingClientRect();
		var p = parent.getBoundingClientRect();
		var x = c.left - p.left + container.clientLeft;
		var y = c.top - p.top + container.clientTop;
		var w = container.clientWidth;
		var h = container.clientHeight;
		var dark = typeof Editor !== 'undefined' && Editor.isDarkMode();

		if (shown)
		{
			layer.style.left = x + 'px';
			layer.style.top = y + 'px';
			layer.style.width = w + 'px';
			layer.style.height = h + 'px';
			layer.style.backgroundColor = getBackground();
			pane.style.filter = (dark) ? darkFilter : '';
			placeTiles(w, h);
		}

		notice.style.display = (town) ? '' : 'none';

		if (town)
		{
			if (notice.innerHTML == '')
			{
				notice.innerHTML = getNotice();
			}

			notice.style.left = (x + w - 6) + 'px';
			notice.style.top = (y + h - 6) + 'px';
			notice.style.color = (dark) ? '#e6e7e9' : '#1f2328';
			notice.style.background = (dark) ? 'rgba(24,25,27,0.8)' : 'rgba(255,255,255,0.8)';

			var links = notice.getElementsByTagName('a');

			for (var i = 0; i < links.length; i++)
			{
				links[i].style.color = (dark) ? '#6ba1f5' : '#1a73e8';
			}
		}

		if ((lastGeo != null) != available)
		{
			for (var i = 0; i < listeners.length; i++)
			{
				listeners[i](available);
			}
		}
	};

	update = TrafficRoads.guard(update, 'map');
	graph.model.addListener(mxEvent.CHANGE, update);
	graph.view.addListener(mxEvent.SCALE, update);
	graph.view.addListener(mxEvent.TRANSLATE, update);
	graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, update);
	graph.addListener(mxEvent.PAN, update);
	graph.addListener('zoomPreview', update);
	graph.addListener('zoomPreviewComplete', update);
	ui.addListener('darkModeChanged', update);
	mxEvent.addListener(container, 'scroll', update);
	window.addEventListener('resize', update);

	if (typeof ResizeObserver !== 'undefined')
	{
		new ResizeObserver(update).observe(container);
	}

	update();

	return {isTown: isTown, update: update,
		isAvailable: function()
		{
			return geo != null;
		},
		isVisible: function()
		{
			return visible;
		},
		/**
		 * Shows the map behind towns instead of the drawing of their roads.
		 */
		setVisible: function(value)
		{
			visible = value;
			update();
		},
		/**
		 * Sets the opacity of the tiles from 0 (transparent) to 1 (opaque),
		 * after the filter of dark mode.
		 */
		setOpacity: function(value)
		{
			pane.style.opacity = (value < 1) ? String(Math.max(0, value)) : '';
		},
		/**
		 * Adds a function that is called with true when the current page gets
		 * a map and with false when it has none any more.
		 */
		addListener: function(fn)
		{
			listeners.push(fn);
		}};
};
