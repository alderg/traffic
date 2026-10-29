/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Units of speed for what the panel and the simulation show and take: km/h
 * (kmh) or mph. The simulation keeps km/h and cells of 7.5 m per step
 * inside, and the styles of roads km/h or mph after the number (maxSpeed,
 * see TrafficRoads.getMaxSpeed). This script runs in the page, in the
 * window of the editor and in Node (tools/unit-test.js).
 */
var TrafficUnits = (function()
{
	var kmPerMile = 1.609344;
	var labels = {kmh: 'km/h', mph: 'mph'};

	/**
	 * Returns the given speed in km/h in the given unit.
	 */
	function toUnit(kmh, unit)
	{
		return (unit == 'mph') ? kmh / kmPerMile : kmh;
	};

	/**
	 * Returns the label of the given unit, km/h by default.
	 */
	function getLabel(unit)
	{
		return labels[unit] || labels.kmh;
	};

	/**
	 * Returns the given speed in km/h in the given unit with the given
	 * digits after the point and the label, eg. 31 mph.
	 */
	function format(kmh, unit, digits)
	{
		return toUnit(kmh, unit).toFixed(digits || 0) + ' ' + getLabel(unit);
	};

	return {kmPerMile: kmPerMile, units: ['kmh', 'mph'], toUnit: toUnit, getLabel: getLabel,
		format: format};
})();

if (typeof module == 'object' && module.exports != null)
{
	module.exports = TrafficUnits;
}
