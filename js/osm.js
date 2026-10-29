/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Road networks of towns from OpenStreetMap for the traffic simulation. This
 * script runs in the page and in Node (tools/osm2drawio.js).
 *
 * Towns are found with Photon (suggestions while typing) and Nominatim
 * (search on submit, and the boundary of the chosen place), roads come from
 * the Overpass API. All of them send CORS headers, so the browser loads them
 * directly. Nominatim allows one request per second and no autocomplete, so
 * its requests wait for each other. Overpass servers are often busy: the
 * servers are tried in turn, and once more after a pause, when one answers
 * with an error, is at capacity, times out or reports a runtime error.
 * Loaded towns and places are cached in IndexedDB with the date and the
 * query.
 *
 * build turns the ways of the roads into junctions and roads like
 * tools/net2drawio.py does for the examples, in units of 1 m around the
 * center of the town with north up, in Web Mercator like the map tiles
 * with the scale of the center (see createProjection), which the text with
 * the attribution keeps as mercator for js/map.js: ways of the chosen road classes are
 * cut where they leave the town (its administrative boundary, a circle
 * around the center for places without one, and the chosen section) and
 * the cut ends are gates, junctions with gate=1 where cars enter and leave
 * the network. Junctions are nodes where three or more roads meet or where
 * roads end. A node that only joins two roads is never a junction: the
 * chain of ways and nodes between two junctions is one road with the shape
 * of the ways as its points, simplified. Roads keep oneway, the lanes per
 * direction (lanes, lanes:forward and lanes:backward) and maxspeed (as
 * maxSpeed in km/h). Rings of junction=roundabout become roundabouts,
 * highway=traffic_signals on or near a junction a traffic light, and
 * junctions closer than a few meters, eg. of dual carriageways, one
 * junction, with the old ends of the roads as waypoints. The carriageways
 * of dual roads stay one-way roads, so that cars drive on them on the map.
 * Small parts that are not connected to the rest are dropped.
 *
 * Zones for the trips of the simulation come with the roads in the same
 * query (getZoneQuery), as light as possible: only the ids and bounding
 * boxes of land use areas (residential, commercial and retail, industrial)
 * and the ids and positions of shops, offices and amenities where people
 * work, learn, shop or go out, each kind after a marker element. build
 * gives the junctions in the town that are not gates homes and jobs in
 * their style: residential areas homes and the others and the places jobs,
 * in proportion to their area or number, shared by the junctions in the
 * bounding box of an area or else the nearest junction within
 * zoneDistance. Towns that were cached before zones get them with one
 * query of their own.
 */
var TrafficOsm = (function()
{
	var nominatim = 'https://nominatim.openstreetmap.org/';
	var photon = 'https://photon.komoot.io/api/';

	// Public instances for the whole world without a key, in the order they
	// are tried (https://wiki.openstreetmap.org/wiki/Overpass_API)
	var servers = ['https://overpass-api.de/api/interpreter',
		'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
		'https://overpass.private.coffee/api/interpreter'];

	// Road classes from the largest. Main roads are always loaded, collector
	// adds unclassified roads and all adds residential streets. Footways,
	// cycleways, paths and service roads are never loaded.
	var levels = ['main', 'collector', 'all'];
	var levelNames = {main: 'Main roads', collector: 'Main and collector roads', all: 'All streets'};
	var classes = {motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 0, primary_link: 0,
		secondary: 0, secondary_link: 0, tertiary: 0, tertiary_link: 0, unclassified: 1,
		residential: 2, living_street: 2};
	var patterns = ['^(motorway|trunk|primary|secondary|tertiary)(_link)?$', '^unclassified$',
		'^(residential|living_street)$'];
	var defaultSpeeds = {motorway: 120, motorway_link: 80, trunk: 100, living_street: 10};

	// Tags that are kept of the ways
	var keys = ['highway', 'oneway', 'lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways',
		'lanes:psv', 'lanes:bus', 'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'junction',
		'access', 'vehicle', 'motor_vehicle', 'motorcar', 'area'];

	// Radius in m around places without a boundary
	var radii = {city: 5000, town: 2500, village: 1200, hamlet: 500, suburb: 1000, quarter: 700,
		neighbourhood: 500, borough: 2000, locality: 500, isolated_dwelling: 300};

	var limits = {junctions: 4000, roads: 6000};
	var earthRadius = 6371008.8;
	var mercatorRadius = 6378137;
	var degree = Math.PI / 180 * earthRadius;
	var boundaryTolerance = 25;
	var signalDistance = 45;
	var minRoadLength = 20;
	var maxClusterSize = 40;
	var simplifyTolerance = 4;
	var lightGreen = 10;
	// Zones: weights per hectare of land use and per place, the share of the
	// bounding box that an area fills and the distance of the nearest
	// junction that gets the weight of an area or place without a junction
	var zoneWeights = {homes: 40, commercial: 60, industrial: 25, places: 8};
	var zoneFill = 0.6;
	var zoneDistance = 300;
	var zoneAmenities = '^(school|college|university|kindergarten|hospital|clinic|doctors|dentist|' +
		'restaurant|cafe|fast_food|bar|pub|cinema|theatre|townhall|marketplace|bank|pharmacy|' +
		'post_office|library|community_centre|police|fire_station)$';
	// Lanes as wide as on the streets of the map
	var laneWidth = 3.5;
	var crossingSize = 16;
	var crossingStyle = 'ellipse;aspect=fixed;resizeCentered=1;strokeColor=none;fillColor=light-dark(#5f6368,#5f6368);';
	var roundaboutStyle = 'shape=roundabout;aspect=fixed;resizeCentered=1;perimeter=ellipsePerimeter;' +
		'strokeColor=none;fillColor=light-dark(#5f6368,#5f6368);islandColor=light-dark(#a8d5a0,#2f5d2a);';
	var attribution = '\u00a9 OpenStreetMap contributors';
	var copyrightUrl = 'https://www.openstreetmap.org/copyright';
	var lastNominatim = 0;
	var preferred = 0;
	var memory = null;
	var db = null;

	/**
	 * Returns a promise that resolves after the given milliseconds or
	 * rejects when the given signal aborts.
	 */
	function wait(ms, signal)
	{
		return new Promise(function(resolve, reject)
		{
			if (signal != null && signal.aborted)
			{
				reject(signal.reason || new Error('Cancelled'));

				return;
			}

			var timer = setTimeout(resolve, ms);

			if (signal != null)
			{
				signal.addEventListener('abort', function()
				{
					clearTimeout(timer);
					reject(signal.reason || new Error('Cancelled'));
				});
			}
		});
	};

	function isAbort(e, signal)
	{
		return signal != null && signal.aborted;
	};

	/**
	 * Fetches the given URL and returns the text of the response. Aborts
	 * when no data arrives for the given milliseconds and calls onBytes with
	 * the bytes so far.
	 */
	function fetchText(url, init, signal, timeout, onBytes)
	{
		var controller = new AbortController();
		var timedOut = false;
		var timer = null;

		function arm()
		{
			clearTimeout(timer);

			timer = setTimeout(function()
			{
				timedOut = true;
				controller.abort();
			}, timeout);
		};

		arm();

		function abort()
		{
			controller.abort();
		};

		if (signal != null)
		{
			signal.addEventListener('abort', abort);

			// Sends nothing for a task that was cancelled before
			if (signal.aborted)
			{
				abort();
			}
		}

		init = Object.assign({signal: controller.signal}, init);

		function done()
		{
			clearTimeout(timer);

			if (signal != null)
			{
				signal.removeEventListener('abort', abort);
			}
		};

		return fetch(url, init).then(function(response)
		{
			if (!response.ok)
			{
				var e = new Error(response.status + ' ' + response.statusText);
				e.status = response.status;
				throw e;
			}

			if (response.body == null || response.body.getReader == null)
			{
				return response.text();
			}

			var reader = response.body.getReader();
			var chunks = [];
			var bytes = 0;

			function read()
			{
				return reader.read().then(function(result)
				{
					if (result.done)
					{
						var all = new Uint8Array(bytes);
						var offset = 0;

						for (var i = 0; i < chunks.length; i++)
						{
							all.set(chunks[i], offset);
							offset += chunks[i].length;
						}

						return new TextDecoder().decode(all);
					}

					chunks.push(result.value);
					bytes += result.value.length;
					arm();

					if (onBytes != null)
					{
						onBytes(bytes);
					}

					return read();
				});
			};

			return read();
		})['catch'](function(e)
		{
			if (timedOut)
			{
				e = new Error('No answer in ' + Math.round(timeout / 1000) + ' s');
				e.timeout = true;
			}

			throw e;
		}).then(function(text)
		{
			done();

			return text;
		}, function(e)
		{
			done();

			throw e;
		});
	};

	/**
	 * Fetches JSON from Nominatim, at most one request per second.
	 */
	function fetchNominatim(path, signal)
	{
		var delay = Math.max(0, lastNominatim + 1100 - Date.now());
		lastNominatim = Date.now() + delay;

		return wait(delay, signal).then(function()
		{
			return fetchText(nominatim + path, {}, signal, 20000);
		}).then(function(text)
		{
			return JSON.parse(text);
		});
	};

	function getLanguage()
	{
		return (typeof navigator != 'undefined' && navigator.language != null) ?
			navigator.language.split('-')[0] : 'en';
	};

	/**
	 * Returns the place of a result of Nominatim.
	 */
	function getNominatimPlace(r)
	{
		var b = r.boundingbox;
		var tags = r.extratags || {};

		return {key: r.osm_type + '/' + r.osm_id, name: r.name || r.display_name.split(',')[0],
			label: r.display_name, kind: r.addresstype || r.type, lat: parseFloat(r.lat),
			lon: parseFloat(r.lon), population: parsePopulation(tags.population),
			bbox: (b != null) ? [parseFloat(b[0]), parseFloat(b[2]), parseFloat(b[1]), parseFloat(b[3])] : null};
	};

	/**
	 * Searches towns with Nominatim and returns their places, the most
	 * important first. With cached, the results of the same text are reused,
	 * eg. for the town in a link.
	 */
	function search(text, signal, cached)
	{
		var key = 'q:' + text.trim().toLowerCase();

		return ((cached) ? cacheGet('places', key) : Promise.resolve(null)).then(function(list)
		{
			return list || fetchNominatim('search?format=jsonv2&limit=10&featureType=settlement&extratags=1&' +
				'accept-language=' + encodeURIComponent(getLanguage()) + '&q=' +
				encodeURIComponent(text), signal).then(function(results)
			{
				list = results.filter(function(r)
				{
					return r.osm_type != null && ['state', 'country', 'region', 'province'].indexOf(r.addresstype) < 0;
				}).map(getNominatimPlace);

				if (list.length > 0)
				{
					cachePut('places', key, list);
				}

				return list;
			});
		});
	};

	/**
	 * Suggests towns for the given text with Photon.
	 */
	function suggest(text, signal)
	{
		var lang = getLanguage();
		var types = {N: 'node', W: 'way', R: 'relation'};

		return fetchText(photon + '?limit=7&layer=city&layer=district&layer=locality&layer=county' +
			((['de', 'en', 'fr', 'it'].indexOf(lang) >= 0) ? '&lang=' + lang : '') + '&q=' +
			encodeURIComponent(text), {}, signal, 10000).then(function(text)
		{
			return JSON.parse(text).features.filter(function(f)
			{
				var p = f.properties;

				return types[p.osm_type] != null && (p.osm_key == 'place' || p.osm_key == 'boundary');
			}).map(function(f)
			{
				var p = f.properties;
				var e = p.extent;
				var parts = [p.name, p.county, p.state, p.country].filter(function(s, i, all)
				{
					return s != null && all.indexOf(s) == i;
				});

				return {key: types[p.osm_type] + '/' + p.osm_id, name: p.name, label: parts.join(', '),
					kind: p.osm_value, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
					bbox: (e != null) ? [e[3], e[0], e[1], e[2]] : null};
			});
		});
	};

	/**
	 * Returns the place with the given key, eg. relation/1682248, with the
	 * rings of its boundary as [lon, lat] or null if it has none, from the
	 * cache or Nominatim.
	 */
	function lookup(key, signal)
	{
		var m = /^(node|way|relation)\/(\d+)$/.exec(key);

		if (m == null)
		{
			return Promise.reject(new Error('Not an OpenStreetMap node, way or relation: ' + key + '.'));
		}

		return cacheGet('places', key).then(function(place)
		{
			return place || fetchNominatim('lookup?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0001&' +
				'extratags=1&accept-language=' + encodeURIComponent(getLanguage()) + '&osm_ids=' +
				m[1].charAt(0).toUpperCase() + m[2], signal).then(function(results)
			{
				if (results.length == 0)
				{
					throw new Error('OpenStreetMap has no place ' + key + '.');
				}

				var place = getNominatimPlace(results[0]);
				var g = results[0].geojson;
				place.rings = null;

				if (g != null && g.type == 'Polygon')
				{
					place.rings = g.coordinates;
				}
				else if (g != null && g.type == 'MultiPolygon')
				{
					place.rings = [].concat.apply([], g.coordinates);
				}

				if (place.rings == null)
				{
					place.radius = radii[place.kind] || 2000;
				}

				place.date = new Date().toISOString();
				cachePut('places', key, place);

				return place;
			});
		});
	};

	/**
	 * Returns the bounds [south, west, north, east] of the given place and
	 * section, which is null for the whole place, {lat, lon, r} for a circle
	 * with a radius in m or {bbox} for a rectangle.
	 */
	function getBounds(place, section)
	{
		var b = null;

		if (place.rings != null)
		{
			b = [Infinity, Infinity, -Infinity, -Infinity];
			var pad = boundaryTolerance / degree;
			var padLon = pad / Math.cos(place.lat * Math.PI / 180);

			place.rings.forEach(function(ring)
			{
				ring.forEach(function(p)
				{
					b[0] = Math.min(b[0], p[1] - pad);
					b[1] = Math.min(b[1], p[0] - padLon);
					b[2] = Math.max(b[2], p[1] + pad);
					b[3] = Math.max(b[3], p[0] + padLon);
				});
			});
		}
		else
		{
			b = getCircleBounds(place.lat, place.lon, place.radius);
		}

		var s = (section == null) ? null : ((section.bbox != null) ? section.bbox :
			getCircleBounds(section.lat, section.lon, section.r));

		if (s != null)
		{
			b = [Math.max(b[0], s[0]), Math.max(b[1], s[1]), Math.min(b[2], s[2]), Math.min(b[3], s[3])];
		}

		return (b[0] < b[2] && b[1] < b[3]) ? b : null;
	};

	function getCircleBounds(lat, lon, r)
	{
		var dLat = r / degree;
		var dLon = dLat / Math.cos(lat * Math.PI / 180);

		return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
	};

	/**
	 * Returns the area in square kilometers of the given place and section.
	 */
	function getArea(place, section)
	{
		var b = getBounds(place, section);
		var area = 0;

		if (b != null)
		{
			var proj = createProjection((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
			var region = createRegion(place, section, proj);
			var x0 = proj.x(b[1]);
			var y0 = proj.y(b[2]);
			var w = proj.x(b[3]) - x0;
			var h = proj.y(b[0]) - y0;
			var n = 60;
			var inside = 0;

			// Samples a grid, as the parts of the region overlap
			for (var i = 0; i < n; i++)
			{
				for (var j = 0; j < n; j++)
				{
					inside += (region.inside(x0 + (i + 0.5) * w / n, y0 + (j + 0.5) * h / n)) ? 1 : 0;
				}
			}

			area = w * h * inside / (n * n) / 1e6;
		}

		return area;
	};

	function getBboxText(b)
	{
		return b.map(function(v)
		{
			return v.toFixed(5);
		}).join(',');
	};

	/**
	 * Returns the Overpass query for the roads of the given level in the
	 * given bounds: the ways with their tags and nodes, the coordinates of
	 * the nodes and the tags of the nodes with traffic signals.
	 */
	function getQuery(bounds, level)
	{
		var pattern = patterns.slice(0, levels.indexOf(level) + 1).join('|');

		return '[out:json][timeout:180][bbox:' + getBboxText(bounds) + '];' +
			'way[highway~"' + pattern + '"]->.w;.w out body qt;node(w.w)->.n;.n out skel qt;' +
			'node.n[highway=traffic_signals];out tags qt;' + getZoneQuery();
	};

	/**
	 * Returns the statements of the query for the zones: a marker of each
	 * kind followed by the ids and bounding boxes of its land use areas, or
	 * the positions of its places.
	 */
	function getZoneQuery()
	{
		return 'make zone kind="homes";out;wr[landuse=residential];out ids bb qt;' +
			'make zone kind="commercial";out;wr[landuse~"^(commercial|retail)$"];out ids bb qt;' +
			'make zone kind="industrial";out;wr[landuse=industrial];out ids bb qt;' +
			'make zone kind="places";out;nwr[shop];out ids center qt;nwr[office];out ids center qt;' +
			'nwr[amenity~"' + zoneAmenities + '"];out ids center qt;';
	};

	/**
	 * Runs the given Overpass query on the servers in turn, starting with
	 * the last that answered, until one answers: first waiting the given
	 * milliseconds for data from each, then after a pause twice as long.
	 * Calls onStatus with the server, the bytes loaded so far and the
	 * errors of the servers before.
	 */
	function overpass(query, signal, timeout, onStatus)
	{
		var errors = [];
		var rounds = 2;
		var attempt = 0;

		function next()
		{
			if (signal != null && signal.aborted)
			{
				return Promise.reject(signal.reason || new Error('Cancelled'));
			}
			else if (attempt >= rounds * servers.length)
			{
				var e = new Error('No Overpass server could load the roads: ' + errors.join('; ') + '.');
				e.busy = true;

				return Promise.reject(e);
			}

			var index = (preferred + attempt) % servers.length;
			var server = servers[index];
			var host = server.split('/')[2];
			var round = Math.floor(attempt / servers.length);
			var pause = (attempt > 0 && attempt % servers.length == 0) ? 10000 : 0;
			attempt++;

			if (onStatus != null)
			{
				onStatus({server: host, bytes: 0, errors: errors.slice(), pause: pause});
			}

			return wait(pause, signal).then(function()
			{
				return fetchText(server, {method: 'POST', body: new URLSearchParams({data: query})},
					signal, timeout * (round + 1), function(bytes)
				{
					if (onStatus != null)
					{
						onStatus({server: host, bytes: bytes, errors: errors.slice()});
					}
				});
			}).then(function(text)
			{
				var json = JSON.parse(text);

				// Runtime errors come with status 200 and a remark
				if (json.remark != null && /error/i.test(json.remark))
				{
					throw new Error(json.remark.replace(/^runtime error: /, ''));
				}

				preferred = index;
				json.server = host;

				return json;
			})['catch'](function(e)
			{
				if (isAbort(e, signal))
				{
					throw e;
				}
				else if (e.status == 400)
				{
					throw new Error('Overpass did not accept the query (' + host + ').');
				}

				errors.push(host + ': ' + ((e.status == 429) ? 'too many requests' :
					((e.status == 502 || e.status == 503 || e.status == 504) ? 'busy' :
					(e.message || 'no connection'))));

				return next();
			});
		};

		return next();
	};

	/**
	 * Returns the estimated junctions of each level in the given place and
	 * section from its area and, if known, its population, with the
	 * junctions per km\u00b2 and per inhabitant of Zurich, Bern, Zug and Los
	 * Angeles (within about a quarter). A count query on Overpass costs about
	 * as much as loading the roads.
	 */
	function estimate(place, section)
	{
		var area = getArea(place, section);
		var people = (place.population != null) ? place.population *
			Math.min(1, area / Math.max(1e-6, getArea(place, null))) : Infinity;

		return {main: Math.min(7 * area, people / 450), collector: Math.min(8 * area, people / 400),
			all: Math.min(40 * area, people / 70), area: area};
	};

	/**
	 * Returns the compact form of the given Overpass answer: the ways with
	 * the tags that are used, the coordinates of their nodes and the nodes
	 * with traffic signals.
	 */
	function compact(json)
	{
		var ways = [];
		var ids = [];
		var lat = [];
		var lon = [];
		var signals = [];
		var zones = null;
		var kind = null;

		for (var i = 0; i < json.elements.length; i++)
		{
			var e = json.elements[i];

			// The zones come after their markers
			if (e.type == 'zone')
			{
				kind = (e.tags != null) ? e.tags.kind : null;
				zones = zones || createZones();
			}
			else if (kind != null)
			{
				addZone(zones, kind, e);
			}
			else if (e.type == 'way' && e.tags != null && e.nodes != null)
			{
				var tags = {};

				for (var j = 0; j < keys.length; j++)
				{
					if (e.tags[keys[j]] != null)
					{
						tags[keys[j]] = e.tags[keys[j]];
					}
				}

				ways.push({id: e.id, tags: tags, nodes: e.nodes});
			}
			else if (e.type == 'node' && e.lat != null)
			{
				ids.push(e.id);
				lat.push(e.lat);
				lon.push(e.lon);
			}
			else if (e.type == 'node' && e.tags != null && e.tags.highway == 'traffic_signals')
			{
				signals.push(e.id);
			}
		}

		var result = {ways: ways, nodes: {ids: ids, lat: lat, lon: lon}, signals: signals};

		if (zones != null)
		{
			result.zones = zones;
		}

		return result;
	};

	function createZones()
	{
		return {areas: {kind: [], south: [], west: [], north: [], east: []}, places: {lat: [], lon: []}};
	};

	/**
	 * Adds the given element of the answer of Overpass to the given zones as
	 * an area of the given kind with its bounding box or a place.
	 */
	function addZone(zones, kind, e)
	{
		function round(v)
		{
			return Math.round(v * 1e5) / 1e5;
		};

		if (kind == 'places')
		{
			var c = (e.lat != null) ? e : e.center;

			if (c != null)
			{
				zones.places.lat.push(round(c.lat));
				zones.places.lon.push(round(c.lon));
			}
		}
		else if (e.bounds != null)
		{
			var a = zones.areas;
			a.kind.push(kind);
			a.south.push(round(e.bounds.minlat));
			a.west.push(round(e.bounds.minlon));
			a.north.push(round(e.bounds.maxlat));
			a.east.push(round(e.bounds.maxlon));
		}
	};

	/**
	 * Loads the zones of the given cached entry of a town that was loaded
	 * before zones, with one query for its bounds, and keeps them with it.
	 * Resolves to the entry, without zones if no server answers.
	 */
	function loadZones(entry, signal, onStatus)
	{
		var m = /\[bbox:([^\]]+)\]/.exec(entry.query || '');

		if (m == null)
		{
			return Promise.resolve(entry);
		}

		var query = '[out:json][timeout:120][bbox:' + m[1] + '];' + getZoneQuery();

		return overpass(query, signal, 60000, onStatus).then(function(json)
		{
			entry.data.zones = compact(json).zones || createZones();

			return (entry.key != null) ? cachePut('towns', entry.key, entry) : null;
		}).then(function()
		{
			return entry;
		}, function(e)
		{
			if (isAbort(e, signal))
			{
				throw e;
			}

			return entry;
		});
	};

	/**
	 * Loads the roads of the given level in the given place and section
	 * from the cache, also of the whole place or a larger level, or else
	 * from Overpass. Resolves to {data, date, query, server, cached}.
	 */
	function load(place, level, section, signal, onStatus, fresh)
	{
		var bounds = getBounds(place, section);

		if (bounds == null)
		{
			return Promise.reject(new Error('The section is outside of ' + place.name + '.'));
		}

		return ((fresh) ? Promise.resolve(null) : findCached(place, level, section)).then(function(entry)
		{
			if (entry != null)
			{
				entry.cached = true;

				return (entry.data.zones == null) ? loadZones(entry, signal, onStatus) : entry;
			}

			var query = getQuery(bounds, level);

			return overpass(query, signal, 60000, onStatus).then(function(json)
			{
				var result = {data: compact(json), date: new Date().toISOString(), query: query,
					server: json.server, level: level, dataDate: (json.osm3s != null) ?
					json.osm3s.timestamp_osm_base : null};
				result.key = getCacheKey(place, level, section);
				memory = {key: result.key, entry: result};

				return cachePut('towns', memory.key, result).then(function()
				{
					return trimCache();
				}).then(function()
				{
					result.cached = false;

					return result;
				});
			});
		});
	};

	/**
	 * Returns the cached roads of the given place, level and section, also
	 * of the whole place or a larger level, or null.
	 */
	function findCached(place, level, section)
	{
		var cacheKeys = [];

		for (var i = levels.indexOf(level); i < levels.length; i++)
		{
			cacheKeys.push(getCacheKey(place, levels[i], section));

			if (section != null)
			{
				cacheKeys.push(getCacheKey(place, levels[i], null));
			}
		}

		// The last download stays in memory, eg. if it is too large
		function find(i)
		{
			return (i >= cacheKeys.length) ? Promise.resolve(null) : ((memory != null && memory.key == cacheKeys[i]) ?
				Promise.resolve(memory.entry) : cacheGet('towns', cacheKeys[i])).then(function(entry)
			{
				if (entry != null)
				{
					entry.key = cacheKeys[i];
				}

				return entry || find(i + 1);
			});
		};

		return find(0);
	};

	function getCacheKey(place, level, section)
	{
		return place.key + '|' + level + '|' + getSectionText(section);
	};

	/**
	 * Returns the text of the given section in URLs: lat,lon,radius for a
	 * circle or south,west,north,east for a rectangle.
	 */
	function getSectionText(section)
	{
		return (section == null) ? '' : ((section.bbox != null) ? getBboxText(section.bbox) :
			section.lat.toFixed(5) + ',' + section.lon.toFixed(5) + ',' + Math.round(section.r));
	};

	/**
	 * Returns the section of the given circle or bbox text or null.
	 */
	function parseSection(circle, bbox)
	{
		var c = (circle != null) ? circle.split(',').map(parseFloat) : [];
		var b = (bbox != null) ? bbox.split(',').map(parseFloat) : [];

		if (c.length == 3 && c.every(isFinite) && c[2] > 0)
		{
			return {lat: c[0], lon: c[1], r: Math.min(c[2], 50000)};
		}
		else if (b.length == 4 && b.every(isFinite) && b[0] < b[2] && b[1] < b[3])
		{
			return {bbox: b};
		}

		return null;
	};

	function openDb()
	{
		if (db == null)
		{
			db = new Promise(function(resolve)
			{
				try
				{
					var req = indexedDB.open('traffic-osm', 1);

					req.onupgradeneeded = function()
					{
						req.result.createObjectStore('towns');
						req.result.createObjectStore('places');
					};

					req.onsuccess = function()
					{
						resolve(req.result);
					};

					req.onerror = function()
					{
						resolve(null);
					};
				}
				catch (e)
				{
					resolve(null);
				}
			});
		}

		return db;
	};

	/**
	 * Returns the value with the given key in the given store of the cache
	 * or null, also if there is no cache.
	 */
	function cacheGet(store, key)
	{
		return openDb().then(function(idb)
		{
			return new Promise(function(resolve)
			{
				try
				{
					var req = idb.transaction(store).objectStore(store).get(key);

					req.onsuccess = function()
					{
						resolve(req.result || null);
					};

					req.onerror = function()
					{
						resolve(null);
					};
				}
				catch (e)
				{
					resolve(null);
				}
			});
		});
	};

	function cachePut(store, key, value)
	{
		return openDb().then(function(idb)
		{
			return new Promise(function(resolve)
			{
				try
				{
					var tx = idb.transaction(store, 'readwrite');
					tx.objectStore(store).put(value, key);
					tx.oncomplete = resolve;
					tx.onerror = resolve;
					tx.onabort = resolve;
				}
				catch (e)
				{
					resolve();
				}
			});
		});
	};

	/**
	 * Keeps the 12 towns that were loaded last.
	 */
	function trimCache()
	{
		return openDb().then(function(idb)
		{
			return new Promise(function(resolve)
			{
				try
				{
					var tx = idb.transaction('towns', 'readwrite');
					var store = tx.objectStore('towns');
					var entries = [];

					store.openCursor().onsuccess = function(evt)
					{
						var cursor = evt.target.result;

						if (cursor != null)
						{
							entries.push([cursor.key, cursor.value.date]);
							cursor['continue']();
						}
						else
						{
							entries.sort(function(a, b)
							{
								return (a[1] < b[1]) ? 1 : -1;
							});

							for (var i = 12; i < entries.length; i++)
							{
								store['delete'](entries[i][0]);
							}
						}
					};

					tx.oncomplete = resolve;
					tx.onerror = resolve;
					tx.onabort = resolve;
				}
				catch (e)
				{
					resolve();
				}
			});
		});
	};

	/**
	 * Web Mercator (EPSG:3857), the projection of the map tiles, around the
	 * given center with north up, scaled by the cosine of its latitude so
	 * that 1 unit is 1 m there. x0 and y0 are the Mercator meters of the
	 * center and k the scale.
	 */
	function createProjection(lat0, lon0)
	{
		var k = Math.cos(lat0 * Math.PI / 180);
		var x0 = getMercatorX(lon0);
		var y0 = getMercatorY(lat0);

		return {x0: x0, y0: y0, k: k,
			x: function(lon) { return (getMercatorX(lon) - x0) * k; },
			y: function(lat) { return (y0 - getMercatorY(lat)) * k; },
			lon: function(x) { return (x0 + x / k) / mercatorRadius * 180 / Math.PI; },
			lat: function(y) { return (2 * Math.atan(Math.exp((y0 - y / k) / mercatorRadius)) -
				Math.PI / 2) * 180 / Math.PI; }};
	};

	function getMercatorX(lon)
	{
		return mercatorRadius * lon * Math.PI / 180;
	};

	function getMercatorY(lat)
	{
		return mercatorRadius * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
	};

	/**
	 * Returns the region of the given place and section in projected
	 * coordinates: inside(x, y) is true inside the boundary or within
	 * boundaryTolerance of it, so that roads along the boundary stay whole,
	 * and inside the section. Rings are indexed in bands of y.
	 */
	function createRegion(place, section, proj)
	{
		var segs = [];
		var minY = Infinity;
		var maxY = -Infinity;

		if (place.rings != null)
		{
			for (var i = 0; i < place.rings.length; i++)
			{
				var ring = place.rings[i];

				for (var j = 0; j + 1 < ring.length; j++)
				{
					var x1 = proj.x(ring[j][0]);
					var y1 = proj.y(ring[j][1]);
					var x2 = proj.x(ring[j + 1][0]);
					var y2 = proj.y(ring[j + 1][1]);
					segs.push(x1, y1, x2, y2);
					minY = Math.min(minY, y1, y2);
					maxY = Math.max(maxY, y1, y2);
				}
			}
		}

		var n = segs.length / 4;
		var count = Math.max(16, Math.min(2048, Math.round(2 * Math.sqrt(n))));
		var height = (maxY - minY) / count || 1;
		var bands = [];

		function getBand(y)
		{
			return Math.max(0, Math.min(count - 1, Math.floor((y - minY) / height)));
		};

		for (var i = 0; i < count; i++)
		{
			bands.push([]);
		}

		for (var i = 0; i < n; i++)
		{
			var y1 = segs[4 * i + 1];
			var y2 = segs[4 * i + 3];

			for (var b = getBand(Math.min(y1, y2)); b <= getBand(Math.max(y1, y2)); b++)
			{
				bands[b].push(4 * i);
			}
		}

		function inPolygon(x, y)
		{
			var result = false;

			if (y >= minY && y <= maxY)
			{
				var band = bands[getBand(y)];

				for (var i = 0; i < band.length; i++)
				{
					var k = band[i];
					var y1 = segs[k + 1];
					var y2 = segs[k + 3];

					if ((y1 > y) != (y2 > y) && x < segs[k] + (y - y1) * (segs[k + 2] - segs[k]) / (y2 - y1))
					{
						result = !result;
					}
				}
			}

			return result;
		};

		function nearPolygon(x, y, tol)
		{
			if (y + tol >= minY && y - tol <= maxY)
			{
				for (var b = getBand(y - tol); b <= getBand(y + tol); b++)
				{
					var band = bands[b];

					for (var i = 0; i < band.length; i++)
					{
						var k = band[i];

						if (getSegmentDistance(x, y, segs[k], segs[k + 1], segs[k + 2], segs[k + 3]) < tol)
						{
							return true;
						}
					}
				}
			}

			return false;
		};

		var circle = (place.rings == null) ? {x: proj.x(place.lon), y: proj.y(place.lat), r: place.radius} : null;
		var rect = null;

		if (section != null && section.bbox != null)
		{
			rect = [proj.x(section.bbox[1]), proj.y(section.bbox[2]), proj.x(section.bbox[3]), proj.y(section.bbox[0])];
		}
		else if (section != null)
		{
			var c = {x: proj.x(section.lon), y: proj.y(section.lat), r: section.r};

			// The section of a place without a boundary is in its circle
			circle = (circle == null) ? c : {x: c.x, y: c.y, r: c.r, outer: circle};
		}

		function inCircle(c, x, y)
		{
			return (x - c.x) * (x - c.x) + (y - c.y) * (y - c.y) <= c.r * c.r &&
				(c.outer == null || inCircle(c.outer, x, y));
		};

		return {inside: function(x, y)
		{
			return (n == 0 || inPolygon(x, y) || nearPolygon(x, y, boundaryTolerance)) &&
				(circle == null || inCircle(circle, x, y)) &&
				(rect == null || (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]));
		}};
	};

	function getSegmentDistance(x, y, x1, y1, x2, y2)
	{
		var dx = x2 - x1;
		var dy = y2 - y1;
		var d2 = dx * dx + dy * dy;
		var t = (d2 > 0) ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / d2)) : 0;
		var px = x1 + t * dx - x;
		var py = y1 + t * dy - y;

		return Math.sqrt(px * px + py * py);
	};

	function parseCount(value)
	{
		var n = (value != null) ? parseInt(String(value).split(';')[0]) : NaN;

		return (isNaN(n) || n <= 0) ? null : n;
	};

	/**
	 * Returns the population of the given tag, also with separators of
	 * thousands such as 3.769.495, 1,234,567 or 1 234 567, or null.
	 */
	function parsePopulation(value)
	{
		var n = (value != null) ? parseInt(String(value).split(';')[0].replace(/[\s.,'\u2019]/g, '')) : NaN;

		return (isNaN(n) || n <= 0) ? null : n;
	};

	/**
	 * Returns the speed in km/h of the given maxspeed or null.
	 */
	function parseSpeed(value)
	{
		if (value == null)
		{
			return null;
		}

		var v = String(value).split(';')[0].trim().toLowerCase();
		var m = /^(\d+(?:\.\d+)?)\s*(mph|knots)?/.exec(v);
		var zone = /zone:?(\d+)/.exec(v);

		return (m != null) ? Math.round(parseFloat(m[1]) * ((m[2] == 'mph') ? 1.609 :
			((m[2] == 'knots') ? 1.852 : 1))) : ((zone != null) ? parseInt(zone[1]) :
			((v == 'none') ? 130 : ((v == 'walk' || /living_street$/.test(v)) ? 10 :
			(/motorway$/.test(v) ? 120 : (/trunk$/.test(v) ? 100 : (/rural$/.test(v) ? 80 :
			(/urban$/.test(v) ? 50 : null)))))));
	};

	/**
	 * Returns the direction (1 for one-way roads in the direction of the
	 * way, -1 against it, 0 for both), the lanes forward and backward and
	 * the speed of a way with the given tags, or null for ways that cars do
	 * not use.
	 */
	function getAttributes(tags)
	{
		var hw = tags.highway;
		var access = tags.motorcar || tags.motor_vehicle || tags.vehicle || tags.access;
		var oneway = tags.oneway;
		var ring = tags.junction == 'roundabout' || tags.junction == 'circular';

		if (tags.area == 'yes' || access == 'no' || access == 'private' || access == 'agricultural' ||
			access == 'forestry' || oneway == 'reversible' || oneway == 'alternating')
		{
			return null;
		}

		var dir = (oneway == 'yes' || oneway == 'true' || oneway == '1') ? 1 :
			((oneway == '-1' || oneway == 'reverse') ? -1 : ((oneway == 'no' || oneway == 'false' ||
			oneway == '0') ? 0 : ((hw == 'motorway' || hw == 'motorway_link' || ring) ? 1 : 0)));
		var total = parseCount(tags.lanes);
		var f = parseCount(tags['lanes:forward']);
		var b = parseCount(tags['lanes:backward']);

		if (total != null)
		{
			total -= (parseCount(tags['lanes:both_ways']) || 0) + (parseCount(tags['lanes:psv']) || 0) +
				(parseCount(tags['lanes:bus']) || 0);
		}

		if (dir != 0)
		{
			f = (total != null && total > 0) ? total : (((dir > 0) ? f : b) ||
				((hw == 'motorway' || hw == 'trunk') ? 2 : 1));
			b = 0;
		}
		else if (f == null && b == null)
		{
			f = b = Math.max(1, Math.floor((total || 2) / 2));
		}
		else if (f == null)
		{
			f = (total != null) ? total - b : b;
		}
		else if (b == null)
		{
			b = (total != null) ? total - f : f;
		}

		var speed = parseSpeed(tags.maxspeed) || Math.max(parseSpeed(tags['maxspeed:forward']) || 0,
			parseSpeed(tags['maxspeed:backward']) || 0) || defaultSpeeds[hw] || 50;

		return {dir: dir, fwd: Math.max(1, Math.min(4, f)), bwd: (dir != 0) ? 0 : Math.max(1, Math.min(4, b)),
			speed: Math.min(200, speed), ring: ring};
	};

	/**
	 * Graph of junctions and roads with the full shape of each road from its
	 * source to its target, the lanes forward and backward and the speed.
	 */
	function Graph()
	{
		this.vertices = [];
		this.edges = [];
	};

	Graph.prototype.addVertex = function(x, y, id, kind)
	{
		var v = {index: this.vertices.length, id: id, x: x, y: y, kind: kind || 'crossing',
			light: false, signal: false, edges: [], removed: false};
		this.vertices.push(v);

		return v;
	};

	Graph.prototype.addEdge = function(from, to, pts, a, id)
	{
		var e = {from: from, to: to, pts: pts, fwd: a.fwd, bwd: a.bwd, speed: a.speed, ring: a.ring,
			id: id, signals: null, length: null, removed: false};
		from.edges.push(e);
		to.edges.push(e);
		this.edges.push(e);

		return e;
	};

	Graph.prototype.removeEdge = function(e)
	{
		e.removed = true;
		e.from.edges.splice(e.from.edges.indexOf(e), 1);
		e.to.edges.splice(e.to.edges.indexOf(e), 1);
	};

	/**
	 * Moves the given end of the given edge to the given vertex.
	 */
	Graph.prototype.setTerminal = function(e, source, v)
	{
		var old = (source) ? e.from : e.to;
		old.edges.splice(old.edges.indexOf(e), 1);
		v.edges.push(e);

		if (source)
		{
			e.from = v;
			e.pts[0] = {x: v.x, y: v.y};
		}
		else
		{
			e.to = v;
			e.pts[e.pts.length - 1] = {x: v.x, y: v.y};
		}

		e.length = null;
	};

	Graph.prototype.getEdges = function()
	{
		return this.edges.filter(function(e)
		{
			return !e.removed;
		});
	};

	function getLength(e)
	{
		if (e.length == null)
		{
			e.length = 0;

			for (var i = 1; i < e.pts.length; i++)
			{
				e.length += Math.sqrt((e.pts[i].x - e.pts[i - 1].x) * (e.pts[i].x - e.pts[i - 1].x) +
					(e.pts[i].y - e.pts[i - 1].y) * (e.pts[i].y - e.pts[i - 1].y));
			}
		}

		return e.length;
	};

	/**
	 * Returns the point at the given fraction of the length of the given
	 * points.
	 */
	function getPointAt(pts, fraction)
	{
		var total = getLength({pts: pts, length: null});
		var d = fraction * total;

		for (var i = 1; i < pts.length; i++)
		{
			var len = Math.sqrt((pts[i].x - pts[i - 1].x) * (pts[i].x - pts[i - 1].x) +
				(pts[i].y - pts[i - 1].y) * (pts[i].y - pts[i - 1].y));

			if (d <= len || i == pts.length - 1)
			{
				var t = (len > 0) ? Math.min(1, d / len) : 0;

				return {x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y)};
			}

			d -= len;
		}

		return {x: pts[0].x, y: pts[0].y};
	};

	/**
	 * Returns the given edge as seen from the given vertex: ending there if
	 * atEnd is true, else starting there.
	 */
	function orient(e, v, atEnd)
	{
		return ((atEnd) ? e.to == v : e.from == v) ? {from: e.from, to: e.to, pts: e.pts, fwd: e.fwd, bwd: e.bwd} :
			{from: e.to, to: e.from, pts: e.pts.slice().reverse(), fwd: e.bwd, bwd: e.fwd};
	};

	/**
	 * Returns the graph of the given ways: junctions at nodes that are shared
	 * by several ways or end ways, roads along the ways between them.
	 */
	function createGraph(data, level, proj)
	{
		var g = new Graph();
		var nodes = data.nodes;
		var index = new Map();
		var signals = new Set(data.signals);
		var max = levels.indexOf(level);
		var ways = [];

		for (var i = 0; i < nodes.ids.length; i++)
		{
			index.set(nodes.ids[i], i);
		}

		for (var i = 0; i < data.ways.length; i++)
		{
			var way = data.ways[i];
			var rank = classes[way.tags.highway];
			var a = (rank != null && rank <= max) ? getAttributes(way.tags) : null;

			if (a != null)
			{
				var refs = [];

				for (var j = 0; j < way.nodes.length; j++)
				{
					var k = index.get(way.nodes[j]);

					if (k != null)
					{
						refs.push(k);
					}
				}

				if (a.dir < 0)
				{
					refs.reverse();
				}

				if (refs.length > 1)
				{
					ways.push({id: way.id, a: a, refs: refs});
				}
			}
		}

		var uses = new Uint8Array(nodes.ids.length);

		for (var i = 0; i < ways.length; i++)
		{
			var refs = ways[i].refs;

			for (var j = 0; j < refs.length; j++)
			{
				uses[refs[j]] = Math.min(255, uses[refs[j]] + ((j == 0 || j == refs.length - 1) ? 2 : 1));
			}
		}

		var vertices = new Map();

		function getVertex(k)
		{
			var v = vertices.get(k);

			if (v == null)
			{
				v = g.addVertex(proj.x(nodes.lon[k]), proj.y(nodes.lat[k]), 'n' + nodes.ids[k]);
				v.signal = signals.has(nodes.ids[k]);
				vertices.set(k, v);
			}

			return v;
		};

		for (var i = 0; i < ways.length; i++)
		{
			var w = ways[i];
			var start = 0;
			var pts = [{x: proj.x(nodes.lon[w.refs[0]]), y: proj.y(nodes.lat[w.refs[0]])}];
			var along = [];
			var d = 0;

			for (var j = 1; j < w.refs.length; j++)
			{
				var k = w.refs[j];
				var p = {x: proj.x(nodes.lon[k]), y: proj.y(nodes.lat[k])};
				var q = pts[pts.length - 1];
				d += Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
				pts.push(p);

				if (uses[k] >= 2)
				{
					var e = g.addEdge(getVertex(w.refs[start]), getVertex(k), pts,
						{fwd: w.a.fwd, bwd: w.a.bwd, speed: w.a.speed, ring: w.a.ring}, 'w' + w.id);
					e.signals = (along.length > 0) ? along : null;
					start = j;
					pts = [p];
					along = [];
					d = 0;
				}
				else if (signals.has(nodes.ids[k]))
				{
					along.push(d);
				}
			}
		}

		return g;
	};

	/**
	 * Makes junctions of three or more roads traffic lights if a node with
	 * traffic signals is on them or on a road to them within signalDistance.
	 */
	function addLights(g)
	{
		// Follows chains of two roads from v, arrived on e after d m
		function walk(v, e, d)
		{
			while (d <= signalDistance)
			{
				if (v.edges.length >= 3)
				{
					v.light = true;

					return true;
				}
				else if (v.edges.length != 2 || v.edges[0] == v.edges[1])
				{
					return false;
				}

				e = (v.edges[0] == e) ? v.edges[1] : v.edges[0];
				d += getLength(e);
				v = (e.from == v) ? e.to : e.from;
			}

			return false;
		};

		g.edges.forEach(function(e)
		{
			for (var i = 0; e.signals != null && i < e.signals.length; i++)
			{
				var d = e.signals[i];
				var rest = getLength(e) - d;

				if (d <= rest)
				{
					walk(e.from, e, d) || walk(e.to, e, rest);
				}
				else
				{
					walk(e.to, e, rest) || walk(e.from, e, d);
				}
			}
		});

		g.vertices.forEach(function(v)
		{
			if (v.signal && !v.light)
			{
				for (var i = 0; i < v.edges.length && !walk(v, null, 0); i++)
				{
					var e = v.edges[i];
					walk((e.from == v) ? e.to : e.from, e, getLength(e));
				}
			}
		});
	};

	/**
	 * Cuts the roads where they leave the region and adds a gate at each
	 * cut. Pieces between two cuts that are shorter than 30 m are dropped.
	 */
	function clip(g, region)
	{
		var step = 20;
		var gates = 0;

		function inside(p)
		{
			return region.inside(p.x, p.y);
		};

		// Point between a and b where inside changes from the given value
		function bisect(a, b, from)
		{
			for (var i = 0; i < 14; i++)
			{
				var m = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};

				if (inside(m) == from)
				{
					a = m;
				}
				else
				{
					b = m;
				}
			}

			return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
		};

		g.getEdges().forEach(function(e)
		{
			var pieces = [];
			var prev = e.pts[0];
			var was = inside(prev);
			var piece = (was) ? {pts: [prev], cut: false} : null;
			var whole = was;

			for (var i = 1; i < e.pts.length; i++)
			{
				var a = e.pts[i - 1];
				var b = e.pts[i];
				var n = Math.max(1, Math.ceil(Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)) / step));

				for (var j = 1; j <= n; j++)
				{
					var q = (j == n) ? b : {x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n};
					var is = inside(q);

					if (is != was)
					{
						var c = bisect(prev, q, was);
						whole = false;

						if (was)
						{
							piece.pts.push(c);
							pieces.push({pts: piece.pts, start: piece.cut, end: true});
							piece = null;
						}
						else
						{
							piece = {pts: [c], cut: true};
						}

						was = is;
					}

					prev = q;
				}

				if (piece != null)
				{
					piece.pts.push(b);
				}
			}

			if (!whole)
			{
				if (piece != null)
				{
					pieces.push({pts: piece.pts, start: piece.cut, end: false});
				}

				g.removeEdge(e);

				pieces.forEach(function(p)
				{
					var len = getLength({pts: p.pts, length: null});

					if (len > 0.5 && !(p.start && p.end && len < 30))
					{
						var from = (p.start) ? g.addVertex(p.pts[0].x, p.pts[0].y, 'g' + gates++, 'gate') : e.from;
						var to = (p.end) ? g.addVertex(p.pts[p.pts.length - 1].x, p.pts[p.pts.length - 1].y,
							'g' + gates++, 'gate') : e.to;
						g.addEdge(from, to, p.pts, e, e.id);
					}
				});
			}
		});
	};

	/**
	 * Replaces closed rings of one-way roundabout roads with roundabouts and
	 * connects their roads to them.
	 */
	function addRoundabouts(g)
	{
		var rings = g.getEdges().filter(function(e)
		{
			return e.ring && e.bwd == 0 && e.from != e.to;
		});
		var parent = new Map();

		function find(v)
		{
			while (parent.has(v) && parent.get(v) != v)
			{
				v = parent.get(v);
			}

			return v;
		};

		rings.forEach(function(e)
		{
			parent.set(e.from, find(e.from));
			parent.set(e.to, find(e.to));
			var a = find(e.from);
			var b = find(e.to);

			if (a != b)
			{
				parent.set(b, a);
			}
		});

		var groups = new Map();

		rings.forEach(function(e)
		{
			var root = find(e.from);

			if (!groups.has(root))
			{
				groups.set(root, []);
			}

			groups.get(root).push(e);
		});

		var count = 0;

		groups.forEach(function(edges)
		{
			var outs = new Map();
			var ins = new Map();
			var vertices = [];

			edges.forEach(function(e)
			{
				outs.set(e.from, (outs.get(e.from) || 0) + 1);
				ins.set(e.to, (ins.get(e.to) || 0) + 1);

				if (vertices.indexOf(e.from) < 0)
				{
					vertices.push(e.from);
				}
			});

			var closed = vertices.every(function(v)
			{
				return outs.get(v) == 1 && ins.get(v) == 1;
			}) && ins.size == vertices.length;

			if (closed)
			{
				var sx = 0;
				var sy = 0;
				var pts = [];

				edges.forEach(function(e)
				{
					pts = pts.concat(e.pts.slice(1));
				});

				pts.forEach(function(p)
				{
					sx += p.x;
					sy += p.y;
				});

				var cx = sx / pts.length;
				var cy = sy / pts.length;
				var r = 0;

				pts.forEach(function(p)
				{
					r += Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)) / pts.length;
				});

				if (r >= 3 && r <= 80)
				{
					var lanes = Math.min(3, Math.max.apply(null, edges.map(function(e)
					{
						return e.fwd;
					})));
					var v = g.addVertex(cx, cy, 'r' + count++, 'roundabout');
					v.radius = Math.max(10, r + lanes * laneWidth / 2 + 1);
					v.lanes = lanes;

					edges.forEach(function(e)
					{
						g.removeEdge(e);
					});

					vertices.forEach(function(u)
					{
						u.edges.slice().forEach(function(e)
						{
							if (e.from == u)
							{
								g.setTerminal(e, true, v);
							}

							if (e.to == u)
							{
								g.setTerminal(e, false, v);
							}
						});

						u.removed = true;
					});

					// Points inside the ring
					v.edges.slice().forEach(function(e)
					{
						if (e.removed)
						{
							return;
						}
						else if (e.from == v && e.to == v)
						{
							g.removeEdge(e);
						}
						else
						{
							trimEnd(e, e.from == v, v);
						}
					});
				}
			}
		});
	};

	/**
	 * Removes the points of the given end of the given road that are inside
	 * the given roundabout.
	 */
	function trimEnd(e, source, v)
	{
		var pts = e.pts;
		var inside = function(p)
		{
			return (p.x - v.x) * (p.x - v.x) + (p.y - v.y) * (p.y - v.y) < v.radius * v.radius;
		};

		while (pts.length > 2 && inside((source) ? pts[1] : pts[pts.length - 2]))
		{
			pts.splice((source) ? 1 : pts.length - 2, 1);
		}

		e.length = null;
	};

	/**
	 * Merges the two roads of each junction that joins only two roads into
	 * one road, with the junction as a waypoint, where traffic passes in one
	 * direction or both. The road keeps the lanes of the longer part and the
	 * speed of the time to drive both. Two roads to the same junction become
	 * a loop without another junction, which cars cannot use: with dropLoops
	 * it is removed, else the junction stays, eg. for mergePairs.
	 */
	function mergeChains(g, dropLoops)
	{
		var merged = true;

		while (merged)
		{
			merged = false;

			g.vertices.forEach(function(v)
			{
				if (!v.removed && v.kind == 'crossing' && v.edges.length == 2 && v.edges[0] != v.edges[1])
				{
					var e0 = v.edges[0];
					var e1 = v.edges[1];
					var a = orient(e0, v, true);
					var b = orient(e1, v, false);
					var fwd = a.fwd > 0 && b.fwd > 0;
					var bwd = a.bwd > 0 && b.bwd > 0;

					if ((fwd || bwd) && (dropLoops || a.from != b.to))
					{
						var la = getLength(e0);
						var lb = getLength(e1);
						var longer = (la >= lb) ? a : b;
						g.removeEdge(e0);
						g.removeEdge(e1);
						v.removed = true;
						merged = true;

						if (a.from != b.to)
						{
							g.addEdge(a.from, b.to, a.pts.concat(b.pts.slice(1)), {fwd: (fwd) ? longer.fwd : 0,
								bwd: (bwd) ? longer.bwd : 0, speed: Math.round((la + lb) /
								Math.max(1e-6, la / e0.speed + lb / e1.speed)), ring: e0.ring && e1.ring}, e0.id);
						}
					}
				}
			});
		}
	};

	/**
	 * Makes one junction of junctions that are joined by roads shorter than
	 * minRoadLength, at most maxClusterSize wide, eg. the crossings of dual
	 * carriageways.
	 */
	function contract(g)
	{
		var short = g.getEdges().filter(function(e)
		{
			return e.from != e.to && e.from.kind == 'crossing' && e.to.kind == 'crossing' &&
				getLength(e) < minRoadLength;
		}).sort(function(a, b)
		{
			return getLength(a) - getLength(b);
		});
		var parent = new Map();
		var clusters = new Map();

		function find(v)
		{
			while (parent.has(v))
			{
				v = parent.get(v);
			}

			return v;
		};

		function getCluster(v)
		{
			if (!clusters.has(v))
			{
				clusters.set(v, {members: [v], x0: v.x, y0: v.y, x1: v.x, y1: v.y});
			}

			return clusters.get(v);
		};

		short.forEach(function(e)
		{
			var a = find(e.from);
			var b = find(e.to);

			if (a != b)
			{
				var ca = getCluster(a);
				var cb = getCluster(b);
				var x0 = Math.min(ca.x0, cb.x0);
				var y0 = Math.min(ca.y0, cb.y0);
				var x1 = Math.max(ca.x1, cb.x1);
				var y1 = Math.max(ca.y1, cb.y1);

				if (x1 - x0 <= maxClusterSize && y1 - y0 <= maxClusterSize)
				{
					parent.set(b, a);
					clusters['delete'](b);
					clusters.set(a, {members: ca.members.concat(cb.members), x0: x0, y0: y0, x1: x1, y1: y1});
				}
			}
		});

		clusters.forEach(function(c, root)
		{
			if (c.members.length > 1)
			{
				var x = 0;
				var y = 0;

				c.members.forEach(function(m)
				{
					x += m.x / c.members.length;
					y += m.y / c.members.length;
					root.light = root.light || m.light;
				});

				c.members.forEach(function(m)
				{
					m.x0 = m.x;
					m.y0 = m.y;
				});

				root.x = x;
				root.y = y;

				// Moves the end to the new junction and keeps the old end as a
				// waypoint, so that the road stays on its street
				var moveEnd = function(e, source, m)
				{
					g.setTerminal(e, source, root);

					if (Math.abs(m.x0 - x) + Math.abs(m.y0 - y) > 0.5)
					{
						e.pts.splice((source) ? 1 : e.pts.length - 1, 0, {x: m.x0, y: m.y0});
					}
				};

				c.members.forEach(function(m)
				{
					m.edges.slice().forEach(function(e)
					{
						// Each end once, loops have the edge twice
						if (e.from == m && (m != root || e.pts[0].x != x || e.pts[0].y != y))
						{
							moveEnd(e, true, m);
						}

						if (e.to == m && (m != root || e.pts[e.pts.length - 1].x != x ||
							e.pts[e.pts.length - 1].y != y))
						{
							moveEnd(e, false, m);
						}
					});

					if (m != root)
					{
						m.removed = true;
					}
				});

				root.edges.slice().forEach(function(e)
				{
					if (!e.removed && e.from == root && e.to == root && getLength(e) < 2 * maxClusterSize)
					{
						g.removeEdge(e);
					}
				});
			}
		});
	};

	/**
	 * Removes dead ends shorter than minRoadLength that are no gates.
	 */
	function dropStubs(g)
	{
		g.vertices.forEach(function(v)
		{
			if (!v.removed && v.kind == 'crossing' && v.edges.length == 1 && getLength(v.edges[0]) < minRoadLength)
			{
				g.removeEdge(v.edges[0]);
				v.removed = true;
			}
		});
	};

	/**
	 * Removes roads that start and end at the same junction without another
	 * junction on them, as cars cannot use them.
	 */
	function dropLoops(g)
	{
		g.getEdges().forEach(function(e)
		{
			if (e.from == e.to)
			{
				g.removeEdge(e);
			}
		});
	};

	/**
	 * Removes the parts that are not connected to the rest and have fewer
	 * roads than 1 % of all, at least 5 and at most 50.
	 */
	function dropParts(g)
	{
		var parent = new Map();

		function find(v)
		{
			while (parent.has(v))
			{
				v = parent.get(v);
			}

			return v;
		};

		var edges = g.getEdges();

		edges.forEach(function(e)
		{
			var a = find(e.from);
			var b = find(e.to);

			if (a != b)
			{
				parent.set(b, a);
			}
		});

		var sizes = new Map();

		edges.forEach(function(e)
		{
			var root = find(e.from);
			sizes.set(root, (sizes.get(root) || 0) + 1);
		});

		var min = Math.min(50, Math.max(5, Math.round(edges.length / 100)));
		var largest = 0;
		var dropped = 0;

		sizes.forEach(function(size)
		{
			largest = Math.max(largest, size);
		});

		// The largest part stays also if it is small, eg. a small town
		edges.forEach(function(e)
		{
			var size = sizes.get(find(e.from));

			if (size < min && size < largest)
			{
				g.removeEdge(e);
				dropped++;
			}
		});

		return dropped;
	};

	/**
	 * Douglas-Peucker simplification of the given points.
	 */
	function simplify(pts, tol)
	{
		if (pts.length <= 2)
		{
			return pts;
		}

		var keep = new Uint8Array(pts.length);
		var stack = [[0, pts.length - 1]];
		keep[0] = keep[pts.length - 1] = 1;

		while (stack.length > 0)
		{
			var range = stack.pop();
			var a = pts[range[0]];
			var b = pts[range[1]];
			var best = -1;
			var max = tol;

			for (var i = range[0] + 1; i < range[1]; i++)
			{
				var d = getSegmentDistance(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);

				if (d > max)
				{
					max = d;
					best = i;
				}
			}

			if (best >= 0)
			{
				keep[best] = 1;
				stack.push([range[0], best], [best, range[1]]);
			}
		}

		return pts.filter(function(p, i)
		{
			return keep[i] == 1;
		});
	};

	function escape(text)
	{
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	};

	/**
	 * Gives the given junctions inside the given region, other than gates,
	 * the homes and jobs of the given zones (see getZoneQuery): each area its
	 * weight per hectare of the bounding box that it fills, shared by the
	 * junctions in the box, else given to the nearest junction within
	 * zoneDistance, like each place. Returns the number of areas and places
	 * that were used and the sums of homes and jobs.
	 */
	function addZones(vertices, zones, proj, region)
	{
		var size = 250;
		var grid = new Map();
		var result = {areas: 0, places: 0, homes: 0, jobs: 0};

		vertices.forEach(function(v)
		{
			v.homes = 0;
			v.jobs = 0;

			if (v.kind != 'gate')
			{
				var key = Math.floor(v.x / size) + ',' + Math.floor(v.y / size);
				var list = grid.get(key);

				if (list == null)
				{
					list = [];
					grid.set(key, list);
				}

				list.push(v);
			}
		});

		function inBox(x0, y0, x1, y1)
		{
			var found = [];

			for (var gx = Math.floor(x0 / size); gx <= Math.floor(x1 / size); gx++)
			{
				for (var gy = Math.floor(y0 / size); gy <= Math.floor(y1 / size); gy++)
				{
					var list = grid.get(gx + ',' + gy) || [];

					for (var i = 0; i < list.length; i++)
					{
						var v = list[i];

						if (v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1)
						{
							found.push(v);
						}
					}
				}
			}

			return found;
		};

		function nearest(x, y)
		{
			var best = null;
			var dist = zoneDistance;

			inBox(x - zoneDistance, y - zoneDistance, x + zoneDistance, y + zoneDistance).forEach(function(v)
			{
				var d = Math.sqrt((v.x - x) * (v.x - x) + (v.y - y) * (v.y - y));

				if (d < dist)
				{
					dist = d;
					best = v;
				}
			});

			return best;
		};

		function add(list, key, weight)
		{
			for (var i = 0; i < list.length; i++)
			{
				list[i][key] += weight / list.length;
			}

			result[key] += (list.length > 0) ? weight : 0;
		};

		var a = zones.areas;

		for (var i = 0; i < a.kind.length; i++)
		{
			var x0 = proj.x(a.west[i]);
			var x1 = proj.x(a.east[i]);
			var y0 = proj.y(a.north[i]);
			var y1 = proj.y(a.south[i]);
			var cx = (x0 + x1) / 2;
			var cy = (y0 + y1) / 2;
			var weight = zoneWeights[a.kind[i]];

			if (weight != null && region.inside(cx, cy))
			{
				var list = inBox(x0 - 30, y0 - 30, x1 + 30, y1 + 30);
				var v = (list.length == 0) ? nearest(cx, cy) : null;
				add((v != null) ? [v] : list, (a.kind[i] == 'homes') ? 'homes' : 'jobs',
					weight * (x1 - x0) * (y1 - y0) * zoneFill / 1e4);
				result.areas++;
			}
		}

		var p = zones.places;

		for (var i = 0; i < p.lat.length; i++)
		{
			var x = proj.x(p.lon[i]);
			var y = proj.y(p.lat[i]);
			var v = (region.inside(x, y)) ? nearest(x, y) : null;

			if (v != null)
			{
				add([v], 'jobs', zoneWeights.places);
				result.places++;
			}
		}

		return result;
	};

	/**
	 * Returns the style of the given road: lanes per direction, laneSpec
	 * for different lanes per direction, an arrow for one-way roads and
	 * maxSpeed in km/h.
	 */
	function getRoadStyle(e)
	{
		var style = 'shape=road;';

		if (e.bwd == 0)
		{
			style += 'endArrow=block;startArrow=none;lanes=' + e.fwd + ';';
		}
		else if (e.fwd == e.bwd)
		{
			style += 'endArrow=none;startArrow=none;lanes=' + e.fwd + ';';
		}
		else
		{
			style += 'endArrow=none;startArrow=none;laneSpec=' + new Array(e.bwd + 1).join('b,') +
				new Array(e.fwd).join('f,') + 'f;';
		}

		return style + 'laneWidth=' + laneWidth + ';strokeWidth=' + ((e.fwd + e.bwd) * laneWidth) +
			';maxSpeed=' + e.speed + ';';
	};

	/**
	 * Returns the network of the given compact data of the given place,
	 * level and section as a draw.io file and its size, or tooLarge if it
	 * has more junctions or roads than the limits.
	 */
	function build(data, place, level, section, options)
	{
		options = options || {};
		var b = getBounds(place, section) || place.bbox;
		var proj = createProjection((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
		var region = createRegion(place, section, proj);
		var g = createGraph(data, level, proj);
		addLights(g);
		clip(g, region);
		addRoundabouts(g);
		mergeChains(g, false);
		contract(g);
		mergeChains(g, false);
		dropStubs(g);
		dropLoops(g);
		mergeChains(g, true);
		var dropped = dropParts(g);

		var edges = g.getEdges();
		var vertices = g.vertices.filter(function(v)
		{
			if (v.light && v.edges.length < 3)
			{
				v.light = false;
			}

			return !v.removed && v.edges.length > 0;
		});
		var stats = {junctions: vertices.length, roads: edges.length, lights: 0, roundabouts: 0, gates: 0,
			km: 0, laneKm: 0, points: 0, dropped: dropped, zones: null};

		if (data.zones != null)
		{
			stats.zones = addZones(vertices, data.zones, proj, region);
		}

		vertices.forEach(function(v)
		{
			stats.lights += (v.light) ? 1 : 0;
			stats.roundabouts += (v.kind == 'roundabout') ? 1 : 0;
			stats.gates += (v.kind == 'gate') ? 1 : 0;
		});

		edges.forEach(function(e)
		{
			stats.km += getLength(e) / 1000;
			stats.laneKm += getLength(e) * (e.fwd + e.bwd) / 1000;
		});

		var max = Object.assign({}, limits, options.limits);

		if (vertices.length == 0)
		{
			return {stats: stats, empty: true};
		}
		else if (stats.junctions > max.junctions || stats.roads > max.roads)
		{
			return {stats: stats, tooLarge: true, limits: max};
		}

		var x0 = Infinity;
		var y0 = Infinity;
		var x1 = -Infinity;
		var y1 = -Infinity;

		vertices.forEach(function(v)
		{
			x0 = Math.min(x0, v.x);
			y0 = Math.min(y0, v.y);
			x1 = Math.max(x1, v.x);
			y1 = Math.max(y1, v.y);
		});

		edges.forEach(function(e)
		{
			e.pts = simplify(e.pts, simplifyTolerance);

			e.pts.forEach(function(p)
			{
				x0 = Math.min(x0, p.x);
				y0 = Math.min(y0, p.y);
				x1 = Math.max(x1, p.x);
				y1 = Math.max(y1, p.y);
			});
		});

		// Moves the network to the origin with a margin
		var dx = 40 - x0;
		var dy = 40 - y0;
		var name = options.name || place.name;
		var out = ['<mxfile host="drawio"><diagram id="osm" name="' + escape(name) + '">' +
			'<mxGraphModel grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" ' +
			'page="0" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
			'<root><mxCell id="0"/><mxCell id="1" parent="0"/>'];
		var ids = new Set();

		vertices.forEach(function(v)
		{
			var size = (v.kind == 'roundabout') ? 2 * v.radius : crossingSize;
			var style = ((v.kind == 'roundabout') ? roundaboutStyle + 'lanes=' + v.lanes + ';laneWidth=' + laneWidth + ';' :
				crossingStyle + ((v.light) ? 'trafficLight=' + lightGreen + ';' : '') +
				((v.kind == 'gate') ? 'gate=1;' : '')) + ((v.homes >= 1) ? 'homes=' + Math.round(v.homes) + ';' : '') +
				((v.jobs >= 1) ? 'jobs=' + Math.round(v.jobs) + ';' : '');

			while (ids.has(v.id))
			{
				v.id += "'";
			}

			ids.add(v.id);
			out.push('<mxCell id="' + v.id + '" value="" style="' + style + '" vertex="1" parent="1">' +
				'<mxGeometry x="' + (v.x + dx - size / 2).toFixed(2) + '" y="' + (v.y + dy - size / 2).toFixed(2) +
				'" width="' + size.toFixed(2) + '" height="' + size.toFixed(2) + '" as="geometry"/></mxCell>');
		});

		edges.forEach(function(e)
		{
			// One-way roads are drawn in their direction
			if (e.fwd == 0)
			{
				var r = orient(e, e.to, false);
				e = {id: e.id, from: r.from, to: r.to, pts: r.pts, fwd: r.fwd, bwd: r.bwd, speed: e.speed};
			}

			var id = e.id;

			for (var k = 1; ids.has(id); k++)
			{
				id = e.id + '-' + k;
			}

			ids.add(id);
			var points = '';

			for (var i = 1; i < e.pts.length - 1; i++)
			{
				points += '<mxPoint x="' + (e.pts[i].x + dx).toFixed(1) + '" y="' + (e.pts[i].y + dy).toFixed(1) + '"/>';
			}

			stats.points += Math.max(0, e.pts.length - 2);
			out.push('<mxCell id="' + id + '" value="" style="' + getRoadStyle(e) + '" edge="1" parent="1" source="' +
				e.from.id + '" target="' + e.to.id + '"><mxGeometry relative="1" as="geometry">' +
				((points.length > 0) ? '<Array as="points">' + points + '</Array>' : '') + '</mxGeometry></mxCell>');
		});

		// Attribution of the data below the network with the Mercator meters
		// of the origin of the diagram and the scale for the map
		var font = Math.max(12, Math.round((x1 - x0) / 60));
		var date = options.date || new Date().toISOString();
		var mercator = [(proj.x0 - dx / proj.k).toFixed(3), (proj.y0 + dy / proj.k).toFixed(3), proj.k.toFixed(12)];
		out.push('<UserObject label="' + escape(name + ': roads' + ((stats.zones != null) ? ' and zones ' : ' ') +
			attribution + ' (ODbL), ' + date.substring(0, 10)) + '" link="' + copyrightUrl + '" mercator="' + mercator.join(',') +
			'" id="osm-attribution">' +
			'<mxCell style="text;html=1;align=left;verticalAlign=top;whiteSpace=nowrap;fontSize=' + font +
			';fontColor=light-dark(#59636e,#9aa0a6);" vertex="1" parent="1"><mxGeometry x="40" y="' +
			(y1 + dy + 2 * font).toFixed(0) + '" width="' + (30 * font) + '" height="' + Math.round(1.5 * font) +
			'" as="geometry"/></mxCell></UserObject>');
		out.push('</root></mxGraphModel></diagram></mxfile>');

		return {xml: out.join('\n'), stats: stats};
	};

	return {servers: servers, levels: levels, levelNames: levelNames, limits: limits,
		attribution: attribution, copyrightUrl: copyrightUrl, search: search, suggest: suggest,
		lookup: lookup, estimate: estimate, load: load, findCached: findCached, build: build, compact: compact, getBounds: getBounds,
		getArea: getArea, getQuery: getQuery, getSectionText: getSectionText, parseSection: parseSection,
		createProjection: createProjection, getAttributes: getAttributes, parseSpeed: parseSpeed,
		parsePopulation: parsePopulation};
})();

if (typeof module == 'object' && module.exports != null)
{
	module.exports = TrafficOsm;
}
