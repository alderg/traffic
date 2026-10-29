/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Opens the page at the given URL in headless Chrome with the Town example
 * and checks the speed unit and the driving side: with the region United
 * Kingdom the panel shows mph and the speed limits of roads in mph, the cars
 * keep left on the roads in both directions and drive clockwise around the
 * roundabout, the page keeps both settings for the next visit, and with
 * right-hand traffic the cars keep right and drive counterclockwise again,
 * without errors on the page.
 *
 * Usage: node tools/driving-side-test.js http://localhost:8000/index.html
 *
 * It needs playwright-core and Chrome at CHROME, /usr/bin/google-chrome by
 * default.
 */
var assert = require('assert');
var chromium = require('playwright-core').chromium;
var url = process.argv[2];
var timeout = 90000;

/**
 * Opens the page and waits for the network of the Town example.
 */
async function open(page)
{
	await page.goto(url, {timeout: timeout, waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#start:not([disabled])', {timeout: timeout});
	await page.waitForFunction(function()
	{
		return /Network: [1-9]\d* crossings/.test(document.getElementById('stats').textContent);
	}, null, {timeout: timeout});
};

/**
 * Returns the cars on the two-way roads of the network that keep left and
 * right, away from the junctions, and the cars in the rings of the
 * roundabouts that drive clockwise and counterclockwise on the screen, from
 * where they are in two frames.
 */
async function measure(page)
{
	return page.evaluate(async function()
	{
		var win = document.getElementById('editor').contentWindow;
		var ui = await new Promise(function(resolve)
		{
			win.Draw.loadPlugin(resolve);
		});
		var graph = ui.editor.graph;
		var roads = win.TrafficRoads;
		var cars = graph.view.getOverlayPane().querySelector('g[fill-rule="evenodd"]');

		function sample()
		{
			var result = new Map();

			for (var i = 0; i < cars.children.length; i++)
			{
				var m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(cars.children[i].getAttribute('d') || '');

				if (m != null)
				{
					result.set(cars.children[i], {x: parseFloat(m[1]), y: parseFloat(m[2])});
				}
			}

			return result;
		};

		var before = sample();
		await new Promise(function(resolve)
		{
			window.setTimeout(resolve, 400);
		});
		var after = sample();
		var s = graph.view.scale;
		var t = graph.view.translate;
		var segments = [];
		var rings = [];

		graph.view.states.visit(function(id, state)
		{
			if (state.style == null)
			{
				return;
			}

			if (graph.model.isEdge(state.cell) && state.absolutePoints != null && roads.getDirection(state.style) == 0)
			{
				var pts = state.absolutePoints.map(function(p)
				{
					return {x: p.x / s - t.x, y: p.y / s - t.y};
				});
				var w = roads.getRoadWidth(state.style);

				for (var i = 1; i < pts.length; i++)
				{
					segments.push({p0: pts[i - 1], p1: pts[i], w: w, first: i == 1, last: i == pts.length - 1});
				}
			}
			else if (graph.model.isVertex(state.cell) && roads.isRoundabout(state.style))
			{
				rings.push({x: state.getCenterX() / s - t.x, y: state.getCenterY() / s - t.y, r: state.width / s / 2});
			}
		});

		var result = {left: 0, right: 0, clockwise: 0, counterclockwise: 0, cars: after.size};

		after.forEach(function(b, node)
		{
			var a = before.get(node);

			if (a == null || Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 1)
			{
				return;
			}

			var mx = b.x - a.x;
			var my = b.y - a.y;
			var moved = Math.sqrt(mx * mx + my * my);

			for (var i = 0; i < rings.length; i++)
			{
				var ax = a.x - rings[i].x;
				var ay = a.y - rings[i].y;
				var bx = b.x - rings[i].x;
				var by = b.y - rings[i].y;
				var r = Math.sqrt(bx * bx + by * by);

				if (r < rings[i].r && r > 0.3 * rings[i].r)
				{
					// Around the center, not on the way in or out, where the
					// angle grows clockwise on the screen with y down
					var cross = ax * by - ay * bx;

					if (Math.abs(cross) > 0.8 * r * moved)
					{
						result[(cross > 0) ? 'clockwise' : 'counterclockwise']++;
					}

					return;
				}
			}

			for (var i = 0; i < segments.length; i++)
			{
				var seg = segments[i];
				var dx = seg.p1.x - seg.p0.x;
				var dy = seg.p1.y - seg.p0.y;
				var len = Math.sqrt(dx * dx + dy * dy);

				if (len < 1)
				{
					continue;
				}

				dx /= len;
				dy /= len;
				var along = (b.x - seg.p0.x) * dx + (b.y - seg.p0.y) * dy;
				var across = dx * (b.y - seg.p0.y) - dy * (b.x - seg.p0.x);
				var travel = mx * dx + my * dy;

				// Away from the junctions at the ends, along the road
				if (Math.abs(across) < seg.w / 2 && along > ((seg.first) ? 30 : 0) &&
					along < len - ((seg.last) ? 30 : 0) && Math.abs(travel) > 0.9 * moved)
				{
					// Across is to the right of the drawn direction
					result[(across * travel > 0) ? 'right' : 'left']++;

					return;
				}
			}
		});

		return result;
	});
};

/**
 * Drives the cars for some seconds and checks that they keep to the given
 * side and turn in the rings in the given direction.
 */
async function checkSide(page, side, turn)
{
	await page.click('#reset');

	if (!/Pause/.test(await page.textContent('#start')))
	{
		await page.click('#start');
	}

	await page.waitForTimeout(8000);
	var counts = {left: 0, right: 0, clockwise: 0, counterclockwise: 0};

	for (var i = 0; i < 5; i++)
	{
		var m = await measure(page);

		for (var key in counts)
		{
			counts[key] += m[key];
		}

		await page.waitForTimeout(700);
	}

	var other = (side == 'left') ? 'right' : 'left';
	var otherTurn = (turn == 'clockwise') ? 'counterclockwise' : 'clockwise';
	console.log(side + ': ' + JSON.stringify(counts));
	assert.ok(counts[side] >= 50, 'Too few cars on two-way roads: ' + JSON.stringify(counts));
	assert.ok(counts[side] >= 0.9 * (counts[side] + counts[other]), 'Cars do not keep ' + side + ': ' +
		JSON.stringify(counts));
	assert.ok(counts[turn] >= 5, 'Too few cars in the roundabout: ' + JSON.stringify(counts));
	assert.ok(counts[turn] >= 0.9 * (counts[turn] + counts[otherTurn]), 'Cars do not drive ' + turn +
		' in the roundabout: ' + JSON.stringify(counts));
	await page.click('#start');
};

/**
 * Returns the unit and the value of the speed limit of the selected road
 * of the Town example with 50 km/h and its maxSpeed after the given value
 * is entered.
 */
async function enterSpeedLimit(page, value)
{
	return page.evaluate(async function(value)
	{
		var win = document.getElementById('editor').contentWindow;
		var ui = await new Promise(function(resolve)
		{
			win.Draw.loadPlugin(resolve);
		});
		var graph = ui.editor.graph;
		var road = graph.model.getDescendants(graph.model.getRoot()).filter(function(cell)
		{
			return graph.model.isEdge(cell) && graph.getCellStyle(cell).maxSpeed == '50';
		})[0];
		graph.setSelectionCells([road]);
		var input = document.getElementById('max-speed');
		var result = {unit: document.getElementById('max-speed-unit').textContent, value: input.value};
		input.value = value;
		input.dispatchEvent(new Event('change'));
		result.style = graph.getCellStyle(road).maxSpeed;
		ui.editor.undoManager.undo();
		graph.clearSelection();

		return result;
	}, value);
};

async function main()
{
	var browser = await chromium.launch({executablePath: process.env.CHROME || '/usr/bin/google-chrome',
		headless: true});
	var errors = [];

	try
	{
		var context = await browser.newContext({viewport: {width: 1280, height: 800}});
		var page = await context.newPage();

		page.on('pageerror', function(e)
		{
			errors.push(e.message);
		});

		page.on('console', function(msg)
		{
			if (msg.type() == 'error' && /^Traffic error/.test(msg.text()))
			{
				errors.push(msg.text().split('\n')[0]);
			}
		});

		await open(page);
		assert.strictEqual(await page.inputValue('#region'), 'world');
		assert.strictEqual(await page.inputValue('#units'), 'kmh');
		assert.strictEqual(await page.inputValue('#side'), 'right');
		assert.strictEqual(await page.textContent('#vmax option[value="5"]'), '135 km/h');

		// The United Kingdom sets mph and left-hand traffic
		await page.selectOption('#region', 'uk');
		assert.strictEqual(await page.inputValue('#units'), 'mph');
		assert.strictEqual(await page.inputValue('#side'), 'left');
		assert.strictEqual(await page.textContent('#vmax option[value="5"]'), '84 mph');
		assert.ok(/mph$/.test(await page.textContent('#types .speed-scale')), 'Legend not in mph');
		var limit = await enterSpeedLimit(page, '30');
		assert.deepStrictEqual(limit, {unit: 'mph', value: '31', style: '30 mph'});
		console.log('Region United Kingdom: mph in the panel, speed limits in mph');
		await checkSide(page, 'left', 'clockwise');

		// The page keeps both for the next visit
		await open(page);
		assert.strictEqual(await page.inputValue('#region'), 'uk');
		assert.strictEqual(await page.inputValue('#units'), 'mph');
		assert.strictEqual(await page.inputValue('#side'), 'left');
		console.log('Speed unit and driving side kept after a reload');

		// Right-hand traffic with mph is the United States
		await page.selectOption('#side', 'right');
		assert.strictEqual(await page.inputValue('#region'), 'us');
		await checkSide(page, 'right', 'counterclockwise');

		await page.selectOption('#region', 'au');
		assert.strictEqual(await page.inputValue('#units'), 'kmh');
		assert.strictEqual(await page.inputValue('#side'), 'left');
		await page.selectOption('#region', 'world');
	}
	finally
	{
		await browser.close();
	}

	if (errors.length > 0)
	{
		throw new Error('Errors on the page:\n' + errors.join('\n'));
	}
};

main().then(function()
{
	console.log('Driving side test passed');
}, function(e)
{
	console.error('Driving side test failed: ' + e.message);
	process.exitCode = 1;
});
