/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Road elements of the traffic simulation in the editor. This script runs in
 * the window of the editor: TrafficRoads(ui) registers the road shape,
 * replaces the shape libraries of the given EditorUi with a palette of road
 * elements and makes new connectors two-way roads.
 *
 * The road shape paints a connector as asphalt in its stroke color with
 * markings in its fill color: a dashed center line for a road in both
 * directions, arrows in the direction of travel for a one-way road. One
 * arrow is a one-way road, no or two arrows a road in both directions, as
 * in the simulation. Other draw.io apps paint it as a plain connector.
 *
 * The colors are light-dark pairs with the same color on both sides, so
 * that the dark mode of the editor does not invert them.
 */
window.TrafficRoads = function(ui)
{
	var graph = ui.editor.graph;
	var asphalt = 'light-dark(#5f6368,#5f6368)';
	var marking = 'light-dark(#ffffff,#ffffff)';

	var lightImage = 'data:image/svg+xml,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" ' +
		'width="10" height="22" viewBox="0 0 10 22">' +
		'<rect x="0.5" y="0.5" width="9" height="21" rx="2.5" fill="#202124" stroke="#ffffff"/>' +
		'<circle cx="5" cy="5" r="2.4" fill="#ea4335"/>' +
		'<circle cx="5" cy="11" r="2.4" fill="#fbbc04"/>' +
		'<circle cx="5" cy="17" r="2.4" fill="#34a853"/></svg>');

	var crossingStyle = 'ellipse;aspect=fixed;html=1;strokeColor=none;fillColor=' + asphalt + ';';
	var lightStyle = 'shape=label;rounded=1;arcSize=50;aspect=fixed;perimeter=ellipsePerimeter;html=1;' +
		'strokeColor=none;fillColor=' + asphalt + ';image=' + lightImage + ';imageWidth=10;imageHeight=22;' +
		'imageAlign=center;imageVerticalAlign=middle;trafficLight=10;';
	var roadStyle = 'shape=road;html=1;strokeColor=' + asphalt + ';fillColor=' + marking + ';';
	var oneWayStyle = roadStyle + 'endArrow=block;startArrow=none;strokeWidth=8;';
	var twoWayStyle = roadStyle + 'endArrow=none;startArrow=none;strokeWidth=14;';

	/**
	 * Returns 1 for a road from source to target, -1 for the opposite
	 * direction and 0 for both directions (see getDirection in simulation.js).
	 */
	function getDirection(style)
	{
		var end = mxUtils.getValue(style, mxConstants.STYLE_ENDARROW, mxConstants.NONE) != mxConstants.NONE;
		var start = mxUtils.getValue(style, mxConstants.STYLE_STARTARROW, mxConstants.NONE) != mxConstants.NONE;

		return (end == start) ? 0 : ((end) ? 1 : -1);
	};

	function RoadShape()
	{
		mxConnector.call(this);
	};

	mxUtils.extend(RoadShape, mxConnector);

	/**
	 * Returns the given points with the ends moved into the crossings by
	 * the depth of the gap between the end of the asphalt and a round
	 * crossing, so that roads join crossings without notches.
	 */
	RoadShape.prototype.extendEnds = function(pts, h)
	{
		var result = pts.slice();
		var n = pts.length;

		for (var i = 0; i < 2 && this.state != null && n > 1; i++)
		{
			var terminal = this.state.getVisibleTerminalState(i == 0);

			if (terminal != null)
			{
				var r = Math.min(terminal.width, terminal.height) / 2 / this.scale;
				var e = Math.min(r, (h < r) ? r - Math.sqrt(r * r - h * h) + 0.5 : r);
				var p0 = pts[(i == 0) ? 0 : n - 1];
				var p1 = pts[(i == 0) ? 1 : n - 2];
				var dx = p0.x - p1.x;
				var dy = p0.y - p1.y;
				var len = Math.sqrt(dx * dx + dy * dy);

				if (len > 0)
				{
					result[(i == 0) ? 0 : n - 1] = new mxPoint(p0.x + dx / len * e, p0.y + dy / len * e);
				}
			}
		}

		return result;
	};

	/**
	 * Paints the arrows of a one-way road along the given points, which are
	 * in the direction of travel.
	 */
	RoadShape.prototype.paintArrows = function(c, pts, w)
	{
		if (this.style[mxConstants.STYLE_CURVED] == 1 && Graph.edgeSupportsCurved(this.style))
		{
			pts = Graph.getCurvePoints(pts, this.style[mxConstants.STYLE_BEZIER] == 1);
		}

		var lengths = [0];

		for (var i = 1; i < pts.length; i++)
		{
			lengths.push(lengths[i - 1] + Math.sqrt(Math.pow(pts[i].x - pts[i - 1].x, 2) +
				Math.pow(pts[i].y - pts[i - 1].y, 2)));
		}

		var total = lengths[lengths.length - 1];
		var count = Math.max(1, Math.floor(total / (8 * w)));
		var j = 1;

		c.setDashed(false);
		c.setStrokeWidth(w / 8);
		c.setFillColor(this.markColor);

		for (var i = 0; i < count; i++)
		{
			var d = (i + 0.5) * total / count;

			while (j < lengths.length - 1 && lengths[j] < d)
			{
				j++;
			}

			var len = lengths[j] - lengths[j - 1];

			if (len > 0)
			{
				var ux = (pts[j].x - pts[j - 1].x) / len;
				var uy = (pts[j].y - pts[j - 1].y) / len;
				var x = pts[j - 1].x + ux * (d - lengths[j - 1]);
				var y = pts[j - 1].y + uy * (d - lengths[j - 1]);

				// Shaft behind and head in front of the center
				c.begin();
				c.moveTo(x - ux * 1.2 * w, y - uy * 1.2 * w);
				c.lineTo(x, y);
				c.stroke();

				c.begin();
				c.moveTo(x + ux * 0.8 * w, y + uy * 0.8 * w);
				c.lineTo(x - uy * 0.3 * w, y + ux * 0.3 * w);
				c.lineTo(x + uy * 0.3 * w, y - ux * 0.3 * w);
				c.close();
				c.fill();
			}
		}
	};

	/**
	 * Paints the asphalt and the markings instead of the line and markers.
	 */
	RoadShape.prototype.paintEdgeShape = function(c, pts)
	{
		var w = this.strokewidth;
		var dir = getDirection(this.style);
		this.markColor = mxUtils.getValue(this.style, mxConstants.STYLE_FILLCOLOR, '#ffffff');

		c.setLineJoin('round');
		c.setDashed(false);
		mxPolyline.prototype.paintEdgeShape.call(this, c, this.extendEnds(pts, w / 2));

		if (this.markColor != mxConstants.NONE && w >= 2)
		{
			c.setShadow(false);
			c.setStrokeColor(this.markColor);

			if (dir == 0)
			{
				c.setStrokeWidth(w / 14);
				c.setDashed(true, false);
				c.setDashPattern('8 6');
				mxPolyline.prototype.paintEdgeShape.call(this, c, pts);
			}
			else
			{
				this.paintArrows(c, (dir > 0) ? pts : pts.slice().reverse(), w);
			}
		}
	};

	mxCellRenderer.registerShape('road', RoadShape);

	/**
	 * Returns the palette entry for a road from left to right.
	 */
	function createRoadEntry(sidebar, style, width, height, title)
	{
		return function()
		{
			var cell = new mxCell('', new mxGeometry(0, 0, width, height), style);
			cell.geometry.setTerminalPoint(new mxPoint(0, height / 2), true);
			cell.geometry.setTerminalPoint(new mxPoint(width, height / 2), false);
			cell.geometry.relative = true;
			cell.edge = true;

			return sidebar.createEdgeTemplateFromCells([cell], width, height, title);
		};
	};

	/**
	 * Replaces the libraries with the palette of road elements, also in
	 * sidebars created later, eg. for other themes.
	 */
	Sidebar.prototype.init = function()
	{
		this.sidebarTitles = true;
		this.thumbWidth = 72;
		this.thumbHeight = 36;

		this.addPaletteFunctions('roads', 'Roads', true,
		[
			this.createVertexTemplateEntry(crossingStyle, 20, 20, '', 'Crossing', null, null, 'crossing'),
			createRoadEntry(this, twoWayStyle, 80, 14, 'Two-way road'),
			createRoadEntry(this, oneWayStyle, 80, 8, 'One-way road'),
			this.createVertexTemplateEntry(lightStyle, 28, 28, '', 'Traffic light', null, null, 'traffic light')
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

	/**
	 * Makes new connectors two-way roads, also after the default styles are
	 * reset for a new theme.
	 */
	function setDefaultEdgeStyle()
	{
		// Keeps the arrows with value none, which getCellStyle removes
		var pairs = twoWayStyle.split(';');
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

	// Paints roads of a diagram that was opened before the shape existed
	graph.refresh();
};
