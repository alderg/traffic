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
 * without errors on the page. Then it loads small towns in the United
 * Kingdom and Australia, which Nominatim and Overpass of this test answer,
 * and checks that they get the region of their country, that cars keep
 * left there, that a region chosen by hand for a town is kept when it opens
 * again and that a place cached without its country is looked up again.
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
 * Returns a small town at the given place with the given id of its
 * relation, address of Nominatim and maxspeed of its roads: its key, the
 * answer of Nominatim to a lookup of it with its limits and the answer of
 * Overpass with its roads, a grid of 4 by 4 junctions 250 m apart.
 */
function createTown(id, name, lat, lon, address, maxspeed)
{
	var n = 4;
	var dLat = 250 / 111320;
	var dLon = dLat / Math.cos(lat * Math.PI / 180);
	var elements = [];

	for (var i = 0; i < n; i++)
	{
		for (var j = 0; j < n; j++)
		{
			elements.push({type: 'node', id: id * 100 + i * n + j, lat: lat + (i - 1.5) * dLat,
				lon: lon + (j - 1.5) * dLon});
		}
	}

	for (var i = 0; i < n; i++)
	{
		var row = [];
		var column = [];

		for (var j = 0; j < n; j++)
		{
			row.push(id * 100 + i * n + j);
			column.push(id * 100 + j * n + i);
		}

		elements.push({type: 'way', id: id * 100 + i, nodes: row, tags: {highway: 'secondary', maxspeed: maxspeed}});
		elements.push({type: 'way', id: id * 100 + 50 + i, nodes: column,
			tags: {highway: 'secondary', maxspeed: maxspeed}});
	}

	var south = lat - 2.5 * dLat;
	var north = lat + 2.5 * dLat;
	var west = lon - 2.5 * dLon;
	var east = lon + 2.5 * dLon;

	return {id: id, key: 'relation/' + id, name: name, lat: lat, lon: lon,
		lookup: {place_id: id, osm_type: 'relation', osm_id: id, lat: String(lat), lon: String(lon), name: name,
			display_name: name + ', ' + address.state + ', ' + address.country, addresstype: 'town',
			type: 'administrative', boundingbox: [String(south), String(north), String(west), String(east)],
			extratags: {population: '4000'}, address: address, geojson: {type: 'Polygon',
			coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}},
		overpass: {version: 0.6, osm3s: {timestamp_osm_base: '2026-10-29T00:00:00Z'}, elements: elements}};
};

var towns = [createTown(900001, 'Testbury', 51.75, -1.25, {town: 'Testbury', county: 'Oxfordshire',
	state: 'England', 'ISO3166-2-lvl4': 'GB-ENG', country: 'United Kingdom', country_code: 'gb'}, '30 mph'),
	createTown(900002, 'Testville', -33.87, 151.2, {town: 'Testville', state: 'New South Wales',
	'ISO3166-2-lvl4': 'AU-NSW', country: 'Australia', country_code: 'au'}, '50')];

/**
 * Answers Nominatim and Overpass with the towns of this test in the given
 * context and counts the lookups of each town, and answers the tiles of the
 * map with nothing.
 */
async function serveTowns(context, lookups)
{
	await context.route(/^https:\/\/(nominatim\.openstreetmap\.org|[^\/]*overpass[^\/]*|maps\.mail\.ru|tile\.openstreetmap\.org|photon\.komoot\.io)\//,
		function(route)
	{
		var request = route.request();
		var u = new URL(request.url());
		var json = null;

		if (u.hostname == 'nominatim.openstreetmap.org' && u.pathname == '/lookup')
		{
			var id = parseInt((u.searchParams.get('osm_ids') || '').substring(1));
			json = towns.filter(function(t)
			{
				return t.id == id;
			}).map(function(t)
			{
				lookups[t.key] = (lookups[t.key] || 0) + 1;

				return t.lookup;
			});
		}
		else if (request.method() == 'POST' && /overpass/.test(u.href))
		{
			var query = new URLSearchParams(request.postData() || '').get('data') || '';
			var b = (/\[bbox:([^\]]+)\]/.exec(query) || [null, '0,0,0,0'])[1].split(',').map(parseFloat);
			json = towns.filter(function(t)
			{
				return t.lat > b[0] && t.lat < b[2] && t.lon > b[1] && t.lon < b[3];
			}).map(function(t)
			{
				return t.overpass;
			})[0] || {elements: []};
		}

		return (json != null) ? route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(json)}) :
			route.fulfill({status: 404, body: ''});
	});
};

/**
 * Opens the page with the given town in the URL and waits for its network.
 */
async function openTown(page, town)
{
	await page.goto(url + '?osm=' + town.key, {timeout: timeout, waitUntil: 'domcontentloaded'});
	await page.waitForSelector('#start:not([disabled])', {timeout: timeout});
	await page.waitForFunction(function(name)
	{
		return !document.getElementById('town-info').hidden && document.getElementById('town-name').textContent == name &&
			/Network: [1-9]\d* crossings/.test(document.getElementById('stats').textContent);
	}, town.name, {timeout: timeout});
};

/**
 * Puts the given town into the cache of the page as a place without its
 * country, as the page cached places before it looked them up with it.
 */
async function cacheOldPlace(page, town)
{
	var t = town.lookup;
	var b = t.boundingbox.map(parseFloat);
	var place = {key: town.key, name: t.name, label: t.display_name, kind: t.addresstype, lat: town.lat,
		lon: town.lon, population: 4000, bbox: [b[0], b[2], b[1], b[3]], rings: t.geojson.coordinates,
		date: '2026-10-01T00:00:00.000Z'};

	await page.evaluate(function(place)
	{
		return new Promise(function(resolve, reject)
		{
			var req = indexedDB.open('traffic-osm', 1);

			req.onsuccess = function()
			{
				var tx = req.result.transaction('places', 'readwrite');
				tx.objectStore('places').put(place, place.key);
				tx.oncomplete = function()
				{
					req.result.close();
					resolve();
				};
				tx.onerror = reject;
			};

			req.onerror = reject;
		});
	}, place);
};

/**
 * Collects the errors of the given page, with the errors of the editor that
 * debug output logs, into the given list.
 */
function watchErrors(page, errors)
{
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
};

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
 * side and turn in the rings in the given direction, if not null.
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

	if (turn != null)
	{
		assert.ok(counts[turn] >= 5, 'Too few cars in the roundabout: ' + JSON.stringify(counts));
		assert.ok(counts[turn] >= 0.9 * (counts[turn] + counts[otherTurn]), 'Cars do not drive ' + turn +
			' in the roundabout: ' + JSON.stringify(counts));
	}

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
		watchErrors(page, errors);

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
		await context.close();

		// Towns get the region of their country, in a browser of their own
		var lookups = {};
		context = await browser.newContext({viewport: {width: 1280, height: 800}});
		await serveTowns(context, lookups);
		page = await context.newPage();
		watchErrors(page, errors);
		await openTown(page, towns[0]);
		assert.strictEqual(await page.inputValue('#region'), 'uk');
		assert.strictEqual(await page.inputValue('#units'), 'mph');
		assert.strictEqual(await page.inputValue('#side'), 'left');
		assert.strictEqual(await page.textContent('#region-hint'), 'From the country of Testbury: United Kingdom.');
		console.log('Town in the United Kingdom: mph and left-hand traffic');
		await checkSide(page, 'left', null);

		// A region chosen by hand for the town is kept when it opens again
		await page.selectOption('#region', 'world');
		assert.strictEqual(await page.textContent('#region-hint'), 'Kept for Testbury when it opens again.');
		await openTown(page, towns[0]);
		assert.strictEqual(await page.inputValue('#region'), 'world');
		assert.strictEqual(await page.textContent('#region-hint'), 'As you chose for Testbury.');
		assert.strictEqual(lookups[towns[0].key], 1, 'Testbury was looked up again');
		console.log('Region chosen by hand kept for the town');

		// A place cached without its country is looked up again
		await cacheOldPlace(page, towns[1]);
		await openTown(page, towns[1]);
		assert.strictEqual(await page.inputValue('#region'), 'au');
		assert.strictEqual(await page.inputValue('#units'), 'kmh');
		assert.strictEqual(await page.inputValue('#side'), 'left');
		assert.strictEqual(await page.textContent('#region-hint'), 'From the country of Testville: Australia.');
		assert.strictEqual(lookups[towns[1].key], 1, 'Testville was not looked up again');
		console.log('Town in Australia: km/h and left-hand traffic');
		await checkSide(page, 'left', null);

		// Examples keep the region and forget the town
		await page.selectOption('#example', 'town');
		await page.waitForFunction(function()
		{
			return document.getElementById('region-hint').hidden;
		}, null, {timeout: timeout});
		assert.strictEqual(await page.inputValue('#region'), 'au');
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
