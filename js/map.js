/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * OpenStreetMap layer of towns in the editor. This script runs in the
 * window of the editor after js/roads.js: TrafficMap(ui) shows the notice
 * "© OpenStreetMap contributors" with the ODbL in the bottom right corner of
 * the diagram while the current page is a town that js/osm.js built, which
 * has the text with the id osm-attribution. The notice stays in view at all
 * zoom levels and scroll positions.
 */
window.TrafficMap = function(ui)
{
	var graph = ui.editor.graph;
	var container = graph.container;
	var parent = container.parentNode;
	var copyrightUrl = 'https://www.openstreetmap.org/copyright';
	var licenseUrl = 'https://opendatacommons.org/licenses/odbl/';
	var town = false;

	var notice = document.createElement('div');
	notice.className = 'trafficMapNotice';
	notice.style.cssText = 'position:absolute;z-index:3;display:none;padding:2px 6px;border-radius:4px;' +
		'font:11px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;' +
		'transform:translate(-100%,-100%);pointer-events:auto;';
	notice.innerHTML = '© <a href="' + copyrightUrl + '" target="_blank" rel="noopener">OpenStreetMap ' +
		'contributors</a>, <a href="' + licenseUrl + '" target="_blank" rel="noopener">ODbL</a>';
	parent.appendChild(notice);

	/**
	 * Returns true if the current page is a town of OpenStreetMap.
	 */
	function isTown()
	{
		return graph.model.getCell('osm-attribution') != null;
	};

	/**
	 * Puts the notice into the bottom right corner of the visible area of
	 * the diagram, inside the scrollbars, in the colors of the theme.
	 */
	function update()
	{
		town = isTown();
		notice.style.display = (town) ? '' : 'none';

		if (town)
		{
			var c = container.getBoundingClientRect();
			var p = parent.getBoundingClientRect();
			var dark = typeof Editor !== 'undefined' && Editor.isDarkMode();
			notice.style.left = (c.left - p.left + container.clientLeft + container.clientWidth - 6) + 'px';
			notice.style.top = (c.top - p.top + container.clientTop + container.clientHeight - 6) + 'px';
			notice.style.color = (dark) ? '#e6e7e9' : '#1f2328';
			notice.style.background = (dark) ? 'rgba(24,25,27,0.8)' : 'rgba(255,255,255,0.8)';

			var links = notice.getElementsByTagName('a');

			for (var i = 0; i < links.length; i++)
			{
				links[i].style.color = (dark) ? '#6ba1f5' : '#1a73e8';
			}
		}
	};

	update = TrafficRoads.guard(update, 'map notice');
	graph.model.addListener(mxEvent.CHANGE, update);
	ui.addListener('darkModeChanged', update);
	window.addEventListener('resize', update);

	if (typeof ResizeObserver !== 'undefined')
	{
		new ResizeObserver(update).observe(container);
	}

	update();

	return {isTown: isTown, update: update};
};
