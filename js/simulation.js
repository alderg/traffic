/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Traffic simulation on a draw.io diagram, a port of sim.traffic (Gaudenz
 * Alder, 2000).
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
 * there is space, in each case only if no car is close behind there. With
 * passEitherSide in the config (US), they pass on either side, where there
 * is more space, and do not go back to the right.
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
 * junction to another of the trip mode of the page (trips in the config,
 * see pickTrip): random ones, half of them from or to a junction with
 * gate=1 in its style if there are such entries and exits, commuters
 * between homes and the centre with a gravity model, through traffic
 * between gates, both mixed, or commuters between the homes and jobs of
 * zones from OpenStreetMap with through traffic, on the fastest
 * route under the current speeds with the turns their lanes allow and look
 * for another route after waiting at a junction. maxSpeed=<km/h> in the
 * style of a road is its speed limit. Cars that do not arrive in their
 * lifetime leave the network.
 *
 * Trucks, cars and fast cars have their own top speed, so that faster ones
 * pass slower ones where there is a free lane and queue behind them where
 * there is none, and their own length: cars take one cell and trucks two.
 * A vehicle is in each cell that it takes, so that every check of a free
 * cell sees its length: it moves with its head and its tail follows in the
 * cells behind, in its lane or ring lane and, while it is still there, in
 * the last cell of the lane before a crossing or in the ring that it left
 * (see setTail), also for a step in the lane that it leaves in a lane
 * change. Crossings let a car go only on a way through them that no car in
 * them crosses, until that car's tail has passed (Crossing.isClear), so
 * that crossing cars take turns and a car clears a crossing only when its
 * tail has. On roads with one lane per direction, with passOncoming in
 * the config, a car that is blocked by a slower one passes it through the
 * oncoming lane if there is space to get back in ahead of it and it can pass
 * before an oncoming car, the end of the road or a turn comes near
 * (Link.prototype.mayPass), one per road at a time. Oncoming cars brake for
 * it and the cars behind keep the cell behind it free, so that it can
 * always fall back in when it aborts (Link.prototype.stepPasser). Without
 * passOncoming, cars that pass finish or abort their pass and no new ones
 * start. Vehicles are painted from above with
 * the shape of their type along their lane, inside the cells that they take
 * with a gap to the next (trucks between their head and their tail),
 * turned in their direction
 * through curves, crossings, roundabouts and lane changes, and in the color
 * of their speed in the color set of the config (colors), unless vehicles in
 * the config is off, which skips painting them, like lights for the heads of
 * the traffic lights and roads for the drawing of the diagram. The stop bars
 * of the traffic lights on the lanes are always painted. They, traffic
 * lights and the density of the
 * lanes are painted into the overlay pane, and optionally labels with the
 * cars that are on each road and junction in view, on their way there, and
 * that entered and left. Each link and junction counts its cars for the
 * statistics of the selection (getStats). A click on a car selects it: its
 * route is colored from its start A to its destination B, a ring and a label
 * follow it, and getVehicle returns its data. With center in the config, the
 * view glides with the selected car when it leaves the middle half of the
 * view (centerView). The overlay has no pointer
 * events, so a mouse listener before those of draw.io tests clicks against
 * the positions of the cars, and drags edit the diagram as usual. With debug
 * output, a summary, the links and junctions with cars, the cars that stand
 * longest and the events of the last second (spawns, lane changes,
 * crossings, roundabouts, arrivals, reroutes, phases) go to the console once
 * a second, with a warning if no car moves. The simulation never changes the
 * diagram, only importFile inserts cells and setTrips sets the trips of a
 * page in its root. This script runs in the window of
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
	// Overtaking through the oncoming lane on roads with one lane per
	// direction: the probability per step that a car that may pass does, the
	// cells before the end of the link where passes must be done, the cells
	// of safety to oncoming cars and the steps after which a pass is aborted
	var passProbability = 0.5;
	var passEndCells = 8;
	var passMargin = 3;
	var passSteps = 60;
	var turnCells = 12;
	// Ways through crossings closer than this touch, wider than vehicles
	var conflictDistance = 3;
	var lifetimeFactor = 4;
	var gateShare = 0.5;
	// Trips other than random (see pickTrip): the share of local trips toward
	// the centre or the jobs, the rest go back, the share of them that start
	// or end at a gate, and the default share of through traffic
	var tripModes = ['random', 'commuters', 'through', 'mixed', 'zones'];
	var inboundShare = 0.65;
	var gateCommuterShare = 0.12;
	var defaultThroughShare = 0.25;
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
	// maximum speed, their length in cells, with the key of their share in
	// the config
	var vehicleTypes = [{name: 'car', dv: 0, cells: 1}, {name: 'truck', dv: -2, cells: 2, share: 'trucks'},
		{name: 'fast', dv: 1, cells: 1, share: 'fast'}];
	var slowest = {type: vehicleTypes.reduce(function(a, b)
	{
		return (b.dv < a.dv) ? b : a;
	})};
	var maxLength = vehicleTypes.reduce(function(a, b)
	{
		return Math.max(a, b.cells);
	}, 1);

	/**
	 * Returns the links of the given network where cars may pass through the
	 * oncoming lane: of roads with one lane per direction, without a speed
	 * limit that makes all vehicles equally fast.
	 */
	function getPassable(network)
	{
		return network.paired.filter(function(link)
		{
			return link.limit == 0 || link.limit > getTopSpeed(slowest);
		});
	};

	// Top views of the types of vehicles in units, driving to the right, with
	// the windows cut out of the body, which is in the color of the speed:
	// cars of 4.5 m in a cell of 7.5 m and trucks of 12.5 m with a cab and a
	// trailer in two cells, so that there is a gap between them in queues.
	var vehicleShapes = {
		car: {length: 4.48, width: 2.4, body: 'M 2.24 0 C 2.24 -0.96 2.08 -1.2 1.48 -1.2 L -1.84 -1.2 ' +
			'Q -2.24 -1.2 -2.24 -0.8 L -2.24 0.8 Q -2.24 1.2 -1.84 1.2 L 1.48 1.2 C 2.08 1.2 2.24 0.96 2.24 0 Z',
			windows: 'M 1.16 -0.96 Q 1.4 0 1.16 0.96 L 0.48 0.84 L 0.48 -0.84 Z ' +
			'M -1.32 -0.88 L -1.32 0.88 L -1.8 0.92 Q -1.94 0 -1.8 -0.92 Z'},
		truck: {length: 12.5, width: 2.6, body: 'M 6.25 -0.85 Q 6.25 -1.2 5.85 -1.2 L 4.05 -1.2 L 4.05 1.2 ' +
			'L 5.85 1.2 Q 6.25 1.2 6.25 0.85 Z M 3.75 -1.3 L -6.25 -1.3 L -6.25 1.3 L 3.75 1.3 Z',
			windows: 'M 6 -0.95 Q 6.18 0 6 0.95 L 5.55 0.88 L 5.55 -0.88 Z'},
		fast: {length: 4.8, width: 2.4, body: 'M 2.4 0 C 2.4 -0.6 1.84 -1.12 0.96 -1.12 L -2.08 -1.12 ' +
			'Q -2.28 -1.12 -2.28 -0.88 L -2.28 0.88 Q -2.28 1.12 -2.08 1.12 L 0.96 1.12 C 1.84 1.12 2.4 0.6 2.4 0 Z ' +
			'M -2.4 -1.2 L -2.08 -1.2 L -2.08 1.2 L -2.4 1.2 Z',
			windows: 'M 0.84 -0.8 Q 1.08 0 0.84 0.8 L 0.08 0.74 L 0.08 -0.74 Z ' +
			'M -1 -0.68 L -1 0.68 L -1.44 0.74 L -1.44 -0.74 Z'}};

	// Color sets of the speed from standing to the fastest vehicles (colors in
	// the config), as light-dark pairs for the theme (adaptive in the config,
	// see TrafficRoads.themeAsphalt): dark colors on the lighter road of light
	// mode (#a3a8ad), at least 3:1 against it at every step and 7.5:1 against
	// white, also on the light map, and light ones on the darker road of dark
	// mode (#3c4043), at least 5:1, also on the dark map. Without adaptive, the
	// road is the same gray (#5f6368) in both themes and the vehicles on it
	// are light, at least 3:1, and dark on the light map without the roads
	// (map, else light). The first set is the default, from blue over violet
	// and magenta to red, which stand out from the green of free lanes.
	var speedStops = ['#71bfff', '#baafff', '#f993ff', '#ff98ca', '#ff9f8f'];
	var colorSets = {
		blueRed: {label: 'Blue, violet, red', light: ['#0040dd', '#5b00f6', '#9400a1', '#a50060', '#a91100'],
			dark: speedStops, map: ['#0d61ff', '#792cff', '#b100bd', '#c20080', '#cb0e00']},
		redGreen: {label: 'Red, yellow, green', light: ['#a60000', '#833d00', '#5f5000', '#375a05', '#055e0c'],
			dark: ['#ffb1b1', '#ffb575', '#e9c200', '#85db0c', '#0ce41e']},
		yellowGreen: {label: 'Yellow to green', light: ['#674b00', '#525200', '#345900', '#025d02', '#005b45'],
			dark: ['#fdb900', '#cbcb00', '#81dc00', '#06e406', '#00dfa8']},
		blueOrange: {label: 'Blue to orange (colorblind-friendly)', light: ['#003fd1', '#1e518d', '#515145',
			'#6b4a13', '#833d00'], dark: ['#acc5ff', '#a9c8ed', '#c5c5bb', '#e8bf7a', '#ffb575']},
		rainbow: {label: 'Rainbow', light: ['#0022fc', '#00586f', '#085e1d', '#595200', '#a40b00'],
			dark: ['#b8c2ff', '#32d6ff', '#12e347', '#dac700', '#ffb1ac']}};

	// Pairs of stops for light and dark mode of each set
	Object.keys(colorSets).forEach(function(name)
	{
		var set = colorSets[name];
		set.theme = {light: set.light, dark: set.dark};
		set.onMap = {light: set.map || set.light, dark: set.dark};
		set.fixed = {light: set.dark, dark: set.dark};
	});
	// Vehicles are painted at least minVehiclePx long on the screen where they
	// fit in their cells with vehicleGap to the next, else as long as fits,
	// but at least minVisiblePx when the cells are smaller on the screen
	var minVehiclePx = 9;
	var minVisiblePx = 4;
	var vehicleGap = 1.5;
	var maxWindowsScale = 1.5;
	var vehicleStroke = 0.35;
	var turnChord = 2.5;
	var laneChangeYaw = 25;
	var lampColors = [['#ff3b30', '#4a1512'], ['#ffcc00', '#4a3d0d'], ['#34c759', '#123d1f']];
	var headSize = 0.72;
	// Stop bars on the road, darker on the lighter road of light mode
	var themeBarColors = ['light-dark(#d93025,#ff3b30)', 'light-dark(#f29900,#ffcc00)', 'light-dark(#188038,#34c759)'];
	var config = {cars: 60, speed: 10, vmax: 5, noise: 0.25, reroute: true, density: false, labels: false, lifetime: 300,
		trucks: 0.2, fast: 0.1, passEitherSide: false, passOncoming: true, roads: true, lights: false, vehicles: true,
		mapBackground: false, center: false, adaptive: true, colors: 'blueRed', trips: 'random',
		through: defaultThroughShare, zones: false};

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
	var camera = null;
	var zoomPreview = false;
	var press = null;
	var lastLabels = 0;
	var lastDebug = 0;
	var debugSteps = 0;
	var debugTime = 0;
	var loggedConflicts = 0;

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
	function Link(key, from, to, points, lanes, lw, limit)
	{
		this.key = key;
		this.limit = limit || 0;
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
		this.fill = [];
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
			this.fill.push(0);
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
		this.opposite = null;
		this.road = null;
		this.passPath = null;
		this.block = -1;
		this.passMoved = 0;
	};

	/**
	 * Returns the path of the given lane, or of the oncoming lane in the
	 * direction of this link for the lane after the last.
	 */
	Link.prototype.getPath = function(lane)
	{
		return (lane < this.paths.length) ? this.paths[lane] : this.passPath;
	};

	/**
	 * Returns the top speed of the given car on this link: its own, at most
	 * the speed limit of the link.
	 */
	Link.prototype.getTopSpeed = function(v)
	{
		var vm = getTopSpeed(v);

		return (this.limit > 0) ? Math.min(vm, this.limit) : vm;
	};

	/**
	 * Returns the speed of free flow on this link.
	 */
	Link.prototype.getFreeSpeed = function()
	{
		return (this.limit > 0) ? Math.min(config.vmax, this.limit) : config.vmax;
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
	 * Returns the number of free cells ahead of the given cell, at most max,
	 * before block (see setBlock).
	 */
	Link.prototype.getGap = function(lane, cell, max)
	{
		var cells = this.cells[lane];
		var end = (this.block > cell) ? this.block - 1 : this.out;
		var gap = 0;

		while (gap < max && cell + gap < end && cells[cell + gap + 1] == null)
		{
			gap++;
		}

		return gap;
	};

	/**
	 * Returns true if the given number of cells up to the given cell of the
	 * given lane are free and in the link.
	 */
	Link.prototype.isFree = function(lane, cell, count)
	{
		var cells = this.cells[lane];

		for (var i = 0; i < count; i++)
		{
			if (cell - i < 0 || cell - i > this.out || cells[cell - i] != null)
			{
				return false;
			}
		}

		return true;
	};

	/**
	 * Sets the cell of the links of the given road that their cars do not
	 * drive into while a car passes through the oncoming lane: for the
	 * oncoming cars, the cell of the car that passes, and for the cars behind
	 * it in its lane, the cell behind it, or behind the slower one while it
	 * is beside it, so that it can always fall back in.
	 */
	function setBlock(road)
	{
		var v = road.passer;
		road.links[0].block = -1;
		road.links[1].block = -1;

		if (v != null)
		{
			var w = v.pass.target;
			var cell = (w.link == v.link && w.lane == 0 && w.cell > v.cell - v.len) ?
				Math.min(v.cell, w.cell - w.len + 1) : v.cell;
			v.link.block = cell - v.len;
			v.link.opposite.block = v.link.out - v.cell;
		}
	};

	/**
	 * Returns the cell of this link of the nearest car in the oncoming lane
	 * ahead of the given cell, or the cell after the end of the link, where
	 * cars may come from that cannot be seen.
	 */
	Link.prototype.getOncoming = function(cell)
	{
		var cells = this.opposite.cells[0];

		for (var q = this.out - cell - 1; q >= 0; q--)
		{
			if (cells[q] != null)
			{
				return this.out - q;
			}
		}

		return this.out + 1;
	};

	/**
	 * Returns the top speed of oncoming cars.
	 */
	Link.prototype.getOncomingSpeed = function()
	{
		var vm = config.vmax + 1;

		return (this.opposite.limit > 0) ? Math.min(vm, this.opposite.limit) : vm;
	};

	/**
	 * Returns the steps that the given car in the given cell needs to be with
	 * its whole length one cell ahead of the given slower car in the given
	 * cell, accelerating to its top speed while the other drives at its top
	 * speed, and the cells that it drives meanwhile.
	 */
	Link.prototype.getPassPlan = function(v, i, w, j)
	{
		var vm = this.getTopSpeed(v);
		var wm = this.getTopSpeed(w);
		var speed = v.v;
		var x = i;
		var y = j;
		var steps = 0;

		while (x < y + 1 + v.len && steps < passSteps)
		{
			speed = Math.min(speed + 1, vm);
			x += speed;
			y += wm;
			steps++;
		}

		return {steps: steps, reach: x - i, done: x >= y + 1 + v.len};
	};

	/**
	 * Returns why the given car in the given cell cannot pass with the given
	 * plan before the car in the given cell ahead of the one it passes, if
	 * any, an oncoming car at its top speed, or one from the end of the link,
	 * comes within passMargin, or before the given cells before the end of
	 * the link, or null if it can.
	 */
	Link.prototype.getPassProblem = function(v, i, plan, ahead, endCells)
	{
		var end = i + plan.reach;
		var c = (ahead >= 0) ? this.cells[0][ahead] : null;

		return (!plan.done || sim.time - ((v.pass != null) ? v.pass.start : sim.time) >= passSteps) ? 'time' :
			((end > this.out - endCells) ? 'end' : ((c != null && end > ahead - 1 + c.v * plan.steps) ? 'ahead' :
			((this.getOncoming(i) - this.getOncomingSpeed() * plan.steps <= end + passMargin) ? 'oncoming' : null)));
	};

	/**
	 * Returns the cell of the first car ahead of the given cell in the only
	 * lane or -1.
	 */
	Link.prototype.getAhead = function(cell)
	{
		var cells = this.cells[0];

		for (var j = cell + 1; j <= this.out; j++)
		{
			if (cells[j] != null)
			{
				return j;
			}
		}

		return -1;
	};

	/**
	 * Returns true if the given car in the given cell of the only lane may
	 * pass the given slower car ahead with its head in the given cell through
	 * the oncoming lane: it is blocked by it, the cell behind it and as many
	 * cells ahead of the other as it is long and one more are free, and it
	 * can pass (see getPassProblem) and be back at least passEndCells before
	 * the end of the link and turnCells before turns.
	 */
	Link.prototype.mayPass = function(v, i, w, j)
	{
		var cells = this.cells[0];
		var vm = this.getTopSpeed(v);

		// Also not beside an oncoming car, which getOncoming does not see
		if (i - v.len < 1 || cells[i - v.len] != null || this.getTopSpeed(w) >= vm ||
			j - w.len - i >= Math.min(v.v + 1, vm) || j + 1 + v.len > this.out || !this.isFree(0, j + 1 + v.len, 1 + v.len) ||
			this.opposite.cells[0][this.out - i] != null)
		{
			return false;
		}

		var next = v.next();
		var turn = (next != null) ? this.getTurn(next) : 's';

		return this.getPassProblem(v, i, this.getPassPlan(v, i, w, j), this.getAhead(j),
			passEndCells + ((turn != 's') ? turnCells : 0)) == null;
	};

	/**
	 * Moves the car that passes through the oncoming lane of this link or
	 * lets one start with passOncoming, before the cars of the links move in
	 * this step.
	 */
	Link.prototype.stepPass = function()
	{
		var v = this.road.passer;

		if (v != null && v.link == this)
		{
			this.passMoved += this.stepPasser(v);
		}
		else if (v == null && this.vehicles > 1 && config.passOncoming)
		{
			this.passMoved += this.startPass();
		}
	};

	/**
	 * Lets a car on a road with one lane per direction that is blocked by a
	 * slower one pass it through the oncoming lane (see mayPass), one car per
	 * road at a time, which drives on there in this step. Returns the cells
	 * that it moved.
	 */
	Link.prototype.startPass = function()
	{
		var cells = this.cells[0];
		var ahead = -1;

		for (var i = this.out; i >= 0; i--)
		{
			var v = cells[i];

			// Cars with their head in the cell, not the cells of their tail
			// or of the tail of one that left
			if (v != null && v.link == this && v.cell == i)
			{
				if (ahead >= 0 && this.mayPass(v, i, cells[ahead], ahead) && Math.random() < passProbability)
				{
					cells[i] = null;
					this.road.passer = v;
					net.passing.add(this.road);
					v.lane = this.cells.length;
					v.pass = {target: cells[ahead], start: sim.time, aborting: false};
					setTail(v);
					record('overtake', v, {link: this.key, cell: i, ahead: cells[ahead].id,
						aheadType: cells[ahead].type.name});

					return this.stepPasser(v);
				}

				ahead = i;
			}
			else if (v != null && v.link != this)
			{
				ahead = -1;
			}
		}

		return 0;
	};

	/**
	 * Moves the car that passes through the oncoming lane of this link. It
	 * goes back to its lane as soon as it is ahead of the car it passes, else
	 * it aborts if it can no longer pass before an oncoming car comes within
	 * passMargin, before the end of the link or before the car ahead of the
	 * other, or after passSteps, and falls back in behind: right away if it
	 * is behind, else into the cells behind the tail of the other, which the
	 * cars behind keep free. Returns the cells that it moved, 0 if it went
	 * back to its lane, where it moves with the others.
	 */
	Link.prototype.stepPasser = function(v)
	{
		var cells = this.cells[0];
		var pass = v.pass;
		var w = pass.target;
		var i = v.cell;
		var vm = this.getTopSpeed(v);
		var before = w.link == this && w.lane == 0 && cells[w.cell] == w && w.cell > i - v.len;
		var tail = w.cell - w.len + 1;
		var free = this.getOncoming(i) - i - 1;

		// The car ahead of the other limits how far it may go
		var ahead = this.getAhead((before) ? w.cell : i);
		var limit = (ahead >= 0) ? Math.min(this.out - 2, ahead - 1) : this.out - 2;

		if (before && !pass.aborting)
		{
			var problem = this.getPassProblem(v, i, this.getPassPlan(v, i, w, w.cell), ahead, passEndCells / 2);

			if (problem != null)
			{
				pass.aborting = problem;
			}
		}

		var back = -1;

		if (!before || (pass.aborting && tail > i))
		{
			back = (this.isFree(0, i, v.len)) ? i : -1;
		}
		else if (pass.aborting && this.isFree(0, tail - 1, v.len))
		{
			back = tail - 1;
		}

		if (back >= 0)
		{
			var aborted = before;
			cells[back] = v;
			v.cell = back;
			v.lane = 0;
			v.pass = null;
			setTail(v);
			this.road.passer = null;
			net.passing['delete'](this.road);
			setBlock(this.road);
			record((aborted) ? 'overtake abort' : 'overtake done', v, {link: this.key, cell: back,
				steps: sim.time - pass.start, reason: (aborted) ? pass.aborting : ''});

			if (aborted)
			{
				sim.passAborts++;
				sim.passReasons[pass.aborting] = (sim.passReasons[pass.aborting] || 0) + 1;
			}
			else
			{
				sim.passes++;
			}

			return 0;
		}

		v.v = Math.max(0, Math.min(v.v + 1, vm, free, limit - i, (pass.aborting) ? w.v - 1 : vm));
		v.cell += v.v;
		v.driven += v.v;
		v.over = 0;
		setBlock(this.road);

		if (v.v == 0)
		{
			v.stood++;
		}

		return v.v;
	};

	/**
	 * Returns the number of cars that stand in a row at the end of the lanes,
	 * behind the tails of cars that left, and the longest row in cells.
	 */
	Link.prototype.getQueue = function()
	{
		var result = {cars: 0, cells: 0};

		for (var k = 0; k < this.cells.length; k++)
		{
			var cells = this.cells[k];
			var j = this.out;

			while (j >= 0 && cells[j] != null && cells[j].link != this)
			{
				j--;
			}

			var end = j;

			while (j >= 0 && cells[j] != null && cells[j].link == this && cells[j].v == 0)
			{
				result.cars += (cells[j].cell == j) ? 1 : 0;
				j--;
			}

			result.cells = Math.max(result.cells, end - j);
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
	 * Returns true if the given car with its head in the given cell can
	 * change from lane k to lane l, where the cells of its length must be
	 * free and the given number of cells behind them.
	 */
	Link.prototype.canChange = function(v, k, l, cell, behind)
	{
		return l >= 0 && l < this.cells.length && Math.abs(k - l) == 1 && this.adjacent[Math.max(k, l)] &&
			this.isFree(l, cell, v.len) && this.isFreeBehind(l, cell - v.len + 1, behind);
	};

	/**
	 * Returns the lane with the given number of free cells at its start, no
	 * cars on their way through the crossing to it and the most space ahead,
	 * preferring lanes that allow the turn to the given next link, or -1.
	 */
	Link.prototype.getFreeLane = function(next, count)
	{
		var result = -1;
		var best = -1;

		for (var k = 0; k < this.cells.length; k++)
		{
			if (this.transit[k].length == 0 && this.isFree(k, count - 1, count))
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
		return (this.queue.length == 0 || this.merged) ? this.getFreeLane(v.after(), 1) : -1;
	};

	/**
	 * Returns the lane and the way through the crossing (see
	 * Crossing.getWay) for the given car from the given lane of the given
	 * link into this link, or null. The cells of its length at the start of
	 * the lane must be free, so that it does not stay in the crossing, and
	 * the car behind the tail of the last car on its way to the lane. Lanes
	 * that allow the next turn come first, then right lanes for right turns,
	 * left lanes for left turns and the same lane from the right for straight
	 * ahead, then space. Through traffic and cars that start on the link
	 * take turns, except at joints, where cars that start wait for a gap.
	 * Other crossings let the car go only on a way that no car in the
	 * crossing or in the given ways of cars that wait crosses, and add its
	 * best way to them if it must wait for that.
	 */
	Link.prototype.chooseEntry = function(v, link, k, waiting)
	{
		var result = null;

		if (this.queue.length == 0 || this.merged || this.from.joint)
		{
			var turn = link.getTurn(this);
			var after = v.after();
			var n = this.cells.length;
			var best = Infinity;
			var blocked = null;
			var least = Infinity;

			for (var l = 0; l < n; l++)
			{
				var cars = this.transit[l];

				if (this.isFree(l, v.len - 1, v.len))
				{
					var way = this.from.getWay(link, k, this, l);

					if (cars.length == 0 || cars[cars.length - 1].left + cars[cars.length - 1].v.len <= way.steps - 1)
					{
						var place = (turn == 'r') ? n - 1 - l : ((turn == 'l') ? l :
							Math.abs((n - 1 - l) - (link.cells.length - 1 - k)));
						var rank = ((this.allows(l, after)) ? 0 : 100) + 10 * place -
							this.getGap(l, 0, config.vmax) + cars.length;

						if (waiting != null && !this.from.joint && !this.from.isClear(way, waiting, v))
						{
							if (rank < least)
							{
								least = rank;
								blocked = way;
							}
						}
						else if (rank < best)
						{
							best = rank;
							result = {lane: l, way: way};
						}
					}
				}
			}

			if (result == null && blocked != null)
			{
				waiting.push(blocked);
			}
		}

		return result;
	};

	/**
	 * Puts the given car with its head into the given cell of the given lane,
	 * the first if no cell is given, with its tail behind.
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
		setTail(v);
	};

	/**
	 * Removes and returns the car with its head in the last cell of the given
	 * lane. Its tail stays until it moves on (see setTail).
	 */
	Link.prototype.pop = function(lane)
	{
		var v = this.cells[lane][this.out];
		this.cells[lane][this.out] = null;
		this.vehicles--;
		var tally = getTally(this);
		tally.left++;
		countPass(tally, v);
		v.behind = {link: this, ring: null, lane: lane, cell: this.out, gap: 0, curve: null, way: null};

		return v;
	};

	/**
	 * Lets the given car drive through the crossing on the given curve to the
	 * given lane of the link in the given number of steps of one cell, of
	 * which it drives the given number, at least one, in this step, behind the
	 * tail of the last car on its way there. Cars that drive past the end of
	 * the curve enter the lane as far as it is free.
	 */
	Link.prototype.addTransit = function(v, lane, way, move)
	{
		var cars = this.transit[lane];
		var steps = way.steps;
		var t = {v: v, link: this, lane: lane, steps: steps, left: steps - Math.max(1, move || 1),
			curve: way.curve, way: way};

		if (cars.length > 0)
		{
			t.left = Math.max(t.left, cars[cars.length - 1].left + cars[cars.length - 1].v.len);
		}

		cars.push(t);
		v.link = null;
		v.ring = null;
		v.transit = t;

		// The curve is between the last cell of the link it came from and the
		// first of this one
		if (v.behind != null)
		{
			v.behind.gap = steps - 1;
			v.behind.curve = way.curve;
			v.behind.way = way;
		}

		var cell = (t.left <= 0 && cars.length == 1) ? Math.min(-t.left, this.getGap(lane, -1, 1 - t.left) - 1) : -1;

		if (cell >= 0)
		{
			this.exitTransit(lane, cell);
		}
		else
		{
			t.left = Math.max(t.left, 1);
			setTail(v);
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
	 * the link, each behind the tail of the one ahead, and lets the first
	 * enter it if its first cell is free, else it waits a step before the
	 * lane. Through joints, cars drive at their speed and enter the lane as
	 * far as it is free.
	 */
	Link.prototype.stepTransit = function()
	{
		var joint = this.from.joint;

		for (var k = 0; k < this.transit.length; k++)
		{
			var cars = this.transit[k];
			var ahead = null;

			// Behind the tail of a long vehicle at the start of the lane that
			// is still in the crossing
			for (var j = 0; j < maxLength - 1 && j <= this.out && cars.length > 0; j++)
			{
				var w = this.cells[k][j];

				if (w != null)
				{
					ahead = (w.link == this && w.cell == j && j < w.len - 1) ? w.len - j : null;

					break;
				}
			}

			for (var i = 0; i < cars.length; i++)
			{
				var t = cars[i];
				var from = t.left;
				var left = (joint) ? from - Math.min(t.v.v + 1, this.getTopSpeed(t.v)) : Math.max(from - 1, 0);

				// The steps that it must stay behind the one ahead
				if (ahead != null)
				{
					left = Math.max(left, ahead);
				}

				// The first enters the lane up to the cell it reaches if they are free
				var cell = (ahead == null && left <= 0) ? Math.min(-left, this.getGap(k, -1, 1 - left) - 1) : -1;

				if (cell >= 0)
				{
					this.exitTransit(k, cell);
					i--;
					ahead = Math.max(1, t.v.len - cell);
				}
				else
				{
					t.left = Math.max(left, 1);
					ahead = t.left + t.v.len;

					if (t.left != from)
					{
						setTail(t.v);
					}
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
	 * its end and at the start of the lanes of the given next link, behind
	 * the tail of the last car on its way there, at most the given number.
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
				result = Math.max(result, (last != null) ? last.steps - last.left - last.v.len :
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
	 * Puts the given car with its whole length into the free cells nearest to
	 * the given cell, in the given lane or else in another. Returns false if
	 * all are full.
	 */
	Link.prototype.place = function(v, lane, cell)
	{
		for (var i = 0; i < this.cells.length; i++)
		{
			var k = (lane + i) % this.cells.length;
			var free = findFreeCell(this.cells[k], cell, v.len, false);

			if (free >= 0)
			{
				this.cells[k][free] = v;
				this.vehicles++;
				v.link = this;
				v.ring = null;
				v.lane = k;
				v.cell = free;
				v.behind = null;
				setTail(v);

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
		var v = (this.vehicles == 0) ? this.getFreeSpeed() : Math.max(this.vavg, 1 / (this.out + 1));

		return this.out / v;
	};

	/**
	 * Returns the point of the given cell, which may be fractional, in the
	 * given lane.
	 */
	Link.prototype.getPoint = function(lane, cell)
	{
		var path = (lane < this.paths.length) ? this.paths[lane] : this.passPath;
		var length = path.lengths[path.lengths.length - 1];

		return roads.getPointAt(path.points, path.lengths, (cell + 0.5) / (this.out + 1) * length) ||
			path.points[0];
	};

	/**
	 * Returns the lane that the given car in lane k and the given cell
	 * changes to, with its whole length, once its tail is in the link. Cars
	 * in lanes that do not allow their next turn move toward one that does,
	 * into gaps of one cell in the last turnCells cells. Others pass on the
	 * left when they are blocked and there is more space, and go back to the
	 * right when there is space for their speed. With passEitherSide (US),
	 * blocked cars pass on the side with more space, the left if both have
	 * as much, and stay in their lane after passing.
	 */
	Link.prototype.chooseLane = function(v, k, cell)
	{
		var vmax = config.vmax;
		var vm = this.getTopSpeed(v);
		var next = v.next();
		var left = this.out - cell;

		if (cell < v.len - 1)
		{
			return k;
		}

		if (next != null && !this.allows(k, next))
		{
			var side = this.getTurnSide(k, next);

			return (side != 0 && this.canChange(v, k, k + side, cell, (left > turnCells) ? vmax : 1)) ? k + side : k;
		}

		if (left > 0 && config.passEitherSide)
		{
			var gap = this.getGap(k, cell, vm);

			if (gap < Math.min(v.v + 1, vm))
			{
				var lane = k;
				var space = gap;

				for (var l = k - 1; l <= k + 1; l += 2)
				{
					if (this.canChange(v, k, l, cell, vmax) && (left > turnCells || this.allows(l, next)))
					{
						var g = this.getGap(l, cell, vm);

						if (g > space)
						{
							lane = l;
							space = g;
						}
					}
				}

				if (lane != k && Math.random() < overtakeProbability)
				{
					return lane;
				}
			}
		}
		else if (left > 0)
		{
			var gap = this.getGap(k, cell, vm);

			if (gap < Math.min(v.v + 1, vm) && this.canChange(v, k, k - 1, cell, vmax) &&
				(left > turnCells || this.allows(k - 1, next)) && this.getGap(k - 1, cell, vm) > gap &&
				Math.random() < overtakeProbability)
			{
				return k - 1;
			}

			if (this.canChange(v, k, k + 1, cell, vmax) && (left > turnCells || this.allows(k + 1, next)) &&
				this.getGap(k + 1, cell, vm) >= Math.min(v.v + 2, vm) && Math.random() < keepRightProbability)
			{
				return k + 1;
			}
		}

		return k;
	};

	/**
	 * Changes lanes, deciding for all cars first, so that the order of the
	 * lanes does not matter. Cars keep the cells that they leave in this
	 * step (see keepCells), and returns the cars that changed.
	 */
	Link.prototype.changeLanes = function()
	{
		var moves = [];
		var changed = [];

		for (var k = 0; k < this.cells.length; k++)
		{
			for (var i = 0; i <= this.out; i++)
			{
				var v = this.cells[k][i];

				if (v != null && v.link == this && v.cell == i)
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

			if (this.isFree(m[2], m[3], m[0].len))
			{
				this.cells[m[1]][m[3]] = null;
				this.cells[m[2]][m[3]] = m[0];
				m[0].lane = m[2];
				setTail(m[0]);
				keepCells(m[0], this.cells[m[1]], m[3], 0);
				changed.push(m[0]);
				record('lane', m[0], {link: this.key, from: m[1], to: m[2], cell: m[3]});
			}
		}

		return changed;
	};

	/**
	 * Nagel-Schreckenberg update of the cars in the link, which move with
	 * their head and keep the cells of their length behind it free of others.
	 */
	Link.prototype.step = function()
	{
		var out = this.out;

		if (this.vehicles == 0 && this.queue.length == 0)
		{
			for (var k = 0; k < this.counts.length; k++)
			{
				this.counts[k] = 0;
				this.fill[k] = 0;
			}

			return;
		}

		// Cars enter traffic at the start of their first link with their
		// whole length, at joints in gaps of the traffic through it
		if (this.queue.length > 0 && !(this.from.joint && this.isApproached()))
		{
			var lane = this.getFreeLane(this.queue[0].after(), this.queue[0].len);

			if (lane >= 0)
			{
				var first = this.queue.shift();
				addActive(first);
				getTally(this.from).left++;
				this.enter(first, lane, first.len - 1);
				this.merged = true;
			}
		}

		var changed = (this.cells.length > 1) ? this.changeLanes() : null;

		var noise = config.noise;
		var moved = this.passMoved;
		this.passMoved = 0;

		for (var k = 0; k < this.cells.length; k++)
		{
			var cells = this.cells[k];
			var count = 0;
			var fill = 0;

			// Accelerates, brakes to the gap and dawdles
			for (var i = 0; i <= out; i++)
			{
				var v = cells[i];
				fill += (v != null) ? 1 : 0;

				if (v != null && v.link == this && v.cell == i && v.lane == k)
				{
					var vm = this.getTopSpeed(v);
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

				if (car != null && car.v > 0 && car.link == this && car.cell == j && car.lane == k)
				{
					var to = Math.min(j + car.v, out);
					cells[j] = null;
					cells[to] = car;
					car.cell = to;
					car.over = j + car.v - to;
					car.driven += to - j;
					moved += car.v;

					if (car.len > 1)
					{
						setTail(car);
					}
				}
			}

			this.counts[k] = count;
			this.fill[k] = fill;
		}

		// Frees the cells that cars left by changing lanes
		for (var i = 0; changed != null && i < changed.length; i++)
		{
			setTail(changed[i]);
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

			if (top != null && top.link == this && top.cell == out && top.lane == k)
			{
				if (top.next() == null)
				{
					park(this.pop(k));
					getTally(this.to).entered++;
				}
				// The wait counts also without rerouting, so that cars in a lane
				// that does not allow their turn pass after two rounds
				else if (++top.wait % replanSteps == 0 && config.reroute && replan(top))
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
		this.gate = false;
		this.center = false;
		this.homes = 0;
		this.jobs = 0;
	};

	/**
	 * Returns the way through this junction from the given lane of the given
	 * link to the given lane of the next link: the curve, its steps and its
	 * points, made once.
	 */
	Crossing.prototype.getWay = function(link, k, next, l)
	{
		if (this.ways == null)
		{
			this.ways = new Map();
		}

		var key = ((link.index * 8 + k) * net.links.length + next.index) * 8 + l;
		var way = this.ways.get(key);

		if (way == null)
		{
			var curve = createCurve(link, k, next, l);
			way = {id: this.ways.size, curve: curve, steps: getTransitSteps(curve), link: link, lane: k,
				next: next, nextLane: l, points: addCurvePoints([], curve), conflicts: new Map(), close: new Map()};
			this.ways.set(key, way);
		}

		return way;
	};

	/**
	 * Returns true if cars on the given ways through this crossing from
	 * other lanes touch: ways to the same lane, which merge, and ways whose
	 * curves come closer than conflictDistance. Cars that wait take turns
	 * with those.
	 */
	Crossing.prototype.isConflict = function(a, b)
	{
		if (a.link == b.link && a.lane == b.lane)
		{
			return false;
		}
		else if (a.next == b.next && a.nextLane == b.nextLane)
		{
			return true;
		}

		var result = a.conflicts.get(b.id);

		if (result == null)
		{
			result = getPolylineDistance(a.points, b.points) < conflictDistance;
			a.conflicts.set(b.id, result);
			b.conflicts.set(a.id, result);
		}

		return result;
	};

	/**
	 * Returns true if a car that starts on the given way touches a car on
	 * the given other way whose tail is the given cells from its start (the
	 * last cell of its lane) where the ways come closer than
	 * conflictDistance or later: ways to the same lane, where the cars keep
	 * their distance, only if one of them is long and they come from other
	 * lanes, until the tail is in the lane.
	 */
	Crossing.prototype.touches = function(way, other, tail, long)
	{
		if (way.next == other.next && way.nextLane == other.nextLane &&
			(!long || (way.link == other.link && way.lane == other.lane)))
		{
			return false;
		}

		var close = other.close.get(way.id);

		// The last half cell of the other way that is close to this one
		if (close == null)
		{
			close = -1;

			for (var p = 0; p <= 2 * other.steps; p++)
			{
				var pt = getCurvePoint(other.curve, p / (2 * other.steps));

				if (getPolylineDistance([pt, pt], way.points) < conflictDistance)
				{
					close = p / 2;
				}
			}

			other.close.set(way.id, close);
		}

		return tail <= close + 0.5;
	};

	/**
	 * Returns true if no car is on a way through this crossing that touches
	 * the given way of the given car (see touches), with its head or its
	 * tail, now or at the start of this step, and none of the given ways of
	 * cars that wait for it, so that crossing cars take turns and a car
	 * clears the crossing only when its tail has.
	 */
	Crossing.prototype.isClear = function(way, waiting, car)
	{
		for (var i = 0; i < waiting.length; i++)
		{
			if (this.isConflict(way, waiting[i]))
			{
				return false;
			}
		}

		for (var i = 0; i < this.fanOut.length; i++)
		{
			var link = this.fanOut[i];

			for (var l = 0; l < link.cells.length; l++)
			{
				var cars = link.transit[l];

				for (var j = 0; j < cars.length; j++)
				{
					var t = cars[j];

					if (this.touches(way, t.way, getWayCell(t.v, t.steps - t.left) - t.v.len + 1, car.len > 1 || t.v.len > 1))
					{
						return false;
					}
				}

				// Cars with their tail in the crossing at the start of the lane
				for (var j = 0; j < maxLength + config.vmax && j <= link.out; j++)
				{
					var v = link.cells[l][j];

					if (v != null && v.link == link && v.cell == j && v.behind != null && v.behind.way != null &&
						v.behind.way.next == link)
					{
						var tail = getWayCell(v, v.behind.way.steps + j) - v.len + 1;

						if (tail < v.behind.way.steps && this.touches(way, v.behind.way, tail, car.len > 1 || v.len > 1))
						{
							return false;
						}
					}
				}
			}
		}

		return true;
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
	 * incoming links with green in turns, on ways that are clear (see
	 * Link.chooseEntry). Cars only pass from lanes that allow their turn,
	 * unless they waited for two reroutes.
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
		var waiting = [];

		for (var i = 0; i < green.length && passed < this.capacity; i++)
		{
			var link = green[(this.finger + i) % green.length];

			for (var k = 0; k < link.cells.length && passed < this.capacity; k++)
			{
				var v = link.cells[k][link.out];
				var next = (v != null && v.link == link) ? v.next() : null;

				if (next != null && next.from == this && (link.allows(k, next) || v.wait > 2 * replanSteps))
				{
					var entry = next.chooseEntry(v, link, k, waiting);

					if (entry != null)
					{
						record('cross', v, {junction: this.id, from: link.key + ':' + k,
							to: next.key + ':' + entry.lane, steps: entry.way.steps});
						countEntry(getTally(this), v);
						next.addTransit(link.pop(k), entry.lane, entry.way);
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

				if (v != null && v.link == link && v.over > 0)
				{
					var next = v.next();
					var entry = (next != null && next.from == this) ? next.chooseEntry(v, link, k, null) : null;

					if (entry != null)
					{
						record('cross', v, {junction: this.id, from: link.key + ':' + k,
							to: next.key + ':' + entry.lane, steps: entry.way.steps});
						countEntry(getTally(this), v);
						next.addTransit(link.pop(k), entry.lane, entry.way, v.over);
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
	 * Returns the cell of the given car on its way through a crossing from
	 * the last cell of the lane before, which is 0, at the start of this
	 * step, or the given cell where it is now if it was not on it then.
	 */
	function getWayCell(v, cell)
	{
		var t = v.prevTransit;

		return (t != null && t.way != null) ? Math.min(cell, Math.round(v.prevProgress * t.steps)) :
			((v.prevLink != null && v.prevLink == v.link) ? Math.min(cell, v.behind.way.steps + v.prevCell) :
			((v.prevLink != null && v.prevLink == v.behind.link) ? 0 : cell));
	};

	/**
	 * Returns the steps to drive along the given curve at one cell per step.
	 */
	function getTransitSteps(curve)
	{
		return Math.max(1, Math.round(curve.length / cellLength));
	};

	/**
	 * Returns the least distance between the given polylines, 0 if they
	 * cross.
	 */
	function getPolylineDistance(p, q)
	{
		var result = Infinity;

		for (var i = 1; i < p.length; i++)
		{
			for (var j = 1; j < q.length; j++)
			{
				var a = p[i - 1];
				var b = p[i];
				var c = q[j - 1];
				var d = q[j];
				var d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
				var d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
				var d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
				var d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);

				if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
				{
					return 0;
				}

				result = Math.min(result, getSegmentDistance(a.x, a.y, c, d), getSegmentDistance(b.x, b.y, c, d),
					getSegmentDistance(c.x, c.y, a, b), getSegmentDistance(d.x, d.y, a, b));
			}
		}

		return result;
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
	 * the cells next to them and ringSpeed cells behind them are free, once
	 * their tail is in the ring.
	 */
	Roundabout.prototype.changeLanes = function(vmax)
	{
		var n = this.size;
		var lanes = this.rings.length;
		var moves = [];
		var changed = [];

		for (var l = 0; l < lanes; l++)
		{
			for (var i = 0; i < n; i++)
			{
				var v = this.rings[l][i];

				if (v != null && v.ring == this && v.cell == i && v.ringMoved >= v.len - 1)
				{
					var target = Math.min(lanes - 1, Math.floor(this.getExitDistance(v, i) * lanes / n));
					var t = l + ((target > l) ? 1 : ((target < l) ? -1 : 0));

					if (t != l && this.isFree(t, i, vmax + v.len - 1))
					{
						moves.push([v, l, t, i]);
					}
				}
			}
		}

		for (var j = 0; j < moves.length; j++)
		{
			var m = moves[j];

			if (this.isFree(m[2], m[3], m[0].len - 1))
			{
				this.rings[m[1]][m[3]] = null;
				this.rings[m[2]][m[3]] = m[0];
				m[0].ringLane = m[2];
				setTail(m[0]);
				keepCells(m[0], this.rings[m[1]], m[3], n);
				changed.push(m[0]);
				record('ringLane', m[0], {junction: this.id, from: m[1], to: m[2], cell: m[3]});
			}
		}

		return changed;
	};

	Roundabout.prototype.step = function()
	{
		var n = this.size;
		var vmax = Math.min(config.vmax, ringSpeed);

		if (this.vehicles > 0)
		{
			var changed = (this.rings.length > 1) ? this.changeLanes(vmax) : null;

			var cars = [];

			// Speeds from the gaps before the move, then all cars move at once
			for (var l = 0; l < this.rings.length; l++)
			{
				var ring = this.rings[l];

				for (var i = 0; i < n; i++)
				{
					var v = ring[i];

					if (v != null && v.ring == this && v.cell == i && v.ringLane == l)
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
				v.ringMoved = Math.min(v.len, v.ringMoved + v.v);
				tally.buckets[b + 2] += v.v;
				this.rings[v.ringLane][v.cell] = v;

				if (v.len > 1)
				{
					setTail(v);
				}
			}

			// Frees the cells that cars left by changing lanes
			for (var i = 0; changed != null && i < changed.length; i++)
			{
				setTail(changed[i]);
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
						// Its tail is in the exit until it drives on
						this.rings[0][v.cell] = null;
						this.vehicles--;
						v.behind = {link: null, ring: this, lane: 0, cell: v.cell, gap: 0, curve: null, way: null};
						v.path = this.getExitPath(v, next, lane);
						record('ringExit', v, {junction: this.id, cell: v.cell, to: next.key + ':' + lane});
						getTally(this).left++;
						next.enter(v, lane);
					}
				}
			}
		}

		// Enters the outer lane from the end of the incoming links if it is free
		// and was free at the start of the step
		for (var i = 0; i < this.fanIn.length; i++)
		{
			var link = this.fanIn[i];

			for (var k = 0; k < link.cells.length; k++)
			{
				var v = link.cells[k][link.out];
				var next = (v != null && v.link == link) ? v.next() : null;
				var ahead = this.rings[0][(link.endCell + 1) % n];

				if (next != null && next.from == this && this.isFree(0, link.endCell, vmax) &&
					(ahead == null || ahead.prevRing != this || (ahead.prevCell - link.endCell + n) % n >= ahead.len) &&
					this.isExitClear(link.endCell, v))
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
					v.ringMoved = 0;
					v.v = 0;
					v.wait = 0;
					this.vehicles++;
					setTail(v);
				}
			}
		}
	};

	/**
	 * Returns true if the given car can enter at the given cell without
	 * touching a car at the start of an exit next to it, which leaves from
	 * about the same cell: long vehicles wait until no long vehicle is
	 * there.
	 */
	Roundabout.prototype.isExitClear = function(cell, v)
	{
		for (var i = 0; i < this.fanOut.length; i++)
		{
			var link = this.fanOut[i];
			var d = Math.abs(link.startCell - cell);

			if (Math.min(d, this.size - d) <= 1)
			{
				for (var l = 0; l < link.cells.length; l++)
				{
					// Also cars that left the start in this step
					for (var j = 0; j <= maxLength + config.vmax && j <= link.out; j++)
					{
						var w = link.cells[l][j];

						if (w != null && v.len > 1 && w.len > 1 && (j == 0 || (w.link == link && w.cell == j &&
							(w.prevRing == this || (w.prevLink == link && w.prevCell < w.len)))))
						{
							return false;
						}
					}
				}
			}
		}

		return true;
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
		this.len = type.cells || 1;
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
		this.ringMoved = 0;
		this.cell = 0;
		this.tail = [];
		this.behind = null;
		this.tail0 = null;
		this.tailSize0 = 0;
		this.v = 0;
		this.wait = 0;
		this.stood = 0;
		this.stopped = 0;
		this.driven = 0;
		this.over = 0;
		this.origin = route[0].from;
		this.trail = [];
		this.pass = null;
		this.trip = null;
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
		this.length = 0;
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

	var trackCells = null;
	var trackIndex = -1;
	var trackDistance = 0;

	/**
	 * Finds the place of the cell of the given car the given number of cells
	 * behind its head: in its lane or ring lane, else the cells behind the
	 * start of them, on the curve through the crossing that it came from and
	 * then in the last cells of the lane before the curve, or of the outer
	 * ring lane before the exit of a roundabout (behind, see Link.pop). Sets
	 * trackCells and trackIndex to its cell, or trackCells to null if it has
	 * none: in the curve, in the oncoming lane or before the start of the
	 * lane where the car started. Returns the cells behind the start of the
	 * lane, ring lane or next lane in transit, or 0 if it is in them.
	 */
	function findTrack(v, d)
	{
		var r = 0;
		trackCells = null;
		trackIndex = -1;

		if (v.transit != null)
		{
			r = v.transit.left + d;
		}
		else if (v.ring != null)
		{
			if (v.ringMoved >= d)
			{
				trackCells = v.ring.rings[v.ringLane];
				trackIndex = (v.cell - d + v.ring.size) % v.ring.size;

				return 0;
			}

			r = d - v.ringMoved;
		}
		else if (v.link != null && v.pass == null)
		{
			if (v.cell >= d)
			{
				trackCells = v.link.cells[v.lane];
				trackIndex = v.cell - d;

				return 0;
			}

			r = d - v.cell;
		}

		var b = v.behind;

		if (r > 0 && b != null && r > b.gap)
		{
			var j = r - b.gap - 1;

			if (b.ring != null)
			{
				trackCells = b.ring.rings[b.lane];
				trackIndex = (b.cell - j + b.ring.size) % b.ring.size;
			}
			else if (b.cell - j >= 0)
			{
				trackCells = b.link.cells[b.lane];
				trackIndex = b.cell - j;
			}
		}

		return r;
	};

	/**
	 * Puts the tail of the given car into the cells behind its head that it
	 * occupies now (see findTrack) and frees the cells of its tail before,
	 * so that no other car drives into them.
	 */
	function setTail(v)
	{
		var tail = v.tail;

		for (var j = 0; j < tail.length; j += 2)
		{
			if (tail[j][tail[j + 1]] == v)
			{
				tail[j][tail[j + 1]] = null;
			}
		}

		tail.length = 0;

		for (var d = 1; d < v.len; d++)
		{
			findTrack(v, d);

			if (trackCells != null)
			{
				var other = trackCells[trackIndex];

				if (other == null)
				{
					trackCells[trackIndex] = v;
					tail.push(trackCells, trackIndex);
				}
				else if (other != v)
				{
					// Must not happen, the debug output warns
					sim.conflicts++;
					record('conflict', v, {place: getPlace(v), other: other.id});
				}
			}
		}
	};

	/**
	 * Keeps the given cells, which the given car leaves in a lane change, up
	 * to the given cell for its length in this step as part of its tail, so
	 * that the cars behind do not drive into them while it moves across
	 * (they are freed with setTail). Cells of rings of the given size wrap.
	 */
	function keepCells(v, cells, cell, size)
	{
		for (var d = 0; d < v.len; d++)
		{
			var i = (size > 0) ? (cell - d + size) % size : cell - d;

			if (i >= 0 && cells[i] == null)
			{
				cells[i] = v;
				v.tail.push(cells, i);
			}
		}
	};

	/**
	 * Frees the cells of the tail of the given car.
	 */
	function clearTail(v)
	{
		for (var j = 0; j < v.tail.length; j += 2)
		{
			if (v.tail[j][v.tail[j + 1]] == v)
			{
				v.tail[j][v.tail[j + 1]] = null;
			}
		}

		v.tail.length = 0;
	};

	/**
	 * Returns the point of the cell of the given car the given number of
	 * cells behind its head (see findTrack), which is on the curve through
	 * the crossing if it is there, and sets trackDistance to the length of
	 * that cell.
	 */
	function getTrackPoint(v, d)
	{
		var r = findTrack(v, d);
		var b = v.behind;

		if (r > 0 && b != null && r <= b.gap)
		{
			trackDistance = b.curve.length / (b.gap + 1);

			return getCurvePoint(b.curve, (b.gap + 1 - r) / (b.gap + 1));
		}
		else if (r > 0 && b != null)
		{
			var cell = b.cell - (r - b.gap - 1);
			trackDistance = getCellSize(b.link, b.lane, b.ring, b.lane, null);

			return (b.ring != null) ? b.ring.getPoint(b.lane, cell) : b.link.getPoint(b.lane, cell);
		}

		// Its own lane or ring lane, also before the start of the lane where
		// it started
		trackDistance = getCellSize(v.link, v.lane, v.ring, v.ringLane, null);

		return (v.ring != null) ? v.ring.getPoint(v.ringLane, v.cell - d) :
			((v.link != null) ? v.link.getPoint(v.lane, v.cell - d) : v.getPoint(false));
	};

	/**
	 * Returns the length of a cell of the given lane of the given link, ring
	 * lane of the given roundabout or curve through a crossing.
	 */
	function getCellSize(link, lane, ring, ringLane, transit)
	{
		if (transit != null)
		{
			return transit.curve.length / transit.steps;
		}
		else if (ring != null)
		{
			return 2 * Math.PI * ring.radii[ringLane] / ring.size;
		}
		else if (link != null)
		{
			var path = link.getPath(lane);

			return path.lengths[path.lengths.length - 1] / (link.out + 1);
		}

		return cellLength;
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
			origins: [], dests: [], gateOrigins: [], gateDests: [], paired: [], passable: [],
			passing: new Set(), cells: 0, lanes: 0, roundabouts: 0, lights: 0, ends: [], dist: null,
			prev: null, stamps: null, search: 0, tooLarge: false, trips: null, zones: false};
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
				junction.gate = mxUtils.getValue(state.style, 'gate', '0') == '1';
				junction.center = mxUtils.getValue(state.style, 'center', '0') == '1';
				junction.homes = Math.max(0, parseFloat(mxUtils.getValue(state.style, 'homes', '0')) || 0);
				junction.jobs = Math.max(0, parseFloat(mxUtils.getValue(state.style, 'jobs', '0')) || 0);
				result.zones = result.zones || junction.homes > 0 || junction.jobs > 0;
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

		/**
		 * Makes the given links of the two directions of a road with one lane
		 * each the oncoming links of each other, with the path of the
		 * oncoming lane in the direction of each, where cars pass.
		 */
		function pairLinks(a, b)
		{
			if (a != null && b != null && a.out == b.out)
			{
				var road = {links: [a, b], passer: null};
				a.opposite = b;
				b.opposite = a;
				a.road = road;
				b.road = road;
				var pa = roads.offsetPoints(a.points, -b.offsets[0]);
				var pb = roads.offsetPoints(b.points, -a.offsets[0]);
				a.passPath = {points: pa, lengths: roads.getLengths(pa)};
				b.passPath = {points: pb, lengths: roads.getLengths(pb)};
				result.paired.push(a, b);
			}
		};

		function addLink(key, from, to, points, lanes, lw, limit)
		{
			var link = new Link(key, from, to, points, lanes, lw, limit);

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
						var limit = getSpeedLimit(state.style);

						if (forward.length > 0)
						{
							addLink(state.cell.id + '>', from, to, pts, forward, lw, limit);
						}

						if (backward.length > 0)
						{
							addLink(state.cell.id + '<', to, from, pts.slice().reverse(), backward, lw, limit);
						}

						// One lane per direction side by side can be passed on
						if (forward.length == 1 && backward.length == 1 &&
							Math.abs(forward[0].index - backward[0].index) == 1)
						{
							pairLinks(result.linkMap.get(state.cell.id + '>'),
								result.linkMap.get(state.cell.id + '<'));
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

				if (junction.gate)
				{
					result.gateOrigins.push(junction);
				}
			}

			if (junction.fanIn.length > 0)
			{
				result.dests.push(junction);

				if (junction.gate)
				{
					result.gateDests.push(junction);
				}
			}
		}

		result.passable = getPassable(result);

		return result;
	};

	/**
	 * Returns the speed limit in cells per step of a road with the given
	 * style, from maxSpeed in km/h, at least one cell per step, or 0 for
	 * none.
	 */
	function getSpeedLimit(style)
	{
		var kmh = parseFloat(mxUtils.getValue(style, 'maxSpeed', '0'));

		return (kmh > 0) ? Math.max(1, Math.round(kmh / (3.6 * cellLength))) : 0;
	};

	function createSim()
	{
		return {time: 0, active: new Set(), queued: 0, created: 0,
			arrived: 0, expired: 0, travel: 0, driven: 0, replanned: 0, passes: 0, passAborts: 0,
			passReasons: {}, conflicts: 0};
	};

	/**
	 * Returns the seconds that a car on the given route has to arrive after
	 * it starts: the lifetime in the config, or four times the time of the
	 * route without other cars at its top speed and the speed limits if that
	 * is longer.
	 */
	function getLifetime(route, v)
	{
		var steps = 0;

		for (var i = 0; i < route.length; i++)
		{
			steps += (route[i].out + 1) / route[i].getTopSpeed(v) + 3;
		}

		return Math.max(config.lifetime, Math.round(lifetimeFactor * steps));
	};

	/**
	 * Returns a random junction of the given list, or of the given gates,
	 * the entries and exits of the network, for gateShare of the cars.
	 */
	function getRandomJunction(list, gates)
	{
		var from = (gates.length > 0 && Math.random() < gateShare) ? gates : list;

		return from[Math.floor(Math.random() * from.length)];
	};

	/**
	 * Keeps the number of cars by adding cars with routes between origins and
	 * destinations of the trip model in the config (trips): random ones as in
	 * the Java version, which also read plans from files, or those of
	 * pickTrip.
	 */
	function addCars()
	{
		// At most one new car per origin and a few routes per step
		var missing = Math.min(config.cars - sim.active.size - sim.queued,
			net.origins.length, maxNewCarsPerStep);
		var random = config.trips == 'random';

		for (var i = 0; i < missing && net.origins.length > 0; i++)
		{
			var trip = (random) ? null : pickTrip();
			var start = (random) ? getRandomJunction(net.origins, net.gateOrigins) : trip.start;
			var end = (random) ? getRandomJunction(net.dests, net.gateDests) : trip.end;
			var route = (start != end) ? getRoute(start, end) : null;

			if (route != null)
			{
				var v = new Vehicle(sim.created++, route, sim.time, getRandomType());
				v.trip = (random) ? {kind: 'random', from: (start.gate) ? 'gate' : 'junction',
					to: (end.gate) ? 'gate' : 'junction'} : trip.info;
				route[0].queue.push(v);
				sim.queued++;
			}
		}
	};

	/**
	 * Returns the trip model of the current network for the modes other than
	 * random, made once per network (see buildTrips).
	 */
	function getTrips()
	{
		if (net.trips == null)
		{
			net.trips = buildTrips(net);
		}

		return net.trips;
	};

	/**
	 * Returns the cumulative sums of the given weights.
	 */
	function getCumulative(weights)
	{
		var cum = new Float64Array(weights.length);
		var sum = 0;

		for (var i = 0; i < weights.length; i++)
		{
			sum += Math.max(0, weights[i]);
			cum[i] = sum;
		}

		return cum;
	};

	/**
	 * Returns a random index of the given cumulative weights, in proportion
	 * to the weights, or -1 if they are all 0.
	 */
	function pickIndex(cum)
	{
		var total = (cum.length > 0) ? cum[cum.length - 1] : 0;

		if (total <= 0)
		{
			return -1;
		}

		var x = Math.random() * total;
		var lo = 0;
		var hi = cum.length - 1;

		while (lo < hi)
		{
			var mid = (lo + hi) >> 1;

			if (cum[mid] > x)
			{
				hi = mid;
			}
			else
			{
				lo = mid + 1;
			}
		}

		return lo;
	};

	/**
	 * Returns the weight of the given gate for through traffic and commuters
	 * from outside: its lanes, more for faster roads, so that main roads
	 * carry more of them.
	 */
	function getGateWeight(gate)
	{
		var links = gate.fanOut.concat(gate.fanIn);
		var w = 0;

		for (var i = 0; i < links.length; i++)
		{
			var kmh = 3.6 * cellLength * ((links[i].limit > 0) ? links[i].limit : config.vmax);
			w = Math.max(w, links[i].cells.length * Math.pow(kmh / 50, 1.5));
		}

		return Math.max(0.05, w);
	};

	/**
	 * Returns the trip model of the given network. Its center are the
	 * junctions with center=1 in their style, else the mean of the junctions
	 * weighted by the square of their roads, so the most connected, and its
	 * radius the distance of three quarters of the junctions from there. The
	 * structure of any network gives homes, more toward the outskirts, and
	 * the centre, which attracts trips the more the closer a junction is to
	 * the center and the more roads it has. Zones have the homes and jobs of
	 * the junctions from OpenStreetMap (homes and jobs in their style, see
	 * js/osm.js). Gates are the junctions with gate=1, else dead ends in the
	 * outer part of the network, else its outermost junctions, with pairs
	 * weighted by their roads (getGateWeight) and more on opposite sides.
	 */
	function buildTrips(network)
	{
		var js = network.crossings;
		var marked = js.filter(function(j)
		{
			return j.center;
		});
		var cx = 0;
		var cy = 0;
		var sw = 0;
		var list = (marked.length > 0) ? marked : js;

		for (var i = 0; i < list.length; i++)
		{
			var n = getRoadCount(list[i]);
			var w = (marked.length > 0) ? 1 : n * n * ((list[i].phases != null || list[i].rings != null) ? 2 : 1);
			cx += list[i].x * w;
			cy += list[i].y * w;
			sw += w;
		}

		cx = (sw > 0) ? cx / sw : 0;
		cy = (sw > 0) ? cy / sw : 0;

		var dist = js.map(function(j)
		{
			return Math.sqrt((j.x - cx) * (j.x - cx) + (j.y - cy) * (j.y - cy));
		});
		var sorted = dist.slice().sort(function(a, b)
		{
			return a - b;
		});
		var radius = Math.max(50, sorted[Math.floor(0.75 * (sorted.length - 1))] || 0);
		var far = sorted[sorted.length - 1] || 0;

		// Gates: marked, else dead ends outside, else the outermost junctions
		var gates = js.filter(function(j)
		{
			return j.gate;
		});

		if (gates.length < 2)
		{
			gates = js.filter(function(j, i)
			{
				return getRoadCount(j) == 1 && dist[i] >= 0.6 * far;
			});
		}

		if (gates.length < 2)
		{
			var outer = sorted[Math.floor(0.9 * (sorted.length - 1))] || 0;

			gates = js.filter(function(j, i)
			{
				return dist[i] >= outer && dist[i] > 0;
			});
		}

		var isGate = new Set(gates);
		var trips = {cx: cx, cy: cy, radius: radius, gates: gates, isGate: isGate, zones: false,
			origins: [], dests: [], gateOrigins: [], gateDests: [], pairs: [], pairCum: null};

		for (var i = 0; i < js.length; i++)
		{
			var j = js[i];
			var r = dist[i] / radius;
			var n = getRoadCount(j);
			trips.zones = trips.zones || j.homes > 0 || j.jobs > 0;

			if (!isGate.has(j))
			{
				var node = {junction: j, home: n * (0.2 + Math.min(1.2, r)),
					centre: n * (Math.exp(-(r / 0.45) * (r / 0.45)) + 0.05) + ((j.center) ? 4 * n : 0),
					homes: j.homes, jobs: j.jobs};

				if (j.fanOut.length > 0)
				{
					trips.origins.push(node);
				}

				if (j.fanIn.length > 0)
				{
					trips.dests.push(node);
				}
			}
		}

		// Weights of gates and of pairs of gates for through traffic
		var gw = gates.map(getGateWeight);
		var pw = [];

		for (var i = 0; i < gates.length; i++)
		{
			if (gates[i].fanOut.length > 0)
			{
				trips.gateOrigins.push({junction: gates[i], weight: gw[i]});
			}

			if (gates[i].fanIn.length > 0)
			{
				trips.gateDests.push({junction: gates[i], weight: gw[i]});
			}

			for (var k = 0; k < gates.length && gates[i].fanOut.length > 0; k++)
			{
				if (k != i && gates[k].fanIn.length > 0)
				{
					var ax = gates[i].x - cx;
					var ay = gates[i].y - cy;
					var bx = gates[k].x - cx;
					var by = gates[k].y - cy;
					var len = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
					var cos = (len > 0) ? (ax * bx + ay * by) / len : 0;
					var apart = (1 - cos) / 2;
					trips.pairs.push([gates[i], gates[k]]);
					pw.push(gw[i] * gw[k] * (0.05 + apart * apart));
				}
			}
		}

		trips.pairCum = getCumulative(pw);
		trips.gateOriginCum = getCumulative(trips.gateOrigins.map(function(g)
		{
			return g.weight;
		}));
		trips.gateDestCum = getCumulative(trips.gateDests.map(function(g)
		{
			return g.weight;
		}));

		// Cumulative weights of the origins and destinations for both models
		['home', 'centre', 'homes', 'jobs'].forEach(function(key)
		{
			function get(node)
			{
				return node[key];
			};

			trips['origin_' + key] = getCumulative(trips.origins.map(get));
			trips['dest_' + key] = getCumulative(trips.dests.map(get));
		});

		return trips;
	};

	/**
	 * Returns the factor of the gravity model for a trip of the given length
	 * in a network of the given radius: few very short trips, and fewer the
	 * longer they are.
	 */
	function getDeterrence(d, radius)
	{
		var short = d / (0.2 * radius);

		return (1 - Math.exp(-short * short)) * Math.exp(-d / (1.2 * radius));
	};

	/**
	 * Returns a destination of the given list for a trip from the given
	 * junction with the given cumulative weights, in proportion to the weight
	 * and the gravity model (getDeterrence), by rejection.
	 */
	function pickDestination(list, cum, from, radius)
	{
		var best = -1;

		for (var tries = 0; tries < 40; tries++)
		{
			var i = pickIndex(cum);

			if (i < 0)
			{
				return null;
			}

			var j = list[i].junction;
			var d = Math.sqrt((j.x - from.x) * (j.x - from.x) + (j.y - from.y) * (j.y - from.y));
			best = i;

			if (j != from && Math.random() < getDeterrence(d, radius))
			{
				break;
			}
		}

		return list[best].junction;
	};

	/**
	 * Returns the start and end of a new trip in the mode of the config and
	 * what kind of trip it is: through traffic between gates with the share
	 * of through traffic of the mode (none for commuters, all for through
	 * traffic), else a local trip of the gravity model, toward the centre or
	 * the jobs for inboundShare of them, from homes and from gates for
	 * gateCommuterShare, and back from there for the others.
	 */
	function pickTrip()
	{
		var t = getTrips();
		var mode = config.trips;
		var zones = mode == 'zones' && t.zones;
		var share = (mode == 'through') ? 1 : ((mode == 'mixed' || mode == 'zones') ? config.through : 0);
		var home = (zones) ? 'homes' : 'home';
		var attract = (zones) ? 'jobs' : 'centre';
		var name = (zones) ? 'work' : 'centre';

		if (t.pairs.length > 0 && Math.random() < share)
		{
			var pair = t.pairs[pickIndex(t.pairCum)];

			return {start: pair[0], end: pair[1], info: {kind: 'through', from: 'gate', to: 'gate'}};
		}

		var inbound = Math.random() < inboundShare;
		var gate = t.gateOrigins.length > 0 && t.gateDests.length > 0 && Math.random() < gateCommuterShare;
		var start = null;
		var end = null;
		var from = (inbound) ? 'home' : name;
		var to = (inbound) ? name : 'home';
		var i = -1;

		if (inbound && gate)
		{
			start = t.gateOrigins[pickIndex(t.gateOriginCum)].junction;
			from = 'gate';
		}
		else
		{
			i = pickIndex(t['origin_' + ((inbound) ? home : attract)]);
			start = (i >= 0) ? t.origins[i].junction : null;
		}

		if (start == null)
		{
			start = net.origins[Math.floor(Math.random() * net.origins.length)];
			from = 'junction';
		}

		if (!inbound && gate)
		{
			end = t.gateDests[pickIndex(t.gateDestCum)].junction;
			to = 'gate';
		}
		else
		{
			end = pickDestination(t.dests, t['dest_' + ((inbound) ? attract : home)], start, t.radius);
		}

		// Another junction if the model has none or only the start, eg. in
		// small networks where all other junctions are gates
		for (var tries = 0; (end == null || end == start) && tries < 10; tries++)
		{
			end = net.dests[Math.floor(Math.random() * net.dests.length)];
			to = (end.gate) ? 'gate' : 'junction';
		}

		return {start: start, end: end, info: {kind: 'local', from: from, to: to}};
	};

	function addActive(v)
	{
		v.end = sim.time + getLifetime(v.route, v);
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
		clearTail(v);

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
			if (v.pass != null)
			{
				v.link.road.passer = null;
				net.passing['delete'](v.link.road);
				setBlock(v.link.road);
				v.pass = null;
			}
			else
			{
				v.link.cells[v.lane][v.cell] = null;
			}

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
	 * interpolation in paintCars, long ones also the point of their tail.
	 */
	function step()
	{
		var tails = config.vehicles && config.speed <= 20;
		addCars();

		sim.active.forEach(function(v)
		{
			if (sim.time >= v.end)
			{
				expire(v);

				return;
			}

			v.tail0 = (tails && v.len > 1) ? getTrackPoint(v, v.len - 1) : null;
			v.tailSize0 = trackDistance;

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

		if (config.passOncoming)
		{
			for (var i = 0; i < net.passable.length; i++)
			{
				if (net.passable[i].vehicles > 0)
				{
					net.passable[i].stepPass();
				}
			}
		}
		else if (net.passing.size > 0)
		{
			// Cars that pass finish or abort their pass, without new ones and
			// their random draws, as before there was overtaking
			Array.from(net.passing).forEach(function(road)
			{
				if (road.passer != null)
				{
					road.passer.link.stepPass();
				}
			});
		}

		for (var i = 0; i < net.links.length; i++)
		{
			net.links[i].step();
		}

		for (var i = 0; i < net.crossings.length; i++)
		{
			net.crossings[i].step();
		}

		if (debug)
		{
			checkPasses();
		}

		sim.time++;
	};

	var passWarnings = 0;

	/**
	 * Warns if a car that passes through the oncoming lane shares its cell
	 * with an oncoming car, is in its own lane too, is at the end of the link
	 * or passes for longer than passSteps, which must not happen.
	 */
	function checkPasses()
	{
		net.passing.forEach(function(road)
		{
			var v = road.passer;

			if (v != null && passWarnings < 20)
			{
				var link = v.link;
				var problem = (link.opposite.cells[0][link.out - v.cell] != null) ? 'an oncoming car in its cell' :
					((link.cells[0].indexOf(v) >= 0) ? 'also in its lane' : ((v.cell >= link.out - 1) ?
					'at the end of the link' : ((sim.time - v.pass.start > passSteps) ? 'passing too long' : null)));

				if (problem != null)
				{
					passWarnings++;
					console.warn('Traffic ' + formatTime(sim.time) + ': car ' + v.id + ' passing on ' +
						getPlace(v) + ' with ' + problem);
				}
			}
		});
	};

	/**
	 * Returns the cell of the given cells nearest to the given cell, looking
	 * behind first, where the given number of cells up to it are free, or -1.
	 * Behind the start of the cells, those of a ring are at its end.
	 */
	function findFreeCell(cells, cell, count, ring)
	{
		for (var d = 0; d < cells.length; d++)
		{
			if (cell - d >= 0 && isFreeRun(cells, cell - d, count, ring))
			{
				return cell - d;
			}
			else if (d > 0 && cell + d < cells.length && isFreeRun(cells, cell + d, count, ring))
			{
				return cell + d;
			}
		}

		return -1;
	};

	/**
	 * Returns true if the given number of cells up to the given cell are free.
	 */
	function isFreeRun(cells, cell, count, ring)
	{
		for (var i = 0; i < count; i++)
		{
			var j = (ring) ? (cell - i + cells.length) % cells.length : cell - i;

			if (j < 0 || cells[j] != null)
			{
				return false;
			}
		}

		return true;
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

		// The cells of the old network are gone, the tails come with the
		// cars to the new one
		sim.active.forEach(function(v)
		{
			v.tail.length = 0;
			v.behind = null;
			v.tail0 = null;
		});

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

					if (v != null && v.ring == prev && v.cell == j)
					{
						var lane = (junction != null && junction.rings != null) ?
							Math.min(l, junction.rings.length - 1) : -1;
						var cell = (lane >= 0) ? findFreeCell(junction.rings[lane],
							Math.round(j * junction.size / prev.size) % junction.size, v.len, true) : -1;

						if (cell >= 0)
						{
							junction.rings[lane][cell] = v;
							junction.vehicles++;
							v.ring = junction;
							v.ringLane = lane;
							v.cell = cell;
							v.ringMoved = v.len;
							setTail(v);
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

					if (v != null && v.link == link && v.cell == j && (next == null ||
						!next.place(v, Math.min(k, next.cells.length - 1), Math.round(j * next.out / link.out))))
					{
						removeActive(v);
					}
				}
			}

			// A car that passes goes back to its lane
			if (link.road != null && link.road.passer != null && link.road.passer.link == link)
			{
				var v = link.road.passer;
				link.road.passer = null;
				v.pass = null;

				if (next == null || !next.place(v, 0, Math.round(v.cell * next.out / link.out)))
				{
					removeActive(v);
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
			keepTrip(v);
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
				v.origin = route[0].from;
				route[0].queue.push(v);
				sim.queued++;
			}
		}
	};

	/**
	 * Gives the given car the start and the roads behind it in the new
	 * network, or copies of the old ones without their links if they are
	 * gone, so that cars do not keep the old network alive.
	 */
	function keepTrip(v)
	{
		var o = v.origin;
		v.origin = net.crossingMap.get(o.id) || {id: o.id, x: o.x, y: o.y, joint: o.joint, gate: o.gate,
			rings: (o.rings != null) ? [] : null, phases: (o.phases != null) ? [] : null};

		for (var i = 0; i < v.trail.length; i++)
		{
			var link = v.trail[i];
			v.trail[i] = net.linkMap.get(link.key) || {key: link.key,
				paths: [link.paths[Math.floor((link.paths.length - 1) / 2)]]};
		}
	};

	function rebuild()
	{
		var old = net;
		dirty = false;
		net = createNetwork();
		readTrips();
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
		// Layers from the bottom up: zones, density, route, stop bars, which
		// are always shown, also on the map without the roads, so that one
		// sees why cars stop there, heads of the traffic lights, cars
		overlay = {root: root, scale: graph.view.scale, zones: createNode('g', root, {}), roads: createNode('g', root, {}),
			route: createNode('g', root, {}), bars: createNode('g', root, {}), heads: createNode('g', root, {}),
			cars: createNode('g', root, {stroke: 'rgba(0,0,0,0.6)', 'stroke-linejoin': 'round', 'fill-rule': 'evenodd'}),
			labels: createNode('g', root, {}), focus: createNode('g', root, {})};
		overlay.cars.style.display = (config.vehicles) ? '' : 'none';
		overlay.heads.style.display = (config.lights) ? '' : 'none';
		graph.view.getDrawPane().style.display = (config.roads) ? '' : 'none';
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
	 * Returns the scale of the traffic light heads, headSize of 14 units high
	 * but at least headSize of 18 pixels (13 pixels) up to 8 times that, so
	 * that they are readable at normal zoom and cover little of the road.
	 */
	function getHeadScale()
	{
		return headSize * Math.min(8, Math.max(1, 18 / 14 / graph.view.scale));
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
	 * Paints the origins and destinations of the trip mode with Show zones
	 * (zones in the config): homes in blue and the centre or the jobs in
	 * orange, as circles with an area in proportion to their weight, the
	 * gates as rings and the center of the network as a cross.
	 */
	function paintZones()
	{
		clearChildren(overlay.zones);

		if (!config.zones || net == null || net.crossings.length == 0)
		{
			return;
		}

		var t = getTrips();
		var mode = config.trips;
		var zones = mode == 'zones' && t.zones;
		var keys = (mode == 'random') ? [] : ((zones) ? ['homes', 'jobs'] : ['home', 'centre']);
		var colors = ['rgba(26,115,232,0.3)', 'rgba(232,113,10,0.35)'];
		var maxR = 0.06 * t.radius;

		for (var k = 0; k < keys.length; k++)
		{
			var nodes = (k == 0) ? t.origins : t.dests;
			var max = 0;

			for (var i = 0; i < nodes.length; i++)
			{
				max = Math.max(max, nodes[i][keys[k]]);
			}

			var g = createNode('g', overlay.zones, {fill: colors[k]});

			for (var i = 0; i < nodes.length && max > 0; i++)
			{
				var f = nodes[i][keys[k]] / max;

				if (f > 0.02)
				{
					createNode('circle', g, {cx: nodes[i].junction.x, cy: nodes[i].junction.y,
						r: Math.round(maxR * Math.sqrt(f) * 10) / 10});
				}
			}
		}

		var rings = createNode('g', overlay.zones, {fill: 'none', 'stroke-width': Math.max(2, maxR / 8)});
		rings.style.stroke = 'light-dark(#3c4043,#e8eaed)';
		var gates = (mode == 'random') ? net.crossings.filter(function(j)
		{
			return j.gate;
		}) : t.gates;

		for (var i = 0; i < gates.length; i++)
		{
			createNode('circle', rings, {cx: gates[i].x, cy: gates[i].y, r: maxR / 2});
		}

		if (mode != 'random' && !zones)
		{
			var c = maxR / 2;
			createNode('path', rings, {d: 'M ' + (t.cx - c) + ' ' + t.cy + ' L ' + (t.cx + c) + ' ' + t.cy +
				' M ' + t.cx + ' ' + (t.cy - c) + ' L ' + t.cx + ' ' + (t.cy + c)});
		}
	};

	/**
	 * Paints the density of the lanes and the traffic lights.
	 */
	function paintNetwork()
	{
		paintZones();
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
						'stroke-width': getSize(0.3, 2), 'stroke-linecap': 'round'}));
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

			// Green when free, red when vehicles take half of the cells of a
			// lane (stop and go)
			for (var k = 0; link.nodes != null && k < link.nodes.length; k++)
			{
				var hue = Math.round(120 * (1 - Math.min(1, 2 * link.fill[k] / (link.out + 1))));

				if (hue != link.hues[k])
				{
					link.nodes[k].style.stroke = getDensityColor(hue);
					link.hues[k] = hue;
				}
			}
		}

		// Hidden heads keep the state they show until they are shown again,
		// the stop bars always show it
		for (var i = 0; i < net.crossings.length; i++)
		{
			var crossing = net.crossings[i];

			for (var j = 0; crossing.signals != null && j < crossing.signals.length; j++)
			{
				var signal = crossing.signals[j];
				var state = crossing.getSignal(signal.phase);

				if (state != signal.barState)
				{
					signal.barState = state;
					signal.bar.style.stroke = (config.adaptive) ? themeBarColors[state] : lampColors[state][0];
				}

				if (config.lights && state != signal.lampState)
				{
					signal.lampState = state;

					for (var k = 0; k < 3; k++)
					{
						signal.lamps[k].setAttribute('fill', lampColors[k][(k == state) ? 0 : 1]);
					}
				}
			}
		}
	};

	/**
	 * Returns the color of the density stripe with the given hue, translucent
	 * on the road, and with adaptive a bit more opaque, darker on the lighter
	 * road of light mode and lighter on the darker road of dark mode.
	 */
	function getDensityColor(hue)
	{
		return (config.adaptive) ? 'light-dark(hsla(' + hue + ',85%,40%,0.4),hsla(' + hue + ',85%,50%,0.4))' :
			'hsla(' + hue + ',85%,45%,0.35)';
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
		var path = (lane < link.paths.length) ? link.paths[lane] : link.passPath;
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

	var pose = {x: 0, y: 0, a: 0, yaw: 0};
	var lanePose = {x: 0, y: 0, a: 0, yaw: 0};

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
		pose.yaw = 0;

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
				pose.yaw = ((dr > 0) ? 1 : -1) * yaw * Math.sin(Math.PI * alpha);
				pose.a += pose.yaw;
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
				pose.yaw = side * yaw * Math.sin(Math.PI * alpha);
				pose.a += pose.yaw;
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
	 * Returns the scale of the shape of the given type of vehicle: larger so
	 * that cars are at least minVehiclePx long on the screen, but at most as
	 * long as fits in the cells of its length with vehicleGap, and at least
	 * the scale where cars are minVisiblePx long (see getLeastScale).
	 */
	function getVehicleScale(type)
	{
		var fit = (type.cells * cellLength - vehicleGap) / vehicleShapes[type.name].length;

		return Math.max(Math.min(Math.max(1, minVehiclePx / vehicleShapes.car.length / graph.view.scale),
			Math.max(1, fit)), getLeastScale(type));
	};

	/**
	 * Returns the least scale of the shape of the given type of vehicle, where
	 * cars are minVisiblePx long on the screen and the others as much longer
	 * as fits in their cells, so that all fill their cells at the same zoom.
	 */
	function getLeastScale(type)
	{
		return minVisiblePx / graph.view.scale / (cellLength - vehicleGap) *
			(type.cells * cellLength - vehicleGap) / vehicleShapes[type.name].length;
	};

	/**
	 * Returns the scale of the width of the given type of vehicle: half as
	 * much larger as its length where it fits in its cells (see
	 * getVehicleScale), so that it stays narrower than conflictDistance and
	 * the lanes of towns, and as its length where it is smaller.
	 */
	function getVehicleWidth(type)
	{
		var k = getVehicleScale(type);

		return Math.min(k, Math.max(1 + (k - 1) / 2, getLeastScale(type)));
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
	 * of vehicles in cells per step, from blue to red, as light-dark pairs
	 * for the theme, so that a change of the theme needs no repaint.
	 */
	function getSpeedColors()
	{
		var top = config.vmax + ((config.fast > 0) ? 1 : 0);
		var stops = getSpeedStopPair();

		if (speedColors == null || speedColors.length != top + 1 || speedColors.stops != stops)
		{
			speedColors = [];
			speedColors.stops = stops;

			for (var i = 0; i <= top; i++)
			{
				var light = getScaleColor(stops.light, i / top);
				var dark = getScaleColor(stops.dark, i / top);
				speedColors.push((light == dark) ? light : 'light-dark(' + light + ',' + dark + ')');
			}
		}

		return speedColors;
	};

	/**
	 * Returns the colors of the speeds in light and dark mode for what is
	 * under the vehicles: with adaptive, the roads of the theme and the light
	 * map or the inverted dark map, else the gray roads, and the light map
	 * without the roads, in the color set of the config (see colorSets).
	 */
	function getSpeedStopPair()
	{
		var set = colorSets[config.colors] || colorSets.blueRed;

		return (config.adaptive) ? set.theme : ((config.mapBackground && !config.roads) ? set.onMap : set.fixed);
	};

	/**
	 * Returns the colors of the speeds as the vehicles show them now, in the
	 * theme of the diagram, for the legend.
	 */
	function getSpeedStops()
	{
		var pair = getSpeedStopPair();
		var dark = typeof Editor !== 'undefined' && Editor.isDarkMode() &&
			(graph.getAdaptiveColors == null || graph.getAdaptiveColors() != 'none');

		return (dark) ? pair.dark : pair.light;
	};

	var speedColors = null;

	/**
	 * Returns the color at the given fraction of the given colors.
	 */
	function getScaleColor(stops, f)
	{
		var x = Math.max(0, Math.min(1, f)) * (stops.length - 1);
		var i = Math.min(stops.length - 2, Math.floor(x));
		var a = parseInt(stops[i].substring(1), 16);
		var b = parseInt(stops[i + 1].substring(1), 16);
		var t = x - i;
		var rgb = [];

		for (var shift = 16; shift >= 0; shift -= 8)
		{
			rgb.push(Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t));
		}

		return 'rgb(' + rgb.join(',') + ')';
	};

	var outlines = {scale: 0};
	var squashSteps = 20;

	/**
	 * Returns the outline of the given type of vehicle turned by the given
	 * whole degrees in the scale of its type (see getVehicleScale) and
	 * shortened to the given number of squashSteps, without the first point,
	 * so that the path of a vehicle is its place and this outline. Changing
	 * the path paints faster than changing a transform.
	 */
	function getOutline(type, deg, squash)
	{
		var turns = outlines[type.name] || (outlines[type.name] = []);
		var key = deg + 360 * squash;
		var result = turns[key];

		if (result == null)
		{
			var shape = vehicleShapes[type.name];
			var k = outlines.scales[type.name];

			// Leaves out the windows when the vehicles are painted larger
			// than they are, which paints faster and is clearer
			result = turnPath((k > maxWindowsScale) ? shape.body : shape.body + ' ' + shape.windows,
				deg * Math.PI / 180, k * squash / squashSteps, outlines.widths[type.name]);
			turns[key] = result;
		}

		return result;
	};

	/**
	 * Returns the given path of absolute M, L, Q, C and Z commands scaled by
	 * the given factors along and across and turned by the given radians
	 * around 0, 0 with relative commands, which start at 0, 0.
	 */
	function turnPath(path, a, kx, ky)
	{
		var tokens = path.split(' ');
		var cos = Math.cos(a);
		var sin = Math.sin(a);
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
					var px = parseFloat(tokens[i++]) * kx;
					var py = parseFloat(tokens[i++]) * ky;
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
	 * Returns the length of the shortest cell around the given car at the
	 * given fraction of the last step: of its lane, ring lane or way through
	 * a crossing, now and before, and of the way through the crossing and
	 * the lane after it while it is there, so that it fits between the cars
	 * around it where the cells of lanes and ways differ in length.
	 */
	function getCellRoom(v, alpha)
	{
		var size = getCellSize(v.link, v.lane, v.ring, v.ringLane, v.transit);
		var way = (v.transit != null) ? v.transit.way : ((v.link != null && v.cell < v.len &&
			v.behind != null) ? v.behind.way : null);

		if (alpha < 1 && (v.prevLink != null || v.prevRing != null || v.prevTransit != null))
		{
			size = Math.min(size, getCellSize(v.prevLink, v.prevLane, v.prevRing, v.prevRingLane, v.prevTransit));
		}

		if (way != null)
		{
			size = Math.min(size, way.curve.length / way.steps, getCellSize(way.next, way.nextLane, null, 0, null));
		}

		return size;
	};

	/**
	 * Sets the given pose to the place of the given long car at the given
	 * fraction of the last step, between its head and the cell at the end of
	 * its tail, which moves straight from where it was, and returns the
	 * length that it has there.
	 */
	function setLongPose(pose, v, alpha)
	{
		setStepPose(pose, v, alpha);
		var t = getTrackPoint(v, v.len - 1);
		var size = Math.min(trackDistance, getCellRoom(v, alpha));
		var x = t.x;
		var y = t.y;

		if (v.tail0 != null && alpha < 1)
		{
			x = v.tail0.x + (x - v.tail0.x) * alpha;
			y = v.tail0.y + (y - v.tail0.y) * alpha;
			size = Math.min(size, v.tailSize0);
		}

		var dx = pose.x - x;
		var dy = pose.y - y;
		var dist = Math.sqrt(dx * dx + dy * dy);

		// Turns toward the next lane in lane changes like the head
		if (dist > 0.01)
		{
			pose.a = Math.atan2(dy, dx) * 180 / Math.PI + pose.yaw;
		}

		pose.x = (pose.x + x) / 2;
		pose.y = (pose.y + y) / 2;

		return dist + size;
	};

	/**
	 * Paints the cars between their previous and current position, turned
	 * in their direction and in the color of their speed, in their cells
	 * with vehicleGap to the next, so that they never overlap where the
	 * cells of a lane are shorter or longer than cellLength, only where they
	 * are smaller than minVisiblePx on the screen.
	 */
	function paintCars(alpha)
	{
		// Hidden vehicles are painted where they are when they are shown
		if (!config.vehicles)
		{
			return;
		}

		var colors = getSpeedColors();
		var top = colors.length - 1;
		var s = graph.view.scale;

		if (s != outlines.scale)
		{
			outlines = {scale: s, scales: {}, widths: {}, least: {}};

			for (var i = 0; i < vehicleTypes.length; i++)
			{
				outlines.scales[vehicleTypes[i].name] = getVehicleScale(vehicleTypes[i]);
				outlines.widths[vehicleTypes[i].name] = getVehicleWidth(vehicleTypes[i]);
				outlines.least[vehicleTypes[i].name] = getLeastScale(vehicleTypes[i]);
			}

			overlay.cars.setAttribute('stroke-width', vehicleStroke * outlines.widths.car);
		}

		sim.active.forEach(function(v)
		{
			var room = 0;

			if (v.len > 1)
			{
				room = setLongPose(pose, v, alpha);
			}
			else
			{
				setStepPose(pose, v, alpha);
				room = getCellRoom(v, alpha);
			}

			// Shorter where the cells are shorter, not below the least size
			var shape = vehicleShapes[v.type.name].length;
			var length = shape * outlines.scales[v.type.name];
			var squash = Math.max(1, Math.min(squashSteps, Math.floor(squashSteps *
				Math.max(room - vehicleGap, shape * outlines.least[v.type.name]) / length)));
			v.angle = pose.a;
			v.x = pose.x;
			v.y = pose.y;
			v.length = length * squash / squashSteps;
			var d = 'M ' + Math.round(pose.x * 100) / 100 + ' ' + Math.round(pose.y * 100) / 100 +
				' ' + getOutline(v.type, ((Math.round(pose.a) % 360) + 360) % 360, squash);
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
				v.node.style.fill = fill;
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
		// At least 1 unit, as cells of 0 would never end the loops of add
		var grid = new LabelGrid(Math.max(1, Math.max(view.width, view.height) / 10));

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
			var cells = 0;

			sim.active.forEach(function(v)
			{
				cells += v.len;
			});

			lines.push('Cars: ' + sim.active.size + ' driving, ' + sim.queued + ' waiting to start');
			lines.push('Density: ' + (100 * cells / net.cells).toFixed(1) + ' % of the cells');
			lines.push('Arrived: ' + sim.arrived + ((sim.expired > 0) ?
				' (' + sim.expired + ' not arrived)' : ''));

			if (sim.arrived > 0 && sim.travel > 0)
			{
				lines.push('Average trip: ' + formatTime(Math.round(sim.travel / sim.arrived)));
				lines.push('Average speed: ' + (3.6 * cellLength * sim.driven / sim.travel).toFixed(1) + ' km/h');
			}

			lines.push('Reroutes: ' + sim.replanned);

			if (config.passOncoming)
			{
				lines.push('Overtakes in the oncoming lane: ' + sim.passes + ((sim.passAborts > 0) ?
					', ' + sim.passAborts + ' aborted' : ''));
			}

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

		// Moves the view first, while the layout of the last frame is valid,
		// with the selected car where it was painted then, and keeps frames
		// coming while it glides with the simulation paused
		if (centerView(now) && !running)
		{
			schedule();
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
			v.ringLane + ' cell ' + v.cell : 'link ' + v.link.key + ((v.pass != null) ? ' oncoming lane' :
			' lane ' + v.lane) + ' cell ' + v.cell + '/' + v.link.out);
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
					var v = link.cells[k][j];
					placed += (v != null && v.link == link && v.cell == j) ? 1 : 0;
				}
			}

			placed += (link.road != null && link.road.passer != null && link.road.passer.link == link) ? 1 : 0;

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
					var v = junction.rings[l][j];
					placed += (v != null && v.ring == junction && v.cell == j) ? 1 : 0;
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
			arrived: sim.arrived, notArrived: sim.expired, reroutes: sim.replanned, overtakes: sim.passes,
			overtakesAborted: sim.passAborts, abortedFor: JSON.stringify(sim.passReasons), tailConflicts: sim.conflicts,
			kmh: (moving > 0) ? Math.round(3.6 * cellLength * speed / sim.active.size) : 0,
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

		if (sim.conflicts > loggedConflicts)
		{
			console.warn('Traffic ' + formatTime(sim.time) + ': ' + (sim.conflicts - loggedConflicts) +
				' tails of long vehicles found their cells taken');
		}

		loggedConflicts = sim.conflicts;

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
				v.tail0 = null;
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
	 * interpolation, Show density repaints the roads, hiding the vehicles
	 * stops painting them, also the selected one, hiding the roads takes the
	 * draw pane out of the page, so that its cells are neither painted nor
	 * hit, while the stop bars stay, hiding the traffic lights stops painting
	 * their heads while they keep switching, colors paints the
	 * vehicles in another color set, center turned on again ends a pause of
	 * centering, passOncoming turned off starts no new passes through the
	 * oncoming lane, adaptive paints the roads, the vehicles, the stop bars and
	 * the density in the colors of the theme or in the same ones for both,
	 * and mapBackground, which the page sets while the map is behind the
	 * roads, changes the colors of the vehicles without adaptive.
	 */
	function setOption(key, value)
	{
		config[key] = value;

		if (key == 'speed')
		{
			setRunning(running);
		}
		else if (key == 'vmax' && net != null)
		{
			net.passable = getPassable(net);
			net.trips = null;

			// Cars that pass on roads that no longer qualify finish their pass
			net.passing.forEach(function(road)
			{
				if (road.passer != null && net.passable.indexOf(road.passer.link) < 0)
				{
					net.passable.push(road.passer.link);
				}
			});

			// The colors of the speeds change, also while paused
			schedule();
		}
		else if (key == 'fast')
		{
			schedule();
		}
		else if (key == 'zones' && overlay != null)
		{
			paintZones();
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
		else if (key == 'mapBackground')
		{
			schedule();
		}
		else if (key == 'roads' && overlay != null)
		{
			// Hidden roads and junctions are neither painted nor hit, and the
			// selection of the diagram ends. The stop bars stay.
			graph.view.getDrawPane().style.display = (value) ? '' : 'none';

			if (!value)
			{
				graph.clearSelection();
			}

			schedule();
		}
		else if (key == 'lights' && overlay != null)
		{
			overlay.heads.style.display = (value) ? '' : 'none';

			if (value && net != null)
			{
				updateNetwork();
			}
		}
		else if (key == 'adaptive')
		{
			// Repaints the shapes of roads and junctions, the stop bars and the
			// density
			roads.adaptive = value;

			graph.view.states.visit(function(id, state)
			{
				if (state.shape != null && state.style != null && (state.style[mxConstants.STYLE_SHAPE] == 'road' ||
					state.style[mxConstants.STYLE_SHAPE] == 'roundabout' || roads.isCrossing(state.style)))
				{
					state.shape.redraw();
				}
			});

			if (net != null)
			{
				for (var i = 0; i < net.links.length; i++)
				{
					var link = net.links[i];

					for (var k = 0; link.hues != null && k < link.hues.length; k++)
					{
						link.hues[k] = null;
					}
				}

				for (var i = 0; i < net.crossings.length; i++)
				{
					for (var j = 0; net.crossings[i].signals != null && j < net.crossings[i].signals.length; j++)
					{
						net.crossings[i].signals[j].barState = null;
					}
				}

				updateNetwork();
			}

			schedule();
		}
		else if (key == 'passOncoming')
		{
			// Shows or hides the overtakes in the statistics, also while paused
			schedule();
		}
		else if (key == 'colors')
		{
			// Paints every vehicle in the new colors, also while paused
			schedule();
		}
		else if (key == 'center')
		{
			// Turning it on again ends a pause
			if (focus != null)
			{
				focus.centerPaused = false;
			}

			schedule();
		}
		else if (key == 'vehicles' && overlay != null)
		{
			// Hiding the vehicles ends following the selected one
			overlay.cars.style.display = (value) ? '' : 'none';

			if (!value)
			{
				selectVehicle(null);
			}

			schedule();
		}
	};

	/**
	 * Reads the trip mode and the share of through traffic of the current
	 * page into the config from the attributes trips and throughShare of the
	 * root of the page, where Edit Data on the background shows them too.
	 * Without a mode, or zones in a network without zones, it is zones for
	 * towns with zones and else random.
	 */
	function readTrips()
	{
		var root = graph.model.getRoot();
		var value = (root != null) ? root.value : null;
		var data = value != null && typeof value == 'object' && value.getAttribute != null;
		var mode = (data) ? value.getAttribute('trips') : null;
		var share = (data && value.getAttribute('throughShare') != null) ?
			parseFloat(value.getAttribute('throughShare')) : NaN;
		var zones = net != null && net.zones;

		if (tripModes.indexOf(mode) < 0 || (mode == 'zones' && !zones))
		{
			mode = (zones) ? 'zones' : 'random';
		}

		config.trips = mode;
		config.through = (share >= 0 && share <= 1) ? share : defaultThroughShare;
	};

	/**
	 * Sets the trip mode and the share of through traffic of the current page
	 * for new cars, in the root of the page, so that the diagram keeps them
	 * and they can be undone.
	 */
	function setTrips(mode, share)
	{
		var model = graph.model;
		var root = model.getRoot();
		var value = root.value;
		var obj = (value != null && typeof value == 'object' && value.cloneNode != null) ? value.cloneNode(true) :
			mxUtils.createXmlDocument().createElement('object');

		if (typeof value == 'string' && value.length > 0)
		{
			obj.setAttribute('label', value);
		}

		obj.setAttribute('trips', mode);
		obj.setAttribute('throughShare', String(Math.round(Math.max(0, Math.min(1, share)) * 100) / 100));
		model.setValue(root, obj);
	};

	/**
	 * Returns the trip modes with their labels and whether the current
	 * network offers them, and the mode and share of through traffic.
	 */
	function getTripModes()
	{
		var labels = {random: 'Random', commuters: 'Commuters to the centre', through: 'Through traffic',
			mixed: 'Commuters and through traffic', zones: 'Zones (OpenStreetMap)'};

		return {mode: config.trips, through: config.through, modes: tripModes.map(function(mode)
		{
			return {value: mode, label: labels[mode], available: mode != 'zones' || (net != null && net.zones)};
		})};
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
	// Changes of the trips of the page only change the trips of new cars
	graph.model.addListener(mxEvent.CHANGE, roads.guard(function(sender, evt)
	{
		var edit = evt.getProperty('edit');
		var root = graph.model.getRoot();

		if (edit != null && edit.changes.length > 0 && edit.changes.every(function(change)
		{
			return change instanceof mxValueChange && change.cell == root;
		}))
		{
			readTrips();

			if (overlay != null)
			{
				paintZones();
				schedule();
			}
		}
		else
		{
			invalidate();
		}
	}, 'simulation model change'));

	// Hidden roads and junctions cannot be selected, also not by a rectangle
	var isCellSelectable = graph.isCellSelectable;

	graph.isCellSelectable = function(cell)
	{
		return config.roads && isCellSelectable.apply(this, arguments);
	};

	// Paints the vehicles in the colors of the theme, also when paused
	ui.addListener('darkModeChanged', function()
	{
		schedule();
	});

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

	// Scrolling and resizing show other roads and junctions, and a pan by
	// hand pauses centering
	var viewChanged = roads.guard(function()
	{
		if (config.labels)
		{
			labelsDirty = true;
			schedule();
		}
		else if (camera != null)
		{
			schedule();
		}
	}, 'simulation view change');

	// The zoom preview of draw.io changes the view until it is complete
	graph.addListener('zoomPreview', function()
	{
		zoomPreview = true;
	});

	graph.addListener('zoomPreviewComplete', function()
	{
		zoomPreview = false;
		schedule();
	});

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
	 * coordinates, on it or within a few pixels, or null. The distance is
	 * to the line along the middle of the car, so that the whole length of
	 * long ones can be clicked.
	 */
	function findVehicle(pt)
	{
		var best = 8 / graph.view.scale;
		var result = null;

		if (sim != null && overlay != null && config.vehicles)
		{
			sim.active.forEach(function(v)
			{
				if (v.x != null)
				{
					var shape = vehicleShapes[v.type.name];
					var w = shape.width * getVehicleWidth(v.type);
					var a = v.angle * Math.PI / 180;
					var dx = pt.x - v.x;
					var dy = pt.y - v.y;
					var h = Math.max(0, ((v.length || shape.length) - w) / 2);
					var along = Math.max(-h, Math.min(h, dx * Math.cos(a) + dy * Math.sin(a)));
					var ex = dx - along * Math.cos(a);
					var ey = dy - along * Math.sin(a);
					var d = Math.sqrt(ex * ex + ey * ey) - w / 2;

					if (d < best)
					{
						best = d;
						result = v;
					}
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
	 * Selects the given car, or none if it is null or vehicles are hidden:
	 * highlights it with a label that drives along, colors its route from
	 * its start A to its destination B and clears the selection of the
	 * diagram.
	 */
	function selectVehicle(v)
	{
		if (overlay != null)
		{
			clearChildren(overlay.route);
			clearChildren(overlay.focus);
		}

		focus = null;

		if (v != null && overlay != null && config.vehicles)
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

		// Center selected car starts also while the simulation is paused
		schedule();
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
					var path = v.link.getPath(v.lane);
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
			var r = vehicleShapes[v.type.name].length / 2 * getVehicleScale(v.type) + 4 / s;
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
	 * Moves the view with the selected car while Center selected car is on
	 * (center in the config) and returns true while it glides. The view stays
	 * while the car is in the middle half of it. When the car leaves that
	 * zone, or is outside it when centering starts, the scroll position
	 * glides towards the car in the middle with a critically damped spring,
	 * which starts and comes to rest softly, never overshoots and smooths the
	 * steps, turns and lane changes of the car, until the view rests on the
	 * car again. The spring is stiffer for cars that are fast on the screen,
	 * so that they lag at most a tenth of the view behind its middle. The map
	 * moves in the same frame with the PAN event of the graph, which draw.io
	 * fires when it scrolls while dragging. Zooming keeps centering, a pan by
	 * hand pauses it until the car is clicked again, and when the car leaves
	 * or is deselected, the view comes to rest where it is heading.
	 */
	function centerView(now)
	{
		var c = graph.container;
		var s = graph.view.scale;
		var t = graph.view.translate;
		var v = (config.center && focus != null && focus.status == null && !focus.centerPaused &&
			focus.v.x != null) ? focus.v : null;

		if (camera == null && v == null)
		{
			return false;
		}

		var rebase = camera == null || camera.s != s || camera.tx != t.x || camera.ty != t.y ||
			camera.w != c.clientWidth || camera.h != c.clientHeight;

		// Zooms in progress move the view on their own, and other scrolls
		// than for a zoom, a new translate or size are pans by hand
		if (zoomPreview || graph.panDx || graph.panDy || (!rebase &&
			(Math.abs(c.scrollLeft - camera.sx) > 1 || Math.abs(c.scrollTop - camera.sy) > 1)))
		{
			if (!zoomPreview && focus != null && config.center)
			{
				focus.centerPaused = true;
			}

			camera = null;

			return false;
		}

		// Starts at rest after zooms, page switches and resizes
		if (rebase)
		{
			camera = {s: s, tx: t.x, ty: t.y, w: c.clientWidth, h: c.clientHeight, x: c.scrollLeft,
				y: c.scrollTop, sx: c.scrollLeft, sy: c.scrollTop, ux: 0, uy: 0, glide: false,
				v: null, px: 0, py: 0, speed: 0, last: now};
		}

		var dt = Math.min(0.1, Math.max(0, (now - camera.last) / 1000));
		var w = camera.w;
		var h = camera.h;
		var omega = 3;
		var tx = camera.x + camera.ux / omega;
		var ty = camera.y + camera.uy / omega;
		camera.last = now;

		if (v != null)
		{
			var px = (v.x + t.x) * s;
			var py = (v.y + t.y) * s;

			// Speed of the car on the screen, smoothed over half a second
			if (camera.v == v && dt > 0)
			{
				var speed = Math.sqrt((px - camera.px) * (px - camera.px) + (py - camera.py) * (py - camera.py)) / dt;
				camera.speed += (speed - camera.speed) * (1 - Math.exp(-dt / 0.5));
			}
			else if (camera.v != v)
			{
				camera.speed = 0;
			}

			camera.v = v;
			camera.px = px;
			camera.py = py;
			omega = Math.min(12, Math.max(3, 20 * camera.speed / Math.min(w, h)));

			// The car in the middle, as far as the view can scroll
			tx = Math.max(0, Math.min(c.scrollWidth - w, px - w / 2));
			ty = Math.max(0, Math.min(c.scrollHeight - h, py - h / 2));

			if (!camera.glide && (Math.abs(tx - camera.x) > w / 4 || Math.abs(ty - camera.y) > h / 4))
			{
				camera.glide = true;
			}
		}
		else if (!camera.glide)
		{
			camera = null;

			return false;
		}

		if (camera.glide && dt > 0)
		{
			// Exact step of the spring for any frame time. It pulls at most as
			// for a view away, so that long glides start gently and cruise,
			// and lets the car get farther from the middle only up to 0.4 of
			// the view.
			var k = Math.exp(-omega * dt);
			var ex = camera.x - tx;
			var ey = camera.y - ty;
			tx = camera.x - Math.max(-w, Math.min(w, ex));
			ty = camera.y - Math.max(-h, Math.min(h, ey));
			ex = camera.x - tx;
			ey = camera.y - ty;
			var ax = (camera.ux + omega * ex) * dt;
			var ay = (camera.uy + omega * ey) * dt;
			camera.ux = (camera.ux - omega * ax) * k;
			camera.uy = (camera.uy - omega * ay) * k;
			var mx = Math.max(0.4 * w, Math.abs(ex));
			var my = Math.max(0.4 * h, Math.abs(ey));
			camera.x = tx + Math.max(-mx, Math.min(mx, (ex + ax) * k));
			camera.y = ty + Math.max(-my, Math.min(my, (ey + ay) * k));
			var x = Math.round(camera.x);
			var y = Math.round(camera.y);

			if (Math.abs(c.scrollLeft - x) >= 1 || Math.abs(c.scrollTop - y) >= 1)
			{
				c.scrollLeft = x;
				c.scrollTop = y;

				// The view cannot scroll farther
				if (Math.abs(c.scrollLeft - x) > 1)
				{
					camera.x = c.scrollLeft;
					camera.ux = 0;
				}

				if (Math.abs(c.scrollTop - y) > 1)
				{
					camera.y = c.scrollTop;
					camera.uy = 0;
				}

				graph.fireEvent(new mxEventObject(mxEvent.PAN));
			}

			camera.sx = c.scrollLeft;
			camera.sy = c.scrollTop;
			var tolerance = Math.max(4, 0.02 * Math.min(w, h));

			if (Math.sqrt(camera.ux * camera.ux + camera.uy * camera.uy) < 20 &&
				(v == null || (Math.abs(tx - camera.x) < tolerance && Math.abs(ty - camera.y) < tolerance)))
			{
				camera.glide = false;
				camera.ux = 0;
				camera.uy = 0;

				if (v == null)
				{
					camera = null;
				}
			}
		}

		return camera != null && camera.glide;
	};

	/**
	 * Returns true if Center selected car is on and was paused by a pan by
	 * hand, until the car is clicked again.
	 */
	function isCenterPaused()
	{
		return config.center && focus != null && focus.status == null && focus.centerPaused == true;
	};

	/**
	 * Returns the kind of the given trip with the types of its origin and
	 * destination for the panel.
	 */
	function getTripText(trip)
	{
		var names = {home: 'home', centre: 'centre', work: 'work or shops', gate: 'gate', junction: 'junction'};

		if (trip == null)
		{
			return 'Random';
		}

		var kind = (trip.kind == 'through') ? 'Through traffic' : ((trip.kind == 'random') ? 'Random' :
			((trip.from == 'gate') ? 'Commuter from outside' : ((trip.to == 'gate') ? 'Local, leaving town' : 'Local')));

		return kind + ', ' + names[trip.from] + ' \u2192 ' + names[trip.to];
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
			rows.push(['Speed', Math.round(getKmh(v)) + ' of ' + Math.round(3.6 * cellLength *
				((v.link != null) ? v.link.getTopSpeed(v) : getTopSpeed(v))) + ' km/h']);
		}

		rows.push(['Trip', getTripText(v.trip)]);
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
				((v.pass != null) ? ', passing in the oncoming lane' : ', lane ' + (v.lane + 1) + ' of ' +
				v.link.cells.length));
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
		vehicleShapes: vehicleShapes, colorSets: colorSets, getSpeedStops: getSpeedStops,
		selectVehicle: selectVehicle, isCenterPaused: isCenterPaused, setDebug: setDebug,
		getTripModes: getTripModes, setTrips: setTrips};
};
