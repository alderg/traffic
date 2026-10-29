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
 * lanes and take the incoming links in turns. Cars only pass from lanes that
 * allow their turn and drive through crossings on a curve at about one cell
 * per step to a lane of the next link that suits their turn and the turn
 * after it. Crossings of two roads without a light are joints in the road:
 * the first car in a lane looks past the end of its link into the next and
 * drives through at its speed in all lanes, without the turns of the lanes,
 * and cars that start there wait for a gap. A shape with
 * trafficLight=<steps> in its style gives green to the links of one approach
 * axis at a time for that many steps, followed by 3 steps of yellow. A shape
 * with shape=roundabout is a ring with lanes of cells where traffic
 * circulates counterclockwise at one cell per step: cars enter the outer
 * lane when it is free before the entry, move inward for exits that are far
 * away and back out before their exit, and leave from the outer lane where
 * their next road starts. Free ends of roads join the junction they are on
 * or other free ends nearby, else they are dead ends. Cars drive from a
 * random junction to another on the fastest route under the current speeds
 * with the turns their lanes allow and look for another route after waiting
 * at a junction. Cars that do not arrive in their lifetime leave the
 * network.
 *
 * Trucks, cars and fast cars have their own top speed, so that faster ones
 * pass slower ones where there is a free lane and queue behind them where
 * there is none. Vehicles are painted from above with the shape of their
 * type along their lane, turned in their direction through curves,
 * crossings, roundabouts and lane changes, and in the color of their speed
 * from blue to red. They, traffic lights and the density of the lanes are
 * painted into the overlay pane, and optionally labels with the cars that
 * are on each road and junction in view, on their way there, and that
 * entered and left. Each link and junction counts its cars for the
 * statistics of the selection (getStats). A click on a car selects it: its
 * route is colored from its start A to its destination B, a ring and a label
 * follow it, and getVehicle returns its data. The overlay has no pointer
 * events, so a mouse listener before those of draw.io tests clicks against
 * the positions of the cars, and drags edit the diagram as usual. With debug
 * output, a summary, the links and junctions with cars, the cars that stand
 * longest and the events of the last second (spawns, lane changes,
 * crossings, roundabouts, arrivals, reroutes, phases) go to the console once
 * a second, with a warning if no car moves. The simulation never changes the
 * diagram, only importFile inserts cells. This script runs in the window of
 * the editor after js/roads.js, whose lane geometry it uses:
 * TrafficSimulation(ui, listener) attaches the simulation to the graph of
 * the given EditorUi and calls listener with the lines of the statistics and
 * the running state.
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
	var tallySteps = 10;
	var tallyBuckets = 6;
	var maxLabels = 400;
	var labelFont = 10;
	var labelLine = 12;
	var labelInterval = 500;
	var maxStepsPerFrame = 100;
	var maxFrameTime = 40;
	var maxNewCarsPerStep = 10;
	var maxLinkCells = 10000;
	var maxNetworkCells = 5000000;
	var maxImportCells = 50000;
	var maxImportSize = 20 * 1024 * 1024;
	var maxImportExtent = 1e6;
	// Top speed of the types of vehicles in cells per step relative to the
	// maximum speed, with the key of their share in the config
	var vehicleTypes = [{name: 'car', dv: 0}, {name: 'truck', dv: -2, share: 'trucks'},
		{name: 'fast', dv: 1, share: 'fast'}];

	// Top views of the types of vehicles in units, driving to the right, with
	// the windows cut out of the body, which is in the color of the speed.
	// Trucks are at most a cell long, so that they do not overlap in queues.
	var vehicleShapes = {
		car: {length: 5.6, width: 3, body: 'M 2.8 0 C 2.8 -1.2 2.6 -1.5 1.85 -1.5 L -2.3 -1.5 ' +
			'Q -2.8 -1.5 -2.8 -1 L -2.8 1 Q -2.8 1.5 -2.3 1.5 L 1.85 1.5 C 2.6 1.5 2.8 1.2 2.8 0 Z',
			windows: 'M 1.45 -1.2 Q 1.75 0 1.45 1.2 L 0.6 1.05 L 0.6 -1.05 Z ' +
			'M -1.65 -1.1 L -1.65 1.1 L -2.25 1.15 Q -2.42 0 -2.25 -1.15 Z'},
		truck: {length: 7.4, width: 3.3, body: 'M 3.7 -1.1 Q 3.7 -1.5 3.25 -1.5 L 2 -1.5 L 2 1.5 ' +
			'L 3.25 1.5 Q 3.7 1.5 3.7 1.1 Z M 1.75 -1.65 L -3.7 -1.65 L -3.7 1.65 L 1.75 1.65 Z',
			windows: 'M 3.4 -1.2 Q 3.62 0 3.4 1.2 L 2.9 1.12 L 2.9 -1.12 Z'},
		fast: {length: 6, width: 3, body: 'M 3 0 C 3 -0.75 2.3 -1.4 1.2 -1.4 L -2.6 -1.4 Q -2.85 -1.4 ' +
			'-2.85 -1.1 L -2.85 1.1 Q -2.85 1.4 -2.6 1.4 L 1.2 1.4 C 2.3 1.4 3 0.75 3 0 Z ' +
			'M -3 -1.5 L -2.6 -1.5 L -2.6 1.5 L -3 1.5 Z',
			windows: 'M 1.05 -1 Q 1.35 0 1.05 1 L 0.1 0.92 L 0.1 -0.92 Z ' +
			'M -1.25 -0.85 L -1.25 0.85 L -1.8 0.92 L -1.8 -0.92 Z'}};

	// Colors of the speed from standing to the fastest vehicles, from blue over
	// violet and magenta to red, which stand out from the green of free lanes
	var speedStops = ['#2d5ed4', '#7b46e9', '#bb2ad0', '#e71994', '#f62f53', '#f64734'];
	var minVehiclePx = 9;
	var maxWindowsScale = 1.5;
	var vehicleStroke = 0.35;
	var turnChord = 2.5;
	var laneChangeYaw = 25;
	var lampColors = [['#ff3b30', '#4a1512'], ['#ffcc00', '#4a3d0d'], ['#34c759', '#123d1f']];
	var config = {cars: 60, speed: 10, vmax: 5, noise: 0.25, reroute: true, density: true, labels: false, lifetime: 300,
		trucks: 0.2, fast: 0.1};

	var crossingStyle = 'ellipse;aspect=fixed;resizeCentered=1;strokeColor=none;fillColor=' + roads.asphalt + ';';
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
	var expected = null;
	var labels = null;
	var labelsDirty = true;
	var focus = null;
	var press = null;
	var lastLabels = 0;
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
			var e = {time: sim.time, event: type, car: (v != null) ? v.id : '',
				type: (v != null) ? v.type.name : ''};

			for (var key in data)
			{
				e[key] = data[key];
			}

			events.push(e);
		}
	};

	/**
	 * Counts of a link or junction that exists since the given step: the cars
	 * that entered and left it since the start, and in the last minute in
	 * buckets of ten steps the cars that passed, the steps that they stood
	 * before, and the cells that cars moved and the cars that were there in
	 * each step. Junctions count cars that arrive there as entering and cars
	 * that start there as leaving.
	 */
	function Tally(since)
	{
		this.since = since;
		this.slot = Math.floor(since / tallySteps);
		this.entered = 0;
		this.left = 0;
		this.buckets = new Float64Array(4 * tallyBuckets);
	};

	/**
	 * Returns the index of the bucket of the current step, with the cars that
	 * passed, the steps they stood, the cells moved and the cars present,
	 * and empties the buckets of the steps since the last call.
	 */
	Tally.prototype.get = function()
	{
		var slot = Math.floor(sim.time / tallySteps);

		for (var s = Math.max(this.slot + 1, slot - tallyBuckets + 1); s <= slot; s++)
		{
			this.buckets.fill(0, 4 * (s % tallyBuckets), 4 * (s % tallyBuckets) + 4);
		}

		this.slot = Math.max(this.slot, slot);

		return 4 * (this.slot % tallyBuckets);
	};

	/**
	 * Returns the sums of the buckets with the number of steps they cover.
	 */
	Tally.prototype.sum = function()
	{
		this.get();
		var result = {passed: 0, stood: 0, moved: 0, present: 0, steps: sim.time -
			Math.max(this.since, (this.slot - tallyBuckets + 1) * tallySteps)};

		for (var i = 0; i < this.buckets.length; i += 4)
		{
			result.passed += this.buckets[i];
			result.stood += this.buckets[i + 1];
			result.moved += this.buckets[i + 2];
			result.present += this.buckets[i + 3];
		}

		return result;
	};

	/**
	 * Returns the tally of the given link or junction, which is created when
	 * it is first used, so that large networks need no memory for it.
	 */
	function getTally(owner)
	{
		if (owner.tally == null)
		{
			owner.tally = new Tally(owner.since);
		}

		return owner.tally;
	};

	/**
	 * Counts the given car, which passes after it stood v.stood steps on its
	 * link, in the given tally.
	 */
	function countPass(tally, v)
	{
		var b = tally.get();
		tally.buckets[b]++;
		tally.buckets[b + 1] += v.stood;
	};

	/**
	 * Counts the given car, which drives into the junction of the given
	 * tally after it stood v.stood steps on its link.
	 */
	function countEntry(tally, v)
	{
		tally.entered++;
		countPass(tally, v);
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
		this.jointCells = null;
		this.since = (sim != null) ? sim.time : 0;
		this.tally = null;
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
	 * Returns the number of cars that stand in a row at the end of the lanes
	 * and the longest row in cells.
	 */
	Link.prototype.getQueue = function()
	{
		var result = {cars: 0, cells: 0};

		for (var k = 0; k < this.cells.length; k++)
		{
			var j = this.out;

			while (j >= 0 && this.cells[k][j] != null && this.cells[k][j].v == 0)
			{
				j--;
			}

			result.cars += this.out - j;
			result.cells = Math.max(result.cells, this.out - j);
		}

		return result;
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
	 * Through traffic and cars that start on the link take turns, except at
	 * joints, where cars that start wait for a gap.
	 */
	Link.prototype.chooseEntry = function(v, link, k)
	{
		var result = null;

		if (this.queue.length == 0 || this.merged || this.from.joint)
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
	 * Puts the given car into the given cell of the given lane, the first if
	 * no cell is given.
	 */
	Link.prototype.enter = function(v, lane, cell)
	{
		cell = (cell != null) ? cell : 0;
		this.vehicles++;
		this.cells[lane][cell] = v;
		v.link = this;
		v.ring = null;
		v.lane = lane;
		v.cell = cell;
		v.wait = 0;
		v.stood = 0;
		v.index++;
		this.merged = false;
		getTally(this).entered++;
		v.trail.push(this);
	};

	/**
	 * Removes and returns the car in the last cell of the given lane.
	 */
	Link.prototype.pop = function(lane)
	{
		var v = this.cells[lane][this.out];
		this.cells[lane][this.out] = null;
		this.vehicles--;
		var tally = getTally(this);
		tally.left++;
		countPass(tally, v);

		return v;
	};

	/**
	 * Lets the given car drive through the crossing on the given curve to the
	 * given lane of the link in the given number of steps of one cell, of
	 * which it drives the given number, at least one, in this step. Cars
	 * that drive past the end of the curve enter the lane as far as it is
	 * free.
	 */
	Link.prototype.addTransit = function(v, lane, steps, curve, move)
	{
		var cars = this.transit[lane];
		var t = {v: v, link: this, lane: lane, steps: steps, left: steps - Math.max(1, move || 1), curve: curve};

		if (cars.length > 0)
		{
			t.left = Math.max(t.left, cars[cars.length - 1].left + 1);
		}

		cars.push(t);
		v.link = null;
		v.ring = null;
		v.transit = t;

		if (t.left <= 0 && cars.length == 1)
		{
			this.exitTransit(lane, Math.min(-t.left, this.getGap(lane, -1, 1 - t.left) - 1));
		}
	};

	/**
	 * Moves the first car on its way through the crossing to the given lane
	 * into the given cell of the lane, the first if no cell is given.
	 */
	Link.prototype.exitTransit = function(lane, cell)
	{
		var t = this.transit[lane].shift();
		t.v.transit = null;
		t.v.curve = t.curve;
		getTally(this.from).left++;
		this.enter(t.v, lane, cell);
		t.v.driven += t.v.cell;
	};

	/**
	 * Moves the cars on their way through the crossing one step closer to
	 * the link, at least one step apart, and lets the first enter it if its
	 * first cell is free. Through joints, cars drive at their speed and
	 * enter the lane as far as it is free.
	 */
	Link.prototype.stepTransit = function()
	{
		var joint = this.from.joint;

		for (var k = 0; k < this.transit.length; k++)
		{
			var cars = this.transit[k];
			var ahead = null;

			for (var i = 0; i < cars.length; i++)
			{
				var t = cars[i];
				var from = t.left;
				var left = (joint) ? from - Math.min(t.v.v + 1, getTopSpeed(t.v)) : Math.max(from - 1, 0);

				if (ahead != null)
				{
					left = Math.max(left, ahead + 1);
				}

				// The first enters the lane up to the cell it reaches if they are free
				var cell = (ahead == null && left <= 0) ? Math.min(-left, this.getGap(k, -1, 1 - left) - 1) : -1;

				if (cell >= 0)
				{
					this.exitTransit(k, cell);
					i--;
					ahead = 0;
				}
				else
				{
					t.left = Math.max(left, 0);
					ahead = t.left;
				}

				if (joint)
				{
					t.v.v = (cell >= 0) ? from + cell : from - t.left;
				}
			}
		}
	};

	/**
	 * Returns the free cells after the end of this link through the joint at
	 * its end and at the start of the lanes of the given next link, at most
	 * the given number.
	 */
	Link.prototype.getGapAfter = function(next, max)
	{
		var result = 0;

		for (var l = 0; l < next.cells.length && result < max; l++)
		{
			var cars = next.transit[l];

			if (next.cells[l][0] == null)
			{
				var last = (cars.length > 0) ? cars[cars.length - 1] : null;
				result = Math.max(result, (last != null) ? last.steps - last.left - 1 :
					this.getJointCells(next) + next.getGap(l, -1, max));
			}
		}

		return Math.min(result, max);
	};

	/**
	 * Returns the cells of the curve through the joint at the end of this
	 * link to the given next link between the last and the first cell.
	 */
	Link.prototype.getJointCells = function(next)
	{
		if (this.jointCells == null)
		{
			this.jointCells = new Map();
		}

		var cells = this.jointCells.get(next);

		if (cells == null)
		{
			cells = getTransitSteps(createCurve(this, this.cells.length - 1, next, next.cells.length - 1)) - 1;
			this.jointCells.set(next, cells);
		}

		return cells;
	};

	/**
	 * Returns true if a car on a link to the joint at the start of this link
	 * can reach it in this step, so that cars that start on the link wait.
	 */
	Link.prototype.isApproached = function()
	{
		var fanIn = this.from.fanIn;

		for (var i = 0; i < fanIn.length; i++)
		{
			var link = fanIn[i];

			for (var k = 0; k < link.cells.length; k++)
			{
				for (var j = link.out; j >= 0 && j >= link.out - config.vmax - 1; j--)
				{
					var v = link.cells[k][j];

					if (v != null)
					{
						if (v.next() == this)
						{
							return true;
						}

						break;
					}
				}
			}
		}

		return false;
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
		var vm = getTopSpeed(v);
		var next = v.next();
		var left = this.out - cell;

		if (next != null && !this.allows(k, next))
		{
			var side = this.getTurnSide(k, next);

			return (side != 0 && this.canChange(k, k + side, cell, (left > turnCells) ? vmax : 1)) ? k + side : k;
		}

		if (left > 0)
		{
			var gap = this.getGap(k, cell, vm);

			if (gap < Math.min(v.v + 1, vm) && this.canChange(k, k - 1, cell, vmax) &&
				(left > turnCells || this.allows(k - 1, next)) && this.getGap(k - 1, cell, vm) > gap &&
				Math.random() < overtakeProbability)
			{
				return k - 1;
			}

			if (this.canChange(k, k + 1, cell, vmax) && (left > turnCells || this.allows(k + 1, next)) &&
				this.getGap(k + 1, cell, vm) >= Math.min(v.v + 2, vm) && Math.random() < keepRightProbability)
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

		// Cars enter traffic at the start of their first link, at joints in
		// gaps of the traffic through it
		if (this.queue.length > 0 && !(this.from.joint && this.isApproached()))
		{
			var lane = this.getFreeLane(this.queue[0].after());

			if (lane >= 0)
			{
				var first = this.queue.shift();
				addActive(first);
				getTally(this.from).left++;
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
					var vm = Math.max(1, vmax + v.type.dv);
					var gap = this.getGap(k, i, vm);

					// The first car drives on through a joint at the end
					if (i + gap == out && gap < vm && this.to.joint)
					{
						var next = v.next();

						if (next != null && next.from == this.to)
						{
							gap += this.getGapAfter(next, vm - gap);
						}
					}

					v.v = Math.min(gap, vm, v.v + 1);
					count++;

					if (v.v > 0 && Math.random() < noise)
					{
						v.v--;
					}

					if (v.v == 0)
					{
						v.stood++;
					}
				}
			}

			// Moves from the front so that no car moves twice. Cars that drive
			// through a joint stop at the end and keep the cells beyond.
			for (var j = out; j >= 0; j--)
			{
				var car = cells[j];

				if (car != null && car.v > 0)
				{
					var to = Math.min(j + car.v, out);
					cells[j] = null;
					cells[to] = car;
					car.cell = to;
					car.over = j + car.v - to;
					car.driven += to - j;
					moved += car.v;
				}
			}

			this.counts[k] = count;
		}

		this.vavg = (this.vehicles > 0) ? moved / this.vehicles : 0;

		if (this.vehicles > 0)
		{
			var tally = getTally(this);
			var b = tally.get();
			tally.buckets[b + 2] += moved;
			tally.buckets[b + 3] += this.vehicles;
		}

		for (var k = 0; k < this.cells.length; k++)
		{
			var top = this.cells[k][out];

			if (top != null)
			{
				if (top.next() == null)
				{
					park(this.pop(k));
					getTally(this.to).entered++;
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
		this.radius = 0;
		this.joint = false;
		this.phases = null;
		this.phase = 0;
		this.counter = 0;
		this.finger = 0;
		this.signals = null;
		this.since = (sim != null) ? sim.time : 0;
		this.tally = null;
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

		if (this.joint)
		{
			this.stepJoint();

			return;
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
						countEntry(getTally(this), v);
						next.addTransit(link.pop(k), entry.lane, entry.steps, entry.curve);
						this.finger = (this.finger + i + 1) % green.length;
						passed++;
					}
				}
			}
		}
	};

	/**
	 * Lets the cars at the end of the links to a joint drive on with the
	 * cells beyond the end that they kept in this step, in all lanes.
	 */
	Crossing.prototype.stepJoint = function()
	{
		for (var i = 0; i < this.fanIn.length; i++)
		{
			var link = this.fanIn[i];

			for (var k = 0; k < link.cells.length; k++)
			{
				var v = link.cells[k][link.out];

				if (v != null && v.over > 0)
				{
					var next = v.next();
					var entry = (next != null && next.from == this) ? next.chooseEntry(v, link, k) : null;

					if (entry != null)
					{
						record('cross', v, {junction: this.id, from: link.key + ':' + k,
							to: next.key + ':' + entry.lane, steps: entry.steps});
						countEntry(getTally(this), v);
						next.addTransit(link.pop(k), entry.lane, entry.steps, entry.curve, v.over);
					}
					else
					{
						v.v = 0;
					}

					v.over = 0;
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
	 * Returns a cubic curve from p0 in direction a to p1 in direction b, the
	 * quadratic curve through the intersection of the directions if they
	 * intersect in front of both points, else one that leaves and reaches
	 * the points in their directions, with the length of a line between
	 * them for the steps through the crossing.
	 */
	function createCurveBetween(p0, a, p1, b)
	{
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
				var c = new mxPoint(p0.x + a.x * s, p0.y + a.y * s);

				return {p0: p0, c0: new mxPoint(p0.x + 2 * (c.x - p0.x) / 3, p0.y + 2 * (c.y - p0.y) / 3),
					c1: new mxPoint(p1.x + 2 * (c.x - p1.x) / 3, p1.y + 2 * (c.y - p1.y) / 3), p1: p1,
					length: (roads.getDistance(p0, c) + roads.getDistance(c, p1) + dist) / 2};
			}
		}

		return {p0: p0, c0: new mxPoint(p0.x + a.x * dist / 3, p0.y + a.y * dist / 3),
			c1: new mxPoint(p1.x - b.x * dist / 3, p1.y - b.y * dist / 3), p1: p1, length: dist};
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
		var a = (1 - s) * (1 - s) * (1 - s);
		var b = 3 * (1 - s) * (1 - s) * s;
		var c = 3 * (1 - s) * s * s;
		var d = s * s * s;

		return new mxPoint(a * curve.p0.x + b * curve.c0.x + c * curve.c1.x + d * curve.p1.x,
			a * curve.p0.y + b * curve.c0.y + c * curve.c1.y + d * curve.p1.y);
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

			var tally = getTally(this);
			var b = tally.get();
			tally.buckets[b + 3] += cars.length;

			for (var i = 0; i < cars.length; i++)
			{
				var v = cars[i];
				v.cell = (v.cell + v.v) % n;
				v.driven += v.v;
				tally.buckets[b + 2] += v.v;
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
						getTally(this).left++;
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
					countEntry(getTally(this), v);
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
	 * cell of the given lane of the given next link. The curve leaves the
	 * ring between the previous cell and the exit where it turns into the
	 * lane best, as lanes on the right of the road start before the exit.
	 */
	Roundabout.prototype.getExitPath = function(v, next, lane)
	{
		var n = this.size;
		var d = (v.prevRing == this) ? (v.cell - v.prevCell + n) % n : 0;
		var p1 = next.getPoint(lane, 0);
		var b = getDirection(next.paths[lane].points, true);
		var exit = d;
		var best = null;

		for (var e = d; e >= 0; e -= 0.25)
		{
			var score = this.getExitScore(v.cell - d + e, p1, b);

			if (best == null || score < best)
			{
				best = score;
				exit = e;
			}
		}

		var pts = (v.prevRing == this) ? [this.getPoint(0, v.prevCell, this.radii[v.prevRingLane])] : [];

		for (var i = 1; i < exit; i++)
		{
			pts.push(this.getPoint(0, v.cell - d + i));
		}

		return addCurvePoints(pts, createCurveBetween(this.getPoint(0, v.cell - d + exit),
			this.getTangent(v.cell - d + exit), p1, b));
	};

	/**
	 * Returns how far a curve from the given cell of the outer lane to the
	 * given point in the given direction is from a turn where both meet at
	 * the same distance in front of them, plus 1000 if they do not meet in
	 * front of both.
	 */
	Roundabout.prototype.getExitScore = function(cell, p1, b)
	{
		var p0 = this.getPoint(0, cell);
		var a = this.getTangent(cell);
		var dx = p1.x - p0.x;
		var dy = p1.y - p0.y;
		var det = a.x * b.y - a.y * b.x;

		if (Math.abs(det) < 0.1)
		{
			return 1000 + Math.sqrt(dx * dx + dy * dy);
		}

		var s = (dx * b.y - dy * b.x) / det;
		var t = (a.x * dy - a.y * dx) / det;

		return (s > 0 && t > 0) ? Math.abs(s - t) : 1000 + Math.max(0, -s) + Math.max(0, -t);
	};

	/**
	 * Car with a route of links.
	 */
	function Vehicle(id, route, time, type)
	{
		this.id = id;
		this.type = type;
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
		this.stood = 0;
		this.stopped = 0;
		this.driven = 0;
		this.over = 0;
		this.origin = route[0].from;
		this.trail = [];
		this.waited = 0;
		this.reroutes = 0;
		this.prevLink = null;
		this.prevRing = null;
		this.prevTransit = null;
		this.prevLane = 0;
		this.prevRingLane = 0;
		this.prevCell = 0;
		this.prevProgress = 0;
		this.d = null;
		this.fill = null;
		this.node = null;
		this.x = null;
		this.y = null;
		this.angle = 0;
	};

	/**
	 * Returns the top speed of the given car in cells per step.
	 */
	function getTopSpeed(v)
	{
		return Math.max(1, config.vmax + v.type.dv);
	};

	/**
	 * Returns a random type of vehicle with the shares in the config.
	 */
	function getRandomType()
	{
		var r = Math.random();

		for (var i = 1; i < vehicleTypes.length; i++)
		{
			r -= config[vehicleTypes[i].share];

			if (r < 0)
			{
				return vehicleTypes[i];
			}
		}

		return vehicleTypes[0];
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
	 * the painted curve for curved edges and around the corners for rounded
	 * edges.
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

		return roads.getPath(model, style);
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

	/**
	 * Returns the number of roads that start or end at the given junction.
	 */
	function getRoadCount(junction)
	{
		var keys = new Set();
		var links = junction.fanIn.concat(junction.fanOut);

		for (var i = 0; i < links.length; i++)
		{
			keys.add(links[i].key.substring(0, links[i].key.length - 1));
		}

		return keys.size;
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

				junction.radius = Math.max(b.width, b.height) / 2;
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

			// Crossings of two roads without a light are joints in the road,
			// where cars drive on in all lanes without the turns of the lanes
			if (junction.rings == null && junction.phases == null && getRoadCount(junction) <= 2)
			{
				junction.joint = true;

				for (var j = 0; j < junction.fanIn.length; j++)
				{
					junction.fanIn[j].open = true;
					junction.fanIn[j].reach = new Set(junction.fanOut);
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
	function getLifetime(route, vmax)
	{
		var cells = 0;

		for (var i = 0; i < route.length; i++)
		{
			cells += route[i].out + 1;
		}

		return Math.max(config.lifetime, Math.round(lifetimeFactor *
			(cells / vmax + 3 * route.length)));
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
				route[0].queue.push(new Vehicle(sim.created++, route, sim.time, getRandomType()));
				sim.queued++;
			}
		}
	};

	function addActive(v)
	{
		v.end = sim.time + getLifetime(v.route, getTopSpeed(v));
		record('spawn', v, {link: v.route[0].key, dest: v.dest.id, lifetime: v.end - sim.time});
		sim.queued--;
		sim.active.add(v);

		// One path with the outline of its type, painted in paintCars
		v.node = createNode('path', overlay.cars, {});
		v.d = null;
		v.fill = null;
	};

	function removeActive(v)
	{
		sim.active['delete'](v);

		if (focus != null && focus.v == v && focus.status == null)
		{
			focus.status = 'Left the network';
			focus.end = sim.time;
		}

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
			getTally(v.ring).left++;
		}
		else
		{
			v.link.cells[v.lane][v.cell] = null;
			v.link.vehicles--;
			getTally(v.link).left++;
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

		if (focus != null && focus.v == v)
		{
			focus.status = 'Did not arrive in its lifetime and left';
			focus.end = sim.time;
		}

		if (v.transit != null)
		{
			var cars = v.transit.link.transit[v.transit.lane];
			cars.splice(cars.indexOf(v.transit), 1);
			getTally(v.transit.link.from).left++;
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

		if (focus != null && focus.v == v)
		{
			focus.status = 'Arrived at B';
			focus.end = sim.time;
		}

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
			v.reroutes++;
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
			v.waited += (v.stopped > 0) ? 1 : 0;
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

		// Keeps the statistics of the links that are still there
		for (var i = 0; i < old.links.length; i++)
		{
			var link = net.linkMap.get(old.links[i].key);

			if (link != null)
			{
				link.tally = old.links[i].tally;
				link.since = old.links[i].since;
			}
		}

		for (var i = 0; i < old.crossings.length; i++)
		{
			var prev = old.crossings[i];
			var junction = net.crossingMap.get(prev.id);

			if (junction != null)
			{
				junction.tally = prev.tally;
				junction.since = prev.since;
			}

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
			v.over = 0;

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

		labelsDirty = true;
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
			route: createNode('g', root, {}), bars: createNode('g', root, {}),
			cars: createNode('g', root, {stroke: 'rgba(0,0,0,0.6)', 'stroke-linejoin': 'round', 'fill-rule': 'evenodd'}),
			heads: createNode('g', root, {}), labels: createNode('g', root, {}), focus: createNode('g', root, {})};
		outlines = {scale: 0};
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
			var transform = 'scale(' + s + ') translate(' + t.x + ',' + t.y + ')';

			if (overlay.transform != transform)
			{
				overlay.transform = transform;
				overlay.root.setAttribute('transform', transform);
				labelsDirty = true;
			}

			if (overlay.scale != s)
			{
				overlay.scale = s;
				updateSizes();
			}
		}
	};

	function updateSizes()
	{
		var w = getSize(0.3, 2);
		var bw = getSize(0.3, 3);
		var hs = getHeadScale();

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
	 * Returns the index of the segment of the given lengths of points that
	 * contains the given distance, from 1 to the last point.
	 */
	function getSegment(lengths, d)
	{
		var lo = 1;
		var hi = lengths.length - 1;

		while (lo < hi)
		{
			var mid = (lo + hi) >> 1;

			if (lengths[mid] < d)
			{
				lo = mid + 1;
			}
			else
			{
				hi = mid;
			}
		}

		return lo;
	};

	/**
	 * Sets x and y of the given pose to the point at the given distance along
	 * the given points with their lengths, clamped to their ends.
	 */
	function setPathPoint(pose, pts, lengths, d)
	{
		var i = getSegment(lengths, d);
		var len = lengths[i] - lengths[i - 1];
		var f = (len > 0) ? Math.max(0, Math.min(1, (d - lengths[i - 1]) / len)) : 0;
		pose.x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
		pose.y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
	};

	var chordPose = {x: 0, y: 0, a: 0};

	/**
	 * Sets the given pose to the point at the given distance along the given
	 * points with their lengths and the angle of the chord around it, so
	 * that vehicles turn smoothly through curves and at corners.
	 */
	function setPathPose(pose, pts, lengths, d)
	{
		var total = lengths[lengths.length - 1];
		setPathPoint(chordPose, pts, lengths, Math.min(total, d + turnChord));
		var x = chordPose.x;
		var y = chordPose.y;
		setPathPoint(chordPose, pts, lengths, Math.max(0, d - turnChord));

		if (x != chordPose.x || y != chordPose.y)
		{
			pose.a = Math.atan2(y - chordPose.y, x - chordPose.x) * 180 / Math.PI;
		}

		setPathPoint(pose, pts, lengths, d);
	};

	/**
	 * Sets the given pose to the given cell, which may be fractional, of the
	 * given lane of the given link.
	 */
	function setLanePose(pose, link, lane, cell)
	{
		var path = link.paths[lane];
		setPathPose(pose, path.points, path.lengths, (cell + 0.5) / (link.out + 1) *
			path.lengths[path.lengths.length - 1]);
	};

	/**
	 * Sets the given pose to the given fraction of the given curve through a
	 * crossing, with the angle of its tangent.
	 */
	function setCurvePose(pose, curve, s)
	{
		var pt = getCurvePoint(curve, s);
		var a = (1 - s) * (1 - s);
		var b = 2 * (1 - s) * s;
		var c = s * s;
		var dx = a * (curve.c0.x - curve.p0.x) + b * (curve.c1.x - curve.c0.x) + c * (curve.p1.x - curve.c1.x);
		var dy = a * (curve.c0.y - curve.p0.y) + b * (curve.c1.y - curve.c0.y) + c * (curve.p1.y - curve.c1.y);

		if (dx == 0 && dy == 0)
		{
			dx = curve.p1.x - curve.p0.x;
			dy = curve.p1.y - curve.p0.y;
		}

		pose.x = pt.x;
		pose.y = pt.y;
		pose.a = Math.atan2(dy, dx) * 180 / Math.PI;
	};

	/**
	 * Sets the given pose to the given cell, which may be fractional, of the
	 * given roundabout at the given radius, with the direction of traffic.
	 */
	function setRingPose(pose, ring, cell, radius)
	{
		var pt = ring.getPoint(0, cell, radius);
		var t = ring.getTangent(cell);
		pose.x = pt.x;
		pose.y = pt.y;
		pose.a = Math.atan2(t.y, t.x) * 180 / Math.PI;
	};

	/**
	 * Sets the given pose to the place of the given car before or after the
	 * last step.
	 */
	function setPose(pose, v, prev)
	{
		var transit = (prev) ? v.prevTransit : v.transit;
		var ring = (prev) ? v.prevRing : v.ring;
		var cell = (prev) ? v.prevCell : v.cell;

		if (transit != null)
		{
			setCurvePose(pose, transit.curve, (prev) ? v.prevProgress : getProgress(transit));
		}
		else if (ring != null)
		{
			setRingPose(pose, ring, cell, ring.radii[(prev) ? v.prevRingLane : v.ringLane]);
		}
		else
		{
			setLanePose(pose, (prev) ? v.prevLink : v.link, (prev) ? v.prevLane : v.lane, cell);
		}
	};

	var pose = {x: 0, y: 0, a: 0};
	var lanePose = {x: 0, y: 0, a: 0};

	/**
	 * Sets the given pose to the place of the given car at the given fraction
	 * of the last step: along its path into and out of roundabouts, along the
	 * end of its last link, the curve through the crossing and the start of
	 * the next link, around roundabouts, along its lane and across to the
	 * next in lane changes, where it turns toward the lane and back.
	 */
	function setStepPose(pose, v, alpha)
	{
		var curve = (v.transit != null) ? v.transit.curve : v.curve;
		pose.a = v.angle;

		if (alpha >= 1 || (v.prevLink == null && v.prevRing == null && v.prevTransit == null))
		{
			setPose(pose, v);
		}
		else if (v.path != null)
		{
			setPose(lanePose, v);
			var pts = v.path.concat([new mxPoint(lanePose.x, lanePose.y)]);
			var lengths = roads.getLengths(pts);
			setPathPose(pose, pts, lengths, alpha * lengths[lengths.length - 1]);

			// Turns from the direction at the start into the one at the end,
			// which short paths into and out of roundabouts reach only near
			// their ends
			var turn = ((lanePose.a - pose.a) % 360 + 540) % 360 - 180;
			pose.a += turn * alpha * alpha;
			setPose(lanePose, v, true);
			turn = ((lanePose.a - pose.a) % 360 + 540) % 360 - 180;
			pose.a += turn * (1 - alpha) * (1 - alpha);
		}
		else if (curve != null && curve.length > 0 && (v.prevTransit == null || v.prevTransit.curve == curve))
		{
			var link = (v.prevTransit == null) ? v.prevLink : null;
			var size = (link != null) ? link.length / (link.out + 1) : 0;
			var d0 = (link != null) ? (link.out - v.prevCell) * size : 0;
			var s0 = (v.prevTransit != null) ? v.prevProgress : 0;
			var d1 = d0 + (((v.transit != null) ? getProgress(v.transit) : 1) - s0) * curve.length;
			var size1 = (v.transit == null) ? v.link.length / (v.link.out + 1) : 0;
			var d = alpha * (d1 + ((v.transit == null) ? v.cell * size1 : 0));

			if (d < d0)
			{
				setLanePose(pose, link, v.prevLane, v.prevCell + d / size);
			}
			else if (d <= d1)
			{
				setCurvePose(pose, curve, s0 + (d - d0) / curve.length);
			}
			else
			{
				setLanePose(pose, v.link, v.lane, (d - d1) / size1);
			}
		}
		else if (v.prevRing != null && v.prevRing == v.ring)
		{
			var n = v.ring.size;
			var r = v.ring.radii[v.prevRingLane];
			var dr = v.ring.radii[v.ringLane] - r;
			var cells = (v.cell - v.prevCell + n) % n;
			setRingPose(pose, v.ring, v.prevCell + cells * alpha, r + dr * alpha);

			// Turns outward, which is to the right, or inward and back in lane changes
			if (dr != 0)
			{
				var ahead = cells * 2 * Math.PI * (r + dr / 2) / n;
				var yaw = Math.min(laneChangeYaw, Math.atan2(Math.abs(dr), ahead) * 180 / Math.PI);
				pose.a += ((dr > 0) ? 1 : -1) * yaw * Math.sin(Math.PI * alpha);
			}
		}
		else if (v.prevLink != null && v.prevLink == v.link)
		{
			var cell = v.prevCell + (v.cell - v.prevCell) * alpha;
			setLanePose(lanePose, v.link, v.prevLane, cell);
			setLanePose(pose, v.link, v.lane, cell);

			if (v.prevLane != v.lane)
			{
				// Turns toward the next lane and back
				var dx = pose.x - lanePose.x;
				var dy = pose.y - lanePose.y;
				var a = pose.a * Math.PI / 180;
				var side = (Math.cos(a) * dy - Math.sin(a) * dx > 0) ? 1 : -1;
				var ahead = (v.cell - v.prevCell) * v.link.length / (v.link.out + 1);
				var yaw = Math.min(laneChangeYaw, Math.atan2(Math.sqrt(dx * dx + dy * dy), ahead) * 180 / Math.PI);
				pose.a += side * yaw * Math.sin(Math.PI * alpha);
				pose.x = lanePose.x + dx * alpha;
				pose.y = lanePose.y + dy * alpha;
			}
		}
		else
		{
			setPose(lanePose, v);
			var p0 = v.getPoint(true);
			var dx = lanePose.x - p0.x;
			var dy = lanePose.y - p0.y;
			pose.x = p0.x + dx * alpha;
			pose.y = p0.y + dy * alpha;
			pose.a = (dx != 0 || dy != 0) ? Math.atan2(dy, dx) * 180 / Math.PI : lanePose.a;
		}
	};

	/**
	 * Returns the scale of the shapes of the vehicles, so that cars are at
	 * least minVehiclePx long.
	 */
	function getVehicleScale()
	{
		return Math.max(1, minVehiclePx / vehicleShapes.car.length / graph.view.scale);
	};

	/**
	 * Returns the speed of the given car in cells per step, one through
	 * crossings other than joints.
	 */
	function getSpeed(v)
	{
		return (v.transit != null && !v.transit.link.from.joint) ? 1 : v.v;
	};

	/**
	 * Returns the colors of the speeds from 0 to the top speed of all types
	 * of vehicles in cells per step, from blue to red.
	 */
	function getSpeedColors()
	{
		var top = config.vmax + ((config.fast > 0) ? 1 : 0);

		if (speedColors == null || speedColors.length != top + 1)
		{
			speedColors = [];

			for (var i = 0; i <= top; i++)
			{
				speedColors.push(getScaleColor(i / top));
			}
		}

		return speedColors;
	};

	var speedColors = null;

	/**
	 * Returns the color at the given fraction of speedStops.
	 */
	function getScaleColor(f)
	{
		var x = Math.max(0, Math.min(1, f)) * (speedStops.length - 1);
		var i = Math.min(speedStops.length - 2, Math.floor(x));
		var a = parseInt(speedStops[i].substring(1), 16);
		var b = parseInt(speedStops[i + 1].substring(1), 16);
		var t = x - i;
		var rgb = [];

		for (var shift = 16; shift >= 0; shift -= 8)
		{
			rgb.push(Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t));
		}

		return 'rgb(' + rgb.join(',') + ')';
	};

	var outlines = {scale: 0};

	/**
	 * Returns the outline of the given type of vehicle turned by the given
	 * whole degrees in the current scale of the vehicles, without the first
	 * point, so that the path of a vehicle is its place and this outline.
	 * Changing the path paints faster than changing a transform.
	 */
	function getOutline(type, deg)
	{
		var turns = outlines[type.name] || (outlines[type.name] = []);
		var result = turns[deg];

		if (result == null)
		{
			var shape = vehicleShapes[type.name];

			// Leaves out the windows when the vehicles are painted larger
			// than they are, which paints faster and is clearer
			result = turnPath((outlines.scale > maxWindowsScale) ? shape.body :
				shape.body + ' ' + shape.windows, deg * Math.PI / 180, outlines.scale);
			turns[deg] = result;
		}

		return result;
	};

	/**
	 * Returns the given path of absolute M, L, Q, C and Z commands turned by
	 * the given radians around 0, 0 and scaled by the given factor with
	 * relative commands, which start at 0, 0.
	 */
	function turnPath(path, a, k)
	{
		var tokens = path.split(' ');
		var cos = Math.cos(a) * k;
		var sin = Math.sin(a) * k;
		var x = 0;
		var y = 0;
		var start = null;
		var result = '';

		for (var i = 0; i < tokens.length;)
		{
			var cmd = tokens[i++];

			if (cmd == 'Z')
			{
				result += 'z';
				x = start.x;
				y = start.y;
			}
			else
			{
				var n = (cmd == 'C') ? 3 : ((cmd == 'Q') ? 2 : 1);
				result += cmd.toLowerCase();

				for (var j = 0; j < n; j++)
				{
					var px = parseFloat(tokens[i++]);
					var py = parseFloat(tokens[i++]);
					var tx = px * cos - py * sin;
					var ty = px * sin + py * cos;
					result += ((j > 0) ? ' ' : '') + Math.round((tx - x) * 1000) / 1000 + ' ' +
						Math.round((ty - y) * 1000) / 1000;

					if (j == n - 1)
					{
						x = tx;
						y = ty;
					}
				}

				if (cmd == 'M')
				{
					start = {x: x, y: y};
				}
			}
		}

		return result;
	};

	/**
	 * Paints the cars between their previous and current position, turned
	 * in their direction and in the color of their speed.
	 */
	function paintCars(alpha)
	{
		var k = getVehicleScale();
		var colors = getSpeedColors();
		var top = colors.length - 1;

		if (k != outlines.scale)
		{
			outlines = {scale: k};
			overlay.cars.setAttribute('stroke-width', vehicleStroke * k);
		}

		sim.active.forEach(function(v)
		{
			setStepPose(pose, v, alpha);
			v.angle = pose.a;
			v.x = pose.x;
			v.y = pose.y;
			var d = 'M ' + Math.round(pose.x * 100) / 100 + ' ' + Math.round(pose.y * 100) / 100 +
				' ' + getOutline(v.type, ((Math.round(pose.a) % 360) + 360) % 360);
			var fill = colors[Math.min(top, getSpeed(v))];

			// Leaves standing vehicles as they are
			if (d != v.d)
			{
				v.d = d;
				v.node.setAttribute('d', d);
			}

			if (fill != v.fill)
			{
				v.fill = fill;
				v.node.setAttribute('fill', fill);
			}
		});

		paintFocus();
	};

	/**
	 * Returns the distance from the given point to the given rectangle, 0
	 * inside.
	 */
	function getRectDistance(x, y, r)
	{
		var dx = Math.max(r.x - x, 0, x - r.x - r.width);
		var dy = Math.max(r.y - y, 0, y - r.y - r.height);

		return Math.sqrt(dx * dx + dy * dy);
	};

	/**
	 * Returns the distance from the given point to the segment from a to b.
	 */
	function getSegmentDistance(x, y, a, b)
	{
		var dx = b.x - a.x;
		var dy = b.y - a.y;
		var len = dx * dx + dy * dy;
		var t = (len > 0) ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;

		return Math.sqrt(Math.pow(a.x + t * dx - x, 2) + Math.pow(a.y + t * dy - y, 2));
	};

	/**
	 * Returns the distance from the segment from a to b to the given
	 * rectangle, 0 if they intersect.
	 */
	function getSegmentRectDistance(a, b, r)
	{
		// Clips the segment to the rectangle
		var p = [a.x - b.x, b.x - a.x, a.y - b.y, b.y - a.y];
		var q = [a.x - r.x, r.x + r.width - a.x, a.y - r.y, r.y + r.height - a.y];
		var t0 = 0;
		var t1 = 1;

		for (var i = 0; i < 4 && t0 <= t1; i++)
		{
			if (p[i] == 0)
			{
				t1 = (q[i] < 0) ? -1 : t1;
			}
			else if (p[i] < 0)
			{
				t0 = Math.max(t0, q[i] / p[i]);
			}
			else
			{
				t1 = Math.min(t1, q[i] / p[i]);
			}
		}

		if (t0 <= t1)
		{
			return 0;
		}

		var d = Math.min(getRectDistance(a.x, a.y, r), getRectDistance(b.x, b.y, r));

		for (var i = 0; i < 4; i++)
		{
			d = Math.min(d, getSegmentDistance(r.x + ((i % 2 == 0) ? 0 : r.width),
				r.y + ((i < 2) ? 0 : r.height), a, b));
		}

		return d;
	};

	/**
	 * Uniform grid of obstacles for the labels: segments of roads with half
	 * their width and rectangles of junctions, lights and labels.
	 */
	function LabelGrid(size)
	{
		this.size = size;
		this.cells = new Map();
	};

	/**
	 * Adds the given obstacle to the cells of the given bounds.
	 */
	LabelGrid.prototype.add = function(obstacle, x0, y0, x1, y1)
	{
		var s = this.size;

		for (var i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++)
		{
			for (var j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++)
			{
				var key = i + ',' + j;
				var list = this.cells.get(key);

				if (list == null)
				{
					list = [];
					this.cells.set(key, list);
				}

				list.push(obstacle);
			}
		}
	};

	LabelGrid.prototype.addSegment = function(a, b, width)
	{
		this.add({a: a, b: b, width: width}, Math.min(a.x, b.x) - width, Math.min(a.y, b.y) - width,
			Math.max(a.x, b.x) + width, Math.max(a.y, b.y) + width);
	};

	LabelGrid.prototype.addRect = function(r)
	{
		this.add({rect: r}, r.x, r.y, r.x + r.width, r.y + r.height);
	};

	/**
	 * Returns true if the given rectangle is closer than the given distance
	 * to an obstacle.
	 */
	LabelGrid.prototype.hits = function(r, pad)
	{
		var s = this.size;

		for (var i = Math.floor((r.x - pad) / s); i <= Math.floor((r.x + r.width + pad) / s); i++)
		{
			for (var j = Math.floor((r.y - pad) / s); j <= Math.floor((r.y + r.height + pad) / s); j++)
			{
				var list = this.cells.get(i + ',' + j);

				for (var k = 0; list != null && k < list.length; k++)
				{
					var o = list[k];

					if ((o.rect != null) ? (o.rect.x < r.x + r.width + pad && r.x < o.rect.x + o.rect.width + pad &&
						o.rect.y < r.y + r.height + pad && r.y < o.rect.y + o.rect.height + pad) :
						getSegmentRectDistance(o.a, o.b, r) < o.width + pad)
					{
						return true;
					}
				}
			}
		}

		return false;
	};

	/**
	 * Returns the roads of the network with their links, the points of their
	 * center line, half their width and their bounds.
	 */
	function getRoads()
	{
		if (net.roads == null)
		{
			var map = new Map();
			net.roads = [];

			for (var i = 0; i < net.links.length; i++)
			{
				var link = net.links[i];
				var id = link.key.substring(0, link.key.length - 1);
				var road = map.get(id);

				if (road == null)
				{
					var pts = (link.key.charAt(link.key.length - 1) == '>') ? link.points :
						link.points.slice().reverse();
					var b = new mxRectangle(pts[0].x, pts[0].y, 0, 0);

					for (var j = 1; j < pts.length; j++)
					{
						b.add(new mxRectangle(pts[j].x, pts[j].y, 0, 0));
					}

					road = {id: id, links: [], points: pts, lengths: roads.getLengths(pts), width: 0, bounds: b};
					map.set(id, road);
					net.roads.push(road);
				}

				road.links.push(link);

				for (var k = 0; k < link.offsets.length; k++)
				{
					road.width = Math.max(road.width, Math.abs(link.offsets[k]) + link.laneWidth / 2);
				}
			}
		}

		return net.roads;
	};

	/**
	 * Returns the lines of the label of the given road or junction: the
	 * cars that are there now and expected, and that entered and left.
	 */
	function getLabelText(item, counts)
	{
		var now = 0;
		var next = 0;
		var entered = 0;
		var left = 0;

		if (item.junction != null)
		{
			now = getJunctionCars(item.junction);
			next = counts.junctions[item.junction.index];
			entered = getTally(item.junction).entered;
			left = getTally(item.junction).left;
		}
		else
		{
			for (var i = 0; i < item.road.links.length; i++)
			{
				var link = item.road.links[i];
				now += link.vehicles;
				next += counts.links[link.index];
				entered += getTally(link).entered;
				left += getTally(link).left;
			}
		}

		return ['now ' + now + ' · exp ' + next, 'in ' + entered + ' · out ' + left];
	};

	/**
	 * Returns the width of a label with the given lines in pixels.
	 */
	function getLabelWidth(lines)
	{
		return Math.ceil(0.52 * labelFont * Math.max(lines[0].length, lines[1].length)) + 8;
	};

	function clearLabels()
	{
		if (overlay != null)
		{
			clearChildren(overlay.labels);
		}

		labels = null;
	};

	/**
	 * Places the labels of the roads and junctions in the visible part of the
	 * diagram next to them, where they overlap no road, junction, traffic
	 * light or other label, with room for wider text. Labels are hidden if
	 * there are more than maxLabels in view.
	 */
	function placeLabels(counts)
	{
		clearLabels();
		labels = {items: [], hidden: false, unplaced: 0};

		var s = graph.view.scale;
		var t = graph.view.translate;
		var c = graph.container;
		var view = new mxRectangle(c.scrollLeft / s - t.x, c.scrollTop / s - t.y, c.clientWidth / s, c.clientHeight / s);
		var h = (2 * labelLine + 6) / s;
		var pad = 3 / s;
		var roadList = getRoads();
		var items = [];

		for (var i = 0; i < net.crossings.length; i++)
		{
			var junction = net.crossings[i];

			if (junction.fanIn.length + junction.fanOut.length > 0 && mxUtils.contains(view, junction.x, junction.y))
			{
				items.push({junction: junction});
			}
		}

		for (var i = 0; i < roadList.length; i++)
		{
			if (mxUtils.intersects(view, roadList[i].bounds))
			{
				items.push({road: roadList[i]});
			}
		}

		if (items.length > maxLabels)
		{
			labels.hidden = true;

			return;
		}

		// Obstacles near the view
		var area = new mxRectangle(view.x - view.width / 2, view.y - view.height / 2, 2 * view.width, 2 * view.height);
		var grid = new LabelGrid(Math.max(view.width, view.height) / 10);

		for (var i = 0; i < roadList.length; i++)
		{
			var road = roadList[i];

			if (mxUtils.intersects(area, road.bounds))
			{
				for (var j = 1; j < road.points.length; j++)
				{
					grid.addSegment(road.points[j - 1], road.points[j], road.width);
				}
			}
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			var junction = net.crossings[i];
			var r = junction.radius;

			if (r > 0 && mxUtils.contains(area, junction.x, junction.y))
			{
				grid.addRect(new mxRectangle(junction.x - r, junction.y - r, 2 * r, 2 * r));
			}

			for (var j = 0; junction.signals != null && j < junction.signals.length; j++)
			{
				var signal = junction.signals[j];
				var hs = getHeadScale();
				grid.addRect(new mxRectangle(signal.x - 3 * hs, signal.y - 7 * hs, 6 * hs, 14 * hs));
			}
		}

		// Junctions first, then the roads from the shortest
		items.sort(function(a, b)
		{
			return ((a.road != null) ? a.road.lengths[a.road.lengths.length - 1] : -1) -
				((b.road != null) ? b.road.lengths[b.road.lengths.length - 1] : -1);
		});

		for (var i = 0; i < items.length; i++)
		{
			var item = items[i];
			var lines = getLabelText(item, counts);

			// Room for one more digit in each number
			item.px = getLabelWidth(lines) + Math.ceil(0.6 * labelFont);
			var rect = findLabelPlace(item, grid, item.px / s, h, pad);

			if (rect != null)
			{
				grid.addRect(rect);
				item.rect = rect;

				// Junctions have a line to their label
				if (item.junction != null)
				{
					var j = item.junction;
					var x = Math.max(rect.x, Math.min(j.x, rect.x + rect.width));
					var y = Math.max(rect.y, Math.min(j.y, rect.y + rect.height));
					var d = Math.sqrt((x - j.x) * (x - j.x) + (y - j.y) * (y - j.y));
					var f = (d > 0) ? Math.min(1, j.radius / d) : 0;
					var line = createNode('line', overlay.labels, {x1: j.x + (x - j.x) * f, y1: j.y + (y - j.y) * f,
						x2: x, y2: y, 'stroke-width': 1 / s});
					line.style.stroke = 'light-dark(#59636e,#9aa0a6)';
				}

				item.node = createNode('g', overlay.labels, {transform: 'translate(' + rect.x + ',' + rect.y +
					') scale(' + (1 / s) + ')'});
				var bg = createNode('rect', item.node, {width: item.px, height: 2 * labelLine + 6, rx: 4});
				bg.style.fill = 'light-dark(rgba(255,255,255,0.92),rgba(32,33,36,0.92))';
				bg.style.stroke = 'light-dark(#c4c7c5,#5f6368)';
				bg.style.strokeWidth = '1';
				item.texts = [];

				for (var j = 0; j < 2; j++)
				{
					var text = createNode('text', item.node, {x: 4, y: 3 + labelLine * (j + 1) - 2,
						'font-size': labelFont, 'font-family': 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'});
					text.style.fill = (j == 0) ? 'light-dark(#1f2328,#e6e7e9)' : 'light-dark(#59636e,#9aa0a6)';
					text.style.fontVariantNumeric = 'tabular-nums';
					item.texts.push(text);
				}

				labels.items.push(item);
			}
			else
			{
				labels.unplaced++;
			}
		}
	};

	/**
	 * Returns the rectangle of the given width and height for the label of
	 * the given road or junction next to it that hits no obstacle in the
	 * given grid, or null.
	 */
	function findLabelPlace(item, grid, w, h, pad)
	{
		var anchors = [];

		if (item.junction != null)
		{
			for (var i = 0; i < 8; i++)
			{
				var a = -Math.PI / 4 - i * Math.PI / 4;
				anchors.push({x: item.junction.x, y: item.junction.y, nx: Math.cos(a), ny: Math.sin(a),
					dist: item.junction.radius + 8 / graph.view.scale});
			}
		}
		else
		{
			var road = item.road;
			var pts = road.points;
			var len = road.lengths[road.lengths.length - 1];
			var fractions = [0.5, 0.35, 0.65, 0.2, 0.8];

			for (var i = 0; i < fractions.length; i++)
			{
				var d = fractions[i] * len;
				var j = 1;

				while (j < pts.length - 1 && road.lengths[j] < d)
				{
					j++;
				}

				var seg = roads.getDistance(pts[j - 1], pts[j]);

				if (seg > 0)
				{
					var p = roads.getPointAt(pts, road.lengths, d) || pts[j];
					var dx = (pts[j].x - pts[j - 1].x) / seg;
					var dy = (pts[j].y - pts[j - 1].y) / seg;
					anchors.push({x: p.x, y: p.y, nx: -dy, ny: dx, dist: road.width});
					anchors.push({x: p.x, y: p.y, nx: dy, ny: -dx, dist: road.width});
				}
			}
		}

		for (var k = 0; k < 2; k++)
		{
			for (var i = 0; i < anchors.length; i++)
			{
				var a = anchors[i];
				var ext = w / 2 * Math.abs(a.nx) + h / 2 * Math.abs(a.ny);
				var dist = a.dist + 2 * pad + ext + k * h;
				var r = new mxRectangle(a.x + a.nx * dist - w / 2, a.y + a.ny * dist - h / 2, w, h);

				if (!grid.hits(r, pad))
				{
					return r;
				}
			}
		}

		return null;
	};

	/**
	 * Updates the text of the labels and places them again if the view or
	 * the network changed or if the text no longer fits.
	 */
	function updateLabels()
	{
		var counts = getExpected();

		if (labelsDirty || labels == null)
		{
			labelsDirty = false;
			placeLabels(counts);
		}

		for (var i = 0; i < labels.items.length; i++)
		{
			var item = labels.items[i];
			var lines = getLabelText(item, counts);

			if (getLabelWidth(lines) > item.px)
			{
				labelsDirty = true;
			}

			for (var j = 0; j < 2; j++)
			{
				if (item.texts[j].textContent != lines[j])
				{
					item.texts[j].textContent = lines[j];
				}
			}
		}
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

			if (config.labels && labels != null && (labels.hidden || labels.unplaced > 0))
			{
				lines.push('Labels: ' + ((labels.hidden) ? 'zoom in to show them' :
					labels.unplaced + ' without space, zoom in to show them'));
			}
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

		// Frames may start before the last step, for example after a start
		paintCars((running && config.speed <= 20) ? Math.max(0, Math.min(1, (now - lastStep) / interval)) : 1);

		if (config.labels && (labelsDirty || now - lastLabels >= labelInterval))
		{
			updateLabels();
			lastLabels = now;
		}

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
		var types = {};

		for (var i = 0; i < vehicleTypes.length; i++)
		{
			types[vehicleTypes[i].name] = {count: 0, topKmh: Math.round(3.6 * cellLength *
				Math.max(1, config.vmax + vehicleTypes[i].dv)), kmh: 0};
		}

		sim.active.forEach(function(v)
		{
			var t = types[v.type.name];
			t.count++;
			t.kmh += (v.transit != null) ? 1 : v.v;

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

		// Average speed of each type of vehicle
		for (var name in types)
		{
			types[name].kmh = (types[name].count > 0) ?
				Math.round(3.6 * cellLength * types[name].kmh / types[name].count) : 0;
		}

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
		console.table(types);
		console.log('Network', {junctions: net.crossings.length, links: net.links.length, lanes: net.lanes,
			cells: net.cells, running: running, speed: config.speed});
		console.table(links);
		console.table(junctions);
		console.log('Cars standing for 10 s or more');
		console.table(stopped.slice(0, 50).map(function(v)
		{
			var next = v.next();

			return {car: v.id, type: v.type.name, standing: v.stopped, age: sim.time - v.start, place: getPlace(v),
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

		selectVehicle(null);

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
		else if (key == 'labels')
		{
			labelsDirty = true;
			clearLabels();
			schedule();
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

	var transform = roads.guard(function()
	{
		updateTransform();
		schedule();
	}, 'simulation transform');
	graph.view.addListener(mxEvent.SCALE, transform);
	graph.view.addListener(mxEvent.TRANSLATE, transform);
	graph.view.addListener(mxEvent.SCALE_AND_TRANSLATE, transform);

	// Scrolling and resizing show other roads and junctions
	var viewChanged = roads.guard(function()
	{
		if (config.labels)
		{
			labelsDirty = true;
			schedule();
		}
	}, 'simulation view change');

	mxEvent.addListener(graph.container, 'scroll', viewChanged);
	mxEvent.addListener(window, 'resize', viewChanged);

	/**
	 * Returns the given point in graph coordinates in model coordinates.
	 */
	function getModelPoint(x, y)
	{
		var s = graph.view.scale;
		var t = graph.view.translate;

		return new mxPoint(x / s - t.x, y / s - t.y);
	};

	/**
	 * Returns the car that is painted nearest to the given point in model
	 * coordinates within a few pixels, or null.
	 */
	function findVehicle(pt)
	{
		var best = Math.pow(Math.max(vehicleShapes.truck.length / 2 * getVehicleScale(), 8 / graph.view.scale), 2);
		var result = null;

		if (sim != null && overlay != null)
		{
			sim.active.forEach(function(v)
			{
				var d = (v.x != null) ? (v.x - pt.x) * (v.x - pt.x) + (v.y - pt.y) * (v.y - pt.y) : Infinity;

				if (d < best)
				{
					best = d;
					result = v;
				}
			});
		}

		return result;
	};

	/**
	 * Returns true if the given mouse event is on a handle of a selected
	 * cell, so that cars under it do not take the click.
	 */
	function isHandleEvent(me)
	{
		var cells = graph.getSelectionCells();

		for (var i = 0; i < cells.length; i++)
		{
			var handler = graph.selectionCellsHandler.getHandler(cells[i]);

			if (handler != null && handler.getHandleForEvent != null && handler.getHandleForEvent(me) != null)
			{
				return true;
			}
		}

		return false;
	};

	/**
	 * Selects the given car, or none if it is null: highlights it with a
	 * label that drives along, colors its route from its start A to its
	 * destination B and clears the selection of the diagram.
	 */
	function selectVehicle(v)
	{
		if (overlay != null)
		{
			clearChildren(overlay.route);
			clearChildren(overlay.focus);
		}

		focus = null;

		if (v != null && overlay != null)
		{
			var stroke = 'light-dark(#1a73e8,#8ab4f8)';
			focus = {v: v, status: null, end: 0, key: null, net: null, dest: v.dest};
			focus.trail = createNode('path', overlay.route, {fill: 'none', 'stroke-linecap': 'round',
				'stroke-linejoin': 'round', 'stroke-opacity': '0.4'});
			focus.ahead = createNode('path', overlay.route, {fill: 'none', 'stroke-linecap': 'round',
				'stroke-linejoin': 'round', 'stroke-opacity': '0.75'});
			focus.trail.style.stroke = stroke;
			focus.ahead.style.stroke = stroke;
			focus.markers = [createMarker('A', '#188038'), createMarker('B', '#d93025')];
			// The ring has a halo, so that it stands out from the speed colors
			focus.halo = createNode('circle', overlay.focus, {fill: 'none', 'stroke-opacity': 0.85});
			focus.halo.style.stroke = 'light-dark(#ffffff,#000000)';
			focus.ring = createNode('circle', overlay.focus, {fill: 'none'});
			focus.ring.style.stroke = stroke;
			focus.line = createNode('line', overlay.focus, {});
			focus.line.style.stroke = stroke;
			focus.label = createNode('g', overlay.focus, {});
			focus.box = createNode('rect', focus.label, {x: 0, y: 0, height: 18, rx: 4});
			focus.box.style.fill = 'light-dark(#ffffff,#202124)';
			focus.box.style.stroke = stroke;
			focus.text = createNode('text', focus.label, {x: 6, y: 13, 'font-size': 11,
				'font-family': 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'});
			focus.text.style.fill = 'light-dark(#1f2328,#e6e7e9)';
			focus.text.style.fontVariantNumeric = 'tabular-nums';

			// Paints the car on top of the others
			overlay.cars.appendChild(v.node);
			graph.clearSelection();
			paintFocus();
		}

		if (sim != null && net != null)
		{
			updateStats();
		}
	};

	/**
	 * Returns a marker for the start or destination of the selected car with
	 * the given letter and color.
	 */
	function createMarker(letter, color)
	{
		var g = createNode('g', overlay.route, {});
		createNode('circle', g, {r: 9, fill: color, stroke: '#ffffff', 'stroke-width': 1.5});
		var text = createNode('text', g, {y: 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 'bold',
			fill: '#ffffff', 'font-family': 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'});
		text.textContent = letter;

		return g;
	};

	/**
	 * Returns the points of the middle lane of the given link, of the link
	 * with the same key in the current network.
	 */
	function getLanePoints(link)
	{
		link = net.linkMap.get(link.key) || link;

		return link.paths[Math.floor((link.paths.length - 1) / 2)];
	};

	/**
	 * Returns the SVG path of the given points.
	 */
	function getPathData(pts)
	{
		var d = [];

		for (var i = 0; i < pts.length; i++)
		{
			d.push(((i == 0) ? 'M' : 'L') + Math.round(pts[i].x * 10) / 10 + ' ' + Math.round(pts[i].y * 10) / 10);
		}

		return (d.length > 1) ? d.join(' ') : '';
	};

	/**
	 * Paints the route of the selected car, behind it and ahead, with its
	 * start and destination, and the ring and the label that follow it.
	 */
	function paintFocus()
	{
		if (focus == null)
		{
			return;
		}

		var v = focus.v;
		var s = graph.view.scale;
		var gone = focus.status != null;
		var key = [s, v.index, v.route.length, v.cell, v.lane, v.ringLane,
			v.link != null, v.transit != null, v.ring != null, gone].join(',');

		// Keeps the destination if it was removed
		focus.dest = v.dest || focus.dest;

		if ((key != focus.key || focus.net != net) && net.links.length > 0)
		{
			focus.key = key;
			focus.net = net;
			var behind = [];
			var ahead = [];
			var trail = (v.link != null && !gone) ? v.trail.slice(0, v.trail.length - 1) : v.trail;

			for (var i = 0; i < trail.length; i++)
			{
				behind = behind.concat(getLanePoints(trail[i]).points);
			}

			if (!gone)
			{
				// Splits the lane of the car at the car
				if (v.link != null)
				{
					var path = v.link.paths[v.lane];
					var pos = (v.cell + 0.5) / (v.link.out + 1) * path.lengths[path.lengths.length - 1];
					var pt = v.link.getPoint(v.lane, v.cell);
					var i = 0;

					while (i < path.points.length && path.lengths[i] < pos)
					{
						behind.push(path.points[i++]);
					}

					behind.push(pt);
					ahead.push(pt);

					while (i < path.points.length)
					{
						ahead.push(path.points[i++]);
					}
				}
				else
				{
					var pt = v.getPoint(false);
					behind.push(pt);
					ahead.push(pt);
				}

				for (var i = v.index; i < v.route.length; i++)
				{
					ahead = ahead.concat(getLanePoints(v.route[i]).points);
				}
			}

			var w = getSize(0.6, 5);
			focus.trail.setAttribute('d', getPathData(behind));
			focus.trail.setAttribute('stroke-width', w);
			focus.ahead.setAttribute('d', getPathData(ahead));
			focus.ahead.setAttribute('stroke-width', w);

			var ends = [net.crossingMap.get(v.origin.id) || v.origin, net.crossingMap.get(focus.dest.id) || focus.dest];

			for (var i = 0; i < 2; i++)
			{
				focus.markers[i].setAttribute('transform', 'translate(' + ends[i].x + ',' + ends[i].y +
					') scale(' + (1 / s) + ')');
			}
		}

		focus.ring.style.display = (gone) ? 'none' : '';
		focus.halo.style.display = focus.ring.style.display;
		focus.line.style.display = focus.ring.style.display;
		focus.label.style.display = focus.ring.style.display;

		if (!gone && v.x != null)
		{
			var r = vehicleShapes[v.type.name].length / 2 * getVehicleScale() + 4 / s;
			var lx = v.x + r * 0.7071 + 10 / s;
			var ly = v.y - r * 0.7071 - 10 / s;
			var text = getTypeName(v) + ' · ' + Math.round(getKmh(v)) + ' km/h';
			focus.halo.setAttribute('cx', v.x);
			focus.halo.setAttribute('cy', v.y);
			focus.halo.setAttribute('r', r);
			focus.halo.setAttribute('stroke-width', 5 / s);
			focus.ring.setAttribute('cx', v.x);
			focus.ring.setAttribute('cy', v.y);
			focus.ring.setAttribute('r', r);
			focus.ring.setAttribute('stroke-width', 2.5 / s);
			focus.line.setAttribute('x1', v.x + r * 0.7071);
			focus.line.setAttribute('y1', v.y - r * 0.7071);
			focus.line.setAttribute('x2', lx);
			focus.line.setAttribute('y2', ly);
			focus.line.setAttribute('stroke-width', 1.5 / s);
			focus.label.setAttribute('transform', 'translate(' + lx + ',' + (ly - 18 / s) + ') scale(' + (1 / s) + ')');

			if (focus.text.textContent != text)
			{
				focus.text.textContent = text;
				focus.box.setAttribute('width', Math.ceil(0.55 * 11 * text.length) + 12);
			}
		}
	};

	/**
	 * Returns the name of the type of the given car.
	 */
	function getTypeName(v)
	{
		return (v.type.name == 'truck') ? 'Truck' : ((v.type.name == 'fast') ? 'Fast car' : 'Car');
	};

	/**
	 * Returns the speed of the given car in km/h.
	 */
	function getKmh(v)
	{
		return 3.6 * cellLength * getSpeed(v);
	};

	/**
	 * Returns the name of the given junction for the panel.
	 */
	function getJunctionName(junction)
	{
		var type = (junction.rings != null) ? 'roundabout' : ((junction.phases != null) ? 'traffic light' :
			((junction.id.substring(0, 4) == 'end:') ? 'free end' : ((junction.joint) ? 'joint' : 'crossing')));

		return type + ' ' + ((junction.id.substring(0, 4) == 'end:') ? junction.id.substring(4) : junction.id);
	};

	/**
	 * Returns the data of the selected car as rows of a name and a value, or
	 * null if no car is selected.
	 */
	function getVehicle()
	{
		if (focus == null || sim == null || net == null)
		{
			return null;
		}

		var v = focus.v;
		var gone = focus.status != null;
		var time = (gone) ? focus.end : sim.time;
		var rows = [['Vehicle', getTypeName(v) + ' ' + v.id]];
		rows.push(['Status', (gone) ? focus.status : ((v.stopped > 0) ? 'Standing for ' + v.stopped + ' s' : 'Driving')]);

		if (!gone)
		{
			rows.push(['Speed', Math.round(getKmh(v)) + ' of ' + Math.round(3.6 * cellLength * getTopSpeed(v)) + ' km/h']);
		}

		rows.push(['Start', 'A, ' + getJunctionName(v.origin) + ' at ' + formatTime(v.start)]);
		rows.push(['Destination', 'B, ' + getJunctionName(focus.dest)]);
		rows.push(['Travel time', formatTime(time - v.start)]);
		rows.push(['Distance', (v.driven * cellLength / 1000).toFixed(2) + ' km']);
		rows.push(['Waiting', formatTime(v.waited)]);

		if (!gone)
		{
			var place = (v.transit != null) ? getJunctionName(v.transit.link.from) :
				((v.ring != null) ? getJunctionName(v.ring) + ', ring lane ' + (v.ringLane + 1) +
				' of ' + v.ring.rings.length : 'road ' + v.link.key.substring(0, v.link.key.length - 1) +
				((v.link.key.charAt(v.link.key.length - 1) == '>') ? ' forward' : ' backward') +
				', lane ' + (v.lane + 1) + ' of ' + v.link.cells.length);
			var cells = (v.link != null) ? v.link.out - v.cell : 0;

			for (var i = v.index; i < v.route.length; i++)
			{
				cells += v.route[i].out + 1;
			}

			rows.push(['Place', place]);
			rows.push(['Route left', formatCount(v.route.length - v.index, 'road') + ', ' +
				(cells * cellLength / 1000).toFixed(2) + ' km']);
			rows.push(['Reroutes', String(v.reroutes)]);
			rows.push(['Leaves in', formatTime(Math.max(0, v.end - sim.time)) + ' if not arrived']);
		}

		return {rows: rows, active: !gone};
	};

	// Clicks on cars select them and other clicks clear the selected car,
	// while drags edit the diagram as usual. The cars are painted without
	// pointer events, so clicks are tested against their positions before
	// the handlers of draw.io get them.
	graph.addMouseListener({
		mouseDown: roads.guard(function(sender, me)
		{
			var evt = me.getEvent();
			press = null;

			if (!me.isConsumed() && (mxEvent.isLeftMouseButton(evt) || mxEvent.isTouchEvent(evt)) &&
				!mxEvent.isMultiTouchEvent(evt) && !isHandleEvent(me))
			{
				press = {v: findVehicle(getModelPoint(me.getGraphX(), me.getGraphY())),
					x: me.getGraphX(), y: me.getGraphY()};
			}
		}, 'simulation mouse down'),
		mouseMove: function(sender, me)
		{
			// Ignores the move
		},
		mouseUp: roads.guard(function(sender, me)
		{
			if (press != null && Math.abs(me.getGraphX() - press.x) <= graph.tolerance &&
				Math.abs(me.getGraphY() - press.y) <= graph.tolerance)
			{
				if (press.v != null && sim.active.has(press.v))
				{
					me.consume();
					selectVehicle(press.v);
				}
				else if (focus != null)
				{
					selectVehicle(null);
				}
			}

			press = null;
		}, 'simulation mouse up')
	});

	graph.mouseListeners.unshift(graph.mouseListeners.pop());

	// Double clicks on cars do not edit the road under them
	var dblClick = graph.dblClick;

	graph.dblClick = function(evt, cell)
	{
		var pt = (evt != null) ? mxUtils.convertPoint(graph.container,
			mxEvent.getClientX(evt), mxEvent.getClientY(evt)) : null;

		if (pt != null && findVehicle(getModelPoint(pt.x, pt.y)) != null)
		{
			mxEvent.consume(evt);
		}
		else
		{
			dblClick.apply(this, arguments);
		}
	};

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
	 * Returns the cars that will drive onto each link and into each junction
	 * on their remaining routes, including the cars waiting to start, by the
	 * index of the links and junctions. The result is kept for the step.
	 */
	function getExpected()
	{
		if (expected == null || expected.net != net || expected.time != sim.time)
		{
			var links = new Int32Array(net.links.length);
			var junctions = new Int32Array(net.crossings.length);

			var add = function(v)
			{
				for (var i = v.index; i < v.route.length; i++)
				{
					var link = v.route[i];
					links[link.index]++;

					// Not the junction that the car is in or starts at
					if (i > v.index || v.link != null)
					{
						junctions[link.from.index]++;
					}
				}

				if (v.dest != null && v.ring != v.dest && v.dest.index < junctions.length &&
					net.crossings[v.dest.index] == v.dest)
				{
					junctions[v.dest.index]++;
				}
			};

			sim.active.forEach(add);

			for (var i = 0; i < net.links.length; i++)
			{
				var queue = net.links[i].queue;

				for (var j = 0; j < queue.length; j++)
				{
					add(queue[j]);
				}
			}

			expected = {net: net, time: sim.time, links: links, junctions: junctions};
		}

		return expected;
	};

	/**
	 * Returns the cars that are in the given junction: on their way through
	 * a crossing or on a roundabout.
	 */
	function getJunctionCars(junction)
	{
		var cars = (junction.rings != null) ? junction.vehicles : 0;

		for (var i = 0; i < junction.fanOut.length; i++)
		{
			for (var k = 0; k < junction.fanOut[i].transit.length; k++)
			{
				cars += junction.fanOut[i].transit[k].length;
			}
		}

		return cars;
	};

	/**
	 * Returns the statistics of the given tally with the given cars, queue
	 * and expected cars: the cars, the cars that entered and left since the
	 * start and that are expected, their average speed in km/h if there is a
	 * speed, the cars that passed per hour, the seconds that they stood on
	 * average before and the cars standing in a row with the longest row in
	 * meters.
	 */
	function getTallyStats(tally, cars, queue, next, speed)
	{
		var t = tally.sum();

		return {cars: cars, entered: tally.entered, left: tally.left, expected: next,
			speed: (speed && t.present > 0) ? 3.6 * cellLength * t.moved / t.present : null,
			throughput: (t.steps > 0) ? 3600 * t.passed / t.steps : null,
			wait: (t.passed > 0) ? t.stood / t.passed : null, queue: queue.cars,
			queueLength: queue.cells * cellLength, steps: t.steps};
	};

	/**
	 * Returns the statistics of the last minute and the current state of the
	 * road or junction with the given ID, as columns with a name, or null:
	 * one for a junction with the queues of all roads to it, one for each
	 * direction of a road.
	 */
	function getStats(id)
	{
		if (net == null || sim == null)
		{
			return null;
		}

		var junction = net.crossingMap.get(id);
		var counts = getExpected();

		if (junction != null)
		{
			var queue = {cars: 0, cells: 0};

			for (var i = 0; i < junction.fanIn.length; i++)
			{
				var q = junction.fanIn[i].getQueue();
				queue.cars += q.cars;
				queue.cells = Math.max(queue.cells, q.cells);
			}

			var stats = getTallyStats(getTally(junction), getJunctionCars(junction), queue,
				counts.junctions[junction.index], junction.rings != null);
			stats.name = (junction.rings != null) ? 'Roundabout' : ((junction.phases != null) ?
				'Traffic light' : ((junction.joint) ? 'Joint' : 'Crossing'));

			return [stats];
		}

		var result = [];

		for (var d = 0; d < 2; d++)
		{
			var link = net.linkMap.get(id + ((d == 0) ? '>' : '<'));

			if (link != null)
			{
				var stats = getTallyStats(getTally(link), link.vehicles, link.getQueue(),
					counts.links[link.index], true);
				stats.name = (d == 0) ? '\u2192 Forward' : '\u2190 Backward';
				result.push(stats);
			}
		}

		return (result.length > 0) ? result : null;
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
		importFile: importFile, getLight: getLight, getStats: getStats, getVehicle: getVehicle,
		vehicleShapes: vehicleShapes, speedStops: speedStops,
		selectVehicle: selectVehicle, setDebug: setDebug};
};
