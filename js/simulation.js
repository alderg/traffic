/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Traffic simulation on a draw.io diagram, a port of sim.traffic (Gaudenz
 * Alder, ETH Zurich, 2000).
 *
 * Connectors are roads and the shapes they connect are junctions. Each road
 * has lanes from left to right in its drawn direction, each from source to
 * target or the opposite and with the turns it allows at its end (see
 * TrafficRoads.getLanePlan in js/roads.js): laneSpec in its style, else
 * lanes=<n> per direction of its arrows, where one arrow is a one-way road
 * and no or two arrows a road in both directions. Each direction is a link
 * of lanes of cells of 7.5 units (1 unit is 1 m, 1 step is 1 s) with the
 * Nagel-Schreckenberg update: change lanes, accelerate, brake to the gap,
 * dawdle, move. Cars keep their lane and change to the next lane when their
 * lane does not allow their next turn, earlier and into smaller gaps closer
 * to the end, to the left to pass slower cars, and back to the right when
 * there is space, in each case only if no car is close behind there.
 *
 * Crossings let as many cars pass per step as their widest incoming road has
 * lanes and take the incoming links in turns. Cars only pass from lanes
 * that allow their turn and drive through crossings on a curve at about one
 * cell per step to a lane of the next link that suits their turn and the
 * turn after it. A shape with trafficLight=<steps> in its style gives green
 * to the links of one approach axis at a time for that many steps,
 * followed by 3 steps of yellow. A shape with shape=roundabout is a ring
 * with lanes of cells where traffic circulates counterclockwise at one cell
 * per step: cars enter the outer lane when it is free before the entry,
 * move inward for exits that are far away and back out before their exit,
 * and leave from the outer lane where their next road starts. Free ends of
 * roads join the junction they are on or other free ends nearby, else they
 * are dead ends. Cars drive from a random junction to another on the
 * fastest route under the current speeds with the turns their lanes allow
 * and look for another route after waiting at a junction. Cars that do not
 * arrive in their lifetime leave the network.
 *
 * Cars, traffic lights and the density of the lanes are painted into the
 * overlay pane. With debug output, a summary, the links and junctions with
 * cars, the cars that stand longest and the events of the last second
 * (spawns, lane changes, crossings, roundabouts, arrivals, reroutes,
 * phases) go to the console once a second, with a warning if no car moves. The simulation never changes the diagram, only importFile
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
	var ringSpeed = 1;
	var overtakeProbability = 0.8;
	var keepRightProbability = 0.3;
	var turnCells = 12;
	var lifetimeFactor = 4;
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
	var config = {cars: 60, speed: 10, vmax: 5, noise: 0.25, reroute: true, density: true, lifetime: 300};

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
	var debug = false;
	var events = [];
	var lastDebug = 0;
	var debugSteps = 0;
	var debugTime = 0;

	/**
	 * Records the given event of the given car with the given data for the
	 * debug output.
	 */
	function record(type, v, data)
	{
		if (debug && events.length < 10000)
		{
			var e = {time: sim.time, event: type, car: (v != null) ? v.id : ''};

			for (var key in data)
			{
				e[key] = data[key];
			}

			events.push(e);
		}
	};

	/**
	 * One direction of a road: the given lanes of cells from one junction to
	 * another, from left to right with the offset of their center to the
	 * right of the given points, their turns and their index in the road. All
	 * lanes have the same number of cells, so that cars change lanes at the
	 * same place.
	 */
	function Link(key, from, to, points, lanes, lw)
	{
		this.key = key;
		this.from = from;
		this.to = to;
		this.points = points;
		this.lanes = lanes;
		this.laneWidth = lw;
		this.offsets = [];
		this.length = roads.getLengths(points)[points.length - 1];
		this.paths = [];
		this.cells = [];
		this.transit = [];
		this.counts = [];
		this.adjacent = [];

		var n = Math.min(maxLinkCells, Math.max(2, Math.round(this.length / cellLength)));

		for (var k = 0; k < lanes.length; k++)
		{
			var pts = (lanes[k].offset != 0) ? roads.offsetPoints(points, lanes[k].offset) : points;
			this.offsets.push(lanes[k].offset);
			this.paths.push({points: pts, lengths: roads.getLengths(pts)});
			this.cells.push(new Array(n).fill(null));
			this.transit.push([]);
			this.counts.push(0);
			this.adjacent.push(k > 0 && Math.abs(lanes[k].index - lanes[k - 1].index) == 1);
		}

		this.out = n - 1;
		this.index = 0;
		this.queue = [];
		this.vehicles = 0;
		this.vavg = 0;
		this.merged = false;
		this.moves = null;
		this.reach = null;
		this.open = false;
		this.nodes = null;
		this.hues = null;
		this.startCell = -1;
		this.endCell = -1;
	};

	/**
	 * Returns the turn to the given next link: l, s or r.
	 */
	Link.prototype.getTurn = function(next)
	{
		return (this.moves != null && this.moves.has(next)) ? this.moves.get(next) : 's';
	};

	/**
	 * Returns true if the given lane allows the turn to the given next link,
	 * always at roundabouts and on links where no lane allows any turn.
	 */
	Link.prototype.allows = function(lane, next)
	{
		var turns = this.lanes[lane].turns;

		return next == null || turns == null || this.open || this.to.rings != null ||
			turns.indexOf(this.getTurn(next)) >= 0;
	};

	/**
	 * Returns true if the given lanes are next to each other in the road or
	 * connected by lanes that are.
	 */
	Link.prototype.isConnected = function(k, l)
	{
		for (var i = Math.min(k, l) + 1; i <= Math.max(k, l); i++)
		{
			if (!this.adjacent[i])
			{
				return false;
			}
		}

		return true;
	};

	/**
	 * Returns -1 or 1 for the side of the nearest connected lane that allows
	 * the turn to the given next link or 0 if there is none.
	 */
	Link.prototype.getTurnSide = function(k, next)
	{
		for (var d = 1; d < this.cells.length; d++)
		{
			for (var s = -1; s <= 1; s += 2)
			{
				var l = k + s * d;

				if (l >= 0 && l < this.cells.length && this.allows(l, next) && this.isConnected(k, l))
				{
					return s;
				}
			}
		}

		return 0;
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
	 * Returns true if a car can change from lane k to lane l at the given cell
	 * with the given number of free cells behind it.
	 */
	Link.prototype.canChange = function(k, l, cell, behind)
	{
		return l >= 0 && l < this.cells.length && Math.abs(k - l) == 1 && this.adjacent[Math.max(k, l)] &&
			this.cells[l][cell] == null && this.isFreeBehind(l, cell, behind);
	};

	/**
	 * Returns the lane with a free first cell, no cars on their way through
	 * the crossing to it and the most space ahead, preferring lanes that
	 * allow the turn to the given next link, or -1.
	 */
	Link.prototype.getFreeLane = function(next)
	{
		var result = -1;
		var best = -1;

		for (var k = 0; k < this.cells.length; k++)
		{
			if (this.cells[k][0] == null && this.transit[k].length == 0)
			{
				var rank = this.getGap(k, 0, config.vmax) + ((this.allows(k, next)) ? 100 : 0);

				if (rank > best)
				{
					best = rank;
					result = k;
				}
			}
		}

		return result;
	};

	/**
	 * Returns the lane where the given car can enter the link from its
	 * junction or -1. Through traffic and cars that start on the link take
	 * turns.
	 */
	Link.prototype.accept = function(v)
	{
		return (this.queue.length == 0 || this.merged) ? this.getFreeLane(v.after()) : -1;
	};

	/**
	 * Returns the lane, curve and steps for the given car to drive through
	 * the crossing from the given lane of the given link into this link, or
	 * null. The first cell must be free and the car at least one step behind
	 * the last car on its way to the lane. Lanes that allow the next turn
	 * come first, then right lanes for right turns, left lanes for left
	 * turns and the same lane from the right for straight ahead, then space.
	 * Through traffic and cars that start on the link take turns.
	 */
	Link.prototype.chooseEntry = function(v, link, k)
	{
		var result = null;

		if (this.queue.length == 0 || this.merged)
		{
			var turn = link.getTurn(this);
			var after = v.after();
			var n = this.cells.length;
			var best = Infinity;

			for (var l = 0; l < n; l++)
			{
				var cars = this.transit[l];

				if (this.cells[l][0] == null)
				{
					var curve = createCurve(link, k, this, l);
					var steps = getTransitSteps(curve);

					if (cars.length == 0 || cars[cars.length - 1].left < steps - 1)
					{
						var place = (turn == 'r') ? n - 1 - l : ((turn == 'l') ? l :
							Math.abs((n - 1 - l) - (link.cells.length - 1 - k)));
						var rank = ((this.allows(l, after)) ? 0 : 100) + 10 * place -
							this.getGap(l, 0, config.vmax) + cars.length;

						if (rank < best)
						{
							best = rank;
							result = {lane: l, curve: curve, steps: steps};
						}
					}
				}
			}
		}

		return result;
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
	 * Returns the lane that the given car in lane k and the given cell
	 * changes to. Cars in lanes that do not allow their next turn move
	 * toward one that does, into gaps of one cell in the last turnCells
	 * cells. Others pass on the left when they are blocked and there is more
	 * space, and go back to the right when there is space for their speed.
	 */
	Link.prototype.chooseLane = function(v, k, cell)
	{
		var vmax = config.vmax;
		var next = v.next();
		var left = this.out - cell;

		if (next != null && !this.allows(k, next))
		{
			var side = this.getTurnSide(k, next);

			return (side != 0 && this.canChange(k, k + side, cell, (left > turnCells) ? vmax : 1)) ? k + side : k;
		}

		if (left > 0)
		{
			var gap = this.getGap(k, cell, vmax);

			if (gap < Math.min(v.v + 1, vmax) && this.canChange(k, k - 1, cell, vmax) &&
				(left > turnCells || this.allows(k - 1, next)) && this.getGap(k - 1, cell, vmax) > gap &&
				Math.random() < overtakeProbability)
			{
				return k - 1;
			}

			if (this.canChange(k, k + 1, cell, vmax) && (left > turnCells || this.allows(k + 1, next)) &&
				this.getGap(k + 1, cell, vmax) >= Math.min(v.v + 2, vmax) && Math.random() < keepRightProbability)
			{
				return k + 1;
			}
		}

		return k;
	};

	/**
	 * Changes lanes, deciding for all cars first, so that the order of the
	 * lanes does not matter.
	 */
	Link.prototype.changeLanes = function()
	{
		var moves = [];

		for (var k = 0; k < this.cells.length; k++)
		{
			for (var i = 0; i <= this.out; i++)
			{
				var v = this.cells[k][i];

				if (v != null)
				{
					var l = this.chooseLane(v, k, i);

					if (l != k)
					{
						moves.push([v, k, l, i]);
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
				record('lane', m[0], {link: this.key, from: m[1], to: m[2], cell: m[3]});
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
			for (var k = 0; k < this.counts.length; k++)
			{
				this.counts[k] = 0;
			}

			return;
		}

		// Cars enter traffic at the start of their first link
		if (this.queue.length > 0)
		{
			var lane = this.getFreeLane(this.queue[0].after());

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
			var count = 0;

			// Accelerates, brakes to the gap and dawdles
			for (var i = 0; i <= out; i++)
			{
				var v = cells[i];

				if (v != null)
				{
					v.v = Math.min(this.getGap(k, i, vmax), vmax, v.v + 1);
					count++;

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

			this.counts[k] = count;
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
	 * incoming links with green in turns. Cars only pass from lanes that
	 * allow their turn, unless they waited for two reroutes.
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
				record('phase', null, {junction: this.id, phase: this.phase});
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

				if (next != null && next.from == this && (link.allows(k, next) || v.wait > 2 * replanSteps))
				{
					var entry = next.chooseEntry(v, link, k);

					if (entry != null)
					{
						record('cross', v, {junction: this.id, from: link.key + ':' + k,
							to: next.key + ':' + entry.lane, steps: entry.steps});
						next.addTransit(link.pop(k), entry.lane, entry.steps, entry.curve);
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
	 * Returns the turn from the given link to the given next link: l for
	 * left and U-turns, r for right and s for straight ahead within 30
	 * degrees (y down).
	 */
	function getTurn(link, next)
	{
		var a = getDirection(link.points, false);
		var b = getDirection(next.points, true);
		var angle = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);

		return (angle < -Math.PI / 6 || angle > 5 * Math.PI / 6) ? 'l' : ((angle > Math.PI / 6) ? 'r' : 's');
	};

	/**
	 * Returns a quadratic curve from p0 in direction a to p1 in direction b
	 * through the intersection of the directions or a line if they do not
	 * intersect in front of both points.
	 */
	function createCurveBetween(p0, a, p1, b)
	{
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
	 * Returns the path of a car through a crossing from the last cell of the
	 * given lane of a link to the first cell of the given lane of the next.
	 */
	function createCurve(link, lane, next, nextLane)
	{
		return createCurveBetween(link.getPoint(lane, link.out), getDirection(link.paths[lane].points, false),
			next.getPoint(nextLane, 0), getDirection(next.paths[nextLane].points, true));
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
	 * Adds points along the given curve to the given points.
	 */
	function addCurvePoints(pts, curve)
	{
		for (var i = 0; i <= 8; i++)
		{
			pts.push(getCurvePoint(curve, i / 8));
		}

		return pts;
	};

	/**
	 * Returns the point at the given fraction of the length of the given
	 * points.
	 */
	function getPathPoint(pts, f)
	{
		var lengths = roads.getLengths(pts);

		return roads.getPointAt(pts, lengths, f * lengths[lengths.length - 1]) ||
			pts[(f < 0.5) ? 0 : pts.length - 1];
	};

	/**
	 * Returns the fraction of the way through the crossing.
	 */
	function getProgress(t)
	{
		return (t.steps - t.left) / t.steps;
	};

	/**
	 * Roundabout: a ring of lanes of cells around the center at the given
	 * radii from the outside in, where traffic circulates counterclockwise.
	 * Cell i is at the angle -2 pi i / n (y down) in all lanes. Cars enter
	 * the outer lane from the end of their link when it is free up to
	 * ringSpeed cells before the entry, move inward for exits that are far
	 * away and back out before their exit, and leave from the outer lane at
	 * the cell where their next link starts, or circle once more if it is
	 * full.
	 */
	function Roundabout(id, x, y, radii)
	{
		Crossing.call(this, id, x, y, 0);
		this.radii = radii;
		this.size = Math.max(6, Math.round(2 * Math.PI * radii[0] / cellLength));
		this.rings = [];
		this.vehicles = 0;

		for (var l = 0; l < radii.length; l++)
		{
			this.rings.push(new Array(this.size).fill(null));
		}
	};

	/**
	 * Returns the cell nearest to the given point.
	 */
	Roundabout.prototype.getCell = function(pt)
	{
		var n = this.size;
		var a = Math.atan2(pt.y - this.y, pt.x - this.x);

		return ((Math.round(-a * n / (2 * Math.PI)) % n) + n) % n;
	};

	/**
	 * Returns the point of the given cell, which may be fractional, in the
	 * given lane or at the given radius.
	 */
	Roundabout.prototype.getPoint = function(lane, cell, radius)
	{
		var a = -2 * Math.PI * cell / this.size;
		var r = (radius != null) ? radius : this.radii[lane];

		return new mxPoint(this.x + r * Math.cos(a), this.y + r * Math.sin(a));
	};

	/**
	 * Returns the direction of traffic at the given cell.
	 */
	Roundabout.prototype.getTangent = function(cell)
	{
		var a = -2 * Math.PI * cell / this.size;

		return new mxPoint(Math.sin(a), -Math.cos(a));
	};

	/**
	 * Returns true if the given cell and count cells before it are free in
	 * the given lane.
	 */
	Roundabout.prototype.isFree = function(lane, cell, count)
	{
		var n = this.size;

		for (var d = 0; d <= count; d++)
		{
			if (this.rings[lane][(cell - d + n) % n] != null)
			{
				return false;
			}
		}

		return true;
	};

	/**
	 * Returns the cells from the given cell to the exit of the given car.
	 */
	Roundabout.prototype.getExitDistance = function(v, cell)
	{
		var next = v.next();

		return (next != null) ? (next.startCell - cell + this.size) % this.size : 0;
	};

	/**
	 * Moves cars inward if their exit is far away and outward before it, if
	 * the cell next to them and ringSpeed cells behind it are free.
	 */
	Roundabout.prototype.changeLanes = function(vmax)
	{
		var n = this.size;
		var lanes = this.rings.length;
		var moves = [];

		for (var l = 0; l < lanes; l++)
		{
			for (var i = 0; i < n; i++)
			{
				var v = this.rings[l][i];

				if (v != null)
				{
					var target = Math.min(lanes - 1, Math.floor(this.getExitDistance(v, i) * lanes / n));
					var t = l + ((target > l) ? 1 : ((target < l) ? -1 : 0));

					if (t != l && this.isFree(t, i, vmax))
					{
						moves.push([v, l, t, i]);
					}
				}
			}
		}

		for (var j = 0; j < moves.length; j++)
		{
			var m = moves[j];

			if (this.rings[m[2]][m[3]] == null)
			{
				this.rings[m[1]][m[3]] = null;
				this.rings[m[2]][m[3]] = m[0];
				m[0].ringLane = m[2];
				record('ringLane', m[0], {junction: this.id, from: m[1], to: m[2], cell: m[3]});
			}
		}
	};

	Roundabout.prototype.step = function()
	{
		var n = this.size;
		var vmax = Math.min(config.vmax, ringSpeed);

		if (this.vehicles > 0)
		{
			if (this.rings.length > 1)
			{
				this.changeLanes(vmax);
			}

			var cars = [];

			// Speeds from the gaps before the move, then all cars move at once
			for (var l = 0; l < this.rings.length; l++)
			{
				var ring = this.rings[l];

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
						var d = this.getExitDistance(v, i);

						// Stops at the exit
						if (l == 0 && d > 0 && d < v.v)
						{
							v.v = d;
						}

						cars.push(v);
					}
				}
			}

			for (var i = 0; i < cars.length; i++)
			{
				this.rings[cars[i].ringLane][cars[i].cell] = null;
			}

			for (var i = 0; i < cars.length; i++)
			{
				var v = cars[i];
				v.cell = (v.cell + v.v) % n;
				v.driven += v.v;
				this.rings[v.ringLane][v.cell] = v;
			}

			// Leaves the outer lane at the exit if the next link has space
			for (var i = 0; i < cars.length; i++)
			{
				var v = cars[i];
				var next = v.next();

				if (next == null)
				{
					this.rings[v.ringLane][v.cell] = null;
					this.vehicles--;
					park(v);
				}
				else if (v.ringLane == 0 && next.from == this && next.startCell == v.cell)
				{
					var lane = next.accept(v);

					if (lane >= 0)
					{
						this.rings[0][v.cell] = null;
						this.vehicles--;
						v.path = this.getExitPath(v, next, lane);
						record('ringExit', v, {junction: this.id, cell: v.cell, to: next.key + ':' + lane});
						next.enter(v, lane);
					}
				}
			}
		}

		// Enters the outer lane from the end of the incoming links if it is free
		for (var i = 0; i < this.fanIn.length; i++)
		{
			var link = this.fanIn[i];

			for (var k = 0; k < link.cells.length; k++)
			{
				var v = link.cells[k][link.out];
				var next = (v != null) ? v.next() : null;

				if (next != null && next.from == this && this.isFree(0, link.endCell, vmax))
				{
					var e = link.endCell;
					v.path = addCurvePoints((v.prevLink != null) ? [v.getPoint(true)] : [],
						createCurveBetween(link.getPoint(k, link.out), getDirection(link.paths[k].points, false),
						this.getPoint(0, e), this.getTangent(e)));
					record('ringEnter', v, {junction: this.id, cell: e, from: link.key + ':' + k});
					link.pop(k);
					this.rings[0][e] = v;
					v.link = null;
					v.ring = this;
					v.ringLane = 0;
					v.cell = e;
					v.v = 0;
					v.wait = 0;
					this.vehicles++;
				}
			}
		}
	};

	/**
	 * Returns the points of the way of the given car in this step around the
	 * ring from its previous cell to its exit and on a curve to the first
	 * cell of the given lane of the given next link.
	 */
	Roundabout.prototype.getExitPath = function(v, next, lane)
	{
		var n = this.size;
		var d = (v.prevRing == this) ? (v.cell - v.prevCell + n) % n : 0;
		var pts = [];

		for (var i = 0; i < d; i++)
		{
			pts.push(this.getPoint(0, v.prevCell + i, (i == 0) ? this.radii[v.prevRingLane] : null));
		}

		return addCurvePoints(pts, createCurveBetween(this.getPoint(0, v.cell), this.getTangent(v.cell),
			next.getPoint(lane, 0), getDirection(next.paths[lane].points, true)));
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
		this.end = 0;
		this.link = null;
		this.ring = null;
		this.transit = null;
		this.curve = null;
		this.path = null;
		this.lane = 0;
		this.ringLane = 0;
		this.cell = 0;
		this.v = 0;
		this.wait = 0;
		this.stopped = 0;
		this.driven = 0;
		this.prevLink = null;
		this.prevRing = null;
		this.prevTransit = null;
		this.prevLane = 0;
		this.prevRingLane = 0;
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
	 * Returns the link after the next one or null.
	 */
	Vehicle.prototype.after = function()
	{
		return (this.index + 1 < this.route.length) ? this.route[this.index + 1] : null;
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

		return (ring != null) ? ring.getPoint((prev) ? this.prevRingLane : this.ringLane, cell) :
			link.getPoint((prev) ? this.prevLane : this.lane, cell);
	};

	/**
	 * Binary heap for the shortest paths.
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
	 * Returns the fastest route from the given first links to the given
	 * junction under the current speeds with the turns that the lanes allow,
	 * or null if there is none (Dijkstra on links).
	 */
	function findRoute(firsts, end)
	{
		// Reuses the arrays of the network, entries of other searches are stale
		if (net.stamps == null)
		{
			net.dist = new Float64Array(net.links.length);
			net.prev = new Array(net.links.length);
			net.stamps = new Uint32Array(net.links.length);
		}

		var search = ++net.search;
		var dist = net.dist;
		var prev = net.prev;
		var stamps = net.stamps;
		var heap = new Heap();

		for (var i = 0; i < firsts.length; i++)
		{
			var k = firsts[i].index;
			dist[k] = firsts[i].getCost();
			prev[k] = null;
			stamps[k] = search;
			heap.push(dist[k], firsts[i]);
		}

		while (heap.keys.length > 0)
		{
			var top = heap.pop();
			var link = top.value;

			if (top.key > dist[link.index])
			{
				continue;
			}

			if (link.to == end)
			{
				var path = [];

				while (link != null)
				{
					path.push(link);
					link = prev[link.index];
				}

				return path.reverse();
			}

			var next = link.to.fanOut;

			for (var j = 0; j < next.length; j++)
			{
				var k = next[j].index;
				var d = top.key + next[j].getCost();

				if (link.reach.has(next[j]) && (stamps[k] != search || d < dist[k]))
				{
					stamps[k] = search;
					dist[k] = d;
					prev[k] = link;
					heap.push(d, next[j]);
				}
			}
		}

		return null;
	};

	/**
	 * Returns the fastest route from the given junction to the other.
	 */
	function getRoute(start, end)
	{
		return (start == end) ? [] : findRoute(start.fanOut, end);
	};

	/**
	 * Returns the fastest route after the given link to the given junction,
	 * starting with a turn that the given lane allows or any lane if it is
	 * null.
	 */
	function getRouteFrom(link, lane, end)
	{
		return (link.to == end) ? [] : findRoute(link.to.fanOut.filter(function(next)
		{
			return (lane != null) ? link.allows(lane, next) : link.reach.has(next);
		}), end);
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
			origins: [], dests: [], cells: 0, lanes: 0, roundabouts: 0, lights: 0, ends: [],
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
						roads.getRing(state.style, b.width, b.height).radii);
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

		function addLink(key, from, to, points, lanes, lw)
		{
			var link = new Link(key, from, to, points, lanes, lw);

			if (!isFinite(link.length))
			{
				return;
			}

			if (from.rings != null)
			{
				link.startCell = from.getCell(points[0]);
			}

			if (to.rings != null)
			{
				link.endCell = to.getCell(points[points.length - 1]);
			}

			link.index = result.links.length;
			from.fanOut.push(link);
			to.fanIn.push(link);
			result.links.push(link);
			result.linkMap.set(key, link);
			result.cells += link.cells.length * (link.out + 1);
			result.lanes += link.cells.length;
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
						var plan = roads.getLanePlan(state.style);
						var lw = roads.getLaneWidth(state.style);
						var forward = roads.getTravelLanes(plan, 1, lw);
						var backward = roads.getTravelLanes(plan, -1, lw);

						if (forward.length > 0)
						{
							addLink(state.cell.id + '>', from, to, pts, forward, lw);
						}

						if (backward.length > 0)
						{
							addLink(state.cell.id + '<', to, from, pts.slice().reverse(), backward, lw);
						}
					}
				}
			}
		}

		for (var i = 0; i < result.crossings.length; i++)
		{
			var junction = result.crossings[i];

			if (junction.rings != null)
			{
				result.cells += junction.size * junction.rings.length;
			}

			// Turns to the next links and the next links that a lane allows
			for (var j = 0; j < junction.fanIn.length; j++)
			{
				var link = junction.fanIn[j];
				junction.capacity = Math.max(junction.capacity, link.cells.length);
				link.moves = new Map();
				link.reach = new Set();

				for (var k = 0; k < junction.fanOut.length; k++)
				{
					link.moves.set(junction.fanOut[k], getTurn(link, junction.fanOut[k]));
				}

				for (var k = 0; k < junction.fanOut.length; k++)
				{
					for (var l = 0; l < link.cells.length && !link.reach.has(junction.fanOut[k]); l++)
					{
						if (link.allows(l, junction.fanOut[k]))
						{
							link.reach.add(junction.fanOut[k]);
						}
					}
				}

				if (link.reach.size == 0)
				{
					link.open = true;
					link.reach = new Set(junction.fanOut);
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
			arrived: 0, expired: 0, travel: 0, driven: 0, replanned: 0};
	};

	/**
	 * Returns the seconds that a car on the given route has to arrive after
	 * it starts: the lifetime in the config, or four times the time of the
	 * route without other cars if that is longer.
	 */
	function getLifetime(route)
	{
		var cells = 0;

		for (var i = 0; i < route.length; i++)
		{
			cells += route[i].out + 1;
		}

		return Math.max(config.lifetime, Math.round(lifetimeFactor *
			(cells / config.vmax + 3 * route.length)));
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
			var route = (start != end) ? getRoute(start, end) : null;

			if (route != null)
			{
				route[0].queue.push(new Vehicle(sim.created++, route, sim.time));
				sim.queued++;
			}
		}
	};

	function addActive(v)
	{
		v.end = sim.time + getLifetime(v.route);
		record('spawn', v, {link: v.route[0].key, dest: v.dest.id, lifetime: v.end - sim.time});
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
			v.ring.rings[v.ringLane][v.cell] = null;
			v.ring.vehicles--;
		}
		else
		{
			v.link.cells[v.lane][v.cell] = null;
			v.link.vehicles--;
		}

		removeActive(v);
	};

	/**
	 * Removes the given car, which has not arrived in its lifetime, from the
	 * network.
	 */
	function expire(v)
	{
		record('expire', v, {place: getPlace(v), age: sim.time - v.start, dest: v.dest.id});
		sim.expired++;

		if (v.transit != null)
		{
			var cars = v.transit.link.transit[v.transit.lane];
			cars.splice(cars.indexOf(v.transit), 1);
			v.transit = null;
			removeActive(v);
		}
		else
		{
			remove(v);
		}
	};

	function park(v)
	{
		record('arrive', v, {junction: v.dest.id, trip: sim.time - v.start});
		removeActive(v);
		sim.arrived++;
		sim.travel += sim.time - v.start;
		sim.driven += v.driven;
	};

	/**
	 * Gives the car the fastest route from the junction it drives to, with a
	 * turn that its lane allows at the end of its link.
	 */
	function replan(v)
	{
		var route = (v.ring != null) ? getRoute(v.ring, v.dest) :
			getRouteFrom(v.link, (v.cell == v.link.out) ? v.lane : null, v.dest);

		if (route != null)
		{
			v.route = route;
			v.index = 0;
			record('reroute', v, {junction: v.getJunction().id, links: route.length});
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
			if (sim.time >= v.end)
			{
				expire(v);

				return;
			}

			v.stopped = (v.v == 0 && v.transit == null) ? v.stopped + 1 : 0;
			v.prevLink = v.link;
			v.prevRing = v.ring;
			v.prevTransit = v.transit;
			v.prevLane = v.lane;
			v.prevRingLane = v.ringLane;
			v.prevCell = v.cell;
			v.prevProgress = (v.transit != null) ? getProgress(v.transit) : 0;
			v.curve = null;
			v.path = null;
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

			if (junction != null && junction.rings == null)
			{
				junction.phase = (junction.phases != null) ? prev.phase % junction.phases.length : 0;
				junction.counter = prev.counter;
				junction.finger = prev.finger;
			}

			for (var l = 0; prev.rings != null && l < prev.rings.length; l++)
			{
				for (var j = 0; j < prev.size; j++)
				{
					var v = prev.rings[l][j];

					if (v != null)
					{
						var lane = (junction != null && junction.rings != null) ?
							Math.min(l, junction.rings.length - 1) : -1;
						var cell = (lane >= 0) ? findFreeCell(junction.rings[lane],
							Math.round(j * junction.size / prev.size) % junction.size) : -1;

						if (cell >= 0)
						{
							junction.rings[lane][cell] = v;
							junction.vehicles++;
							v.ring = junction;
							v.ringLane = lane;
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
			v.prevTransit = null;
			v.path = null;

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
				route = (start != null && dest != null && start != dest) ? getRoute(start, dest) : null;
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
		record('network', null, {junctions: net.crossings.length, links: net.links.length,
			lanes: net.lanes, cells: net.cells});

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
		var lw = link.laneWidth;
		var a = Math.min.apply(null, link.offsets) - lw / 2;
		var b = Math.max.apply(null, link.offsets) + lw / 2;
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
			link.hues = null;

			if (config.density)
			{
				link.nodes = [];
				link.hues = [];

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
					link.hues.push(null);
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

			// Green when free, red at half of the cells of a lane (stop and go)
			for (var k = 0; link.nodes != null && k < link.nodes.length; k++)
			{
				var hue = Math.round(120 * (1 - Math.min(1, 2 * link.counts[k] / (link.out + 1))));

				if (hue != link.hues[k])
				{
					link.nodes[k].setAttribute('stroke', 'hsl(' + hue + ',85%,45%)');
					link.hues[k] = hue;
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
					signal.bar.setAttribute('stroke', lampColors[state][0]);

					for (var k = 0; k < 3; k++)
					{
						signal.lamps[k].setAttribute('fill', lampColors[k][(k == state) ? 0 : 1]);
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

			// Into and out of roundabouts
			if (alpha < 1 && v.path != null)
			{
				pt = getPathPoint(v.path.concat([pt]), alpha);
			}
			// Along the end of the last link and the curve through the crossing
			else if (alpha < 1 && curve != null && curve.length > 0 &&
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
					var n = v.ring.size;
					var r = v.ring.radii[v.prevRingLane];
					pt = v.ring.getPoint(0, v.prevCell + ((v.cell - v.prevCell + n) % n) * alpha,
						r + (v.ring.radii[v.ringLane] - r) * alpha);
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
				formatCount(net.links.length, 'link') + ', ' + formatCount(net.lanes, 'lane') +
				', ' + net.cells + ' cells');
			lines.push('Cars: ' + sim.active.size + ' driving, ' + sim.queued + ' waiting to start');
			lines.push('Density: ' + (100 * sim.active.size / net.cells).toFixed(1) + ' %');
			lines.push('Arrived: ' + sim.arrived + ((sim.expired > 0) ?
				' (' + sim.expired + ' not arrived)' : ''));

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

			debugSteps += steps;
			debugTime += window.performance.now() - start;

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

		if (debug && now - lastDebug >= 1000)
		{
			logState();
			lastDebug = now;
		}
	};

	/**
	 * Returns where the given car is for the debug output.
	 */
	function getPlace(v)
	{
		return (v.transit != null) ? 'crossing ' + v.transit.link.from.id + ' to ' + v.transit.link.key +
			' lane ' + v.transit.lane : ((v.ring != null) ? 'roundabout ' + v.ring.id + ' lane ' +
			v.ringLane + ' cell ' + v.cell : 'link ' + v.link.key + ' lane ' + v.lane + ' cell ' +
			v.cell + '/' + v.link.out);
	};

	/**
	 * Writes a summary, the links and junctions with cars, the cars that
	 * stand longest and the events since the last call to the console, and
	 * a warning if no car moves.
	 */
	function logState()
	{
		var links = [];
		var junctions = [];
		var stopped = [];
		var moving = 0;
		var speed = 0;

		sim.active.forEach(function(v)
		{
			if (v.v > 0 || v.transit != null)
			{
				moving++;
				speed += (v.transit != null) ? 1 : v.v;
			}
			else if (v.stopped >= 10)
			{
				stopped.push(v);
			}
		});

		var placed = 0;

		for (var i = 0; i < net.links.length; i++)
		{
			var link = net.links[i];
			var transit = 0;

			for (var k = 0; k < link.transit.length; k++)
			{
				transit += link.transit[k].length;
				placed += link.transit[k].length;
			}

			for (var k = 0; k < link.cells.length; k++)
			{
				for (var j = 0; j < link.cells[k].length; j++)
				{
					placed += (link.cells[k][j] != null) ? 1 : 0;
				}
			}

			if (links.length < 500 && (link.vehicles > 0 || link.queue.length > 0 || transit > 0))
			{
				links.push({link: link.key, from: link.from.id, to: link.to.id, lanes: link.cells.length,
					cars: link.counts.join('/'), waiting: link.queue.length, crossing: transit,
					speed: Math.round(link.vavg * 100) / 100});
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var junction = net.crossings[i];

			for (var l = 0; junction.rings != null && l < junction.rings.length; l++)
			{
				for (var j = 0; j < junction.size; j++)
				{
					placed += (junction.rings[l][j] != null) ? 1 : 0;
				}
			}

			if (junctions.length < 500 && (junction.rings != null || junction.phases != null))
			{
				junctions.push({junction: junction.id, type: (junction.rings != null) ? 'roundabout' : 'traffic light',
					cars: (junction.rings != null) ? junction.vehicles : '', phase: (junction.phases != null) ?
					junction.phase + ' ' + ['red', 'yellow', 'green'][junction.getSignal(junction.phase)] : ''});
			}
		}

		stopped.sort(function(a, b)
		{
			return b.stopped - a.stopped;
		});

		var expired = events.filter(function(e)
		{
			return e.event == 'expire';
		});

		console.groupCollapsed('Traffic ' + formatTime(sim.time) + ': ' + sim.active.size + ' driving (' +
			moving + ' moving), ' + sim.queued + ' waiting, ' + sim.arrived + ' arrived, ' +
			sim.expired + ' not arrived, ' + events.length + ' events');
		console.log('Summary', {time: sim.time, driving: sim.active.size, moving: moving,
			standing: sim.active.size - moving, standing10s: stopped.length, waitingToStart: sim.queued,
			arrived: sim.arrived, notArrived: sim.expired, reroutes: sim.replanned, kmh: (moving > 0) ?
			Math.round(3.6 * cellLength * speed / sim.active.size) : 0,
			steps: debugSteps, msPerStep: (debugSteps > 0) ? Math.round(100 * debugTime / debugSteps) / 100 : 0});
		console.log('Network', {junctions: net.crossings.length, links: net.links.length, lanes: net.lanes,
			cells: net.cells, running: running, speed: config.speed});
		console.table(links);
		console.table(junctions);
		console.log('Cars standing for 10 s or more');
		console.table(stopped.slice(0, 50).map(function(v)
		{
			var next = v.next();

			return {car: v.id, standing: v.stopped, age: sim.time - v.start, place: getPlace(v),
				next: (next != null) ? next.key : '', dest: v.dest.id};
		}));
		console.table(events.slice(0, 1000));
		console.groupEnd();

		if (expired.length > 0)
		{
			console.info('Traffic ' + formatTime(sim.time) + ': ' + formatCount(expired.length, 'car') +
				' did not arrive in their lifetime and left');
			console.table(expired.slice(0, 100));
		}

		if (placed != sim.active.size)
		{
			console.warn('Traffic ' + formatTime(sim.time) + ': ' + placed + ' cars on the roads and ' +
				'junctions, but ' + sim.active.size + ' driving');
		}

		// No car moved in the last step, and the oldest stands for a while
		if (running && sim.active.size > 0 && moving == 0 && stopped.length > 0 &&
			stopped[0].stopped >= 30)
		{
			var places = [];

			for (var i = 0; i < stopped.length && places.length < 10; i++)
			{
				var id = stopped[i].getJunction().id;

				if (places.indexOf(id) < 0)
				{
					places.push(id);
				}
			}

			console.warn('Traffic ' + formatTime(sim.time) + ': no car moves, gridlock at junctions ' +
				places.join(', '));
		}

		events = [];
		debugSteps = 0;
		debugTime = 0;
	};

	function schedule()
	{
		if (frameId == null)
		{
			frameId = window.requestAnimationFrame(tick);
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
				v.path = null;
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

	var tick = roads.guard(frame, 'simulation frame');
	graph.model.addListener(mxEvent.CHANGE, roads.guard(invalidate, 'simulation model change'));

	// Opening a file starts a new simulation
	ui.editor.addListener('fileLoaded', roads.guard(function()
	{
		if (overlay != null)
		{
			reset();
		}
	}, 'simulation file loaded'));

	// Traced outlines of images move edges without a change of the model
	if (graph.refreshTracedOutlines != null)
	{
		var refreshTracedOutlines = graph.refreshTracedOutlines;

		graph.refreshTracedOutlines = roads.guard(function()
		{
			refreshTracedOutlines.apply(this, arguments);
			invalidate();
		}, 'simulation traced outlines');
	}

	var transform = roads.guard(updateTransform, 'simulation transform');
	graph.view.addListener(mxEvent.SCALE, transform);
	graph.view.addListener(mxEvent.TRANSLATE, transform);
	graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, transform);

	/**
	 * Returns the timing of the traffic light with the given ID in steps:
	 * the number of approach axes, green, yellow and the cycle, or null.
	 */
	function getLight(id)
	{
		var crossing = (net != null) ? net.crossingMap.get(id) : null;

		return (crossing != null && crossing.phases != null) ? {axes: crossing.phases.length,
			green: crossing.light, yellow: crossing.yellow,
			cycle: crossing.phases.length * (crossing.light + crossing.yellow)} : null;
	};

	/**
	 * Turns the debug output on or off.
	 */
	function setDebug(value)
	{
		debug = value;
		events = [];
		lastDebug = 0;
		schedule();
	};

	return {config: config, start: start, reset: reset, setRunning: setRunning,
		isRunning: function() { return running; }, setOption: setOption,
		importFile: importFile, getLight: getLight, setDebug: setDebug};
};
