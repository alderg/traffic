/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Units of speed for what the panel and the simulation show and take: km/h
 * (kmh) or mph, and the regions of the panel with their unit and driving
 * side, which towns get from their country. The simulation keeps km/h and
 * cells of 7.5 m per step inside, and the styles of roads km/h or mph after
 * the number (maxSpeed, see TrafficRoads.getMaxSpeed). This script runs in
 * the page, in the window of the editor and in Node (tools/unit-test.js).
 */
var TrafficUnits = (function()
{
	var kmPerMile = 1.609344;
	var labels = {kmh: 'km/h', mph: 'mph'};

	/**
	 * Regions of the panel, one for each pair of speed unit and driving side.
	 */
	var regions = [{name: 'world', label: 'Europe and most countries', units: 'kmh', leftHand: false},
		{name: 'us', label: 'United States', units: 'mph', leftHand: false},
		{name: 'uk', label: 'United Kingdom', units: 'mph', leftHand: true},
		{name: 'au', label: 'Australia, Japan, India', units: 'kmh', leftHand: true}];

	// ISO 3166-1 codes of the countries and territories that drive on the
	// left, and of those with speed limits in mph, all others drive on the
	// right with km/h. The territories in the subdivisions of a country (ISO
	// 3166-2) that Nominatim gives for Hong Kong, Macau and the territories
	// of the United States have their own code.
	var leftHand = toSet('ag ai au bb bd bm bn bs bt bw cc ck cx cy dm fj fk gb gd gg gy hk id ie im in je ' +
		'jm jp ke ki kn ky lc lk ls mo ms mt mu mv mw my mz na nf np nr nu nz pg pk sb sc sg sh sr sz tc th ' +
		'tl to tt tv tz ug vc vg vi ws za zm zw');
	var mph = toSet('ag ai as bs bz dm fk gb gd gg gu im je kn ky lc mp ms pr sh tc um us vc vg vi ws');
	var territories = {'cn-hk': 'hk', 'cn-mo': 'mo', 'us-as': 'as', 'us-gu': 'gu', 'us-mp': 'mp',
		'us-pr': 'pr', 'us-um': 'um', 'us-vi': 'vi'};

	function toSet(codes)
	{
		var result = {};

		codes.split(' ').forEach(function(code)
		{
			result[code] = true;
		});

		return result;
	};

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

	/**
	 * Returns the lowercase ISO 3166-1 code of the country or territory of
	 * the given country code and ISO 3166-2 codes of the subdivisions of a
	 * place, eg. hk for cn and CN-HK, or null without a country.
	 */
	function getTerritory(country, subdivisions)
	{
		var list = subdivisions || [];

		for (var i = 0; i < list.length; i++)
		{
			var code = territories[String(list[i]).toLowerCase()];

			if (code != null)
			{
				return code;
			}
		}

		return (country != null && country != '') ? String(country).toLowerCase() : null;
	};

	/**
	 * Returns the region of the given ISO 3166-1 code of a country or
	 * territory, eg. the one named uk for gb, or null for none.
	 */
	function getRegion(code)
	{
		if (code == null || code == '')
		{
			return null;
		}

		code = String(code).toLowerCase();
		var units = (mph[code]) ? 'mph' : 'kmh';
		var left = leftHand[code] == true;

		return regions.filter(function(r)
		{
			return r.units == units && r.leftHand == left;
		})[0];
	};

	return {kmPerMile: kmPerMile, units: ['kmh', 'mph'], regions: regions, toUnit: toUnit, getLabel: getLabel,
		format: format, getTerritory: getTerritory, getRegion: getRegion};
})();

if (typeof module == 'object' && module.exports != null)
{
	module.exports = TrafficUnits;
}
