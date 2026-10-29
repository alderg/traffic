/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Road elements of the traffic simulation in the editor. This script runs in
 * the window of the editor: TrafficRoads(ui) registers the road and
 * roundabout shapes, replaces the shape libraries of the given EditorUi with
 * palettes of junctions and roads, makes new connectors two-way roads and
 * connects road ends that are dropped on junctions. The static functions of
 * TrafficRoads are the geometry of lanes and rings that js/simulation.js
 * shares with the shapes.
 *
 * A road is a connector with shape=road. lanes=<n> is the number of lanes
 * per direction (1 to 4) and laneWidth the width of a lane (7 units). One
 * arrow is a one-way road, no or two arrows a road in both directions, as
 * in the simulation. The stroke color is the asphalt and the fill color the
 * markings: edge lines, dashed lane dividers, a dashed center line (solid
 * double line with more lanes), arrows on the lanes of one-way roads, stop
 * lines at traffic lights and give-way lines at roundabouts.
 *
 * A roundabout is a shape with shape=roundabout: a ring road with lanes on
 * the outside and a central island in islandColor. Traffic circulates
 * counterclockwise and enters and leaves on the roads connected to it.
 *
 * Default colors are light-dark pairs with the same color on both sides, so
 * that the dark mode of the editor does not invert them. Other draw.io apps
 * paint roads as plain connectors and roundabouts as rectangles.
 */
window.TrafficRoads = function(ui)
{
	var graph = ui.editor.graph;
	var roads = window.TrafficRoads;

	var lightImage = 'data:image/svg+xml,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" ' +
		'width="10" height="22" viewBox="0 0 10 22">' +
		'<rect x="0.5" y="0.5" width="9" height="21" rx="2.5" fill="#202124" stroke="#ffffff"/>' +
		'<circle cx="5" cy="5" r="2.4" fill="#a33a32"/>' +
		'<circle cx="5" cy="11" r="2.4" fill="#a88a2a"/>' +
		'<circle cx="5" cy="17" r="2.4" fill="#2f8046"/></svg>');

	var crossingStyle = 'ellipse;aspect=fixed;html=1;strokeColor=none;fillColor=' + roads.asphalt + ';';
	var lightStyle = 'shape=label;rounded=1;arcSize=50;aspect=fixed;perimeter=ellipsePerimeter;html=1;' +
		'strokeColor=none;fillColor=' + roads.asphalt + ';image=' + lightImage + ';imageWidth=10;imageHeight=22;' +
		'imageAlign=center;imageVerticalAlign=middle;trafficLight=10;';
	var roundaboutStyle = 'shape=roundabout;aspect=fixed;perimeter=ellipsePerimeter;html=1;' +
		'strokeColor=none;fillColor=' + roads.asphalt + ';islandColor=' + roads.island + ';';
	var roadStyle = 'shape=road;html=1;strokeColor=' + roads.asphalt + ';fillColor=' + roads.marking + ';';

	function getRoadStyle(lanes, oneWay)
	{
		return roadStyle + ((oneWay) ? 'endArrow=block;startArrow=none;' : 'endArrow=none;startArrow=none;') +
			'lanes=' + lanes + ';strokeWidth=' + (lanes * roads.laneWidth * ((oneWay) ? 1 : 2)) + ';';
	};

	/**
	 * Returns the color for the given key in the style of the given shape or
	 * the given default if the style of the cell has no such color, as draw.io
	 * replaces the default colors of the stylesheet with black and white.
	 */
	function getColor(shape, key, defaultColor)
	{
		var own = (shape.state != null) ? shape.state.cell.style : null;
		var value = shape.style[key];

		return (value == null || value == 'default' || (typeof own === 'string' &&
			own.indexOf(key + '=') < 0)) ? defaultColor : value;
	};

	/**
	 * Strokes the given points as one path.
	 */
	function paintPath(c, pts)
	{
		c.begin();
		c.moveTo(pts[0].x, pts[0].y);

		for (var i = 1; i < pts.length; i++)
		{
			c.lineTo(pts[i].x, pts[i].y);
		}

		c.stroke();
	};

	function RoadShape()
	{
		mxConnector.call(this);
	};

	mxUtils.extend(RoadShape, mxConnector);

	/**
	 * The width of the road follows from its lanes.
	 */
	RoadShape.prototype.apply = function(state)
	{
		mxConnector.prototype.apply.apply(this, arguments);

		if (this.style != null)
		{
			this.strokewidth = roads.getRoadWidth(this.style);
		}
	};

	/**
	 * Returns the terminal state at the given end of the road.
	 */
	RoadShape.prototype.getTerminal = function(source)
	{
		return (this.state != null) ? this.state.getVisibleTerminalState(source) : null;
	};

	/**
	 * Returns the given points with the ends moved into round junctions, so
	 * that the asphalt joins them without notches. Ends in junctions that are
	 * narrower than the road move to the center and are added to discs.
	 */
	RoadShape.prototype.extendEnds = function(pts, h, discs)
	{
		var result = pts.slice();
		var n = pts.length;

		for (var i = 0; i < 2; i++)
		{
			var terminal = this.getTerminal(i == 0);

			if (terminal != null)
			{
				var r = Math.min(terminal.width, terminal.height) / 2 / this.scale;
				var e = (h < r) ? Math.min(r, r - Math.sqrt(r * r - h * h) + 0.5) : r;
				var p0 = pts[(i == 0) ? 0 : n - 1];
				var p1 = pts[(i == 0) ? 1 : n - 2];
				var len = roads.getDistance(p0, p1);

				if (len > 0)
				{
					result[(i == 0) ? 0 : n - 1] = new mxPoint(p0.x + (p0.x - p1.x) / len * e,
						p0.y + (p0.y - p1.y) / len * e);

					if (h >= r)
					{
						discs.push(result[(i == 0) ? 0 : n - 1]);
					}
				}
			}
		}

		return result;
	};

	/**
	 * Paints arrows along the given points, which are in the direction of
	 * travel, every 8 lane widths.
	 */
	RoadShape.prototype.paintArrows = function(c, pts, lw)
	{
		var lengths = roads.getLengths(pts);
		var total = lengths[lengths.length - 1];
		var count = Math.max(1, Math.floor(total / (8 * lw)));

		for (var i = 0; i < count; i++)
		{
			var p = roads.getPointAt(pts, lengths, (i + 0.5) * total / count);

			if (p != null)
			{
				c.begin();
				c.moveTo(p.x - p.dx * 1.2 * lw, p.y - p.dy * 1.2 * lw);
				c.lineTo(p.x, p.y);
				c.stroke();

				c.begin();
				c.moveTo(p.x + p.dx * 0.8 * lw, p.y + p.dy * 0.8 * lw);
				c.lineTo(p.x - p.dy * 0.3 * lw, p.y + p.dx * 0.3 * lw);
				c.lineTo(p.x + p.dy * 0.3 * lw, p.y - p.dx * 0.3 * lw);
				c.close();
				c.fill();
			}
		}
	};

	/**
	 * Paints a line across the lanes from offset a to b to the right of the
	 * incoming traffic at the given end of the path: solid in front of
	 * traffic lights, dashed at roundabouts.
	 */
	RoadShape.prototype.paintEndLine = function(c, path, source, a, b, m, dashed)
	{
		var n = path.length;
		var p0 = path[(source) ? 0 : n - 1];
		var p1 = path[(source) ? 1 : n - 2];
		var len = roads.getDistance(p0, p1);

		if (len > 0)
		{
			// Direction into the road and the right of the incoming traffic
			var dx = (p1.x - p0.x) / len;
			var dy = (p1.y - p0.y) / len;
			var x = p0.x + dx * 1.5 * m;
			var y = p0.y + dy * 1.5 * m;

			c.setDashed(dashed, true);
			c.setDashPattern('2 2');
			c.setStrokeWidth((dashed) ? 1.5 * m : 2.5 * m);
			c.begin();
			c.moveTo(x + dy * a, y - dx * a);
			c.lineTo(x + dy * b, y - dx * b);
			c.stroke();
		}
	};

	/**
	 * Paints the asphalt and the markings instead of the line and markers.
	 */
	RoadShape.prototype.paintEdgeShape = function(c, pts)
	{
		var style = this.style;
		var path = roads.getPath(pts, style);

		if (path.length < 2)
		{
			return;
		}

		var dir = roads.getDirection(style);
		var lanes = roads.getLanes(style);
		var lw = roads.getLaneWidth(style);
		var w = this.strokewidth;
		var m = lw / 8;
		var markColor = getColor(this, mxConstants.STYLE_FILLCOLOR, roads.marking);
		var prev = c.pointerEventsValue;
		c.pointerEventsValue = 'stroke';

		var asphalt = getColor(this, mxConstants.STYLE_STROKECOLOR, roads.asphalt);
		var discs = [];
		c.setStrokeColor(asphalt);
		c.setLineJoin('round');
		c.setDashed(false);
		paintPath(c, this.extendEnds(path, w / 2, discs));

		// Widens junctions that are narrower than the road
		c.setFillColor(asphalt);

		for (var i = 0; i < discs.length; i++)
		{
			c.ellipse(discs[i].x - w / 2, discs[i].y - w / 2, w, w);
			c.fill();
		}

		// Markings are skipped where they are too small to see
		if (markColor != mxConstants.NONE && lw * this.scale >= 3)
		{
			c.setShadow(false);
			c.setStrokeColor(markColor);
			c.setFillColor(markColor);

			// Edge lines
			c.setStrokeWidth(0.8 * m);
			paintPath(c, roads.offsetPoints(path, w / 2 - m));
			paintPath(c, roads.offsetPoints(path, m - w / 2));

			// Lane dividers
			c.setStrokeWidth(m);
			c.setDashed(true, true);
			c.setDashPattern('5 5');

			for (var k = 1; k < lanes; k++)
			{
				if (dir == 0)
				{
					paintPath(c, roads.offsetPoints(path, k * lw));
					paintPath(c, roads.offsetPoints(path, -k * lw));
				}
				else
				{
					paintPath(c, roads.offsetPoints(path, (k - lanes / 2) * lw));
				}
			}

			if (dir == 0)
			{
				// Center line, solid and double with more lanes
				if (lanes == 1)
				{
					paintPath(c, path);
				}
				else
				{
					c.setDashed(false);
					paintPath(c, roads.offsetPoints(path, 0.8 * m));
					paintPath(c, roads.offsetPoints(path, -0.8 * m));
				}
			}
			else
			{
				// Arrows on each lane in the direction of travel
				var travel = (dir > 0) ? path : path.slice().reverse();
				var offsets = roads.getLaneOffsets(style);
				c.setDashed(false);

				for (var k = 0; k < offsets.length; k++)
				{
					this.paintArrows(c, roads.offsetPoints(travel, offsets[k]), lw);
				}
			}

			// Stop and give-way lines across the incoming lanes
			for (var i = 0; i < 2; i++)
			{
				var source = i == 0;
				var terminal = this.getTerminal(source);
				var giveWay = terminal != null && roads.isRoundabout(terminal.style);
				var stop = terminal != null && mxUtils.getValue(terminal.style, 'trafficLight', 0) > 0;

				if ((giveWay || stop) && (dir == 0 || (dir > 0) != source))
				{
					this.paintEndLine(c, path, source, (dir == 0) ? 0 : m - w / 2,
						w / 2 - m, m, giveWay);
				}
			}
		}

		c.pointerEventsValue = prev;
	};

	mxCellRenderer.registerShape('road', RoadShape);

	function RoundaboutShape()
	{
		mxEllipse.call(this);
	};

	mxUtils.extend(RoundaboutShape, mxEllipse);

	/**
	 * Paints the ring road, the central island, the lane dividers and arrows
	 * in the direction of traffic.
	 */
	RoundaboutShape.prototype.paintVertexShape = function(c, x, y, w, h)
	{
		var ring = roads.getRing(this.style, w, h);
		var lw = roads.getLaneWidth(this.style);
		var m = lw / 8;
		var cx = x + w / 2;
		var cy = y + h / 2;

		c.setFillColor(getColor(this, mxConstants.STYLE_FILLCOLOR, roads.asphalt));
		c.ellipse(cx - ring.outer, cy - ring.outer, 2 * ring.outer, 2 * ring.outer);
		c.fill();

		c.setFillColor(getColor(this, 'islandColor', roads.island));
		c.ellipse(cx - ring.inner, cy - ring.inner, 2 * ring.inner, 2 * ring.inner);
		c.fill();

		if (lw * this.scale >= 3)
		{
			c.setShadow(false);
			c.setStrokeColor(roads.marking);
			c.setFillColor(roads.marking);
			c.setStrokeWidth(m);
			c.ellipse(cx - ring.inner, cy - ring.inner, 2 * ring.inner, 2 * ring.inner);
			c.stroke();

			c.setDashed(true, true);
			c.setDashPattern('5 5');

			for (var k = 1; k < ring.lanes; k++)
			{
				var r = ring.inner + 1 + k * lw;
				c.ellipse(cx - r, cy - r, 2 * r, 2 * r);
				c.stroke();
			}

			// Counterclockwise arrows on the ring
			c.setDashed(false);
			var r = ring.center;
			var s = Math.min(lw, r * 0.35);

			for (var i = 0; i < 4; i++)
			{
				var a = (i + 0.5) * Math.PI / 2;
				var px = cx + r * Math.cos(a);
				var py = cy + r * Math.sin(a);
				var dx = Math.sin(a);
				var dy = -Math.cos(a);

				c.begin();
				c.moveTo(px - dx * 0.7 * s, py - dy * 0.7 * s);
				c.lineTo(px, py);
				c.stroke();

				c.begin();
				c.moveTo(px + dx * 0.6 * s, py + dy * 0.6 * s);
				c.lineTo(px - dy * 0.3 * s, py + dx * 0.3 * s);
				c.lineTo(px + dy * 0.3 * s, py - dx * 0.3 * s);
				c.close();
				c.fill();
			}
		}
	};

	mxCellRenderer.registerShape('roundabout', RoundaboutShape);

	/**
	 * Returns the palette entry for a road from left to right.
	 */
	function createRoadEntry(sidebar, style, width, title)
	{
		return function()
		{
			var height = roads.getRoadWidth(graph.stylesheet.getCellStyle(style, {}));
			var cell = new mxCell('', new mxGeometry(0, 0, width, height), style);
			cell.geometry.setTerminalPoint(new mxPoint(0, height / 2), true);
			cell.geometry.setTerminalPoint(new mxPoint(width, height / 2), false);
			cell.geometry.relative = true;
			cell.edge = true;

			return sidebar.createEdgeTemplateFromCells([cell], width, height, title);
		};
	};

	/**
	 * Replaces the libraries with the palettes of junctions and roads, also
	 * in sidebars created later, eg. for other themes.
	 */
	Sidebar.prototype.init = function()
	{
		this.sidebarTitles = true;
		this.thumbWidth = 72;
		this.thumbHeight = 36;

		this.addPaletteFunctions('junctions', 'Junctions', true,
		[
			this.createVertexTemplateEntry(crossingStyle, 24, 24, '', 'Crossing', null, null, 'crossing'),
			this.createVertexTemplateEntry(lightStyle, 32, 32, '', 'Traffic light', null, null, 'traffic light'),
			this.createVertexTemplateEntry(roundaboutStyle, 60, 60, '', 'Roundabout', null, null, 'roundabout')
		]);

		this.addPaletteFunctions('roads', 'Roads', true,
		[
			createRoadEntry(this, getRoadStyle(1, false), 100, 'Two-way, 1+1 lanes'),
			createRoadEntry(this, getRoadStyle(2, false), 100, 'Two-way, 2+2 lanes'),
			createRoadEntry(this, getRoadStyle(1, true), 100, 'One-way, 1 lane'),
			createRoadEntry(this, getRoadStyle(2, true), 100, 'One-way, 2 lanes'),
			createRoadEntry(this, getRoadStyle(3, true), 100, 'One-way, 3 lanes')
		]);
	};

	Sidebar.prototype.createMoreShapes = function()
	{
		var div = document.createElement('div');
		div.style.display = 'none';

		return div;
	};

	var footers = ui.sidebar.container.getElementsByClassName('geSidebarFooter');

	for (var i = 0; i < footers.length; i++)
	{
		footers[i].style.display = 'none';
	}

	ui.sidebar.refresh();

	// Junctions in the shape picker of the hover arrows and connectors
	ui.defaultShapePickerEntries = [
		{style: crossingStyle, width: 24, height: 24, keepStyle: true},
		{style: lightStyle, width: 32, height: 32, keepStyle: true},
		{style: roundaboutStyle, width: 60, height: 60, keepStyle: true}];

	/**
	 * Makes new connectors two-way roads, also after the default styles are
	 * reset for a new theme.
	 */
	function setDefaultEdgeStyle()
	{
		// Keeps the arrows with value none, which getCellStyle removes
		var pairs = getRoadStyle(1, false).split(';');
		var style = {};

		for (var i = 0; i < pairs.length; i++)
		{
			var pair = pairs[i].split('=');

			if (pair.length == 2)
			{
				style[pair[0]] = pair[1];
			}
		}

		graph.defaultEdgeStyle = style;
		graph.currentEdgeStyle = mxUtils.clone(style);
	};

	var updateDefaultStyles = ui.updateDefaultStyles;

	ui.updateDefaultStyles = function()
	{
		updateDefaultStyles.apply(this, arguments);
		setDefaultEdgeStyle();
	};

	setDefaultEdgeStyle();

	/**
	 * Connects the free ends of roads to the junctions they are on when the
	 * given roads or junctions are dropped or moved, so that the simulation
	 * uses them.
	 */
	function connectEnds(cells)
	{
		var model = graph.model;
		var vertices = new Map();

		function connect(edge, candidates)
		{
			var geo = model.getGeometry(edge);

			for (var j = 0; j < 2 && geo != null; j++)
			{
				var source = j == 0;
				var pt = geo.getTerminalPoint(source);
				var vertex = (model.getTerminal(edge, source) == null && pt != null) ?
					roads.findJunction(graph, model.getParent(edge), pt, candidates) : null;

				if (vertex != null)
				{
					graph.connectCell(edge, vertex, source);
				}
			}
		};

		for (var i = 0; cells != null && i < cells.length; i++)
		{
			var parent = model.getParent(cells[i]);

			if (model.isEdge(cells[i]))
			{
				connect(cells[i]);
			}
			else if (model.isVertex(cells[i]) && parent != null)
			{
				if (!vertices.has(parent))
				{
					vertices.set(parent, []);
				}

				vertices.get(parent).push(cells[i]);
			}
		}

		vertices.forEach(function(candidates, parent)
		{
			for (var i = 0; i < model.getChildCount(parent); i++)
			{
				var cell = model.getChildAt(parent, i);

				if (model.isEdge(cell) && (model.getTerminal(cell, true) == null ||
					model.getTerminal(cell, false) == null))
				{
					connect(cell, candidates);
				}
			}
		});
	};

	graph.addListener(mxEvent.CELLS_ADDED, function(sender, evt)
	{
		connectEnds(evt.getProperty('cells'));
	});

	graph.addListener(mxEvent.CELLS_MOVED, function(sender, evt)
	{
		connectEnds(evt.getProperty('cells'));
	});

	// Paints roads of a diagram that was opened before the shapes existed
	graph.refresh();
};

/**
 * Default colors of asphalt, markings and roundabout islands.
 */
TrafficRoads.asphalt = 'light-dark(#5f6368,#5f6368)';
TrafficRoads.marking = 'light-dark(#ffffff,#ffffff)';
TrafficRoads.island = 'light-dark(#a8d5a0,#2f5d2a)';

/**
 * Default width of a lane in units (meters).
 */
TrafficRoads.laneWidth = 7;

/**
 * Distance in units within which the free end of a road joins a junction.
 */
TrafficRoads.snapDistance = 6;

/**
 * Returns 1 for a road from source to target, -1 for the opposite
 * direction and 0 for both directions.
 */
TrafficRoads.getDirection = function(style)
{
	var end = mxUtils.getValue(style, mxConstants.STYLE_ENDARROW, mxConstants.NONE) != mxConstants.NONE;
	var start = mxUtils.getValue(style, mxConstants.STYLE_STARTARROW, mxConstants.NONE) != mxConstants.NONE;

	return (end == start) ? 0 : ((end) ? 1 : -1);
};

/**
 * Returns the number of lanes per direction, 1 to 4.
 */
TrafficRoads.getLanes = function(style)
{
	var lanes = parseInt(mxUtils.getValue(style, 'lanes', 1));

	return (isNaN(lanes)) ? 1 : Math.max(1, Math.min(4, lanes));
};

TrafficRoads.getLaneWidth = function(style)
{
	var lw = parseFloat(mxUtils.getValue(style, 'laneWidth', TrafficRoads.laneWidth));

	return (isNaN(lw) || lw <= 0) ? TrafficRoads.laneWidth : Math.min(lw, 50);
};

TrafficRoads.getRoadWidth = function(style)
{
	return TrafficRoads.getLanes(style) * TrafficRoads.getLaneWidth(style) *
		((TrafficRoads.getDirection(style) == 0) ? 2 : 1);
};

/**
 * Returns the offsets of the centers of the lanes of one direction to the
 * right of the direction of travel, from the left to the right lane. Both
 * directions of a two-way road have their lanes on the right.
 */
TrafficRoads.getLaneOffsets = function(style)
{
	var lanes = TrafficRoads.getLanes(style);
	var lw = TrafficRoads.getLaneWidth(style);
	var twoWay = TrafficRoads.getDirection(style) == 0;
	var result = [];

	for (var k = 0; k < lanes; k++)
	{
		result.push(((twoWay) ? k + 0.5 : k - (lanes - 1) / 2) * lw);
	}

	return result;
};

TrafficRoads.isRoundabout = function(style)
{
	return style != null && style[mxConstants.STYLE_SHAPE] == 'roundabout';
};

/**
 * Returns the radii of a roundabout of the given size: outer edge, central
 * island and center of the lanes, and the number of lanes of the ring.
 */
TrafficRoads.getRing = function(style, w, h)
{
	var outer = Math.min(w, h) / 2;
	var lanes = TrafficRoads.getLanes(style);
	var width = Math.min(lanes * TrafficRoads.getLaneWidth(style) + 2, outer * 0.6);

	return {outer: outer, inner: outer - width, center: outer - width / 2, lanes: lanes};
};

/**
 * Returns the points of the painted line, along the curve for curved roads,
 * without repeated points.
 */
TrafficRoads.getPath = function(pts, style)
{
	var result = [];

	if ((style[mxConstants.STYLE_CURVED] == 1 || style[mxConstants.STYLE_BEZIER] == 1) &&
		Graph.getCurvePoints != null && pts.length > 2)
	{
		pts = Graph.getCurvePoints(pts, style[mxConstants.STYLE_BEZIER] == 1);
	}

	for (var i = 0; i < pts.length; i++)
	{
		if (pts[i] != null && (result.length == 0 ||
			TrafficRoads.getDistance(result[result.length - 1], pts[i]) > 0.01))
		{
			result.push(pts[i]);
		}
	}

	return result;
};

/**
 * Returns the given points moved by d to the right of the direction of the
 * points (y down), with miters at bends.
 */
TrafficRoads.offsetPoints = function(pts, d)
{
	var result = [];

	for (var i = 0; i < pts.length; i++)
	{
		var nx = 0;
		var ny = 0;

		for (var j = Math.max(1, i); j <= Math.min(i + 1, pts.length - 1); j++)
		{
			var len = TrafficRoads.getDistance(pts[j - 1], pts[j]);
			nx -= (pts[j].y - pts[j - 1].y) / len;
			ny += (pts[j].x - pts[j - 1].x) / len;
		}

		var f = (i > 0 && i < pts.length - 1) ?
			2 * d / Math.max(nx * nx + ny * ny, 0.5) : d;
		result.push(new mxPoint(pts[i].x + nx * f, pts[i].y + ny * f));
	}

	return result;
};

TrafficRoads.getDistance = function(p0, p1)
{
	var dx = p1.x - p0.x;
	var dy = p1.y - p0.y;

	return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Returns the distances of the given points along the path.
 */
TrafficRoads.getLengths = function(pts)
{
	var result = [0];

	for (var i = 1; i < pts.length; i++)
	{
		result.push(result[i - 1] + TrafficRoads.getDistance(pts[i - 1], pts[i]));
	}

	return result;
};

/**
 * Returns the point at the given distance along the path with the unit
 * vector of its direction in dx and dy.
 */
TrafficRoads.getPointAt = function(pts, lengths, d)
{
	var i = 1;

	while (i < lengths.length - 1 && lengths[i] < d)
	{
		i++;
	}

	var len = lengths[i] - lengths[i - 1];

	if (len > 0)
	{
		var f = Math.max(0, Math.min(1, (d - lengths[i - 1]) / len));
		var result = new mxPoint(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
			pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f);
		result.dx = (pts[i].x - pts[i - 1].x) / len;
		result.dy = (pts[i].y - pts[i - 1].y) / len;

		return result;
	}

	return null;
};

/**
 * Returns the junction among the given cells or the children of the given
 * parent that contains the given point or is within snapDistance of it, the
 * nearest if there are several.
 */
TrafficRoads.findJunction = function(graph, parent, pt, cells)
{
	var model = graph.model;
	var result = null;
	var best = Infinity;
	var tol = TrafficRoads.snapDistance;
	var count = (cells != null) ? cells.length : model.getChildCount(parent);

	for (var i = 0; i < count; i++)
	{
		var cell = (cells != null) ? cells[i] : model.getChildAt(parent, i);
		var geo = model.getGeometry(cell);

		if (model.isVertex(cell) && geo != null && !geo.relative &&
			pt.x >= geo.x - tol && pt.x <= geo.x + geo.width + tol &&
			pt.y >= geo.y - tol && pt.y <= geo.y + geo.height + tol)
		{
			var d = TrafficRoads.getDistance(pt, new mxPoint(geo.getCenterX(), geo.getCenterY()));

			if (d < best)
			{
				best = d;
				result = cell;
			}
		}
	}

	return result;
};
