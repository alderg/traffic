/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Road elements of the traffic simulation in the editor. This script runs in
 * the window of the editor: TrafficRoads(ui) registers the road and
 * roundabout shapes, replaces the shape libraries of the given EditorUi with
 * palettes of junctions and roads, makes new connectors two-way roads and
 * connects road ends that are dropped on junctions. It returns functions to
 * read and change the type of junctions, the green time of traffic lights
 * and the lanes and direction of roads. The static functions of
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
 * A crossing is an ellipse or a traffic light. With roads connected, the
 * roads end as far from its center as its widest road is wide, traffic
 * lights 3 units farther for a small icon in the center, and the crossing
 * is painted as the asphalt between the ends of its roads, with rounded
 * corners and edge lines that continue the edges of the roads. The bounds
 * stay the area for selecting and connecting crossings. Junctions have no
 * fixed connection points, roads always connect to their outline.
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
		'strokeColor=none;fillColor=' + roads.asphalt + ';image=' + lightImage + ';imageWidth=7;imageHeight=15;' +
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
	 * that the asphalt joins them without notches. Ends in junctions other
	 * than crossings that are narrower than the road move to the center and
	 * are added to discs. Crossings paint the asphalt between the roads.
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
				var crossing = roads.getCrossingRadius(terminal);
				var r = (crossing != null) ? crossing :
					Math.min(terminal.width, terminal.height) / 2 / this.scale;
				var e = (crossing != null) ? 0.5 : ((h < r) ?
					Math.min(r, r - Math.sqrt(r * r - h * h) + 0.5) : r);
				var p0 = pts[(i == 0) ? 0 : n - 1];
				var p1 = pts[(i == 0) ? 1 : n - 2];
				var len = roads.getDistance(p0, p1);

				if (len > 0)
				{
					result[(i == 0) ? 0 : n - 1] = new mxPoint(p0.x + (p0.x - p1.x) / len * e,
						p0.y + (p0.y - p1.y) / len * e);

					if (h >= r && crossing == null)
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

		if (markColor != mxConstants.NONE)
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
	};

	mxCellRenderer.registerShape('roundabout', RoundaboutShape);

	/**
	 * Crossing states that were painted before their roads were updated.
	 */
	var pending = [];

	/**
	 * Returns the ends of the roads at the given crossing state in the
	 * coordinates of its shape, sorted by angle: the center of the end, the
	 * unit vector along the road and half the width of the road. Shapes in
	 * the draw pane are painted in model units, else in screen units divided
	 * by the scale.
	 */
	function getRoadEnds(state)
	{
		var view = state.view;
		var model = view.graph.model;
		var s = view.scale;
		var tx = (state.shape.isModelCoordinates()) ? 0 : view.translate.x;
		var ty = (state.shape.isModelCoordinates()) ? 0 : view.translate.y;
		var result = [];

		for (var i = 0; i < model.getEdgeCount(state.cell); i++)
		{
			var edgeState = view.getState(model.getEdgeAt(state.cell, i));

			if (edgeState != null && edgeState.style[mxConstants.STYLE_SHAPE] == 'road')
			{
				if (edgeState.invalid || edgeState.absolutePoints == null)
				{
					pending.push(state);
				}
				else
				{
					var source = edgeState.getVisibleTerminalState(true) == state;
					var path = roads.getPath(edgeState.cellPoints || edgeState.absolutePoints.map(function(p)
					{
						return (p != null) ? new mxPoint(p.x / s - view.translate.x, p.y / s - view.translate.y) : null;
					}), {});

					if (source != (edgeState.getVisibleTerminalState(false) == state) && path.length > 1)
					{
						var p0 = path[(source) ? 0 : path.length - 1];
						var p1 = path[(source) ? 1 : path.length - 2];
						var len = roads.getDistance(p0, p1);
						var dx = (p1.x - p0.x) / len;
						var dy = (p1.y - p0.y) / len;

						result.push({x: p0.x + tx, y: p0.y + ty, dx: dx, dy: dy,
							h: roads.getRoadWidth(edgeState.style) / 2, angle: Math.atan2(dy, dx)});
					}
				}
			}
		}

		result.sort(function(a, b)
		{
			return a.angle - b.angle;
		});

		return result;
	};

	/**
	 * Adds the corner from the right edge of road a to the left edge of the
	 * next road b at the given distance inside the edges to the path: a
	 * curve through the intersection of the edges, a line where the edges
	 * are in line or overlap, and a round end around a gap of half a turn or
	 * more.
	 */
	function addCorner(c, a, b, d, gap)
	{
		var ax = a.x - a.dy * (a.h - d);
		var ay = a.y + a.dx * (a.h - d);
		var bx = b.x + b.dy * (b.h - d);
		var by = b.y - b.dx * (b.h - d);
		var wx = ax - bx;
		var wy = ay - by;
		var dist = Math.sqrt(wx * wx + wy * wy);
		var det = a.dy * b.dx - a.dx * b.dy;
		var u = (Math.abs(det) > 1e-3) ? (wy * b.dx - wx * b.dy) / det : -1;
		var v = (Math.abs(det) > 1e-3) ? (a.dx * wy - a.dy * wx) / det : -1;

		if (u > 0 && v > 0 && u + v < 4 * (dist + a.h + b.h))
		{
			c.quadTo(ax - a.dx * u, ay - a.dy * u, bx, by);
		}
		else if (gap < Math.PI + 1e-3)
		{
			c.lineTo(bx, by);
		}
		else
		{
			var k = 0.66 * dist;
			c.curveTo(ax - a.dx * k, ay - a.dy * k, bx - b.dx * k, by - b.dy * k, bx, by);
		}
	};

	/**
	 * Paints a crossing with the given roads and keeps its bounds for
	 * events. Traffic lights get a small icon in the center.
	 */
	function paintCrossing(shape, c, x, y, w, h, ends)
	{
		var cx = x + w / 2;
		var cy = y + h / 2;
		var n = ends.length;
		var gaps = [];

		for (var i = 0; i < n; i++)
		{
			gaps.push((n == 1) ? 2 * Math.PI : ends[(i + 1) % n].angle - ends[i].angle +
				((i == n - 1) ? 2 * Math.PI : 0));
		}

		c.setShadow(false);
		c.setFillColor(mxConstants.NONE);
		c.setStrokeColor(mxConstants.NONE);
		c.ellipse(x, y, w, h);
		c.fillAndStroke();

		// Asphalt across the ends of the roads and around the corners
		c.setFillColor(getColor(shape, mxConstants.STYLE_FILLCOLOR, roads.asphalt));
		c.begin();
		c.moveTo(ends[0].x + ends[0].dy * ends[0].h, ends[0].y - ends[0].dx * ends[0].h);

		for (var i = 0; i < n; i++)
		{
			c.lineTo(ends[i].x - ends[i].dy * ends[i].h, ends[i].y + ends[i].dx * ends[i].h);
			addCorner(c, ends[i], ends[(i + 1) % n], 0, gaps[i]);
		}

		c.close();
		c.fill();

		// Edge lines of the roads around the corners
		var m = roads.laneWidth / 8;
		c.setStrokeColor(roads.marking);
		c.setStrokeWidth(0.8 * m);

		for (var i = 0; i < n; i++)
		{
			var a = ends[i];
			c.begin();
			c.moveTo(a.x - a.dy * (a.h - m), a.y + a.dx * (a.h - m));
			addCorner(c, a, ends[(i + 1) % n], m, gaps[i]);
			c.stroke();
		}

		if (roads.isLight(shape.style))
		{
			c.setFillColor(roads.iconColors[0]);
			c.setStrokeColor(roads.marking);
			c.setStrokeWidth(0.5);
			c.roundrect(cx - 3, cy - 6, 6, 12, 1.5, 1.5);
			c.fillAndStroke();

			for (var i = 0; i < 3; i++)
			{
				c.setFillColor(roads.iconColors[i + 1]);
				c.ellipse(cx - 1.35, cy - 4.85 + 3.5 * i, 2.7, 2.7);
				c.fill();
			}
		}
	};

	/**
	 * Repaints crossings that were painted before their roads were updated.
	 */
	var validate = graph.view.validate;

	graph.view.validate = function()
	{
		validate.apply(this, arguments);

		if (pending.length > 0)
		{
			var states = pending;
			pending = [];

			for (var i = 0; i < states.length; i++)
			{
				if (states[i].shape != null && this.getState(states[i].cell) == states[i])
				{
					graph.cellRenderer.redraw(states[i], true);
				}
			}
		}
	};

	function CrossingShape()
	{
		mxEllipse.call(this);
	};

	mxUtils.extend(CrossingShape, mxEllipse);

	/**
	 * Paints a crossing with roads, else an ellipse.
	 */
	CrossingShape.prototype.paintVertexShape = function(c, x, y, w, h)
	{
		var ends = (this.state != null && roads.getCrossingRadius(this.state) != null) ?
			getRoadEnds(this.state) : [];

		if (ends.length == 0)
		{
			mxEllipse.prototype.paintVertexShape.apply(this, arguments);
		}
		else
		{
			paintCrossing(this, c, x, y, w, h, ends);
		}
	};

	function LightShape()
	{
		mxLabel.call(this);
	};

	mxUtils.extend(LightShape, mxLabel);

	/**
	 * Paints a traffic light with roads, else the label with the image.
	 */
	LightShape.prototype.paintVertexShape = function(c, x, y, w, h)
	{
		var ends = (this.state != null && roads.getCrossingRadius(this.state) != null) ?
			getRoadEnds(this.state) : [];

		if (ends.length == 0)
		{
			mxLabel.prototype.paintVertexShape.apply(this, arguments);
		}
		else
		{
			paintCrossing(this, c, x, y, w, h, ends);
		}
	};

	var getShapeConstructor = graph.cellRenderer.getShapeConstructor;

	graph.cellRenderer.getShapeConstructor = function(state)
	{
		return (graph.model.isVertex(state.cell) && roads.isCrossing(state.style)) ?
			((state.style[mxConstants.STYLE_SHAPE] == mxConstants.SHAPE_LABEL) ? LightShape : CrossingShape) :
			getShapeConstructor.apply(this, arguments);
	};

	var getAllConnectionConstraints = graph.getAllConnectionConstraints;

	/**
	 * Junctions have no fixed connection points.
	 */
	graph.getAllConnectionConstraints = function(terminal, source)
	{
		return (terminal != null && roads.isJunction(terminal.style)) ? null :
			getAllConnectionConstraints.apply(this, arguments);
	};

	var getConnectionConstraintForPoint = graph.getConnectionConstraintForPoint;

	graph.getConnectionConstraintForPoint = function(state, x, y)
	{
		return (state != null && roads.isJunction(state.style)) ? null :
			getConnectionConstraintForPoint.apply(this, arguments);
	};

	var getOutlineConstraint = graph.getOutlineConstraint;

	graph.getOutlineConstraint = function(point, terminalState, me)
	{
		return (terminalState != null && roads.isJunction(terminalState.style)) ?
			new mxConnectionConstraint() : getOutlineConstraint.apply(this, arguments);
	};

	var getConnectionConstraint = graph.getConnectionConstraint;

	/**
	 * Roads connect to the outline of junctions, also with fixed connection
	 * points in their style.
	 */
	graph.getConnectionConstraint = function(edge, terminal, source)
	{
		return (terminal != null && roads.isJunction(terminal.style)) ?
			new mxConnectionConstraint() : getConnectionConstraint.apply(this, arguments);
	};

	var getPerimeterFunction = graph.view.getPerimeterFunction;

	/**
	 * Roads end at the asphalt of crossings.
	 */
	graph.view.getPerimeterFunction = function(state)
	{
		var r = roads.getCrossingRadius(state);

		if (r != null)
		{
			var s = this.scale;

			return function(bounds, vertex, next)
			{
				var cx = vertex.getCenterX();
				var cy = vertex.getCenterY();
				var d = (next != null) ? roads.getDistance(new mxPoint(cx, cy), next) : 0;

				return (d > 0) ? new mxPoint(cx + (next.x - cx) / d * r * s,
					cy + (next.y - cy) / d * r * s) : new mxPoint(cx + r * s, cy);
			};
		}

		return getPerimeterFunction.apply(this, arguments);
	};

	/**
	 * Updates junctions and their roads when roads are connected,
	 * disconnected, added, removed, moved or restyled, or junctions are moved
	 * or restyled, as crossings follow from their roads and roads paint stop
	 * and give-way lines for their junctions.
	 */
	graph.model.addListener(mxEvent.CHANGE, function(sender, evt)
	{
		var changes = evt.getProperty('edit').changes;
		var model = graph.model;
		var junctions = new Set();

		function add(cell)
		{
			if (cell != null && model.isVertex(cell))
			{
				junctions.add(cell);
			}
		};

		for (var i = 0; i < changes.length; i++)
		{
			var change = changes[i];
			var cell = (change instanceof mxChildChange) ? change.child : change.cell;

			if (change instanceof mxTerminalChange)
			{
				add(change.terminal);
				add(change.previous);
			}
			else if (cell != null && (change instanceof mxStyleChange || change instanceof mxChildChange ||
				change instanceof mxGeometryChange))
			{
				if (model.isEdge(cell))
				{
					add(cell.getTerminal(true));
					add(cell.getTerminal(false));
				}
				else if (!(change instanceof mxChildChange))
				{
					add(cell);

					// Directions of the roads at the other ends change
					for (var j = 0; change instanceof mxGeometryChange && j < model.getEdgeCount(cell); j++)
					{
						var edge = model.getEdgeAt(cell, j);
						add(model.getTerminal(edge, model.getTerminal(edge, true) != cell));
					}
				}
			}
		}

		var states = [];

		junctions.forEach(function(cell)
		{
			var state = graph.view.getState(cell);

			if (state != null)
			{
				graph.view.invalidate(cell, false, true);
				states.push(state);
			}
		});

		if (states.length > 0)
		{
			graph.view.validate();

			for (var i = 0; i < states.length; i++)
			{
				if (states[i].shape != null)
				{
					graph.cellRenderer.redraw(states[i], true);
				}

				for (var j = 0; j < model.getEdgeCount(states[i].cell); j++)
				{
					var edgeState = graph.view.getState(model.getEdgeAt(states[i].cell, j));

					if (edgeState != null && edgeState.shape != null)
					{
						graph.cellRenderer.redraw(edgeState, true);
					}
				}
			}
		}
	});

	// Junctions in the shape picker of the hover arrows and connectors
	ui.defaultShapePickerEntries = [
		{style: crossingStyle, width: 24, height: 24, keepStyle: true},
		{style: lightStyle, width: 24, height: 24, keepStyle: true},
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

	/**
	 * Returns the type of the given junction: crossing, light or roundabout.
	 */
	function getJunctionType(cell)
	{
		var style = graph.getCellStyle(cell);

		return (roads.isRoundabout(style)) ? 'roundabout' : ((roads.isLight(style)) ? 'light' : 'crossing');
	};

	return {
		getJunctionType: getJunctionType,

		/**
		 * Gives the given junctions the style of the given type, keeping their
		 * center and green time. Roundabouts are at least 60 units, other
		 * junctions that were roundabouts 24 units.
		 */
		setJunctionType: function(cells, type)
		{
			var model = graph.model;
			model.beginUpdate();
			try
			{
				for (var i = 0; i < cells.length; i++)
				{
					var cell = cells[i];
					var geo = model.getGeometry(cell);
					var current = getJunctionType(cell);

					if (model.isVertex(cell) && geo != null && current != type)
					{
						var green = parseInt(mxUtils.getValue(graph.getCellStyle(cell), 'trafficLight', 10)) || 10;
						var size = (type == 'roundabout') ? Math.max(60, geo.width, geo.height) :
							((current == 'roundabout') ? 24 : null);
						model.setStyle(cell, (type == 'roundabout') ? roundaboutStyle : ((type == 'light') ?
							lightStyle.replace('trafficLight=10;', 'trafficLight=' + green + ';') : crossingStyle));

						if (size != null)
						{
							geo = geo.clone();
							geo.x += (geo.width - size) / 2;
							geo.y += (geo.height - size) / 2;
							geo.width = size;
							geo.height = size;
							model.setGeometry(cell, geo);
						}
					}
				}
			}
			finally
			{
				model.endUpdate();
			}
		},

		/**
		 * Returns the steps of green of the given traffic light.
		 */
		getGreen: function(cell)
		{
			return parseInt(mxUtils.getValue(graph.getCellStyle(cell), 'trafficLight', 0)) || 0;
		},

		/**
		 * Sets the steps of green of the given traffic lights.
		 */
		setGreen: function(cells, steps)
		{
			graph.setCellStyles('trafficLight', steps, cells.filter(function(cell)
			{
				return getJunctionType(cell) == 'light';
			}));
		},

		/**
		 * Returns the lanes per direction and the direction of the given road,
		 * 1 for source to target, -1 for the opposite and 0 for both.
		 */
		getRoad: function(cell)
		{
			var style = graph.getCellStyle(cell);

			return {lanes: roads.getLanes(style), dir: roads.getDirection(style)};
		},

		/**
		 * Sets the lanes and the direction of the given connectors, which
		 * become roads. Null keeps the value of each road.
		 */
		setRoads: function(cells, lanes, dir)
		{
			var model = graph.model;
			model.beginUpdate();
			try
			{
				for (var i = 0; i < cells.length; i++)
				{
					if (model.isEdge(cells[i]))
					{
						var style = graph.getCellStyle(cells[i]);
						var l = (lanes != null) ? lanes : roads.getLanes(style);
						var d = (dir != null) ? dir : roads.getDirection(style);
						var values = {shape: 'road', lanes: l, endArrow: (d > 0) ? 'block' : 'none',
							startArrow: (d < 0) ? 'block' : 'none',
							strokeWidth: l * roads.getLaneWidth(style) * ((d == 0) ? 2 : 1)};

						for (var key in values)
						{
							graph.setCellStyles(key, values[key], [cells[i]]);
						}
					}
				}
			}
			finally
			{
				model.endUpdate();
			}
		}
	};
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

/**
 * Colors of the housing and the lamps of the traffic light icon.
 */
TrafficRoads.iconColors = ['light-dark(#202124,#202124)', 'light-dark(#a33a32,#a33a32)',
	'light-dark(#a88a2a,#a88a2a)', 'light-dark(#2f8046,#2f8046)'];

TrafficRoads.isLight = function(style)
{
	return style != null && mxUtils.getValue(style, 'trafficLight', 0) > 0;
};

/**
 * Returns true for crossings, which are ellipses and traffic lights.
 */
TrafficRoads.isCrossing = function(style)
{
	return style != null && (style[mxConstants.STYLE_SHAPE] == mxConstants.SHAPE_ELLIPSE ||
		(style[mxConstants.STYLE_SHAPE] == mxConstants.SHAPE_LABEL && TrafficRoads.isLight(style)));
};

/**
 * Returns the radius of the asphalt of the given crossing state, half the
 * width of its widest road, for traffic lights 3 units more and at least 10
 * so that the roads leave room for the icon, or null if it is no crossing
 * or has no roads.
 */
TrafficRoads.getCrossingRadius = function(state)
{
	var result = null;

	if (state != null && TrafficRoads.isCrossing(state.style))
	{
		var view = state.view;
		var model = view.graph.model;

		for (var i = 0; i < model.getEdgeCount(state.cell); i++)
		{
			var edge = model.getEdgeAt(state.cell, i);
			var edgeState = view.getState(edge);
			var style = (edgeState != null) ? edgeState.style : view.graph.getCellStyle(edge);

			if (style != null && style[mxConstants.STYLE_SHAPE] == 'road')
			{
				result = Math.max(result || 0, TrafficRoads.getRoadWidth(style) / 2);
			}
		}

		if (result != null && TrafficRoads.isLight(state.style))
		{
			result = Math.max(result + 3, 10);
		}
	}

	return result;
};

/**
 * Returns true for junctions: crossings, traffic lights and roundabouts.
 */
TrafficRoads.isJunction = function(style)
{
	return TrafficRoads.isCrossing(style) || TrafficRoads.isRoundabout(style);
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
