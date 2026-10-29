/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Traffic simulation on a draw.io diagram, a port of sim.traffic (Gaudenz
 * Alder, ETH Zurich, 2000).
 *
 * Connectors are roads and the shapes they connect are junctions. A
 * connector with one arrow is a one-way road in the direction of the arrow,
 * one with no or two arrows a road in both directions with its lanes on the
 * right of each direction. lanes=<n> in the style of a road is the number of
 * lanes per direction. Each direction is a link of lanes of cells of 7.5
 * units (1 unit is 1 m, 1 step is 1 s) with the Nagel-Schreckenberg update:
 * change lanes, accelerate, brake to the gap, dawdle, move. Cars change to a
 * neighbor lane with more space ahead if no car is close behind there.
 *
 * Crossings let as many cars pass per step as their widest incoming road has
 * lanes and take the incoming links in turns. Cars drive through crossings
 * on a curve at about one cell per step and enter their next link at its
 * end, one car per lane and step. A shape with
 * trafficLight=<steps> in its style gives green to the links of one approach
 * axis at a time for that many steps, followed by 3 steps of yellow. A shape
 * with shape=roundabout is a ring of cells where traffic circulates
 * counterclockwise: cars enter when the ring is free before the entry and
 * leave where their next road starts. Free ends of roads join the junction
 * they are on or other free ends nearby, else they are dead ends. Cars drive
 * from a random junction to another on the fastest route under the current
 * speeds and look for another route after waiting at a junction.
 *
 * Cars, traffic lights and the density of the lanes are painted into the
 * overlay pane. The simulation never changes the diagram, only importFile
 * inserts cells. This script runs in the window of the editor after
 * js/roads.js, whose lane geometry it uses: TrafficSimulation(ui, listener)
 * attaches the simulation to the graph of the given EditorUi and calls
 * listener with the lines of the statistics and the running state.
 */
window.TrafficSimulation = function(ui, listener)
{
	var graph = ui.editor.graph;
	var roads = window.TrafficRoads;
	var cellLength = 7.5;
	var replanSteps = 60;
	var yellowSteps = 3;
	var ringSpeed = 2;
	var laneChangeProbability = 0.8;
	var maxStepsPerFrame = 100;
	var maxFrameTime = 40;
	var maxNewCarsPerStep = 10;
	var maxLinkCells = 10000;
	var maxNetworkCells = 5000000;
	var maxImportCells = 50000;
	var maxImportSize = 20 * 1024 * 1024;
	var maxImportExtent = 1e6;
	var carColors = ['#e53935', '#1e88e5', '#43a047', '#8e24aa', '#fdd835', '#fb8c00'];
	var lampColors = [['#ff3b30', '#4a1512'], ['#ffcc00', '#4a3d0d'], ['#34c759', '#123d1f']];
	var config = {cars: 60, speed: 10, vmax: 5, noise: 0.25, reroute: true, density: true};

	var crossingStyle = 'ellipse;aspect=fixed;strokeColor=none;fillColor=' + roads.asphalt + ';';
	var oneWayStyle = 'shape=road;endArrow=block;strokeWidth=7;';
	var twoWayStyle = 'shape=road;endArrow=none;startArrow=none;strokeWidth=14;';

	var net = null;
	var sim = null;
	var overlay = null;
	var running = false;
	var dirty = false;
	var frameId = null;
	var lastStep = 0;
	var lastStats = 0;

	/**
	 * One direction of a road: lanes of cells from one junction to another,
	 * at the given offsets to the right of the given points. All lanes have
	 * the same number of cells, so that cars change lanes at the same place.
	 */
	function Link(key, from, to, points, offsets)
	{
		this.key = key;
		this.from = from;
		this.to = to;
		this.points = points;
		this.offsets = offsets;
		this.length = roads.getLengths(points)[points.length - 1];
		this.paths = [];
		this.cells = [];
		this.transit = [];

		var n = Math.min(maxLinkCells, Math.max(2, Math.round(this.length / cellLength)));

		for (var k = 0; k < offsets.length; k++)
		{
			var pts = (offsets[k] != 0) ? roads.offsetPoints(points, offsets[k]) : points;
			this.paths.push({points: pts, lengths: roads.getLengths(pts)});
			this.cells.push(new Array(n).fill(null));
			this.transit.push([]);
		}

		this.out = n - 1;
		this.queue = [];
		this.vehicles = 0;
		this.vavg = 0;
		this.merged = false;
		this.nodes = null;
		this.hue = null;
		this.startCell = -1;
		this.endCell = -1;
	};

	/**
	 * Returns the number of free cells ahead of the given cell, at most max.
	 */
	Link.prototype.getGap = function(lane, cell, max)
	{
		var cells = this.cells[lane];
		var gap = 0;

		while (gap < max && cell + gap < this.out && cells[cell + gap + 1] == null)
		{
			gap++;
		}

		return gap;
	};

	/**
	 * Returns true if the given number of cells behind the given cell are
	 * free or behind the start of the link.
	 */
	Link.prototype.isFreeBehind = function(lane, cell, count)
	{
		for (var i = 1; i <= count && cell - i >= 0; i++)
		{
			if (this.cells[lane][cell - i] != null)
			{
				return false;
			}
		}

		return true;
	};

	/**
	 * Returns the lane with a free first cell and the most space ahead or -1.
	 * Lanes with cars on their way through the crossing are not free.
	 */
	Link.prototype.getFreeLane = function()
	{
		var result = -1;
		var best = -1;

		for (var k = 0; k < this.cells.length; k++)
		{
			if (this.cells[k][0] == null && this.transit[k].length == 0)
			{
				var gap = this.getGap(k, 0, config.vmax);

				if (gap > best)
				{
					best = gap;
					result = k;
				}
			}
		}

		return result;
	};

	/**
	 * Returns the lane where a car can enter the link from its junction or
	 * -1. Through traffic and cars that start on the link take turns.
	 */
	Link.prototype.accept = function()
	{
		return (this.queue.length == 0 || this.merged) ? this.getFreeLane() : -1;
	};

	/**
	 * Puts the given car into the first cell of the given lane.
	 */
	Link.prototype.enter = function(v, lane)
	{
		this.vehicles++;
		this.cells[lane][0] = v;
		v.link = this;
		v.ring = null;
		v.lane = lane;
		v.cell = 0;
		v.wait = 0;
		v.index++;
		this.merged = false;
	};

	/**
	 * Removes and returns the car in the last cell of the given lane.
	 */
	Link.prototype.pop = function(lane)
	{
		var v = this.cells[lane][this.out];
		this.cells[lane][this.out] = null;
		this.vehicles--;

		return v;
	};

	/**
	 * Returns the lane where a car can start to drive through the crossing
	 * to the link in the given number of steps or -1. The first cell must be
	 * free and the car must be at least one step behind the last car on its
	 * way to the lane. Through traffic and cars that start on the link take
	 * turns.
	 */
	Link.prototype.acceptTransit = function(steps)
	{
		var result = -1;
		var best = -Infinity;

		if (this.queue.length == 0 || this.merged)
		{
			for (var k = 0; k < this.cells.length; k++)
			{
				var cars = this.transit[k];

				if (this.cells[k][0] == null && (cars.length == 0 || cars[cars.length - 1].left < steps - 1))
				{
					var gap = this.getGap(k, 0, config.vmax) - cars.length;

					if (gap > best)
					{
						best = gap;
						result = k;
					}
				}
			}
		}

		return result;
	};

	/**
	 * Lets the given car drive through the crossing on the given curve to the
	 * given lane of the link in the given number of steps, the first of
	 * which is this step.
	 */
	Link.prototype.addTransit = function(v, lane, steps, curve)
	{
		var t = {v: v, link: this, lane: lane, steps: steps, left: steps - 1, curve: curve};
		this.transit[lane].push(t);
		v.link = null;
		v.ring = null;
		v.transit = t;

		if (t.left == 0 && this.transit[lane].length == 1)
		{
			this.exitTransit(lane);
		}
	};

	/**
	 * Moves the first car on its way through the crossing to the given lane
	 * into the first cell of the lane.
	 */
	Link.prototype.exitTransit = function(lane)
	{
		var t = this.transit[lane].shift();
		t.v.transit = null;
		t.v.curve = t.curve;
		this.enter(t.v, lane);
	};

	/**
	 * Moves the cars on their way through the crossing one step closer to
	 * the link, at least one step apart, and lets the first enter it if its
	 * first cell is free.
	 */
	Link.prototype.stepTransit = function()
	{
		for (var k = 0; k < this.transit.length; k++)
		{
			var cars = this.transit[k];
			var ahead = -1;

			for (var i = 0; i < cars.length; i++)
			{
				var t = cars[i];
				t.left = Math.max(t.left - 1, ahead + 1);

				if (i == 0 && t.left == 0 && this.cells[k][0] == null)
				{
					this.exitTransit(k);
					i--;
					ahead = 0;
				}
				else
				{
					ahead = t.left;
				}
			}
		}
	};

	/**
	 * Puts the given car into the free cell nearest to the given cell, in the
	 * given lane or else in another. Returns false if all are full.
	 */
	Link.prototype.place = function(v, lane, cell)
	{
		for (var i = 0; i < this.cells.length; i++)
		{
			var k = (lane + i) % this.cells.length;
			var free = findFreeCell(this.cells[k], cell);

			if (free >= 0)
			{
				this.cells[k][free] = v;
				this.vehicles++;
				v.link = this;
				v.ring = null;
				v.lane = k;
				v.cell = free;

				return true;
			}
		}

		return false;
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
	 * Returns the point of the given cell, which may be fractional, in the
	 * given lane.
	 */
	Link.prototype.getPoint = function(lane, cell)
	{
		var path = this.paths[lane];
		var length = path.lengths[path.lengths.length - 1];

		return roads.getPointAt(path.points, path.lengths, (cell + 0.5) / (this.out + 1) * length) ||
			path.points[0];
	};

	/**
	 * Moves cars that are blocked ahead to a neighbor lane with more space
	 * ahead if no car is close behind there (Rickert et al. 1996). Decides
	 * for all cars first, so that the order of the lanes does not matter.
	 */
	Link.prototype.changeLanes = function()
	{
		var vmax = config.vmax;
		var moves = [];

		for (var k = 0; k < this.cells.length; k++)
		{
			for (var i = 0; i < this.out; i++)
			{
				var v = this.cells[k][i];

				if (v != null)
				{
					var gap = this.getGap(k, i, vmax);

					if (gap < Math.min(v.v + 1, vmax))
					{
						var target = -1;

						for (var d = -1; d <= 1; d += 2)
						{
							var l = k + d;

							if (l >= 0 && l < this.cells.length && this.cells[l][i] == null &&
								this.isFreeBehind(l, i, vmax))
							{
								var g = this.getGap(l, i, vmax);

								if (g > gap)
								{
									gap = g;
									target = l;
								}
							}
						}

						if (target >= 0 && Math.random() < laneChangeProbability)
						{
							moves.push([v, k, target, i]);
						}
					}
				}
			}
		}

		for (var j = 0; j < moves.length; j++)
		{
			var m = moves[j];

			if (this.cells[m[2]][m[3]] == null)
			{
				this.cells[m[1]][m[3]] = null;
				this.cells[m[2]][m[3]] = m[0];
				m[0].lane = m[2];
			}
		}
	};

	/**
	 * Nagel-Schreckenberg update of the cars in the link.
	 */
	Link.prototype.step = function()
	{
		var out = this.out;

		if (this.vehicles == 0 && this.queue.length == 0)
		{
			return;
		}

		// Cars enter traffic at the start of their first link
		if (this.queue.length > 0)
		{
			var lane = this.getFreeLane();

			if (lane >= 0)
			{
				var first = this.queue.shift();
				addActive(first);
				this.enter(first, lane);
				this.merged = true;
			}
		}

		if (this.cells.length > 1)
		{
			this.changeLanes();
		}

		var vmax = config.vmax;
		var noise = config.noise;
		var moved = 0;

		for (var k = 0; k < this.cells.length; k++)
		{
			var cells = this.cells[k];

			// Accelerates, brakes to the gap and dawdles
			for (var i = 0; i <= out; i++)
			{
				var v = cells[i];

				if (v != null)
				{
					v.v = Math.min(this.getGap(k, i, vmax), vmax, v.v + 1);

					if (v.v > 0 && Math.random() < noise)
					{
						v.v--;
					}
				}
			}

			// Moves from the front so that no car moves twice
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
		}

		this.vavg = (this.vehicles > 0) ? moved / this.vehicles : 0;

		for (var k = 0; k < this.cells.length; k++)
		{
			var top = this.cells[k][out];

			if (top != null)
			{
				if (top.next() == null)
				{
					park(this.pop(k));
				}
				else if (config.reroute && ++top.wait % replanSteps == 0 && replan(top))
				{
					sim.replanned++;
				}
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
		this.yellow = Math.min(yellowSteps, light);
		this.index = 0;
		this.fanIn = [];
		this.fanOut = [];
		this.capacity = 1;
		this.phases = null;
		this.phase = 0;
		this.counter = 0;
		this.finger = 0;
		this.signals = null;
	};

	/**
	 * Returns the signal of the given phase of a traffic light: 0 for red, 1
	 * for yellow and 2 for green.
	 */
	Crossing.prototype.getSignal = function(phase)
	{
		return (phase != this.phase) ? 0 : ((this.counter < this.light) ? 2 : 1);
	};

	/**
	 * Lets the first cars that can enter their next link pass, taking the
	 * incoming links with green in turns.
	 */
	Crossing.prototype.step = function()
	{
		var green = this.fanIn;

		for (var i = 0; i < this.fanOut.length; i++)
		{
			this.fanOut[i].stepTransit();
		}

		if (this.phases != null)
		{
			if (++this.counter >= this.light + this.yellow)
			{
				this.counter = 0;
				this.phase = (this.phase + 1) % this.phases.length;
				this.finger = 0;
			}

			green = (this.counter < this.light) ? this.phases[this.phase] : [];
		}

		var passed = 0;

		for (var i = 0; i < green.length && passed < this.capacity; i++)
		{
			var link = green[(this.finger + i) % green.length];

			for (var k = 0; k < link.cells.length && passed < this.capacity; k++)
			{
				var v = link.cells[k][link.out];
				var next = (v != null) ? v.next() : null;

				if (next != null && next.from == this)
				{
					var steps = getTransitSteps(createCurve(link, k, next, Math.min(k, next.cells.length - 1)));
					var lane = next.acceptTransit(steps);

					if (lane >= 0)
					{
						next.addTransit(link.pop(k), lane, steps, createCurve(link, k, next, lane));
						this.finger = (this.finger + i + 1) % green.length;
						passed++;
					}
				}
			}
		}
	};

	/**
	 * Returns the unit vector of the direction of the given points at their
	 * start or end.
	 */
	function getDirection(pts, start)
	{
		var p0 = pts[(start) ? 0 : pts.length - 2];
		var p1 = pts[(start) ? 1 : pts.length - 1];
		var len = roads.getDistance(p0, p1);

		return (len > 0) ? new mxPoint((p1.x - p0.x) / len, (p1.y - p0.y) / len) : new mxPoint(1, 0);
	};

	/**
	 * Returns the path of a car through a crossing from the last cell of the
	 * given lane of a link to the first cell of the given lane of the next
	 * link: a quadratic curve through the intersection of the lanes or a
	 * line if they do not intersect in front of both cells.
	 */
	function createCurve(link, lane, next, nextLane)
	{
		var p0 = link.getPoint(lane, link.out);
		var p1 = next.getPoint(nextLane, 0);
		var a = getDirection(link.paths[lane].points, false);
		var b = getDirection(next.paths[nextLane].points, true);
		var c = new mxPoint((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
		var dx = p1.x - p0.x;
		var dy = p1.y - p0.y;
		var det = a.x * b.y - a.y * b.x;
		var dist = roads.getDistance(p0, p1);

		if (Math.abs(det) > 0.1)
		{
			var s = (dx * b.y - dy * b.x) / det;
			var t = (a.x * dy - a.y * dx) / det;

			if (s > 0 && t > 0 && s + t < 3 * dist)
			{
				c = new mxPoint(p0.x + a.x * s, p0.y + a.y * s);
			}
		}

		return {p0: p0, c: c, p1: p1, length: (roads.getDistance(p0, c) +
			roads.getDistance(c, p1) + dist) / 2};
	};

	/**
	 * Returns the steps to drive along the given curve at one cell per step.
	 */
	function getTransitSteps(curve)
	{
		return Math.max(1, Math.round(curve.length / cellLength));
	};

	/**
	 * Returns the point at the given fraction of the given curve.
	 */
	function getCurvePoint(curve, s)
	{
		var a = (1 - s) * (1 - s);
		var b = 2 * (1 - s) * s;
		var c = s * s;

		return new mxPoint(a * curve.p0.x + b * curve.c.x + c * curve.p1.x,
			a * curve.p0.y + b * curve.c.y + c * curve.p1.y);
	};

	/**
	 * Returns the fraction of the way through the crossing.
	 */
	function getProgress(t)
	{
		return (t.steps - t.left) / t.steps;
	};

	/**
	 * Roundabout: a ring of cells around the center at the given radius
	 * where traffic circulates counterclockwise. Cell i is at the angle
	 * -2 pi i / n (y down). Cars enter from the end of their link when the
	 * ring is free up to ringSpeed cells before the entry, and leave at the
	 * cell where their next link starts, or circle once more if it is full.
	 */
	function Roundabout(id, x, y, radius)
	{
		Crossing.call(this, id, x, y, 0);
		this.radius = radius;
		this.ring = new Array(Math.max(6, Math.round(2 * Math.PI * radius / cellLength))).fill(null);
		this.vehicles = 0;
	};

	/**
	 * Returns the cell of the ring nearest to the given point.
	 */
	Roundabout.prototype.getCell = function(pt)
	{
		var n = this.ring.length;
		var a = Math.atan2(pt.y - this.y, pt.x - this.x);

		return ((Math.round(-a * n / (2 * Math.PI)) % n) + n) % n;
	};

	/**
	 * Returns the point of the given cell, which may be fractional.
	 */
	Roundabout.prototype.getPoint = function(cell)
	{
		var a = -2 * Math.PI * cell / this.ring.length;

		return new mxPoint(this.x + this.radius * Math.cos(a), this.y + this.radius * Math.sin(a));
	};

	/**
	 * Returns true if the given cell and count cells before it are free.
	 */
	Roundabout.prototype.isFree = function(cell, count)
	{
		var n = this.ring.length;

		for (var d = 0; d <= count; d++)
		{
			if (this.ring[(cell - d + n) % n] != null)
			{
				return false;
			}
		}

		return true;
	};

	Roundabout.prototype.step = function()
	{
		var ring = this.ring;
		var n = ring.length;
		var vmax = Math.min(config.vmax, ringSpeed);

		if (this.vehicles > 0)
		{
			var cars = [];

			// Speeds from the gaps before the move, then all cars move at once
			for (var i = 0; i < n; i++)
			{
				var v = ring[i];

				if (v != null)
				{
					var gap = 0;

					while (gap < vmax && ring[(i + gap + 1) % n] == null)
					{
						gap++;
					}

					v.v = Math.min(gap, vmax, v.v + 1);
					var next = v.next();
					var d = (next != null) ? (next.startCell - i + n) % n : 0;

					// Stops at the exit
					if (d > 0 && d < v.v)
					{
						v.v = d;
					}

					cars.push(v);
				}
			}

			for (var i = 0; i < cars.length; i++)
			{
				ring[cars[i].cell] = null;
			}

			for (var i = 0; i < cars.length; i++)
			{
				var v = cars[i];
				v.cell = (v.cell + v.v) % n;
				v.driven += v.v;
				ring[v.cell] = v;
			}

			// Leaves at the exit if the next link has space
			for (var i = 0; i < cars.length; i++)
			{
				var v = cars[i];
				var next = v.next();

				if (next == null)
				{
					ring[v.cell] = null;
					this.vehicles--;
					park(v);
				}
				else if (next.from == this && next.startCell == v.cell)
				{
					var lane = next.accept();

					if (lane >= 0)
					{
						ring[v.cell] = null;
						this.vehicles--;
						next.enter(v, lane);
					}
				}
			}
		}

		// Enters from the end of the incoming links if the ring is free
		for (var i = 0; i < this.fanIn.length; i++)
		{
			var link = this.fanIn[i];

			for (var k = 0; k < link.cells.length; k++)
			{
				var v = link.cells[k][link.out];
				var next = (v != null) ? v.next() : null;

				if (next != null && next.from == this && this.isFree(link.endCell, vmax))
				{
					link.pop(k);
					ring[link.endCell] = v;
					v.link = null;
					v.ring = this;
					v.cell = link.endCell;
					v.v = 0;
					v.wait = 0;
					this.vehicles++;
				}
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
		this.ring = null;
		this.transit = null;
		this.curve = null;
		this.lane = 0;
		this.cell = 0;
		this.v = 0;
		this.wait = 0;
		this.driven = 0;
		this.prevLink = null;
		this.prevRing = null;
		this.prevTransit = null;
		this.prevLane = 0;
		this.prevCell = 0;
		this.prevProgress = 0;
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
	 * Returns the junction that the car drives to next.
	 */
	Vehicle.prototype.getJunction = function()
	{
		return (this.transit != null) ? this.transit.link.from :
			((this.ring != null) ? this.ring : this.link.to);
	};

	/**
	 * Returns the point of the car before or after the last step.
	 */
	Vehicle.prototype.getPoint = function(prev)
	{
		var transit = (prev) ? this.prevTransit : this.transit;

		if (transit != null)
		{
			return getCurvePoint(transit.curve, (prev) ? this.prevProgress : getProgress(transit));
		}

		var ring = (prev) ? this.prevRing : this.ring;
		var link = (prev) ? this.prevLink : this.link;
		var cell = (prev) ? this.prevCell : this.cell;

		return (ring != null) ? ring.getPoint(cell) :
			link.getPoint((prev) ? this.prevLane : this.lane, cell);
	};

	/**
	 * Binary heap of junctions for the shortest paths.
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
			(Graph.edgeSupportsCurved(style) || style[mxConstants.STYLE_SHAPE] == 'road'))
		{
			model = Graph.getCurvePoints(model, style[mxConstants.STYLE_BEZIER] == 1);
		}

		return roads.getPath(model, {});
	};

	/**
	 * Returns the bounds of the given vertex state in model coordinates.
	 */
	function getModelBounds(state)
	{
		var s = graph.view.scale;
		var t = graph.view.translate;

		return (state.cellBounds != null) ? state.cellBounds :
			new mxRectangle(state.x / s - t.x, state.y / s - t.y, state.width / s, state.height / s);
	};

	/**
	 * Groups the incoming links of a crossing with a traffic light by the
	 * axis they arrive on, so that opposite approaches have green together.
	 * A light with one axis switches between green and red.
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

		if (phases.length == 1)
		{
			phases.push([]);
		}

		crossing.phases = (phases.length > 1) ? phases : null;
	};

	function createEmptyNetwork()
	{
		return {crossings: [], links: [], crossingMap: new Map(), linkMap: new Map(),
			origins: [], dests: [], cells: 0, roundabouts: 0, lights: 0, ends: [],
			dist: null, prev: null, stamps: null, search: 0, tooLarge: false};
	};

	/**
	 * Creates the network of the visible connectors. Returns an empty network
	 * with tooLarge set if it has more than maxNetworkCells.
	 */
	function createNetwork()
	{
		var model = graph.model;
		var view = graph.view;
		var result = createEmptyNetwork();
		var vertices = null;

		function addJunction(junction)
		{
			junction.index = result.crossings.length;
			result.crossings.push(junction);
			result.crossingMap.set(junction.id, junction);

			return junction;
		};

		function getJunction(state)
		{
			var junction = result.crossingMap.get(state.cell.id);

			if (junction == null)
			{
				var b = getModelBounds(state);

				if (roads.isRoundabout(state.style))
				{
					junction = new Roundabout(state.cell.id, b.getCenterX(), b.getCenterY(),
						roads.getRing(state.style, b.width, b.height).center);
					result.roundabouts++;
				}
				else
				{
					var light = parseInt(mxUtils.getValue(state.style, 'trafficLight', '0'));
					junction = new Crossing(state.cell.id, b.getCenterX(), b.getCenterY(),
						(light > 0) ? Math.min(light, 3600) : 0);
				}

				addJunction(junction);
			}

			return junction;
		};

		/**
		 * Returns the state of the vertex that contains the given point or is
		 * within the snap distance, the nearest if there are several.
		 */
		function findVertex(pt)
		{
			if (vertices == null)
			{
				vertices = [];

				model.filterDescendants(function(cell)
				{
					var state = (model.isVertex(cell)) ? view.getState(cell) : null;

					if (state != null)
					{
						vertices.push({state: state, bounds: getModelBounds(state)});
					}

					return false;
				});
			}

			var tol = roads.snapDistance;
			var result = null;
			var best = Infinity;

			for (var i = 0; i < vertices.length; i++)
			{
				var b = vertices[i].bounds;

				if (pt.x >= b.x - tol && pt.x <= b.x + b.width + tol &&
					pt.y >= b.y - tol && pt.y <= b.y + b.height + tol)
				{
					var d = roads.getDistance(pt, new mxPoint(b.getCenterX(), b.getCenterY()));

					if (d < best)
					{
						best = d;
						result = vertices[i].state;
					}
				}
			}

			return result;
		};

		/**
		 * Returns the junction at the given end of a road: its terminal, the
		 * shape under the free end, another free end nearby or a dead end.
		 * Free ends of other connectors are ignored.
		 */
		function getEnd(state, source, pt)
		{
			var terminal = state.getVisibleTerminalState(source);

			if (terminal == null)
			{
				terminal = findVertex(pt);

				if (terminal == null && state.style[mxConstants.STYLE_SHAPE] == 'road')
				{
					for (var i = 0; i < result.ends.length; i++)
					{
						if (roads.getDistance(result.ends[i], pt) <= roads.snapDistance)
						{
							return result.ends[i];
						}
					}

					var end = addJunction(new Crossing('end:' + Math.round(pt.x) +
						',' + Math.round(pt.y), pt.x, pt.y, 0));
					result.ends.push(end);

					return end;
				}
			}

			return (terminal != null && model.isVertex(terminal.cell)) ? getJunction(terminal) : null;
		};

		function addLink(key, from, to, points, offsets)
		{
			var link = new Link(key, from, to, points, offsets);

			if (!isFinite(link.length))
			{
				return;
			}

			if (from.ring != null)
			{
				link.startCell = from.getCell(points[0]);
			}

			if (to.ring != null)
			{
				link.endCell = to.getCell(points[points.length - 1]);
			}

			from.fanOut.push(link);
			to.fanIn.push(link);
			result.links.push(link);
			result.linkMap.set(key, link);
			result.cells += link.cells.length * (link.out + 1);
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
				var pts = getModelPoints(state);

				if (pts.length > 1)
				{
					var from = getEnd(state, true, pts[0]);
					var to = getEnd(state, false, pts[pts.length - 1]);

					if (from != null && to != null && from != to)
					{
						var dir = roads.getDirection(state.style);
						var offsets = roads.getLaneOffsets(state.style);

						if (dir >= 0)
						{
							addLink(state.cell.id + '>', from, to, pts, offsets);
						}

						if (dir <= 0)
						{
							addLink(state.cell.id + '<', to, from, pts.slice().reverse(), offsets);
						}
					}
				}
			}
		}

		for (var i = 0; i < result.crossings.length; i++)
		{
			var junction = result.crossings[i];

			if (junction.ring != null)
			{
				result.cells += junction.ring.length;
			}

			for (var j = 0; j < junction.fanIn.length; j++)
			{
				junction.capacity = Math.max(junction.capacity, junction.fanIn[j].cells.length);
			}
		}

		if (result.cells > maxNetworkCells)
		{
			result = createEmptyNetwork();
			result.tooLarge = true;
		}

		for (var i = 0; i < result.crossings.length; i++)
		{
			var junction = result.crossings[i];

			if (junction.light > 0)
			{
				createPhases(junction);

				if (junction.phases != null)
				{
					result.lights++;
				}
			}

			if (junction.fanOut.length > 0)
			{
				result.origins.push(junction);
			}

			if (junction.fanIn.length > 0)
			{
				result.dests.push(junction);
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

	/**
	 * Removes the given car from its cell and from the simulation.
	 */
	function remove(v)
	{
		if (v.ring != null)
		{
			v.ring.ring[v.cell] = null;
			v.ring.vehicles--;
		}
		else
		{
			v.link.cells[v.lane][v.cell] = null;
			v.link.vehicles--;
		}

		removeActive(v);
	};

	function park(v)
	{
		removeActive(v);
		sim.arrived++;
		sim.travel += sim.time - v.start;
		sim.driven += v.driven;
	};

	/**
	 * Gives the car the fastest route from the junction it drives to.
	 */
	function replan(v)
	{
		var from = v.getJunction();
		var route = (from == v.dest) ? [] : getShortestPath(from, v.dest);

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
			v.prevRing = v.ring;
			v.prevTransit = v.transit;
			v.prevLane = v.lane;
			v.prevCell = v.cell;
			v.prevProgress = (v.transit != null) ? getProgress(v.transit) : 0;
			v.curve = null;
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
	 * Returns the free cell of the given cells nearest to the given cell,
	 * looking behind first, or -1.
	 */
	function findFreeCell(cells, cell)
	{
		for (var d = 0; d < cells.length; d++)
		{
			if (cell - d >= 0 && cells[cell - d] == null)
			{
				return cell - d;
			}
			else if (d > 0 && cell + d < cells.length && cells[cell + d] == null)
			{
				return cell + d;
			}
		}

		return -1;
	};

	/**
	 * Returns the links of the new network with the keys of the given links
	 * from the given index on, or null if one is gone or they no longer
	 * connect from the given junction on to the given destination.
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
	 * Moves the cars of the old network to the links with the same key and
	 * the roundabouts with the same ID in the new one. Cars keep their
	 * routes if all links are still there, else they get new ones. Cars on
	 * removed links and roundabouts are removed.
	 */
	function transferCars(old)
	{
		var queued = [];

		for (var i = 0; i < old.crossings.length; i++)
		{
			var prev = old.crossings[i];
			var junction = net.crossingMap.get(prev.id);

			if (junction != null && junction.ring == null)
			{
				junction.phase = (junction.phases != null) ? prev.phase % junction.phases.length : 0;
				junction.counter = prev.counter;
				junction.finger = prev.finger;
			}

			if (prev.ring != null)
			{
				for (var j = 0; j < prev.ring.length; j++)
				{
					var v = prev.ring[j];

					if (v != null)
					{
						var cell = (junction != null && junction.ring != null) ? findFreeCell(junction.ring,
							Math.round(j * junction.ring.length / prev.ring.length) % junction.ring.length) : -1;

						if (cell >= 0)
						{
							junction.ring[cell] = v;
							junction.vehicles++;
							v.ring = junction;
							v.cell = cell;
						}
						else
						{
							removeActive(v);
						}
					}
				}
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

			// Cars on their way through the crossing enter the link
			for (var k = 0; k < link.transit.length; k++)
			{
				for (var j = 0; j < link.transit[k].length; j++)
				{
					var v = link.transit[k][j].v;
					v.transit = null;

					if (next != null && next.place(v, Math.min(k, next.cells.length - 1), 0))
					{
						v.index++;
					}
					else
					{
						removeActive(v);
					}
				}
			}

			for (var k = 0; k < link.cells.length; k++)
			{
				for (var j = link.out; j >= 0; j--)
				{
					var v = link.cells[k][j];

					if (v != null && (next == null || !next.place(v, Math.min(k, next.cells.length - 1),
						Math.round(j * next.out / link.out))))
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
			var route = mapRoute(v.route, v.index, v.getJunction(), v.dest);
			v.route = (route != null) ? route : [];
			v.index = 0;
			v.prevLink = null;
			v.prevRing = null;

			// Removes cars that can no longer reach their destination
			if (v.dest == null || (route == null && !replan(v)))
			{
				remove(v);
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

	function createNode(name, parent, attrs)
	{
		var node = document.createElementNS(mxConstants.NS_SVG, name);

		for (var key in attrs)
		{
			node.setAttribute(key, attrs[key]);
		}

		if (parent != null)
		{
			parent.appendChild(node);
		}

		return node;
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
		var root = createNode('g', null, {});
		root.style.pointerEvents = 'none';
		overlay = {root: root, scale: graph.view.scale, roads: createNode('g', root, {}),
			bars: createNode('g', root, {}), cars: createNode('g', root, {}),
			heads: createNode('g', root, {})};
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
	 * Returns the scale of the traffic light heads, which are 14 units high
	 * but at least 18 pixels up to 8 times their size.
	 */
	function getHeadScale()
	{
		return Math.min(8, Math.max(1, 18 / 14 / graph.view.scale));
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
		var w = getSize(0.3, 2);
		var bw = getSize(0.3, 3);
		var hs = getHeadScale();

		sim.active.forEach(function(v)
		{
			v.node.setAttribute('r', r);
		});

		for (var i = 0; i < net.links.length; i++)
		{
			for (var k = 0; net.links[i].nodes != null && k < net.links[i].nodes.length; k++)
			{
				net.links[i].nodes[k].setAttribute('stroke-width', w);
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var signals = net.crossings[i].signals;

			for (var j = 0; signals != null && j < signals.length; j++)
			{
				signals[j].bar.setAttribute('stroke-width', bw);
				signals[j].head.setAttribute('transform', 'translate(' + signals[j].x + ',' +
					signals[j].y + ') scale(' + hs + ')');
			}
		}
	};

	/**
	 * Adds the stop bar and the head of the traffic light at the end of the
	 * given link, which shows the signal of the given phase.
	 */
	function addSignal(crossing, link, phase)
	{
		var pts = link.points;
		var p0 = pts[pts.length - 2];
		var p1 = pts[pts.length - 1];
		var len = roads.getDistance(p0, p1);
		var dx = (len > 0) ? (p1.x - p0.x) / len : 1;
		var dy = (len > 0) ? (p1.y - p0.y) / len : 0;
		var lw = (link.offsets.length > 1) ? Math.abs(link.offsets[1] - link.offsets[0]) : roads.laneWidth;
		var a = link.offsets[0] - lw / 2;
		var b = link.offsets[link.offsets.length - 1] + lw / 2;
		var x = p1.x - dx;
		var y = p1.y - dy;

		// Bar across the lanes, head on the right of the road before it
		var bar = createNode('line', overlay.bars, {x1: x - dy * a, y1: y + dx * a,
			x2: x - dy * b, y2: y + dx * b, 'stroke-width': getSize(0.3, 3)});
		var signal = {phase: phase, bar: bar, x: p1.x - dx * 9 - dy * (b + 6),
			y: p1.y - dy * 9 + dx * (b + 6), lamps: []};
		signal.head = createNode('g', overlay.heads, {transform: 'translate(' +
			signal.x + ',' + signal.y + ') scale(' + getHeadScale() + ')'});
		createNode('rect', signal.head, {x: -3, y: -7, width: 6, height: 14, rx: 1.5,
			fill: '#202124', stroke: '#ffffff', 'stroke-width': 0.6});

		for (var i = 0; i < 3; i++)
		{
			signal.lamps.push(createNode('circle', signal.head, {cx: 0, cy: -4.2 + 4.2 * i, r: 1.7}));
		}

		crossing.signals.push(signal);
	};

	/**
	 * Paints the density of the lanes and the traffic lights.
	 */
	function paintNetwork()
	{
		clearChildren(overlay.roads);
		clearChildren(overlay.bars);
		clearChildren(overlay.heads);

		for (var i = 0; i < net.links.length; i++)
		{
			var link = net.links[i];
			link.nodes = null;
			link.hue = null;

			if (config.density)
			{
				link.nodes = [];

				for (var k = 0; k < link.paths.length; k++)
				{
					var pts = link.paths[k].points;
					var d = [];

					for (var j = 0; j < pts.length; j++)
					{
						d.push(((j == 0) ? 'M' : 'L') + pts[j].x + ' ' + pts[j].y);
					}

					link.nodes.push(createNode('path', overlay.roads, {d: d.join(' '), fill: 'none',
						'stroke-width': getSize(0.3, 2), 'stroke-linecap': 'round', 'stroke-opacity': '0.35'}));
				}
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var crossing = net.crossings[i];
			crossing.signals = null;

			if (crossing.phases != null)
			{
				crossing.signals = [];

				for (var j = 0; j < crossing.phases.length; j++)
				{
					for (var k = 0; k < crossing.phases[j].length; k++)
					{
						addSignal(crossing, crossing.phases[j][k], j);
					}
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

			if (link.nodes != null)
			{
				// Green when free, red at half of the cells (stop and go)
				var density = Math.min(1, 2 * link.vehicles / link.cells.length / (link.out + 1));
				var hue = Math.round(120 * (1 - density));

				if (hue != link.hue)
				{
					for (var k = 0; k < link.nodes.length; k++)
					{
						link.nodes[k].setAttribute('stroke', 'hsl(' + hue + ',85%,45%)');
					}

					link.hue = hue;
				}
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var crossing = net.crossings[i];

			for (var j = 0; crossing.signals != null && j < crossing.signals.length; j++)
			{
				var signal = crossing.signals[j];
				var state = crossing.getSignal(signal.phase);

				if (state != signal.state)
				{
					signal.state = state;
					signal.bar.setAttribute('stroke', lampColors[2 - state][0]);

					for (var k = 0; k < 3; k++)
					{
						signal.lamps[k].setAttribute('fill', lampColors[k][(k == 2 - state) ? 0 : 1]);
					}
				}
			}
		}
	};

	/**
	 * Paints the cars between their previous and current position.
	 */
	function paintCars(alpha)
	{
		sim.active.forEach(function(v)
		{
			var pt = v.getPoint(false);
			var curve = (v.transit != null) ? v.transit.curve : v.curve;

			// Along the end of the last link and the curve through the crossing
			if (alpha < 1 && curve != null && curve.length > 0 &&
				(v.prevTransit == null || v.prevTransit.curve == curve))
			{
				var link = (v.prevTransit == null) ? v.prevLink : null;
				var size = (link != null) ? link.length / (link.out + 1) : 0;
				var d0 = (link != null) ? (link.out - v.prevCell) * size : 0;
				var s0 = (v.prevTransit != null) ? v.prevProgress : 0;
				var d = alpha * (d0 + (((v.transit != null) ? getProgress(v.transit) : 1) - s0) * curve.length);

				pt = (d < d0) ? link.getPoint(v.prevLane, v.prevCell + d / size) :
					getCurvePoint(curve, s0 + (d - d0) / curve.length);
			}
			else if (alpha < 1 && (v.prevLink != null || v.prevRing != null || v.prevTransit != null))
			{
				if (v.prevRing != null && v.prevRing == v.ring)
				{
					var n = v.ring.ring.length;
					pt = v.ring.getPoint(v.prevCell + ((v.cell - v.prevCell + n) % n) * alpha);
				}
				else if (v.prevLink != null && v.prevLink == v.link)
				{
					var cell = v.prevCell + (v.cell - v.prevCell) * alpha;
					var p0 = v.link.getPoint(v.prevLane, cell);
					var p1 = v.link.getPoint(v.lane, cell);
					pt = new mxPoint(p0.x + (p1.x - p0.x) * alpha, p0.y + (p1.y - p0.y) * alpha);
				}
				else
				{
					var p0 = v.getPoint(true);
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

	function formatCount(n, name)
	{
		return n + ' ' + name + ((n == 1) ? '' : 's');
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
			lines.push('No roads on this page. Open Shapes and connect junctions with roads, ' +
				'or choose an example.');
		}
		else
		{
			var junctions = [formatCount(net.crossings.length - net.roundabouts, 'crossing')];

			if (net.roundabouts > 0)
			{
				junctions.push(formatCount(net.roundabouts, 'roundabout'));
			}

			if (net.lights > 0)
			{
				junctions.push(formatCount(net.lights, 'traffic light'));
			}

			lines.push('Time: ' + formatTime(sim.time));
			lines.push('Network: ' + junctions.join(', ') + ', ' +
				formatCount(net.links.length, 'link') + ', ' + net.cells + ' cells');
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
				v.prevRing = null;
				v.prevTransit = v.transit;
				v.prevProgress = (v.transit != null) ? getProgress(v.transit) : 0;
				v.curve = null;
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
				roadCells += roads.getDistance(p0, p1) / cellLength;
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
