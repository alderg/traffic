/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Traffic simulation on a draw.io diagram, a port of sim.traffic (Gaudenz
 * Alder, ETH Zurich, 2000).
 *
 * Connectors are roads and the shapes they connect are crossings. A
 * connector with one arrow is a one-way road in the direction of the arrow,
 * one with no or two arrows a road in both directions with a lane on the
 * right of each direction. Each lane is a link of cells of 7.5 units (1 unit
 * is 1 m, 1 step is 1 s) with the Nagel-Schreckenberg update: accelerate,
 * brake to the gap, dawdle, move. Crossings let one car per step pass and
 * take the incoming links in turns. A shape with trafficLight=<steps> in its
 * style gives green to the links of one approach axis at a time. Cars drive
 * from a random crossing to another on the fastest route under the current
 * speeds and look for another route after waiting at a crossing.
 *
 * Cars are painted into the overlay pane. The simulation never changes the
 * diagram, only importFile inserts cells. This script runs in the window of
 * the editor: TrafficSimulation(ui, listener) attaches the simulation to the
 * graph of the given EditorUi and calls listener with the lines of the
 * statistics and the running state.
 */
window.TrafficSimulation = function(ui, listener)
{
	var graph = ui.editor.graph;
	var cellLength = 7.5;
	var replanSteps = 60;
	var maxStepsPerFrame = 100;
	var maxFrameTime = 40;
	var maxNewCarsPerStep = 10;
	var maxLinkCells = 10000;
	var maxNetworkCells = 5000000;
	var maxImportCells = 50000;
	var maxImportSize = 20 * 1024 * 1024;
	var maxImportExtent = 1e6;
	var carColors = ['#e53935', '#1e88e5', '#43a047', '#8e24aa', '#fdd835', '#fb8c00'];
	var config = {cars: 60, speed: 10, vmax: 5, noise: 0.25, reroute: true, density: true};

	var crossingStyle = 'ellipse;html=1;aspect=fixed;';
	var oneWayStyle = 'endArrow=block;endFill=1;endSize=4;html=1;strokeWidth=2;';
	var twoWayStyle = 'endArrow=none;html=1;strokeWidth=2;';

	var net = null;
	var sim = null;
	var overlay = null;
	var running = false;
	var dirty = false;
	var frameId = null;
	var lastStep = 0;
	var lastStats = 0;

	/**
	 * One direction of a road: a row of cells from one crossing to another.
	 */
	function Link(key, from, to, points)
	{
		this.key = key;
		this.from = from;
		this.to = to;
		this.points = points;
		this.lengths = [0];

		for (var i = 1; i < points.length; i++)
		{
			this.lengths.push(this.lengths[i - 1] + getDistance(points[i - 1], points[i]));
		}

		this.length = this.lengths[this.lengths.length - 1];
		this.cells = [];

		for (var i = Math.min(maxLinkCells, Math.max(2, Math.round(this.length / cellLength))); i > 0; i--)
		{
			this.cells.push(null);
		}

		this.out = this.cells.length - 1;
		this.queue = [];
		this.vehicles = 0;
		this.vavg = 0;
		this.merged = false;
		this.node = null;
		this.hue = null;
	};

	/**
	 * Returns true if a car can enter the link from the crossing. Through
	 * traffic and cars that start on the link take turns.
	 */
	Link.prototype.accept = function()
	{
		return this.cells[0] == null && (this.queue.length == 0 || this.merged);
	};

	/**
	 * Puts the given car into the first cell.
	 */
	Link.prototype.enter = function(v)
	{
		this.vehicles++;
		this.cells[0] = v;
		v.link = this;
		v.cell = 0;
		v.wait = 0;
		v.index++;
		this.merged = false;
	};

	/**
	 * Removes and returns the car in the last cell.
	 */
	Link.prototype.pop = function()
	{
		var v = this.cells[this.out];
		this.cells[this.out] = null;
		this.vehicles--;

		return v;
	};

	/**
	 * Returns the expected steps to drive through the link at the current
	 * speed. Empty links are free flow (the Java version used one cell per
	 * step, which made empty links slower than busy ones).
	 */
	Link.prototype.getCost = function()
	{
		var v = (this.vehicles == 0) ? config.vmax : Math.max(this.vavg, 1 / (this.out + 1));

		return this.out / v;
	};

	/**
	 * Returns the distance of the center of the given cell along the link.
	 */
	Link.prototype.getCellDistance = function(cell)
	{
		return (cell + 0.5) * this.length / this.cells.length;
	};

	/**
	 * Returns the point at the given distance along the link.
	 */
	Link.prototype.getPoint = function(d)
	{
		var i = 1;

		while (i < this.lengths.length - 1 && this.lengths[i] < d)
		{
			i++;
		}

		var p0 = this.points[i - 1];
		var p1 = this.points[i];
		var len = this.lengths[i] - this.lengths[i - 1];
		var f = (len > 0) ? Math.max(0, Math.min(1, (d - this.lengths[i - 1]) / len)) : 0;

		return new mxPoint(p0.x + (p1.x - p0.x) * f, p0.y + (p1.y - p0.y) * f);
	};

	/**
	 * Nagel-Schreckenberg update of the cars in the link.
	 */
	Link.prototype.step = function()
	{
		var cells = this.cells;
		var out = this.out;

		if (this.vehicles == 0 && this.queue.length == 0)
		{
			return;
		}

		// Cars enter traffic at the start of their first link
		if (cells[0] == null && this.queue.length > 0)
		{
			var first = this.queue.shift();
			addActive(first);
			this.enter(first);
			this.merged = true;
		}

		var vmax = config.vmax;
		var noise = config.noise;

		// Accelerates, brakes to the gap and dawdles
		for (var i = 0; i <= out; i++)
		{
			var v = cells[i];

			if (v != null)
			{
				var gap = 0;

				while (gap < vmax && i + gap < out && cells[i + gap + 1] == null)
				{
					gap++;
				}

				v.v = Math.min(gap, vmax, v.v + 1);

				if (v.v > 0 && Math.random() < noise)
				{
					v.v--;
				}
			}
		}

		// Moves from the front so that no car moves twice
		var moved = 0;

		for (var j = out; j >= 0; j--)
		{
			var car = cells[j];

			if (car != null && car.v > 0)
			{
				cells[j] = null;
				cells[j + car.v] = car;
				car.cell = j + car.v;
				car.driven += car.v;
				moved += car.v;
			}
		}

		this.vavg = (this.vehicles > 0) ? moved / this.vehicles : 0;
		var top = cells[out];

		if (top != null)
		{
			if (top.next() == null)
			{
				park(this.pop());
			}
			else if (config.reroute && ++top.wait % replanSteps == 0 && replan(top))
			{
				sim.replanned++;
			}
		}
	};

	/**
	 * Crossing of the links that end and start at a shape.
	 */
	function Crossing(id, x, y, light)
	{
		this.id = id;
		this.x = x;
		this.y = y;
		this.light = light;
		this.index = 0;
		this.fanIn = [];
		this.fanOut = [];
		this.phases = null;
		this.phase = 0;
		this.counter = 0;
		this.finger = 0;
		this.lightNodes = null;
	};

	/**
	 * Lets the first car that can enter its next link pass, taking the
	 * incoming links with green in turns.
	 */
	Crossing.prototype.step = function()
	{
		if (this.phases != null && ++this.counter >= this.light)
		{
			this.counter = 0;
			this.phase = (this.phase + 1) % this.phases.length;
			this.finger = 0;
		}

		var green = (this.phases != null) ? this.phases[this.phase] : this.fanIn;

		for (var i = 0; i < green.length; i++)
		{
			var link = green[(this.finger + i) % green.length];
			var v = link.cells[link.out];
			var next = (v != null) ? v.next() : null;

			if (next != null && next.from == this && next.accept())
			{
				next.enter(link.pop());
				this.finger = (this.finger + i + 1) % green.length;

				break;
			}
		}
	};

	/**
	 * Car with a route of links.
	 */
	function Vehicle(id, route, time)
	{
		this.id = id;
		this.route = route;
		this.index = 0;
		this.dest = route[route.length - 1].to;
		this.start = time;
		this.link = null;
		this.cell = 0;
		this.v = 0;
		this.wait = 0;
		this.driven = 0;
		this.prevLink = null;
		this.prevCell = 0;
		this.color = carColors[id % carColors.length];
		this.node = null;
	};

	/**
	 * Returns the link after the current one or null at the end of the route.
	 */
	Vehicle.prototype.next = function()
	{
		return (this.index < this.route.length) ? this.route[this.index] : null;
	};

	/**
	 * Binary heap of crossings for the shortest paths.
	 */
	function Heap()
	{
		this.keys = [];
		this.values = [];
	};

	Heap.prototype.push = function(key, value)
	{
		var i = this.keys.length;
		this.keys.push(key);
		this.values.push(value);

		while (i > 0)
		{
			var p = (i - 1) >> 1;

			if (this.keys[p] <= key)
			{
				break;
			}

			this.keys[i] = this.keys[p];
			this.values[i] = this.values[p];
			i = p;
		}

		this.keys[i] = key;
		this.values[i] = value;
	};

	Heap.prototype.pop = function()
	{
		var result = {key: this.keys[0], value: this.values[0]};
		var key = this.keys.pop();
		var value = this.values.pop();
		var n = this.keys.length;

		if (n > 0)
		{
			var i = 0;

			while (true)
			{
				var c = 2 * i + 1;

				if (c >= n)
				{
					break;
				}

				if (c + 1 < n && this.keys[c + 1] < this.keys[c])
				{
					c++;
				}

				if (this.keys[c] >= key)
				{
					break;
				}

				this.keys[i] = this.keys[c];
				this.values[i] = this.values[c];
				i = c;
			}

			this.keys[i] = key;
			this.values[i] = value;
		}

		return result;
	};

	/**
	 * Returns the links of the fastest route from start to end under the
	 * current speeds or null if there is none (Dijkstra).
	 */
	function getShortestPath(start, end)
	{
		if (start == end)
		{
			return null;
		}

		// Reuses the arrays of the network, entries of other searches are stale
		if (net.stamps == null)
		{
			net.dist = new Float64Array(net.crossings.length);
			net.prev = new Array(net.crossings.length);
			net.stamps = new Uint32Array(net.crossings.length);
		}

		var search = ++net.search;
		var dist = net.dist;
		var prev = net.prev;
		var stamps = net.stamps;
		var heap = new Heap();
		dist[start.index] = 0;
		stamps[start.index] = search;
		heap.push(0, start);

		while (heap.keys.length > 0)
		{
			var top = heap.pop();
			var c = top.value;

			if (top.key > dist[c.index])
			{
				continue;
			}

			if (c == end)
			{
				var path = [];

				while (c != start)
				{
					path.push(prev[c.index]);
					c = prev[c.index].from;
				}

				return path.reverse();
			}

			for (var j = 0; j < c.fanOut.length; j++)
			{
				var link = c.fanOut[j];
				var d = top.key + link.getCost();
				var k = link.to.index;

				if (stamps[k] != search || d < dist[k])
				{
					stamps[k] = search;
					dist[k] = d;
					prev[k] = link;
					heap.push(d, link.to);
				}
			}
		}

		return null;
	};

	function getDistance(p0, p1)
	{
		var dx = p1.x - p0.x;
		var dy = p1.y - p0.y;

		return Math.sqrt(dx * dx + dy * dy);
	};

	/**
	 * Returns 1 for a road from source to target, -1 for the opposite
	 * direction and 0 for both directions.
	 */
	function getDirection(style)
	{
		var end = mxUtils.getValue(style, mxConstants.STYLE_ENDARROW, mxConstants.NONE) != mxConstants.NONE;
		var start = mxUtils.getValue(style, mxConstants.STYLE_STARTARROW, mxConstants.NONE) != mxConstants.NONE;

		return (end == start) ? 0 : ((end) ? 1 : -1);
	};

	/**
	 * Returns the points of the given edge state in model coordinates, along
	 * the painted curve for curved edges.
	 */
	function getModelPoints(state)
	{
		// Fields in model units if the view paints in model coordinates
		var pts = (state.cellPoints != null) ? state.cellPoints : state.absolutePoints;
		var s = (state.cellPoints != null) ? 1 : graph.view.scale;
		var t = (state.cellPoints != null) ? new mxPoint() : graph.view.translate;
		var style = state.style;
		var model = [];

		for (var i = 0; i < pts.length; i++)
		{
			if (pts[i] != null)
			{
				model.push(new mxPoint(pts[i].x / s - t.x, pts[i].y / s - t.y));
			}
		}

		if ((style[mxConstants.STYLE_CURVED] == 1 || style[mxConstants.STYLE_BEZIER] == 1) &&
			Graph.edgeSupportsCurved(style))
		{
			model = Graph.getCurvePoints(model, style[mxConstants.STYLE_BEZIER] == 1);
		}

		var result = [];

		for (var i = 0; i < model.length; i++)
		{
			if (result.length == 0 || getDistance(result[result.length - 1], model[i]) > 0.01)
			{
				result.push(model[i]);
			}
		}

		return result;
	};

	/**
	 * Returns the center of the given vertex state in model coordinates.
	 */
	function getModelCenter(state)
	{
		var b = state.cellBounds;

		return (b != null) ? new mxPoint(b.getCenterX(), b.getCenterY()) :
			new mxPoint(state.getCenterX() / graph.view.scale - graph.view.translate.x,
				state.getCenterY() / graph.view.scale - graph.view.translate.y);
	};

	/**
	 * Returns the given points moved by d to the right of the direction of
	 * travel (right-hand traffic, y down).
	 */
	function offsetPoints(pts, d)
	{
		var result = [];

		for (var i = 0; i < pts.length; i++)
		{
			var nx = 0;
			var ny = 0;

			for (var j = Math.max(1, i); j <= Math.min(i + 1, pts.length - 1); j++)
			{
				var len = getDistance(pts[j - 1], pts[j]);
				nx -= (pts[j].y - pts[j - 1].y) / len;
				ny += (pts[j].x - pts[j - 1].x) / len;
			}

			// Miter at bends, normal at the ends
			var f = (i > 0 && i < pts.length - 1) ?
				2 * d / Math.max(nx * nx + ny * ny, 0.5) : d;
			result.push(new mxPoint(pts[i].x + nx * f, pts[i].y + ny * f));
		}

		return result;
	};

	/**
	 * Groups the incoming links of a crossing with a traffic light by the
	 * axis they arrive on, so that opposite approaches have green together.
	 */
	function createPhases(crossing)
	{
		var phases = [];
		var axes = [];

		for (var i = 0; i < crossing.fanIn.length; i++)
		{
			var link = crossing.fanIn[i];
			var p0 = link.points[link.points.length - 2];
			var p1 = link.points[link.points.length - 1];
			var angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
			var j = 0;

			while (j < axes.length)
			{
				var d = Math.abs(axes[j] - angle) % Math.PI;

				if (Math.min(d, Math.PI - d) < Math.PI / 6)
				{
					break;
				}

				j++;
			}

			if (j == axes.length)
			{
				axes.push(angle);
				phases.push([]);
			}

			phases[j].push(link);
		}

		crossing.phases = (phases.length > 1) ? phases : null;
	};

	function createEmptyNetwork()
	{
		return {crossings: [], links: [], crossingMap: new Map(),
			linkMap: new Map(), origins: [], dests: [], cells: 0,
			dist: null, prev: null, stamps: null, search: 0, tooLarge: false};
	};

	/**
	 * Creates the network of the visible connectors between shapes. Returns
	 * an empty network with tooLarge set if it has more than maxNetworkCells.
	 */
	function createNetwork()
	{
		var model = graph.model;
		var view = graph.view;
		var result = createEmptyNetwork();

		function getCrossing(state)
		{
			var crossing = result.crossingMap.get(state.cell.id);

			if (crossing == null)
			{
				var light = parseInt(mxUtils.getValue(state.style, 'trafficLight', '0'));
				var center = getModelCenter(state);
				crossing = new Crossing(state.cell.id, center.x, center.y,
					(light > 0) ? Math.min(light, 3600) : 0);
				crossing.index = result.crossings.length;
				result.crossings.push(crossing);
				result.crossingMap.set(crossing.id, crossing);
			}

			return crossing;
		};

		function addLink(key, from, to, points)
		{
			var link = new Link(key, from, to, points);

			if (!isFinite(link.length))
			{
				return;
			}

			from.fanOut.push(link);
			to.fanIn.push(link);
			result.links.push(link);
			result.linkMap.set(key, link);
			result.cells += link.cells.length;
		};

		var edges = model.filterDescendants(function(cell)
		{
			return model.isEdge(cell);
		});

		for (var i = 0; i < edges.length && result.cells <= maxNetworkCells; i++)
		{
			var state = view.getState(edges[i]);

			if (state != null && state.absolutePoints != null)
			{
				var src = state.getVisibleTerminalState(true);
				var trg = state.getVisibleTerminalState(false);
				var pts = getModelPoints(state);

				if (src != null && trg != null && src != trg && pts.length > 1 &&
					model.isVertex(src.cell) && model.isVertex(trg.cell))
				{
					var dir = getDirection(state.style);
					var from = getCrossing(src);
					var to = getCrossing(trg);

					if (dir == 0)
					{
						addLink(state.cell.id + '>', from, to, offsetPoints(pts, cellLength * 0.4));
						addLink(state.cell.id + '<', to, from, offsetPoints(pts.slice().reverse(), cellLength * 0.4));
					}
					else if (dir > 0)
					{
						addLink(state.cell.id + '>', from, to, pts);
					}
					else
					{
						addLink(state.cell.id + '<', to, from, pts.slice().reverse());
					}
				}
			}
		}

		if (result.cells > maxNetworkCells)
		{
			result = createEmptyNetwork();
			result.tooLarge = true;
		}

		for (var i = 0; i < result.crossings.length; i++)
		{
			var crossing = result.crossings[i];

			if (crossing.light > 0)
			{
				createPhases(crossing);
			}

			if (crossing.fanOut.length > 0)
			{
				result.origins.push(crossing);
			}

			if (crossing.fanIn.length > 0)
			{
				result.dests.push(crossing);
			}
		}

		return result;
	};

	function createSim()
	{
		return {time: 0, active: new Set(), queued: 0, created: 0,
			arrived: 0, travel: 0, driven: 0, replanned: 0};
	};

	/**
	 * Keeps the number of cars by adding cars with random routes (the random
	 * mode of the Java version, which also read plans from files).
	 */
	function addCars()
	{
		// At most one new car per origin and a few routes per step
		var missing = Math.min(config.cars - sim.active.size - sim.queued,
			net.origins.length, maxNewCarsPerStep);

		for (var i = 0; i < missing && net.origins.length > 0; i++)
		{
			var start = net.origins[Math.floor(Math.random() * net.origins.length)];
			var end = net.dests[Math.floor(Math.random() * net.dests.length)];
			var route = getShortestPath(start, end);

			if (route != null)
			{
				route[0].queue.push(new Vehicle(sim.created++, route, sim.time));
				sim.queued++;
			}
		}
	};

	function addActive(v)
	{
		sim.queued--;
		sim.active.add(v);
		v.node = document.createElementNS(mxConstants.NS_SVG, 'circle');
		v.node.setAttribute('r', getSize(0.4, 2.5));
		v.node.setAttribute('fill', v.color);
		v.node.setAttribute('stroke', 'rgba(0,0,0,0.5)');
		v.node.setAttribute('stroke-width', '0.5');
		overlay.cars.appendChild(v.node);
	};

	function removeActive(v)
	{
		sim.active['delete'](v);

		if (v.node != null && v.node.parentNode != null)
		{
			v.node.parentNode.removeChild(v.node);
		}
	};

	function park(v)
	{
		removeActive(v);
		sim.arrived++;
		sim.travel += sim.time - v.start;
		sim.driven += v.driven;
	};

	/**
	 * Gives the car the fastest route from the end of its link.
	 */
	function replan(v)
	{
		var route = (v.link.to == v.dest) ? [] : getShortestPath(v.link.to, v.dest);

		if (route != null)
		{
			v.route = route;
			v.index = 0;
		}

		return route != null;
	};

	/**
	 * Runs one step. The cars store their positions before the step for the
	 * interpolation in paintCars.
	 */
	function step()
	{
		addCars();

		sim.active.forEach(function(v)
		{
			v.prevLink = v.link;
			v.prevCell = v.cell;
		});

		for (var i = 0; i < net.links.length; i++)
		{
			net.links[i].step();
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			net.crossings[i].step();
		}

		sim.time++;
	};

	/**
	 * Returns the free cell of the given link nearest to the given cell,
	 * looking behind first, or -1.
	 */
	function findFreeCell(link, cell)
	{
		for (var d = 0; d <= link.out; d++)
		{
			if (cell - d >= 0 && link.cells[cell - d] == null)
			{
				return cell - d;
			}
			else if (d > 0 && cell + d <= link.out && link.cells[cell + d] == null)
			{
				return cell + d;
			}
		}

		return -1;
	};

	/**
	 * Returns the links of the new network with the keys of the given links
	 * from the given index on, or null if one is gone or they no longer
	 * connect from the given crossing on to the given destination.
	 */
	function mapRoute(links, index, from, dest)
	{
		var result = [];

		for (var i = index; i < links.length; i++)
		{
			var link = net.linkMap.get(links[i].key);

			if (link == null || (from != null && link.from != from))
			{
				return null;
			}

			result.push(link);
			from = link.to;
		}

		return (from == dest) ? result : null;
	};

	/**
	 * Moves the cars of the old network to the links with the same key in the
	 * new one. Cars keep their routes if all links are still there, else they
	 * get new ones. Cars on removed links are removed.
	 */
	function transferCars(old)
	{
		var queued = [];

		for (var i = 0; i < old.crossings.length; i++)
		{
			var crossing = net.crossingMap.get(old.crossings[i].id);

			if (crossing != null)
			{
				crossing.phase = (crossing.phases != null) ? old.crossings[i].phase % crossing.phases.length : 0;
				crossing.counter = old.crossings[i].counter;
				crossing.finger = old.crossings[i].finger;
			}
		}

		for (var i = 0; i < old.links.length; i++)
		{
			var link = old.links[i];
			var next = net.linkMap.get(link.key);

			if (next != null)
			{
				next.vavg = link.vavg;
			}

			for (var j = link.out; j >= 0; j--)
			{
				var v = link.cells[j];

				if (v != null)
				{
					var cell = (next != null) ? findFreeCell(next,
						Math.round(j * next.out / link.out)) : -1;

					if (cell >= 0)
					{
						next.cells[cell] = v;
						next.vehicles++;
						v.link = next;
						v.cell = cell;
					}
					else
					{
						removeActive(v);
					}
				}
			}

			for (var j = 0; j < link.queue.length; j++)
			{
				queued.push(link.queue[j]);
			}
		}

		sim.active.forEach(function(v)
		{
			v.dest = net.crossingMap.get(v.dest.id);
			var route = mapRoute(v.route, v.index, v.link.to, v.dest);
			v.route = (route != null) ? route : [];
			v.index = 0;
			v.prevLink = null;

			// Removes cars that can no longer reach their destination
			if (v.dest == null || (route == null && !replan(v)))
			{
				v.link.cells[v.cell] = null;
				v.link.vehicles--;
				removeActive(v);
			}
		});

		sim.queued = 0;

		for (var i = 0; i < queued.length; i++)
		{
			var v = queued[i];
			var dest = net.crossingMap.get(v.dest.id);
			var route = mapRoute(v.route, 0, null, dest);

			if (route == null || route.length == 0)
			{
				var start = net.crossingMap.get(v.route[0].from.id);
				route = (start != null && dest != null) ? getShortestPath(start, dest) : null;
			}

			if (route != null && dest != null)
			{
				v.route = route;
				v.dest = dest;
				route[0].queue.push(v);
				sim.queued++;
			}
		}
	};

	function rebuild()
	{
		var old = net;
		dirty = false;
		net = createNetwork();

		if (old != null && sim != null)
		{
			transferCars(old);
		}

		paintNetwork();
	};

	function createGroup(parent)
	{
		var g = document.createElementNS(mxConstants.NS_SVG, 'g');
		parent.appendChild(g);

		return g;
	};

	function clearChildren(node)
	{
		while (node.firstChild != null)
		{
			node.removeChild(node.firstChild);
		}
	};

	function createOverlay()
	{
		var root = document.createElementNS(mxConstants.NS_SVG, 'g');
		root.style.pointerEvents = 'none';
		overlay = {root: root, scale: graph.view.scale, roads: createGroup(root),
			lights: createGroup(root), cars: createGroup(root)};
		graph.view.getOverlayPane().appendChild(root);
		updateTransform();
	};

	/**
	 * Returns the given fraction of a cell in units but at least the given
	 * size in pixels, so that cars stay visible on large networks.
	 */
	function getSize(fraction, px)
	{
		return Math.max(cellLength * fraction, px / graph.view.scale);
	};

	/**
	 * Paints the overlay in model coordinates under the transform of the view.
	 */
	function updateTransform()
	{
		if (overlay != null)
		{
			var s = graph.view.scale;
			var t = graph.view.translate;
			overlay.root.setAttribute('transform', 'scale(' + s + ') translate(' + t.x + ',' + t.y + ')');

			if (overlay.scale != s)
			{
				overlay.scale = s;
				updateSizes();
			}
		}
	};

	function updateSizes()
	{
		var r = getSize(0.4, 2.5);
		var w = getSize(0.5, 3);
		var lr = getSize(0.35, 2.5);

		sim.active.forEach(function(v)
		{
			v.node.setAttribute('r', r);
		});

		for (var i = 0; i < net.links.length; i++)
		{
			if (net.links[i].node != null)
			{
				net.links[i].node.setAttribute('stroke-width', w);
			}
		}

		for (var i = 0; i < overlay.lights.childNodes.length; i++)
		{
			overlay.lights.childNodes[i].setAttribute('r', lr);
		}
	};

	/**
	 * Paints the density of the links and the traffic lights.
	 */
	function paintNetwork()
	{
		clearChildren(overlay.roads);
		clearChildren(overlay.lights);

		for (var i = 0; i < net.links.length; i++)
		{
			var link = net.links[i];
			link.node = null;
			link.hue = null;

			if (config.density)
			{
				var d = [];

				for (var j = 0; j < link.points.length; j++)
				{
					d.push(((j == 0) ? 'M' : 'L') + link.points[j].x + ' ' + link.points[j].y);
				}

				link.node = document.createElementNS(mxConstants.NS_SVG, 'path');
				link.node.setAttribute('d', d.join(' '));
				link.node.setAttribute('fill', 'none');
				link.node.setAttribute('stroke-width', getSize(0.5, 3));
				link.node.setAttribute('stroke-linecap', 'round');
				link.node.setAttribute('stroke-opacity', '0.35');
				overlay.roads.appendChild(link.node);
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var crossing = net.crossings[i];
			crossing.lightNodes = null;

			if (crossing.phases != null)
			{
				crossing.lightNodes = [];

				for (var j = 0; j < crossing.phases.length; j++)
				{
					var nodes = [];

					for (var k = 0; k < crossing.phases[j].length; k++)
					{
						var pts = crossing.phases[j][k].points;
						var node = document.createElementNS(mxConstants.NS_SVG, 'circle');
						node.setAttribute('cx', pts[pts.length - 1].x);
						node.setAttribute('cy', pts[pts.length - 1].y);
						node.setAttribute('r', getSize(0.35, 2.5));
						node.setAttribute('stroke', 'rgba(0,0,0,0.6)');
						node.setAttribute('stroke-width', '0.5');
						overlay.lights.appendChild(node);
						nodes.push(node);
					}

					crossing.lightNodes.push(nodes);
				}
			}
		}

		updateNetwork();
		paintCars(1);
	};

	function updateNetwork()
	{
		for (var i = 0; i < net.links.length; i++)
		{
			var link = net.links[i];

			if (link.node != null)
			{
				// Green when free, red at half of the cells (stop and go)
				var density = Math.min(1, 2 * link.vehicles / link.cells.length);
				var hue = Math.round(120 * (1 - density));

				if (hue != link.hue)
				{
					link.node.setAttribute('stroke', 'hsl(' + hue + ',85%,45%)');
					link.hue = hue;
				}
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var crossing = net.crossings[i];

			if (crossing.lightNodes != null)
			{
				for (var j = 0; j < crossing.lightNodes.length; j++)
				{
					for (var k = 0; k < crossing.lightNodes[j].length; k++)
					{
						crossing.lightNodes[j][k].setAttribute('fill',
							(j == crossing.phase) ? '#00c853' : '#d50000');
					}
				}
			}
		}
	};

	/**
	 * Paints the cars between their previous and current cell.
	 */
	function paintCars(alpha)
	{
		sim.active.forEach(function(v)
		{
			var pt = v.link.getPoint(v.link.getCellDistance(v.cell));

			if (alpha < 1 && v.prevLink != null)
			{
				if (v.prevLink == v.link)
				{
					var d0 = v.link.getCellDistance(v.prevCell);
					var d1 = v.link.getCellDistance(v.cell);
					pt = v.link.getPoint(d0 + (d1 - d0) * alpha);
				}
				else
				{
					var p0 = v.prevLink.getPoint(v.prevLink.getCellDistance(v.prevCell));
					pt = new mxPoint(p0.x + (pt.x - p0.x) * alpha, p0.y + (pt.y - p0.y) * alpha);
				}
			}

			v.node.setAttribute('cx', pt.x);
			v.node.setAttribute('cy', pt.y);
		});
	};

	function formatTime(t)
	{
		var m = Math.floor(t / 60) % 60;
		var s = t % 60;

		return Math.floor(t / 3600) + ':' + ((m < 10) ? '0' : '') + m + ':' + ((s < 10) ? '0' : '') + s;
	};

	function updateStats()
	{
		var lines = [];

		if (net.tooLarge)
		{
			lines.push('This network is too large for the simulation.');
		}
		else if (net.links.length == 0)
		{
			lines.push('No roads on this page. Connect shapes with connectors or insert the sample.');
		}
		else
		{
			lines.push('Time: ' + formatTime(sim.time));
			lines.push('Network: ' + net.crossings.length + ' crossings, ' +
				net.links.length + ' links, ' + net.cells + ' cells');
			lines.push('Cars: ' + sim.active.size + ' driving, ' + sim.queued + ' waiting to start');
			lines.push('Density: ' + (100 * sim.active.size / net.cells).toFixed(1) + ' %');
			lines.push('Arrived: ' + sim.arrived);

			if (sim.arrived > 0 && sim.travel > 0)
			{
				lines.push('Average trip: ' + formatTime(Math.round(sim.travel / sim.arrived)));
				lines.push('Average speed: ' + (3.6 * cellLength * sim.driven / sim.travel).toFixed(1) + ' km/h');
			}

			lines.push('Reroutes: ' + sim.replanned);
		}

		listener(lines, running);
	};

	function frame(now)
	{
		frameId = null;

		if (overlay == null)
		{
			return;
		}

		// Page switches change the scale and translate without events
		updateTransform();

		if (dirty)
		{
			rebuild();
		}

		var interval = 1000 / config.speed;

		if (running)
		{
			var start = window.performance.now();
			var steps = 0;

			while (now - lastStep >= interval && steps < maxStepsPerFrame &&
				(steps == 0 || window.performance.now() - start < maxFrameTime))
			{
				step();
				lastStep += interval;
				steps++;
			}

			// Drops steps that the browser cannot keep up with
			if (now - lastStep >= interval)
			{
				lastStep = now;
			}

			if (steps > 0)
			{
				updateNetwork();
			}

			schedule();
		}

		paintCars((running && config.speed <= 20) ? Math.min(1, (now - lastStep) / interval) : 1);

		if (!running || now - lastStats > 250)
		{
			updateStats();
			lastStats = now;
		}
	};

	function schedule()
	{
		if (frameId == null)
		{
			frameId = window.requestAnimationFrame(frame);
		}
	};

	function setRunning(value)
	{
		running = value;
		lastStep = window.performance.now();

		// Paints the cars where they are until the next step
		if (sim != null)
		{
			sim.active.forEach(function(v)
			{
				v.prevLink = null;
			});
		}

		schedule();
	};

	function reset()
	{
		if (sim != null)
		{
			sim.active.forEach(removeActive);
		}

		sim = createSim();
		net = null;
		rebuild();
		updateStats();
	};

	function start()
	{
		if (overlay == null)
		{
			createOverlay();
			reset();
		}
	};

	/**
	 * Parses the nodes and edges of a network file of the Java version.
	 * Plans are ignored. Stops and sets truncated after maxImportCells.
	 */
	function parseNet(text)
	{
		var nodes = new Map();
		var edges = [];
		var section = null;
		var lines = text.split('\n');
		var truncated = false;

		for (var i = 0; i < lines.length; i++)
		{
			var line = lines[i].trim();

			if (line.charAt(0) == '[')
			{
				section = line;
			}
			else if (line.length > 0)
			{
				var tokens = line.split(',');
				truncated = nodes.size + edges.length >= maxImportCells &&
					(section == '[Nodes]' || section == '[Edges]');

				if (truncated)
				{
					break;
				}
				else if (section == '[Nodes]' && tokens.length >= 3)
				{
					var x = parseFloat(tokens[1]);
					var y = parseFloat(tokens[2]);

					if (isFinite(x) && isFinite(y))
					{
						nodes.set(tokens[0], new mxPoint(x, y));
					}
				}
				else if (section == '[Edges]' && tokens.length >= 3)
				{
					edges.push({source: tokens[1], target: tokens[2]});
				}
			}
		}

		return {nodes: nodes, edges: edges, truncated: truncated};
	};

	/**
	 * Inserts the crossings and roads of the given network file. Two links
	 * in opposite directions become one road in both directions.
	 */
	function insertNet(text)
	{
		if (!graph.isEnabled() || graph.isCellLocked(graph.getDefaultParent()))
		{
			return;
		}

		var data = parseNet(text);
		var min = new mxPoint(Infinity, Infinity);
		var max = new mxPoint(-Infinity, -Infinity);
		var roadCells = 0;

		// Each direction of a road is a link
		for (var i = 0; i < data.edges.length; i++)
		{
			var p0 = data.nodes.get(data.edges[i].source);
			var p1 = data.nodes.get(data.edges[i].target);

			if (p0 != null && p1 != null)
			{
				roadCells += getDistance(p0, p1) / cellLength;
			}
		}

		data.nodes.forEach(function(p)
		{
			min.x = Math.min(min.x, p.x);
			min.y = Math.min(min.y, p.y);
			max.x = Math.max(max.x, p.x);
			max.y = Math.max(max.y, p.y);
		});

		if (data.nodes.size == 0)
		{
			ui.handleError({message: 'No crossings found in this file.'});
		}
		else if (data.truncated || roadCells > maxNetworkCells ||
			max.x - min.x > maxImportExtent || max.y - min.y > maxImportExtent)
		{
			ui.handleError({message: 'This network is too large.'});
		}
		else
		{
			var size = 16;
			var pt = graph.getCenterInsertPoint(new mxRectangle(0, 0,
				max.x - min.x + size, max.y - min.y + size));
			var keys = new Set();

			for (var i = 0; i < data.edges.length; i++)
			{
				keys.add(data.edges[i].source + '\n' + data.edges[i].target);
			}

			var parent = graph.getDefaultParent();
			var vertices = new Map();
			var done = new Set();
			var cells = [];

			graph.model.beginUpdate();
			try
			{
				data.nodes.forEach(function(p, id)
				{
					var vertex = graph.insertVertex(parent, null, '', pt.x + p.x - min.x,
						pt.y + p.y - min.y, size, size, crossingStyle);
					vertices.set(id, vertex);
					cells.push(vertex);
				});

				for (var i = 0; i < data.edges.length; i++)
				{
					var e = data.edges[i];
					var src = vertices.get(e.source);
					var trg = vertices.get(e.target);
					var key = e.source + '\n' + e.target;
					var reverse = e.target + '\n' + e.source;

					if (src != null && trg != null && src != trg && !done.has(key))
					{
						var twoWay = keys.has(reverse);
						cells.push(graph.insertEdge(parent, null, '', src, trg,
							(twoWay) ? twoWayStyle : oneWayStyle));
						done.add(key);

						if (twoWay)
						{
							done.add(reverse);
						}
					}
				}
			}
			finally
			{
				graph.model.endUpdate();
			}

			graph.scrollCellToVisible(cells[0]);
		}
	};

	/**
	 * Inserts the network of the given file of the Java version.
	 */
	function importFile(file)
	{
		if (file.size > maxImportSize)
		{
			ui.handleError({message: mxResources.get('drawingTooLarge')});
		}
		else
		{
			var reader = new FileReader();

			reader.onload = function()
			{
				try
				{
					insertNet(reader.result);
				}
				catch (e)
				{
					ui.handleError(e);
				}
			};

			reader.readAsText(file);
		}
	};

	/**
	 * Sets the given option. Speed changes restart the steps and the
	 * interpolation, Show density repaints the roads.
	 */
	function setOption(key, value)
	{
		config[key] = value;

		if (key == 'speed')
		{
			setRunning(running);
		}
		else if (key == 'density' && overlay != null)
		{
			paintNetwork();
		}
	};

	function invalidate()
	{
		if (overlay != null)
		{
			dirty = true;
			schedule();
		}
	};

	graph.model.addListener(mxEvent.CHANGE, invalidate);

	// Opening a file starts a new simulation
	ui.editor.addListener('fileLoaded', function()
	{
		if (overlay != null)
		{
			reset();
		}
	});

	// Traced outlines of images move edges without a change of the model
	if (graph.refreshTracedOutlines != null)
	{
		var refreshTracedOutlines = graph.refreshTracedOutlines;

		graph.refreshTracedOutlines = function()
		{
			refreshTracedOutlines.apply(this, arguments);
			invalidate();
		};
	}

	graph.view.addListener(mxEvent.SCALE, updateTransform);
	graph.view.addListener(mxEvent.TRANSLATE, updateTransform);
	graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, updateTransform);

	return {config: config, start: start, reset: reset, setRunning: setRunning,
		isRunning: function() { return running; }, setOption: setOption,
		importFile: importFile};
};
