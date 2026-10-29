/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Checks the conversion of the speeds between km/h and mph, the speed limits
 * of roads in both units and the lanes of roads on the right and, mirrored,
 * on the left with left-hand traffic, without a browser. The roads run with
 * the few functions of draw.io that they use for styles.
 *
 * Usage: node tools/unit-test.js
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var units = require('../js/units.js');
var context = {mxConstants: {NONE: 'none', STYLE_ENDARROW: 'endArrow', STYLE_STARTARROW: 'startArrow'},
	mxUtils: {getValue: function(style, key, defaultValue)
	{
		return (style != null && style[key] != null) ? style[key] : defaultValue;
	}}};
context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/roads.js'), 'utf8'), context);
var roads = context.TrafficRoads;
var tests = [];

function test(name, fn)
{
	tests.push({name: name, fn: fn});
};

function near(actual, expected, message)
{
	assert.ok(Math.abs(actual - expected) < 1e-9, message + ': ' + actual + ' is not ' + expected);
};

/**
 * Returns the given style as an object, eg. lanes=2;endArrow=none.
 */
function parseStyle(text)
{
	var style = {};

	text.split(';').forEach(function(pair)
	{
		var i = pair.indexOf('=');

		if (i > 0)
		{
			style[pair.substring(0, i)] = pair.substring(i + 1);
		}
	});

	return style;
};

/**
 * Returns the lanes of the given style as directions from left to right in
 * the drawn direction, eg. bbf.
 */
function getSides(text)
{
	return roads.getLanePlan(parseStyle(text)).map(function(lane)
	{
		return (lane.dir > 0) ? 'f' : 'b';
	}).join('');
};

/**
 * Runs fn with left-hand traffic and the driving side of before afterwards.
 */
function leftHand(fn)
{
	var prev = roads.leftHand;
	roads.leftHand = true;

	try
	{
		fn();
	}
	finally
	{
		roads.leftHand = prev;
	}
};

test('converts km/h to mph and keeps km/h', function()
{
	near(units.toUnit(1.609344, 'mph'), 1, 'one mile per hour');
	near(units.toUnit(100, 'mph'), 62.13711922373339, '100 km/h');
	near(units.toUnit(27, 'kmh'), 27, 'km/h');
	near(units.toUnit(27, 'unknown'), 27, 'unknown unit');
});

test('formats speeds with the label of the unit', function()
{
	assert.strictEqual(units.format(27, 'kmh'), '27 km/h');
	assert.strictEqual(units.format(27, 'mph'), '17 mph');
	assert.strictEqual(units.format(135, 'mph'), '84 mph');
	assert.strictEqual(units.format(48.28032, 'mph', 1), '30.0 mph');
	assert.strictEqual(units.format(38.44, 'kmh', 1), '38.4 km/h');
	assert.strictEqual(units.getLabel('mph'), 'mph');
	assert.strictEqual(units.getLabel(null), 'km/h');
	assert.deepStrictEqual(units.units, ['kmh', 'mph']);
});

test('reads speed limits in km/h and mph', function()
{
	near(roads.getMaxSpeed(parseStyle('maxSpeed=50')), 50, 'km/h');
	near(roads.getMaxSpeed(parseStyle('maxSpeed=30 mph')), 48.28032, 'mph');
	near(roads.getMaxSpeed(parseStyle('maxSpeed=30mph')), 48.28032, 'mph without a space');
	near(roads.getMaxSpeed(parseStyle('maxSpeed= 20 MPH ')), 32.18688, 'capital letters');
	assert.strictEqual(roads.getMaxSpeed(parseStyle('maxSpeed=none')), 0);
	assert.strictEqual(roads.getMaxSpeed(parseStyle('maxSpeed=0')), 0);
	assert.strictEqual(roads.getMaxSpeed(parseStyle('lanes=2')), 0);
});

test('puts the lanes of each direction on its right with right-hand traffic', function()
{
	assert.strictEqual(getSides('lanes=1'), 'bf');
	assert.strictEqual(getSides('lanes=2'), 'bbff');
	assert.strictEqual(getSides('lanesForward=2;lanesBackward=1'), 'bff');
	assert.strictEqual(getSides('lanes=2;endArrow=block'), 'ff');
	assert.strictEqual(getSides('lanes=2;startArrow=block'), 'bb');

	// Forward lanes are to the right of their travel
	var plan = roads.getLanePlan(parseStyle('lanes=2'));
	roads.getTravelLanes(plan, 1, 7).concat(roads.getTravelLanes(plan, -1, 7)).forEach(function(lane)
	{
		assert.ok(lane.offset > 0, 'lane ' + lane.index + ' on the right');
	});
});

test('mirrors the lanes with left-hand traffic', function()
{
	leftHand(function()
	{
		assert.strictEqual(getSides('lanes=1'), 'fb');
		assert.strictEqual(getSides('lanes=2'), 'ffbb');
		assert.strictEqual(getSides('lanesForward=2;lanesBackward=1'), 'ffb');
		assert.strictEqual(getSides('lanes=2;endArrow=block'), 'ff');
		assert.strictEqual(getSides('lanes=2;startArrow=block'), 'bb');

		// Lanes are to the left of their travel, the outer ones on the left
		var plan = roads.getLanePlan(parseStyle('lanesForward=2;lanesBackward=2'));
		var forward = roads.getTravelLanes(plan, 1, 7);
		var backward = roads.getTravelLanes(plan, -1, 7);

		forward.concat(backward).forEach(function(lane)
		{
			assert.ok(lane.offset < 0, 'lane ' + lane.index + ' on the left');
		});

		assert.strictEqual(forward.map(function(lane) { return lane.offset; }).join(), '-10.5,-3.5');
		assert.strictEqual(backward.map(function(lane) { return lane.offset; }).join(), '-10.5,-3.5');
	});
});

test('mirrors the lanes and turns of laneSpec with left-hand traffic', function()
{
	var spec = 'laneSpec=bsr,bl,fl,fsr';
	assert.strictEqual(getSides(spec), 'bbff');

	leftHand(function()
	{
		var plan = roads.getLanePlan(parseStyle(spec));
		assert.strictEqual(getSides(spec), 'ffbb');
		assert.strictEqual(plan.map(function(lane) { return lane.turns; }).join(), 'ls,r,r,ls');

		// The lane on the right of forward travel turns right, next to the
		// oncoming lanes
		var forward = roads.getTravelLanes(plan, 1, 7);
		assert.strictEqual(forward[forward.length - 1].turns, 'r');

		// The panel writes what it shows, which is mirrored back
		assert.strictEqual(roads.getLaneSpec(plan), 'bsr,bl,fl,fsr');
	});

	assert.strictEqual(roads.getLaneSpec(roads.getLanePlan(parseStyle(spec))), 'bsr,bl,fl,fsr');
});

test('mirrors turns', function()
{
	assert.strictEqual(roads.mirrorTurns('l'), 'r');
	assert.strictEqual(roads.mirrorTurns('sr'), 'ls');
	assert.strictEqual(roads.mirrorTurns('s'), 's');
	assert.strictEqual(roads.mirrorTurns(null), null);
});

var failed = 0;

tests.forEach(function(t)
{
	try
	{
		t.fn();
		console.log('ok - ' + t.name);
	}
	catch (e)
	{
		failed++;
		console.log('not ok - ' + t.name + '\n  ' + e.message);
	}
});

console.log((tests.length - failed) + ' of ' + tests.length + ' tests passed');
process.exitCode = (failed > 0) ? 1 : 0;
