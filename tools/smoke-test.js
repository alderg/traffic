/**
 * Copyright (c) 2026, Gaudenz Alder
 */
/**
 * Opens the page at the given URL in headless Chrome and checks that draw.io
 * starts, the roads and the simulation attach to it, the Small example opens
 * with its network and cars drive, without errors on the page. The update of
 * draw.io runs it before it pushes a new release
 * (.github/workflows/update-drawio.yml).
 *
 * Usage: node tools/smoke-test.js http://localhost:8000/index.html
 *
 * It needs playwright-core and Chrome at CHROME, /usr/bin/google-chrome by
 * default.
 */
var chromium = require('playwright-core').chromium;
var url = process.argv[2];
var timeout = 90000;

async function main()
{
	var browser = await chromium.launch({executablePath: process.env.CHROME || '/usr/bin/google-chrome',
		headless: true});
	var errors = [];

	try
	{
		var page = await browser.newPage({viewport: {width: 1280, height: 800}});

		// Debug output logs the errors of the page and the editor
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

		await page.goto(url, {timeout: timeout});
		await page.waitForSelector('#start:not([disabled])', {timeout: timeout});
		console.log('The editor started and the simulation attached');
		await page.waitForFunction(function()
		{
			return /Network: [1-9]\d* crossings/.test(document.getElementById('stats').textContent);
		}, null, {timeout: timeout});
		console.log((await page.textContent('#stats')).split('\n')[1]);
		await page.click('#start');
		await page.waitForFunction(function()
		{
			return /Cars: [1-9]\d* driving/.test(document.getElementById('stats').textContent);
		}, null, {timeout: timeout});
		await page.waitForTimeout(3000);
		console.log((await page.textContent('#stats')).split('\n')[2]);
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
	console.log('Smoke test passed');
}, function(e)
{
	console.error('Smoke test failed: ' + e.message);
	process.exitCode = 1;
});
