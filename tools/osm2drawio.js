/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Builds the road network of a town from saved answers of Nominatim and
 * Overpass with js/osm.js, as the page does, and writes it as a .drawio
 * file. --query prints the Overpass query for the town instead.
 *
 * Usage:
 *   node tools/osm2drawio.js [--roads main|collector|all] [--circle lat,lon,m |
 *     --bbox south,west,north,east] lookup.json [overpass.json output.drawio]
 *
 * lookup.json is the answer of
 *   https://nominatim.openstreetmap.org/lookup?osm_ids=R1682248&format=jsonv2&polygon_geojson=1&polygon_threshold=0.0001&extratags=1
 * and overpass.json the answer of Overpass to the query of --query.
 */
var fs = require('fs');
var path = require('path');
var osm = require(path.join(__dirname, '..', 'js', 'osm.js'));

function main(args)
{
	var options = {roads: 'collector', circle: null, bbox: null, query: false};
	var files = [];

	for (var i = 0; i < args.length; i++)
	{
		if (args[i] == '--query')
		{
			options.query = true;
		}
		else if (args[i].substring(0, 2) == '--')
		{
			options[args[i].substring(2)] = args[++i];
		}
		else
		{
			files.push(args[i]);
		}
	}

	var r = JSON.parse(fs.readFileSync(files[0], 'utf8'))[0];
	var g = r.geojson || {};
	var b = r.boundingbox;
	var place = {key: r.osm_type + '/' + r.osm_id, name: r.name, kind: r.addresstype, lat: parseFloat(r.lat),
		lon: parseFloat(r.lon), population: parseInt((r.extratags || {}).population) || null,
		bbox: [parseFloat(b[0]), parseFloat(b[2]), parseFloat(b[1]), parseFloat(b[3])],
		rings: (g.type == 'Polygon') ? g.coordinates : ((g.type == 'MultiPolygon') ?
			[].concat.apply([], g.coordinates) : null)};
	place.radius = (place.rings == null) ? 2000 : null;
	var section = osm.parseSection(options.circle, options.bbox);

	if (options.query)
	{
		console.log(osm.getQuery(osm.getBounds(place, section), options.roads));

		return;
	}

	var t0 = Date.now();
	var data = osm.compact(JSON.parse(fs.readFileSync(files[1], 'utf8')));
	var result = osm.build(data, place, options.roads, section, {date: fs.statSync(files[1]).mtime.toISOString()});
	var st = result.stats;
	console.log(place.name + ', ' + osm.levelNames[options.roads] + ': ' + st.junctions + ' junctions, ' +
		st.roads + ' roads, ' + st.lights + ' traffic lights, ' + st.roundabouts + ' roundabouts, ' +
		st.gates + ' gates, ' + st.km.toFixed(0) + ' km in ' + (Date.now() - t0) + ' ms');

	if (result.tooLarge)
	{
		console.log('Larger than ' + result.limits.junctions + ' junctions or ' + result.limits.roads +
			' roads, choose a section or fewer roads.');
		process.exitCode = 1;
	}
	else if (result.xml != null)
	{
		fs.writeFileSync(files[2], result.xml);
		console.log('-> ' + files[2]);
	}
}

main(process.argv.slice(2));
