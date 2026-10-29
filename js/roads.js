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
 * in the simulation. laneSpec lists each lane from left to right in the
 * drawn direction instead, as f (forward) or b (backward) followed by the
 * turns it allows at its end (l, s, r, all if none), eg. laneSpec=b,fl,fsr.
 * The stroke color is the asphalt and the fill color the markings: edge
 * lines, dashed lane dividers, a dashed center line (solid double line with
 * more lanes), arrows on the lanes of one-way roads, turn arrows before the
 * end of lanes with turns, stop lines at traffic lights and give-way lines
 * at roundabouts. Roads can be sharp, rounded or curved like connectors.
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
 * stay the area for selecting crossings. For connecting, crossings take
 * roads within connectPadding around their bounds, so that the small
 * crossings are easy to hit, without changing how they look. Junctions have
 * no fixed connection points, roads always connect to their outline.
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
	 * Paints the arrow of the given turns (l, s, r) on the lane along the
	 * given points, which are in the direction of travel, two lane widths
	 * before its end.
	 */
	RoadShape.prototype.paintTurnArrow = function(c, pts, turns, lw)
	{
		var lengths = roads.getLengths(pts);
		var total = lengths[lengths.length - 1];
		var p = roads.getPointAt(pts, lengths, (total > 5 * lw) ? total - 2 * lw : total / 2);

		// Point at u lane widths ahead and v to the right
		function at(u, v)
		{
			return new mxPoint(p.x + (p.dx * u - p.dy * v) * lw, p.y + (p.dy * u + p.dx * v) * lw);
		};

		function line(a, b)
		{
			c.begin();
			c.moveTo(a.x, a.y);
			c.lineTo(b.x, b.y);
			c.stroke();
		};

		function head(tip, b1, b2)
		{
			c.begin();
			c.moveTo(tip.x, tip.y);
			c.lineTo(b1.x, b1.y);
			c.lineTo(b2.x, b2.y);
			c.close();
			c.fill();
		};

		if (p != null)
		{
			var straight = turns.indexOf('s') >= 0;
			c.setStrokeWidth(lw / 8);
			line(at(-0.9, 0), at((straight) ? 0.35 : 0.1, 0));

			if (straight)
			{
				head(at(0.8, 0), at(0.35, -0.22), at(0.35, 0.22));
			}

			for (var side = -1; side <= 1; side += 2)
			{
				if (turns.indexOf((side < 0) ? 'l' : 'r') >= 0)
				{
					line(at(0.1, 0), at(0.1, side * 0.2));
					head(at(0.1, side * 0.47), at(-0.12, side * 0.2), at(0.32, side * 0.2));
				}
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
			var plan = roads.getLanePlan(style);
			var n = plan.length;
			var forward = roads.getTravelLanes(plan, 1, lw);
			var backward = roads.getTravelLanes(plan, -1, lw);
			c.setShadow(false);
			c.setStrokeColor(markColor);
			c.setFillColor(markColor);

			// Edge lines
			c.setStrokeWidth(0.8 * m);
			paintPath(c, roads.offsetPoints(path, w / 2 - m));
			paintPath(c, roads.offsetPoints(path, m - w / 2));

			// Dashed lane dividers in one direction, center lines between the
			// directions, dashed with one lane each, else solid and double
			c.setStrokeWidth(m);

			for (var k = 1; k < n; k++)
			{
				var offset = (k - n / 2) * lw;

				if (plan[k].dir == plan[k - 1].dir || (forward.length == 1 && backward.length == 1))
				{
					c.setDashed(true, true);
					c.setDashPattern('5 5');
					paintPath(c, roads.offsetPoints(path, offset));
				}
				else
				{
					c.setDashed(false);
					paintPath(c, roads.offsetPoints(path, offset + 0.8 * m));
					paintPath(c, roads.offsetPoints(path, offset - 0.8 * m));
				}
			}

			// Arrows on the lanes of one-way roads and turn arrows before the
			// end of lanes with turns
			c.setDashed(false);

			for (var d = -1; d <= 1; d += 2)
			{
				var lanes = (d > 0) ? forward : backward;
				var travel = (d > 0) ? path : path.slice().reverse();

				for (var k = 0; k < lanes.length; k++)
				{
					var pts = roads.offsetPoints(travel, lanes[k].offset);

					if (dir != 0)
					{
						this.paintArrows(c, pts, lw);
					}

					if (lanes[k].turns != null)
					{
						this.paintTurnArrow(c, pts, lanes[k].turns, lw);
					}
				}
			}

			// Stop and give-way lines across the incoming lanes
			for (var i = 0; i < 2; i++)
			{
				var source = i == 0;
				var terminal = this.getTerminal(source);
				var giveWay = terminal != null && roads.isRoundabout(terminal.style);
				var lanes = (source) ? backward : forward;

				for (var k = 0; k < lanes.length && (giveWay || (terminal != null && roads.isLight(terminal.style))); k++)
				{
					this.paintEndLine(c, path, source, Math.max(lanes[k].offset - lw / 2, m - w / 2),
						Math.min(lanes[k].offset + lw / 2, w / 2 - m), m, giveWay);
				}
			}
		}

		c.pointerEventsValue = prev;
	};

	mxCellRenderer.registerShape('road', RoadShape);

	// Roads can be curved and rounded like connectors, in the format panel,
	// the waypoints menu and the inline toolbar
	var edgeSupportsCurved = Graph.edgeSupportsCurved;

	Graph.edgeSupportsCurved = function(style)
	{
		return mxUtils.getValue(style, mxConstants.STYLE_SHAPE, null) == 'road' ||
			edgeSupportsCurved.apply(this, arguments);
	};

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
			var r = ring.outer - 1 - k * ring.laneWidth;
			c.ellipse(cx - r, cy - r, 2 * r, 2 * r);
			c.stroke();
		}

		// Counterclockwise arrows on the outer lane of the ring
		c.setDashed(false);
		var r = ring.radii[0];
		var s = Math.min(ring.laneWidth, r * 0.35);

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

	graph.view.validate = roads.guard(function()
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
	}, 'repaint crossings');

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

	/**
	 * Connections to the outline of junctions are floating. Null instead of a
	 * constraint without a point, which handlers read the point of, eg. the
	 * hint of mxEdgeHandler while a road end is dragged over a junction.
	 */
	graph.getOutlineConstraint = function(point, terminalState, me)
	{
		return (terminalState != null && roads.isJunction(terminalState.style)) ?
			null : getOutlineConstraint.apply(this, arguments);
	};

	var getConnectionConstraint = graph.getConnectionConstraint;

	/**
	 * Roads connect to the outline of junctions, also with fixed connection
	 * points in their style.
	 */
	graph.getConnectionConstraint = function(edge, terminal, source)
	{
		return (terminal != null && roads.isJunction(terminal.style)) ?
			new mxConnectionConstraint(null, false) : getConnectionConstraint.apply(this, arguments);
	};

	/**
	 * Returns true if the given point in screen coordinates is within the
	 * bounds of the given state grown by connectPadding.
	 */
	function isNear(state, x, y)
	{
		var pad = roads.connectPadding * state.view.scale;

		return x >= state.x - pad && x <= state.x + state.width + pad &&
			y >= state.y - pad && y <= state.y + state.height + pad;
	};

	/**
	 * Returns the cell of the crossing near the given point in screen
	 * coordinates, the nearest if there are several, other than the given
	 * cell, or null.
	 */
	function findCrossingAt(x, y, ignore)
	{
		var result = null;
		var best = Infinity;

		graph.view.states.visit(function(key, state)
		{
			if (state.cell != ignore && graph.model.isVertex(state.cell) &&
				roads.isCrossing(state.style) && isNear(state, x, y))
			{
				var d = Math.abs(state.getCenterX() - x) + Math.abs(state.getCenterY() - y);

				if (d < best)
				{
					best = d;
					result = state.cell;
				}
			}
		});

		return result;
	};

	/**
	 * Lets the given marker of a handler that connects roads find crossings
	 * near the mouse, also over roads, except the cell that the given
	 * function returns, while the given function returns true.
	 */
	function padMarker(marker, getIgnored, isConnecting)
	{
		var getCell = marker.getCell;
		var intersects = marker.intersects;

		marker.getCell = function(me)
		{
			var cell = getCell.apply(this, arguments);

			return ((cell == null || !graph.model.isVertex(cell)) && isConnecting()) ?
				(findCrossingAt(me.getGraphX(), me.getGraphY(), getIgnored()) || cell) : cell;
		};

		marker.intersects = function(state, me)
		{
			return (roads.isCrossing(state.style) && isConnecting()) ?
				isNear(state, me.getGraphX(), me.getGraphY()) : intersects.apply(this, arguments);
		};
	};

	// New roads from the arrows of junctions, not back to their own junction,
	// only while connecting, as the marker finds the source of a click too
	padMarker(graph.connectionHandler.marker, function()
	{
		var source = graph.connectionHandler.previous;

		return (source != null) ? source.cell : null;
	}, function()
	{
		return graph.connectionHandler.isConnecting();
	});

	var updateCurrentState = graph.connectionHandler.updateCurrentState;

	/**
	 * Keeps the crossing near the mouse as the target, which outline connect
	 * drops if the mouse is not over it.
	 */
	graph.connectionHandler.updateCurrentState = function(me, point)
	{
		updateCurrentState.apply(this, arguments);
		var state = this.marker.getValidState();

		if (this.currentState == null && this.error == null && this.isConnecting() && state != null &&
			roads.isCrossing(state.style) && isNear(state, me.getGraphX(), me.getGraphY()))
		{
			this.currentState = state;

			if (this.marker.highlight != null && this.marker.highlight.shape != null)
			{
				this.marker.highlight.shape.stroke = mxConstants.DEFAULT_VALID_COLOR;
				this.marker.highlight.repaint();
			}
		}
	};

	// Ends of roads that are dragged, not to the junction at their other end
	var createMarker = mxEdgeHandler.prototype.createMarker;

	mxEdgeHandler.prototype.createMarker = function()
	{
		var marker = createMarker.apply(this, arguments);
		var handler = this;

		padMarker(marker, function()
		{
			var other = handler.state.getVisibleTerminalState(!handler.isSource);

			return (other != null) ? other.cell : null;
		}, function()
		{
			return handler.isSource || handler.isTarget;
		});

		return marker;
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
	graph.model.addListener(mxEvent.CHANGE, roads.guard(function(sender, evt)
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
	}, 'update junctions'));

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

	graph.addListener(mxEvent.CELLS_ADDED, roads.guard(function(sender, evt)
	{
		connectEnds(evt.getProperty('cells'));
	}, 'connect added roads'));

	graph.addListener(mxEvent.CELLS_MOVED, roads.guard(function(sender, evt)
	{
		connectEnds(evt.getProperty('cells'));
	}, 'connect moved roads'));

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
		 * Returns the most lanes per direction, the direction of the given road,
		 * 1 for source to target, -1 for the opposite and 0 for both, and its
		 * lanes from left to right (see TrafficRoads.getLanePlan).
		 */
		getRoad: function(cell)
		{
			var style = graph.getCellStyle(cell);
			var plan = roads.getLanePlan(style);

			return {lanes: Math.max(roads.getTravelLanes(plan, 1, 1).length,
				roads.getTravelLanes(plan, -1, 1).length), dir: roads.getDirection(style), plan: plan};
		},

		/**
		 * Gives the given connector, which becomes a road, the given lanes
		 * from left to right with direction (1 or -1) and turns (null for all).
		 * The arrows, the lanes per direction and the stroke width follow, so
		 * that other apps paint roads of the right width and direction.
		 */
		setLanePlan: function(cell, plan)
		{
			var style = graph.getCellStyle(cell);
			var f = roads.getTravelLanes(plan, 1, 1).length;
			var b = roads.getTravelLanes(plan, -1, 1).length;
			var values = {shape: 'road', laneSpec: roads.getLaneSpec(plan), lanes: Math.max(f, b),
				endArrow: (b == 0) ? 'block' : 'none', startArrow: (f == 0) ? 'block' : 'none',
				strokeWidth: plan.length * roads.getLaneWidth(style)};

			graph.model.beginUpdate();
			try
			{
				for (var key in values)
				{
					graph.setCellStyles(key, values[key], [cell]);
				}
			}
			finally
			{
				graph.model.endUpdate();
			}
		},

		/**
		 * Returns the lanes of the ring of the given roundabout.
		 */
		getRingLanes: function(cell)
		{
			return Math.min(3, roads.getLanes(graph.getCellStyle(cell)));
		},

		/**
		 * Sets the lanes of the rings of the given roundabouts.
		 */
		setRingLanes: function(cells, lanes)
		{
			graph.setCellStyles('lanes', lanes, cells.filter(function(cell)
			{
				return getJunctionType(cell) == 'roundabout';
			}));
		},

		/**
		 * Sets the lanes and the direction of the given connectors, which
		 * become roads with the same lanes in each direction and all turns.
		 * Null keeps the value of each road.
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
						var l = (lanes != null) ? lanes : this.getRoad(cells[i]).lanes;
						var d = (dir != null) ? dir : roads.getDirection(style);
						var values = {shape: 'road', lanes: l, laneSpec: null, endArrow: (d > 0) ? 'block' : 'none',
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
 * Function that is called with errors and the name of the function that
 * threw them in functions wrapped with guard, eg. to log them with stack.
 */
TrafficRoads.onError = null;

/**
 * Returns the given function wrapped so that its errors are passed to
 * onError with the given name before they are thrown again.
 */
TrafficRoads.guard = function(fn, name)
{
	return function()
	{
		try
		{
			return fn.apply(this, arguments);
		}
		catch (e)
		{
			if (TrafficRoads.onError != null)
			{
				TrafficRoads.onError(e, name);
			}

			throw e;
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
 * Distance in units around the bounds of crossings within which ends of
 * roads connect to them when they are dragged or dropped.
 */
TrafficRoads.connectPadding = 8;

/**
 * Distance in units within which the free end of a road joins a junction.
 */
TrafficRoads.snapDistance = 8;

/**
 * Returns 1 for arrows from source to target, -1 for the opposite
 * direction and 0 for no or two arrows.
 */
TrafficRoads.getArrowDirection = function(style)
{
	var end = mxUtils.getValue(style, mxConstants.STYLE_ENDARROW, mxConstants.NONE) != mxConstants.NONE;
	var start = mxUtils.getValue(style, mxConstants.STYLE_STARTARROW, mxConstants.NONE) != mxConstants.NONE;

	return (end == start) ? 0 : ((end) ? 1 : -1);
};

/**
 * Returns 1 for a road from source to target, -1 for the opposite
 * direction and 0 for both directions.
 */
TrafficRoads.getDirection = function(style)
{
	var plan = TrafficRoads.getLanePlan(style);
	var f = false;
	var b = false;

	for (var i = 0; i < plan.length; i++)
	{
		f = f || plan[i].dir > 0;
		b = b || plan[i].dir < 0;
	}

	return (f == b) ? 0 : ((f) ? 1 : -1);
};

/**
 * Returns the lanes of the given road from left to right in the drawn
 * direction, at most 8, with dir 1 for lanes from source to target and -1
 * for the opposite and turns, the turns they allow at their end (l, s, r)
 * or null for all. They come from laneSpec, else lanes=<n> per direction
 * of the arrows.
 */
TrafficRoads.getLanePlan = function(style)
{
	var spec = mxUtils.getValue(style, 'laneSpec', null);
	var result = [];

	if (spec != null)
	{
		var tokens = String(spec).toLowerCase().split(',');

		for (var i = 0; i < tokens.length && result.length < 8; i++)
		{
			var t = tokens[i].trim();
			var turns = '';

			for (var j = 0; j < 3; j++)
			{
				if (t.indexOf('lsr'.charAt(j), 1) > 0)
				{
					turns += 'lsr'.charAt(j);
				}
			}

			if (t.charAt(0) == 'f' || t.charAt(0) == 'b')
			{
				result.push({dir: (t.charAt(0) == 'f') ? 1 : -1,
					turns: (turns.length == 0 || turns.length == 3) ? null : turns});
			}
		}
	}

	if (result.length == 0)
	{
		var lanes = TrafficRoads.getLanes(style);
		var dir = TrafficRoads.getArrowDirection(style);

		for (var i = 0; i < 2 * lanes; i++)
		{
			if ((i < lanes) ? dir <= 0 : dir >= 0)
			{
				result.push({dir: (i < lanes) ? -1 : 1, turns: null});
			}
		}
	}

	return result;
};

/**
 * Returns the laneSpec of the given lanes.
 */
TrafficRoads.getLaneSpec = function(plan)
{
	return plan.map(function(lane)
	{
		return ((lane.dir > 0) ? 'f' : 'b') + (lane.turns || '');
	}).join(',');
};

/**
 * Returns the lanes of the given lanes from left to right for travel in the
 * given direction, with the offset of their center to the right of travel
 * for the given lane width, their turns and their index in the road.
 */
TrafficRoads.getTravelLanes = function(plan, dir, lw)
{
	var n = plan.length;
	var result = [];

	for (var i = 0; i < n; i++)
	{
		var j = (dir > 0) ? i : n - 1 - i;

		if (plan[j].dir == dir)
		{
			result.push({index: j, turns: plan[j].turns, offset: dir * (j + 0.5 - n / 2) * lw});
		}
	}

	return result;
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
	return TrafficRoads.getLanePlan(style).length * TrafficRoads.getLaneWidth(style);
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
 * island and center of the ring, the number and width of its lanes, at
 * most 3, and the radii of the centers of the lanes from the outside in.
 */
TrafficRoads.getRing = function(style, w, h)
{
	var outer = Math.min(w, h) / 2;
	var lanes = Math.min(3, TrafficRoads.getLanes(style));
	var width = Math.min(lanes * TrafficRoads.getLaneWidth(style) + 2, outer * 0.6);
	var lw = Math.max(1, (width - 2) / lanes);
	var radii = [];

	for (var k = 0; k < lanes; k++)
	{
		radii.push(outer - 1 - (k + 0.5) * lw);
	}

	return {outer: outer, inner: outer - width, center: outer - width / 2, lanes: lanes,
		laneWidth: lw, radii: radii};
};

/**
 * Returns the points of the painted line of an edge with the given style
 * and points, along the curve for curved edges and around the corners for
 * rounded edges, without repeated points.
 */
TrafficRoads.getPath = function(pts, style)
{
	function unique(pts)
	{
		var result = [];

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

	var result = unique(pts);
	var shape = mxUtils.getValue(style, mxConstants.STYLE_SHAPE, null);

	if (result.length > 2 && (shape == 'road' || Graph.edgeSupportsCurved(style)))
	{
		if (style[mxConstants.STYLE_CURVED] == 1 || style[mxConstants.STYLE_BEZIER] == 1)
		{
			result = unique(Graph.getCurvePoints(result, style[mxConstants.STYLE_BEZIER] == 1));
		}
		else if (style[mxConstants.STYLE_ROUNDED] == 1 && (shape == null ||
			shape == 'road' || shape == mxConstants.SHAPE_CONNECTOR))
		{
			result = unique(TrafficRoads.getRoundedPoints(result, TrafficRoads.getArcSize(style)));
		}
	}

	return result;
};

/**
 * Returns the distance from the corners where rounded corners of edges
 * with the given style start, as in mxPolyline, and at least the width of
 * roads, so that their lanes have curves.
 */
TrafficRoads.getArcSize = function(style)
{
	var arc = parseFloat(mxUtils.getValue(style, mxConstants.STYLE_ARCSIZE, mxConstants.LINE_ARCSIZE)) / 2;
	arc = (isNaN(arc)) ? mxConstants.LINE_ARCSIZE / 2 : arc;

	return (mxUtils.getValue(style, mxConstants.STYLE_SHAPE, null) == 'road') ?
		Math.max(arc, TrafficRoads.getRoadWidth(style)) : arc;
};

/**
 * Returns the given points with the corners replaced by points along
 * quadratic curves that start the given distance before the corners, as
 * mxShape.addPoints paints them.
 */
TrafficRoads.getRoundedPoints = function(pts, arc)
{
	var steps = 16;
	var result = [pts[0]];
	var pt = pts[0];

	for (var i = 1; i < pts.length - 1; i++)
	{
		var tmp = pts[i];
		var next = pts[i + 1];
		var d0 = TrafficRoads.getDistance(pt, tmp);
		var d1 = TrafficRoads.getDistance(tmp, next);
		var a0 = Math.min(arc, d0 / 2) / d0;
		var a1 = Math.min(arc, d1 / 2) / d1;
		var p0 = new mxPoint(tmp.x + (pt.x - tmp.x) * a0, tmp.y + (pt.y - tmp.y) * a0);
		var p1 = new mxPoint(tmp.x + (next.x - tmp.x) * a1, tmp.y + (next.y - tmp.y) * a1);
		result.push(p0);

		for (var t = 1; t <= steps; t++)
		{
			var u = t / steps;
			var iu = 1 - u;
			result.push(new mxPoint(iu * iu * p0.x + 2 * iu * u * tmp.x + u * u * p1.x,
				iu * iu * p0.y + 2 * iu * u * tmp.y + u * u * p1.y));
		}

		pt = p1;
	}

	result.push(pts[pts.length - 1]);

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
