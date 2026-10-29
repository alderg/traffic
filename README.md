# Traffic Simulation

Cars driving on a road network that you draw in [draw.io](https://www.drawio.com).
Try it at https://www.alderg.com/traffic/.

This is a port of sim.traffic, a traffic simulation written in Java in
2000, to the browser. The road network is a draw.io diagram, so
you can draw, edit, open and save it with the full editor while the cars
are driving. The road network of your own town comes from OpenStreetMap,
see [Loading Your Town](#loading-your-town).

The panel on the left has Start and Reset at the top and below them
sections that fold and unfold with a click on their title, or with Enter
or Space on it, where a chevron shows the state: Simulation, Layers from
the bottom up, Display, Statistics, Vehicle (while a vehicle is followed),
Selection, Network and Drawing Roads. Layers, Display and Drawing Roads
start folded, so that the statistics stay in view below the settings, and
the browser keeps which sections are folded across reloads. Folding stops
nothing: the simulation runs on and a folded section keeps updating, it is
only not shown. Network unfolds by itself for the progress or an error of
loading a town and for "load your town" at the top. The tab on the edge of
the panel hides the whole panel.

The panel works with the keyboard: Tab and Shift+Tab go through its
controls in their order on the screen, with a focus ring in both themes,
Enter or Space fold a section, the arrow keys change dropdowns and the
sliders, and Space checks boxes. Tab leads from the panel into the editor,
where draw.io keeps Tab for itself, so Alt+Shift+S moves the focus from the
editor back to where it was in the panel and from the panel into the
editor; draw.io does not use Alt+Shift+S.

On phones and tablets, a pinch or a double tap zooms only the diagram,
which draw.io zooms and pans itself, and not the page, as a zoomed page
cuts off the panel and the editor and does not zoom back by itself. The
page has `touch-action: pan-x pan-y` (`css/app.css`), which leaves
scrolling to the browser but not zooming, and the viewport
`maximum-scale=1` (`index.html`), which also keeps Safari on iOS from
zooming into a field that gets the focus. Safari on iOS zooms with a pinch
despite the viewport, so `js/app.js` cancels its `gesturestart` and
`gesturechange` events in the page and in the editor outside the diagram.
The panel has 13 px text and 28 px controls, which work without zooming,
and the zoom setting of the browser, eg. Page Zoom of Safari or of Chrome
on Android, still enlarges the whole page.

## Drawing Roads

- Shapes are junctions, connectors between them are roads. The Shapes
  panel has crossings, traffic lights and roundabouts, and two-way and
  one-way roads with 1 to 3 lanes. Drop the ends of a road on junctions,
  select two junctions and click a road, or drag from the arrows of a
  junction, which draws a two-way road.
- A road with one arrow is a one-way road in the direction of the arrow.
  One with no or two arrows is a road in both directions, with its lanes on
  the right of each direction. `lanes=2` in the style of a road (Edit
  Style) sets the lanes per direction, up to 4. `laneSpec` sets each lane
  from left to right in the drawn direction instead, as `f` (forward) or
  `b` (backward) followed by the turns it allows (`l`, `s`, `r`, all if
  none), for example `laneSpec=b,fl,fsr` for one lane back, a left-turn
  lane and a lane for straight on and right. Roads show turn arrows before
  the end of lanes with turns.
- `trafficLight=10` in the style of a junction makes it a traffic light
  that gives green to one approach axis at a time for 10 seconds, followed
  by 3 seconds of yellow. While the simulation runs, a stop bar across the
  lanes of each approach shows its state in red, yellow or green, always,
  whatever layers are shown, also on the map with the roads hidden, so
  that one sees why the cars stop there. The heads of the traffic lights
  with their lamps beside the road show it too when Traffic light heads in
  the panel is on (off by default), at least 13 pixels high and 10 m at
  close zoom.
- A roundabout (`shape=roundabout`) is a ring road where traffic circulates
  counterclockwise, with 1 to 3 lanes (`lanes`). Cars give way to the ring
  when they enter.
- Ends of roads that are dragged or dropped within 8 units of a crossing
  connect to it, so that the small crossings are easy to hit.
- Roads connect to the outline of their junctions. Waypoints of a road that
  lie inside the junction at either end, eg. when a traffic light becomes a
  larger roundabout, are skipped: the road enters the junction from its
  first waypoint outside, in the drawing and for the cars. The waypoints
  stay in the diagram, so that the road looks as before when the junction
  gets smaller again, and their handles are hidden meanwhile.
- Free ends of roads join the junction they are on or other free ends
  nearby, else cars can start and end there.
- The Selection section of the panel shows the selected junctions and
  roads: the type of junctions (crossing, traffic light, roundabout), the
  green time of traffic lights with their cycle, the lanes of roundabouts,
  the lanes per direction and direction of roads, and for one road each
  lane with its direction and turns. Changes apply at once, also while
  cars are driving, and can be undone. Below are live statistics of the
  first selected junction and each direction of the first selected road:
  the cars there now and on their way there on their routes, the cars that
  entered and left since the start, and over the last minute their speed,
  throughput and waiting time before they left, and the queue standing at
  the end of the roads. Junctions count cars that arrive there as entering
  and cars that start there as leaving.
- Show counts at roads and junctions in the panel labels each road and
  junction in view with the cars there now (now), on their way there
  (exp), and that entered (in) and left (out) since the start, live while
  the cars drive and the network changes. The labels are placed next to
  their road or, with a line, their junction where they overlap no road,
  junction, traffic light or other label, and are hidden when more than
  400 roads and junctions are in view.
- The layers in the panel are shown and hidden each on its own, in any
  combination, from the bottom up: Map background (for towns, see
  [Map Background](#map-background)), Roads and junctions, Traffic light
  heads and Vehicles. All are on by default except the heads of the
  traffic lights, as the stop bars of the traffic lights, which are always
  shown, also on the map without the roads, show the phases on the road.
  The simulation runs on exactly as before whatever is shown,
  with its statistics, counts and density, and a hidden layer is not
  painted, which saves the time of painting it (Zurich with all streets
  and 1,000 cars at 10x: 11 frames per second with all layers, 47 with
  only the map and the vehicles, in Chrome without a GPU). Hidden roads
  and junctions cannot be clicked or selected, also not with a rectangle,
  and the selection ends; shown, they are clicked, selected and edited as
  usual, also on the map. The traffic lights keep switching whether their
  heads are shown or not (the small symbol in the middle of the junction
  belongs to the roads). With hidden vehicles, clicks go to
  the roads under them and a vehicle that is followed is let go. On again,
  each layer shows the state of now. Like the other display settings, the
  layers are not kept when the page reloads. Map opacity below Map
  background fades the map, see [Map Background](#map-background), and
  Road opacity below Roads and junctions fades the roads and junctions in
  the same way, from 100 %, the default, to 0 % in steps of 5 %, also with
  the arrow keys, while it is dragged, so that the map shows through them
  while the vehicles, the stop bars, the heads of the traffic lights, the
  route of a followed vehicle and the selection stay opaque. It changes no
  style of the diagram, so the file is not changed and there is nothing to
  undo, and it stays through edits, other towns and examples and a switch
  of the theme. Like the map opacity, the browser keeps it across reloads,
  and it is disabled while the roads are hidden. Each cell that draw.io
  draws (roads, junctions, roundabouts and also other shapes and texts) is
  faded on its own, as an opacity of the whole drawing made the browser
  paint all roads under each moving vehicle again, at a third of the frame
  rate; this way the frame rate stays the same (Zurich with main and
  collector roads, the map and 500 cars at 10x: 34 to 37 frames per second
  at 100, 50 and 0 %).
- Show density in the panel, off by default, colors each lane by its
  density, from green when it is free to red when vehicles take half of
  its cells (stop and go), so that a truck counts twice. The statistics
  show the density as the share of all cells that vehicles take; the
  other counts, the throughput and the queues count vehicles.
- Click a vehicle to follow it: a ring and a label with its type and speed
  drive along with it, its route is colored from its start A to its
  destination B, and the Vehicle section of the panel shows its data live:
  type, speed and top speed, start, destination, travel time, distance,
  waiting time, place and lane, the rest of its route and its reroutes. A
  click elsewhere ends it. Drags that start on a vehicle edit the diagram
  as usual, so that the network can change while the vehicle drives.
- Center selected car in the panel, off by default, moves the view with
  the followed vehicle. The view stays while the vehicle is in the middle
  half of it. When the vehicle gets closer to the edge, or is outside the
  view when centering starts, the view glides back until the vehicle is in
  the middle, also with the simulation paused, with a critically damped
  spring: it starts and stops softly, never overshoots, and smooths the
  steps, turns, lane changes and junctions of the vehicle. Vehicles that
  drive on keep the view gliding with them; the spring is stiffer the
  faster they are on the screen, so that they stay within the middle of
  the view (at most 0.4 of the view from it). Long glides cruise at up to
  about one and a half views per second. The map background moves in the
  same frame and stays on the roads. Zooming by hand keeps centering.
  Moving the view by hand (scroll wheel, scrollbars or panning) pauses it,
  as you want to look elsewhere, until you click the vehicle again or turn
  the checkbox off and on. It ends by itself when the vehicle arrives or
  leaves the network, or another click ends following it, and the view
  comes to rest. Like the other display settings, it is not kept when the
  page reloads. It costs no frame rate: Zurich with main and collector
  roads, the map and 500 cars at 10x and 150 % ran at 28 to 30 frames per
  second with centering and 29 without, in Chrome without a GPU.
- Roads are sharp, rounded or curved like connectors, in the format panel,
  the inline toolbar and the waypoints menu, and their lanes, markings and
  cars follow the waypoints and curves. Rounded corners of roads start at
  least as far from the corner as the road is wide.
- `maxSpeed=50` in the style of a road is its speed limit in km/h, as cells
  per step (rounded, at least 27 km/h). Without it, vehicles drive up to
  Max. speed.
- `highway=residential` in the style of a road is its class, as in
  OpenStreetMap, which keeps trucks on main roads (see [Trips](#trips)):
  `unclassified` roads are collector roads, `residential`, `living_street`
  and `service` roads minor streets, and all others (`motorway`, `trunk`,
  `primary`, `secondary`, `tertiary` and their links) main roads. Loaded
  towns have it on every road. Roads without it are minor streets if their
  speed limit is at most 30 km/h with one lane per direction, like the side
  streets of the Town example, else main roads.
- `gate=1` in the style of a junction makes it an entry and exit of the
  network: with Random trips, half of the cars start at a gate and half end
  at one, so that traffic flows in and out there, and the other trips use
  gates for through traffic and commuters from outside (see
  [Trips](#trips)). Loaded towns have gates where their roads leave the
  town.
- `center=1` in the style of a junction marks the centre of the network for
  the commuters of [Trips](#trips), and `homes=120` and `jobs=80` give it
  homes and jobs, as loaded towns have them, which offers the Zones trips.
- 1 unit is 1 meter and 1 step is 1 second.

Changes to the diagram take effect while the simulation is running. Cars on
removed roads leave, the others keep their routes or look for new ones.

## Model

Each lane is a row of cells of 7.5 m with the Nagel-Schreckenberg update:
accelerate, brake to the gap, dawdle, move. Vehicles have their own top
speed: trucks 2 cells per step below Max. speed, cars Max. speed and fast
cars 1 cell per step above it, with the shares of trucks and fast cars in
the panel, and at most the speed limit of the road. Vehicles have their
own length too: cars and fast cars take one cell and trucks two (15 m).
A vehicle moves with its head and keeps the cells of its length behind
it, so that the one behind brakes to the gap behind its tail: in its
lane, and while its tail is still in a crossing, a roundabout or the
last cell of the lane before, also there (a vehicle clears a lane, a
crossing or a roundabout only when its tail has). Lane changes, passing,
entering roads, crossings and roundabouts and the network rebuilt
while the cars drive all need room for the whole length. Faster
vehicles queue behind slower ones on roads with one lane and pass them
where there is a free lane. Vehicles are painted from above as a car of
4.5 m, a truck of 12.5 m with a cab and a trailer, and a sleeker fast
car of 4.8 m with a spoiler, each inside the cells it takes with a gap
of at least 1.5 m to the next, also where cells are shorter (short
roads, inner ring lanes, short curves through crossings), along their
lane, turned in their direction through curves, crossings, roundabouts
and lane changes, trucks from the cell of their head to the cell of
their tail, and in the color of their speed, as in the legend of the
panel. Zoomed out, they are painted larger so that cars stay 9 pixels
long, but only as long as fits in their cells (cars up to 6 m and
trucks up to 13.5 m, wider by half as much), so that they never overlap
down to about 65 % zoom; further out they keep at least 4 pixels for a
car and 9 for a truck, where vehicles in queues can touch. Colors in the
panel picks the set of colors from standing to the fastest vehicles:
Blue, violet, red (the default, from blue
when they stand over violet and magenta to red), Red, yellow, green (as on
traffic maps), Yellow to green, Blue to orange (colorblind-friendly, as it
changes only between blue and orange, which color vision deficiencies keep
apart) and Rainbow (blue, cyan, green, yellow, red). The set applies at
once to every vehicle, also while the simulation runs, and like the other
display settings it is not kept when the page reloads. With Adapt colors
to light/dark mode in the panel, on by default, roads and vehicles follow
the theme together: in light mode the road is lighter (#a3a8ad) and the
vehicles on it dark, with a contrast of at least 3:1 to the road at every
speed and 7.5:1 to white, so also on the light map with or without the
roads; in dark mode the road is darker (#3c4043) and the vehicles light,
at least 5:1 to the road, also on the inverted dark map. Yellow is ochre
and olive on the light road, as no yellow is dark enough for 3:1 there.
The sets in light mode / dark mode, with their least contrast to the road
of the mode:

| Set | Light mode on #a3a8ad | Dark mode on #3c4043 |
| --- | --- | --- |
| Blue, violet, red | #0040dd, #5b00f6, #9400a1, #a50060, #a91100 (3.15:1) | #71bfff, #baafff, #f993ff, #ff98ca, #ff9f8f (5.2:1) |
| Red, yellow, green | #a60000, #833d00, #5f5000, #375a05, #055e0c (3.3:1) | #ffb1b1, #ffb575, #e9c200, #85db0c, #0ce41e (5.9:1) |
| Yellow to green | #674b00, #525200, #345900, #025d02, #005b45 (3.4:1) | #fdb900, #cbcb00, #81dc00, #06e406, #00dfa8 (5.9:1) |
| Blue to orange | #003fd1, #1e518d, #515145, #6b4a13, #833d00 (3.3:1) | #acc5ff, #a9c8ed, #c5c5bb, #e8bf7a, #ffb575 (6.0:1) |
| Rainbow | #0022fc, #00586f, #085e1d, #595200, #a40b00 (3.3:1) | #b8c2ff, #32d6ff, #12e347, #dac700, #ffb1ac (5.6:1) |

Every set has at least 7.5:1 to white in light mode. The white markings
have 2.4:1 to the light road and 10:1 to the dark one, the stop bars are
darker on the light road (#d93025, #f29900, #188038), and the density
stripes are a bit more opaque on both, darker on the light road and
lighter on the dark one. Off, the road is the same mid-gray (#5f6368) in
both themes and the vehicles on it have the colors of dark mode, at least
3:1, and on the light map with the roads and junctions hidden the colors
of light mode, for the default set the earlier dark ones (#0d61ff,
#792cff, #b100bd, #c20080, #cb0e00), at least 5:1 to white. The colors are
light-dark pairs that the browser resolves for the theme of the editor, so
a change of the theme repaints nothing, and the legend follows the set,
the theme, the layers and the checkbox at once. The road of the theme
stands for the gray asphalt that the styles of roads and junctions have
(`light-dark(#5f6368,#5f6368)`), also in saved diagrams and loaded towns,
and other colors in their styles are kept. Like the other display
settings, the checkbox is not kept when the page reloads.

Cars keep their lane. They change to the next lane
when their lane does not allow their next turn, into smaller gaps closer
to the end, to the left to pass slower cars, and back to the right when
there is space, each only if the cells of their length are free there
and no car is close behind, and the cells that they leave stay taken
for that step, so that the car behind does not drive into them while
they move across. With Pass on
either side (US) in the panel, off by default, every lane is its own lane:
a blocked car passes on the left or the right, where the next lane has
more space (the left if both have as much), with the same checks and
turns, and stays in that lane, as nobody keeps right. The setting applies
at once and, like the others, is not kept when the page reloads. In
roundabouts, cars choose their ring lane by their exit under both rules,
and the passing through the oncoming lane below is the same too. With
Overtake in the oncoming lane in the panel, on by default, on roads with
one lane per direction, a car that is blocked by a slower vehicle, eg. a
truck, passes it through the oncoming lane, with a probability of 50 %
per step, one car per road at a time: only if the cell behind it and as
many cells ahead of the slower one as it is long and one more are free
(two for a car), if it can be past the whole length of the other while
accelerating to its top speed and back at least 8 cells (60 m) before the
end of the road (also before crossings, roundabouts and joints) and 20
(150 m) before a turn, and if no oncoming car at the top speed, or one that comes
from the end of the road, where the driver cannot see, can come within 3
cells meanwhile. While it passes, oncoming cars brake for it and the cars
behind it keep the cell behind it free, or behind the tail of the other
while it is beside it. It goes back to its lane as soon as it is ahead
of the other, and aborts and falls back in behind its tail if the
car ahead of the other leaves no space, an oncoming car or the end of
the road comes too near or it takes longer than 60 steps. Its lane changes
are painted like the others. Cars only pass where vehicles have different
top speeds, so not on roads whose speed limit is at or below the top
speed of trucks.
The panel counts the overtakes in the oncoming lane and those that were
aborted. Turned off, also while the simulation runs, no new passes start
and the cars that pass at that moment finish or abort their pass as
above; then the cars queue behind slower ones on these roads, with the
same steps and random draws as before there was overtaking, and the panel
leaves out the line of the overtakes. Like the others, the setting is not
kept when the page reloads. Crossings let
as many cars pass per step as their widest incoming road has lanes and
take the incoming roads in turns. Cars only pass from
lanes that allow their turn, unless they waited for 2 minutes, and drive
through crossings on a curve at one
cell per step (27 km/h) to a lane of the next road that suits their turn
and the turn after it, behind the tail of the car ahead on its way
there, and only if the cells of their length at the start of that lane
are free, so that they do not stay in the crossing. A car starts only
on a way that no other car in the crossing crosses, until the tail of
that car is past the place where their ways come closer than 3 m; cars
from other lanes merge into the same lane in turns if one of them is a
truck, and a car that waits for a crossing way has its turn before
others that would cross its way. So crossing cars take turns and never
drive through each other. Crossings of two roads without a traffic light are
joints in the road: the first car in a lane looks past the end of its road
into the next and drives through at its speed in all lanes, without the
turns of the lanes, and cars that start there wait for a gap. Roundabouts are rings of lanes of cells at one cell
per step; cars enter the outer lane when it is free before the entry and
was free at the start of the step, trucks also not while a truck leaves
at the exit next to them, move inward for exits far away and back out
before their exit, once their tail is in the ring, and leave where their
next road starts, with their tail in the ring until they drive on.
Vehicles start at the start of their first road with their whole length
in it. Cars drive from a random junction to another, half
of them from or to a gate if there are gates, on the fastest route under the current speeds with the turns that the lanes
allow (Dijkstra on the roads) and look for another route after waiting 60
seconds at a junction. Trucks do the same between junctions of main
roads and avoid other roads (see [Trips](#trips)). Cars that have not
arrived 5 minutes after they started, or four times the time of their route without other cars if that
is longer, leave the network, so that gridlocks can form and dissolve. The
statistics count them as not arrived, and the debug output lists them.

Cars in the panel takes 0 to 20,000 vehicles. Each network holds about a
quarter of its cells (7.5 m of each lane and of the rings of roundabouts)
in vehicles of the mix of the panel, where trucks take two cells: with
20 % of trucks about 0.25 × cells / 1.2, computed from the network when
it is opened, drawn or rebuilt. Beyond that, a car starts only where its
cells are free, so the further cars mostly wait to start while queues at
the junctions reach back. When Cars is more than that, a small hint below
it says "More than this network can hold (about N)"; the value still
applies. In short runs at 100x the vehicles on the roads levelled off
within about 40 % of the estimate, without a deadlock: Town (1,818
cells, about 380) 335, Small with a traffic light (467, about 97) 115,
Race (339, about 71) 53, Axhausen (4,984, about 1,000) 1,330 and rising,
Roundabout with five arms (802, about 170) 190, Grid with traffic lights
(1,248, about 260) 220, Bottleneck with a bypass (1,582, about 330) 240,
and Zug with all streets (21,571, about 4,500) 3,800 to 4,700.

The lengths and the turns in crossings cost throughput where vehicles
queue or cross often, as on real roads. Tested on 2026-10-29 with the same
random draws over 20 minutes after 5, in cars that arrived per hour and
their average speed, before vehicles had a length and now, and with cars
only (no trucks), which shows the turns in crossings alone:

| Network, cars, trucks | Before | Now | Cars only, before / now |
| --- | --- | --- | --- |
| Town, 60, 20 % (defaults) | 2,514, 38 km/h | 2,427, 38 km/h | |
| Town, 200, 50 % | 6,738, 33 km/h | 4,608, 23 km/h | 6,738 / 5,940 |
| Grid, 150, 50 % | 6,189, 43 km/h | 3,567, 27 km/h | 6,156 / 4,743 |
| Roundabout, 80, 50 % | 4,890, 55 km/h | 3,360, 37 km/h | 5,079 / 4,803 |
| Small, 100, 50 % | 2,934, 25 km/h | 2,319, 21 km/h | |
| Race, 60, 50 % | 2,817, 60 km/h | 2,577, 54 km/h | |
| Axhausen, 150, 50 % | 3,573, 77 km/h | 3,522, 75 km/h | |
| Bottleneck, 250, 50 % | 4,647, 31 km/h | 3,012, 23 km/h | |
| Zurich, main and collector, 500, 50 % | 2,520, 34 km/h | 2,397, 33 km/h | |
| Zurich, main and collector, 500, 20 % | 2,631, 34 km/h | 2,532, 33 km/h | |

In the Town all speed limits are at most the top speed of trucks, so
trucks used to drive exactly like cars there. Painted at their size
(300 %), no vehicles overlapped in these runs, except at the junction
where the bypass of the Bottleneck example meets the main road at a
sharp angle, so that the end of the bypass lies on the start of the main
road, and in Zurich, where vehicles side by side can touch where lanes
bend sharply near junctions and roads cross without a junction (bridges).
A step takes about 0.3 ms longer with 1,000 vehicles in Zurich and the
frame rate stays the same (35 to 36 frames per second with 500 vehicles,
half of them trucks, at 10x in Chrome without a GPU).

## Trips

Trips in the panel chooses where the vehicles start and end, on every
network. The choice applies at once to new vehicles, while the others keep
their trips, and the diagram keeps it: the attributes `trips` and
`throughShare` of the page (Edit Data on the background shows them), which
can be undone and are saved with the file. Copy Link adds `trips` and
`through` (in percent) to the link of a town when they are not its default,
and such a link opens the town with them in its file, so that they do not
mark it as changed and cannot be undone. The Vehicle section shows the trip of the followed vehicle, eg. "Local, home
→ work or shops", "Commuter from outside, gate → centre" or "Through
traffic, gate → gate". Show zones paints the homes in blue and the centre
or the jobs in orange, as circles with an area in proportion to their
weight, the gates as rings and the centre as a cross.

- **Random**, the default of drawn networks and the examples: random
  junctions as before; if there are gates, half of the cars start at one and
  half end at one, drawn on their own, so that three quarters of the trips
  touch a gate.
- **Commuters to the centre**: 65 % of the trips go from homes toward the
  centre and 35 % back. The centre is the junctions with `center=1`, else
  the most connected junctions: the mean of the junctions weighted by the
  square of their roads, twice for traffic lights and roundabouts. With R
  the distance of three quarters of the junctions from there and r that of a
  junction, it attracts in proportion to its roads × (e^−(r/0.45R)² + 0.05)
  and has homes in proportion to its roads × (0.2 + r/R, at most 1.4), so
  more toward the outskirts. 12 % of the trips start at a gate (commuters
  from outside) or end at one (leaving town), with the weight of the gate.
  The origin is drawn by its weight and the destination by its weight times
  the gravity factor (1 − e^−(d/0.2R)²) × e^−d/1.2R of the straight
  distance d, so that few trips are very short and fewer the longer they
  are.
- **Through traffic**: all trips go from one gate to another. Gates are the
  junctions with `gate=1`, else the dead ends in the outer part of the
  network (at least 0.6 of the largest distance from the centre), else its
  outermost tenth. A gate weighs its lanes × (speed limit / 50 km/h)^1.5,
  so main roads carry more, and a pair of gates the product × (0.05 +
  ((1 − cos θ) / 2)²) with θ the angle between them at the centre, so that
  most cross the network.
- **Commuters and through traffic**: both, with the share of through
  traffic of the slider below (25 % by default).
- **Zones (OpenStreetMap)**, offered and the default for towns with zones:
  the commuters of the gravity model between the homes and the jobs of the
  junctions from OpenStreetMap (see
  [Loading Your Town](#loading-your-town)), the jobs including shops,
  schools and other places, with the share of through traffic of the
  slider, and commuters from outside at the gates.

Tested on 2026-10-29 at 50x after 25 s, in percent of the cars within half
of R from the centre of the jobs (of the most connected junctions in the
Town example), on fast roads (60 km/h or more, or two lanes per
direction), and their average speed:

| Network, cars | Random | Commuters | Through | Commuters and through | Zones |
| --- | --- | --- | --- | --- | --- |
| Town, 60 | 34 %, 30 %, 39 km/h | 54 %, 11 %, 29 km/h | 22 %, 53 %, 46 km/h | 41 %, 26 %, 36 km/h | |
| Zug, all streets, 110 | 25 %, 6 %, 33 km/h | 43 %, 6 %, 31 km/h | 17 %, 11 %, 34 km/h | 28 %, 9 %, 33 km/h | 30 %, 6 %, 33 km/h |
| Zurich, main and collector, 460 | 36 %, 43 %, 34 km/h | 58 %, 44 %, 33 km/h | 31 %, 57 %, 33 km/h | 51 %, 47 %, 34 km/h | 51 %, 46 %, 34 km/h |

Commuters fill the roads toward the centre, through traffic the arterials,
motorways and the ring of the Town, and both mixed or the zones lie in
between. No mode jams where Random does not: 2 to 7 % of the cars stood,
except through traffic in Zurich at first, when all cars start at the
gates, and after 20 minutes 400 of 460 moved at 41 km/h, more than with
Random (33 to 39 km/h). The trips cost no frame rate (Zurich with 500 cars
at 10x: 38 frames per second in every mode).

Trucks keep to main roads in every mode, as through traffic and
deliveries, while cars keep their trips. They start and end only at
junctions and gates with a main road (see `highway` in
[Drawing Roads](#drawing-roads)), if the network has at least two of each,
and their route search counts the time on collector roads 1.5 times and on
minor streets 4 times, so that they take a side street only where it saves
much time, also when they look for another route after waiting and after
changes of the network. With Random, they drive between random junctions
and gates of main roads, half of them from or to a gate. In the other
modes, at least half of them are through traffic between gates of main
roads (all with Through traffic, and the share of the slider if it is
higher), and the others deliveries between a depot and the centre, or the
jobs with Zones, half of them each way: the depot is a gate of a main road
for half of them, else a junction of a main road, weighted toward the
outskirts, or by its jobs with Zones. The Vehicle section shows eg.
"Delivery, gate → centre" or "Delivery, depot → work or shops". In networks
of one class, such as the examples other than the Town, trucks drive like
cars.

Tested on 2026-10-29 with half of the vehicles trucks at 50x over 20
minutes (the Town 15), in percent of the km of trucks on minor streets
before and now (in Zurich with main and collector roads, which has no
minor streets, on collector roads):

| Network, vehicles | Random | Commuters | Through | Commuters and through | Zones |
| --- | --- | --- | --- | --- | --- |
| Zurich, all streets, 1,000 | 11.1 → 1.4 | 13.7 → 1.2 | 4.7 → 0.8 | 10.2 → 1.1 | |
| Zurich, main and collector, 500 | 1.1 → 0.4 | 1.4 → 0.2 | 0.1 → 0 | 0.8 → 0.2 | 1.1 → 0.1 |
| Bern, all streets, 700 | 11.1 → 0.9 | | | 11.1 → 0.3 | |
| Zug, all streets, 150 | 30.8 → 1.9 | 38.4 → 1.8 | | | |
| Town, 120 | 15.1 → 2.9 | 30.9 → 1.5 | 5.3 → 1.3 | 21.3 → 1.5 | |

With 30 % trucks, Zurich (all streets, Random) went from 11.8 to 1.5 % and
the Town (200 vehicles) from 17.7 to 3.4 %. Before, two thirds of the
trips of trucks in Zurich, Bern and Zug started or ended at a junction of
only minor streets, now none. Cars drive as before, a bit more on minor
streets where trucks fill the main roads (Zurich, all streets, Random:
10.7 and 11.7 % of their km, Zug 28 and 35 %). No vehicle got stuck and
about as many as before did not arrive in their lifetime (0 to 3 in the
towns, 0 to 29 in the examples, before 0 to 63), also over 40 minutes of
through traffic in Zurich and when a road was removed and the class of
another changed while they drove, without errors or warnings of the debug
output, in all examples too. Towns build
as fast, with files 3.6 % larger, and open and run as fast as before
(Zurich, main and collector, 500 vehicles at 10x: 33 frames per second,
all streets, 1,000 vehicles: 12.5).

## Examples

The Example menu under Network opens small networks that show what the
simulation does. All of them were built for this project, without map data
from elsewhere: Small, Race and Axhausen for the Java version, converted
from its `.net` files with `tools/net2drawio.py` (the Import button inserts
such files into the current diagram), and the others for the browser.

- **Town**, which opens when the page opens: a small town of 1.5 by 1 km
  with a main street at 50 km/h from a roundabout at its west end through
  a crossing with traffic lights (20 s of green) with Bahnhofstrasse, where
  both approaches of the main street have a left-turn lane, a quarter of
  side streets at 30 km/h on each side with a one-way pair in the old
  town, a curved lane and a dead end, and a bypass at 80 km/h around the
  south. Five entries with gates bring traffic in from the next villages,
  the station and the south. At 10x it runs at 60 frames per second, and
  it stays free with 60, 120 and 200 cars.
- **Small, with a traffic light**: 15 crossings of one-way roads around
  blocks, with a traffic light where three roads meet.
- **Race**: four one-way roads in a ring, where faster vehicles queue behind
  slower ones on one lane.
- **Axhausen**: 21 crossings of one-way and two-way roads over 6 km, where
  cars drive fast and take the fastest of several routes.
- **Roundabout with five arms**: a roundabout with two ring lanes where five
  roads meet, one of them with two lanes per direction. Cars give way to
  the ring, move to the inner lane for exits far away and back out before
  their exit.
- **Grid with traffic lights**: 4 by 4 junctions 200 m apart with traffic
  lights (15 s of green) at the four in the middle, one-way streets inside
  a two-way ring, and four entries with gates where half of the cars start
  or end, so that traffic crosses the grid.
- **Bottleneck with a bypass**: a road with two lanes per direction narrows
  to one lane at 30 km/h for 400 m, like roadworks (a main road with
  `highway=primary`, which trucks do not avoid like a side street), and a
  longer bypass at 50 km/h runs around it, with gates at both ends. Cars pick the route that
  is faster under the current speeds: with 60 cars fewer than 1 in 10 take
  the bypass, with 250 cars a queue stands before the lane drop and nearly
  1 in 3 do.

## Loading Your Town

Under Network, Load your town loads the roads of a town or city from
[OpenStreetMap](https://www.openstreetmap.org):

- Type the name: suggestions appear while typing, Enter or Search looks the
  name up. Pick the place from the matches if there are several, eg. for
  Springfield.
- A small map shows the town limits: the administrative boundary of the
  place, or for places without one (villages that are only a node) a circle
  of 0.3 to 5 km around the center by the kind of place, which the panel
  says. Click the map to load only a circle of 1 to 5 km (Section) around
  that point, or drag a rectangle.
- Roads chooses the road classes: Main roads (motorway, trunk, primary,
  secondary and tertiary roads with their links), Main and collector
  (also unclassified roads) or All streets (also residential streets and
  living streets). Footways, cycleways, paths, service roads, areas and
  roads without access for cars are never loaded. Towns with up to about
  3,000 junctions of all streets get all streets, larger ones main and
  collector roads, and the largest main roads.
- The panel estimates the junctions from the area and the population.
  Above 4,000 junctions it warns, above twice as many it does not load:
  choose main roads or a section. After loading, networks with more than
  4,000 junctions or 6,000 roads are not opened either, with their size;
  a section or fewer roads are then built from the loaded roads without
  loading again. The limits keep towns fast (see the tests below).
- Load shows its progress (the server, the MB loaded, the seconds) with a
  Cancel button in the panel and in a card over the diagram, like a link
  (see below), builds the network and opens it, and sets Cars for its
  size (1 per 1.5 km of lanes, 100 to 1,500). Copy Link copies a link to
  the town, which opens it at start. The town stays in the URL until an
  example or another town is opened, or a file in draw.io (File > Open,
  New), which also cancels a town that is still loading, so that a reload
  does not open the town again.
- If the diagram has unsaved changes, Load, Load again and the Example
  menu ask at once to discard them, before anything is loaded, and Cancel
  or Escape leaves the diagram and the panel as they were. The diagram is
  replaced only once the new network is loaded and built, without asking
  again: if loading fails, times out, finds no roads or is cancelled, the
  diagram stays with its changes, which draw.io still shows as unsaved,
  and the card shows the error. Of loads started one after the other only
  the last replaces the diagram, and one started while the question is
  open takes the place of the one it was asked for. It asks again only if
  the diagram was changed while the town loaded.
- Loaded towns are kept in the browser (IndexedDB) with the date and the
  query, the 12 last, so that a reload or a link opens them without
  loading again, also a section of a loaded town. Load again loads the
  roads of a cached town again.
- The zones for the Zones trips come with the roads in the same query and
  are cached with them: land use areas (residential, commercial and
  retail, industrial) with only their bounding boxes, and the positions of
  shops, offices and amenities where people work, learn, shop or go out
  (schools, universities, hospitals, doctors, restaurants, cafés, bars,
  cinemas, theatres, banks, pharmacies, post offices, libraries and
  others). The junctions of the town other than its gates get homes for 40
  per hectare of residential land and jobs for 60 per hectare of commercial
  and retail land, 25 of industrial land and 8 per place (`homes` and
  `jobs` in their style): an area fills 60 % of its bounding box and is
  shared by the junctions in it, else goes to the nearest junction within
  300 m, like a place. Towns that were cached before zones get them with
  one query of their own when they open, which waits at most 20 s per
  server; without an answer the town opens without zones and tries again a
  day later. Zurich (main and collector) has
  266 land use areas and 8,371 places, Zug 30 and 580; the zones add 13 ms
  to the build of Zurich (25 to 38 ms) and 2 % to its file.

### Map Background

Towns show the map of OpenStreetMap behind their roads, so that the cars
drive on the streets of the map. Map background in the panel, the bottom
layer, turns it on and off like the other layers: on, the map is behind
the diagram, and the roads and junctions, the traffic lights and the
vehicles show on it as their layers are set, eg. only the vehicles on the
map, or the roads on the map, where they are clicked, selected and edited
as without it; off, there is no map, as in the examples. The density, the
counts and the selection show either way. It is on by default for towns.
The examples have no real coordinates, so the checkbox is disabled for
them and for other diagrams. The notice of OpenStreetMap shows while a
town is open, with the map and without.

Map opacity, the slider below the checkbox, fades the map from 100 %, the
default, to 0 %, where only the background of the diagram is left, as
with the map off, in steps of 5 %, also with the arrow keys, in light and
in dark mode, where the map is inverted first. The map changes while the
slider is dragged, without loading tiles. Unlike the layers, the browser
keeps the opacity across reloads, for all towns. The slider is disabled
while the map is off or the diagram has none. Road opacity fades the roads
on the map in the same way (see the layers in
[Drawing Roads](#drawing-roads)).

The map is a live layer of tiles behind the transparent canvas of draw.io
(`js/map.js`), placed again at each change of the zoom, the scroll and the
pan, also during the zoom preview of draw.io, so that it stays on the roads
and sharp at all zoom levels: it uses the tiles of the next finer zoom
level, or of the coarser one while it is less than a quarter of a level
away, up to zoom 19, which are scaled by 0.6 to 1.19. In dark mode the
tiles are inverted. The tiles are in a pane with the filter of dark mode
and the opacity of the slider, over the background color of the diagram.
Towns are built in Web Mercator like the tiles, with one scale per town,
and the text with the attribution keeps the Mercator meters of the origin
of the diagram and the scale (`mercator`), so that saved towns get their
map too.

The tiles come from tile.openstreetmap.org, which allows light use under
its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/):
the map shows "© OpenStreetMap contributors" with a link, only the tiles in
view are loaded, nothing is loaded ahead, the tiles of the last zoom level
stay only until the new ones are loaded, and the page keeps no tiles, the
browser caches them as their HTTP headers allow. For more than light use,
or another style, set another tile server in the URL: `tiles=<URL>` with
`{z}`, `{x}` and `{y}` (and `{s}` for `a`), `tileMaxZoom=<zoom>` (19) and
`tileAttribution=<text>` for the credit the server asks for, which the map
shows after the one of OpenStreetMap, eg.
`?tiles=https://tiles.example.org/{z}/{x}/{y}.png&tileAttribution=Example%20Maps`.
The small map of the panel uses the same tiles.

The URL of the page has the town: `?city=Zürich` looks the name up and
opens the first match, `?osm=relation/1682248` opens that place of
OpenStreetMap (`node/`, `way/` or `relation/`), which links use with the
name. `roads=main`, `collector` or `all` sets the roads, `circle=<lat>,<lon>,<m>`
or `bbox=<south>,<west>,<north>,<east>` the section, eg.
`?city=Los%20Angeles&osm=relation/207359&roads=main&circle=34.05,-118.25,5000`.
From the start of the page until the town is drawn and the cars can start,
a card over the diagram (at the bottom of the screen on phones) shows a
spinner with "Loading Los Angeles…", with the name of the link and then of
the place that was found, and below it the step that the panel shows, eg.
"Starting the editor…", "Finding Los Angeles…" or "Loading the roads from
overpass-api.de: 2.1 MB… 9 s", with Cancel. Screen readers read the card
(`role="status"`) but not the steps that change every second, which the
panel reads. Errors, eg. no place of the name or the id, no answer from the
Overpass servers or no roads to load, turn the card into the error with
Dismiss (or Escape) and are shown in the panel too. When the town could not
be found or loaded, the Town example opens behind it. The card covers only
itself, not the diagram or the panel.

The network is built like `tools/net2drawio.py` builds the examples, in
Web Mercator like the map tiles, scaled by the cosine of the latitude of
the center of the town so that 1 unit is 1 m there (lengths 10 km to the
north or south are about 0.2 % off at the latitude of Zurich), with north
at the top, and with lanes 3.5 m wide like on the streets of the map:

- Junctions are the nodes where three or more roads meet and the ends of
  roads. A node that only joins two roads, with one way in and one way
  out, is never a junction: the chain of ways and nodes between two
  junctions is one road with the shape of the ways as its waypoints,
  simplified to 4 m, so that the network stays as small as the junctions
  allow. Where the lanes, the speed or the class change along the chain,
  the road keeps the lanes and the class of its longer part and the speed
  of the time to drive all of it. Only a node where two one-way roads meet
  head on, which no traffic can pass, stays the end of both. Roads that come back to the
  same junction without another junction on them are dropped, as cars
  cannot use them.
- Roads keep their class (`highway`, for the trucks), `oneway` (also
  implied on motorways and roundabouts, and `-1`),
  the lanes per direction from `lanes`, `lanes:forward` and
  `lanes:backward` without bus and center lanes (1 to 4, one-way motorways
  and trunk roads 2 by default, others 1 per direction) and `maxspeed` (also
  `mph`, `none`, `walk` and zones such as `CH:urban`, else 120 km/h on
  motorways, 80 on their links, 100 on trunk roads, 10 on living streets and
  50 on the others) as `maxSpeed`.
- Closed rings of `junction=roundabout` become roundabouts, with their roads
  connected to them. Junctions of three or more roads with
  `highway=traffic_signals` on them or on a road to them within 45 m are
  traffic lights.
- Junctions joined by roads shorter than 20 m become one junction in their
  middle, at most 40 m wide, eg. the crossings of dual carriageways, and
  their roads keep their old ends as waypoints. The carriageways of dual
  roads stay one-way roads, so that cars drive on them on the map.
- Roads are cut where they leave the town, 25 m outside the boundary so
  that roads along it stay whole, or the section, and the cut ends are
  gates. Parts that are not connected to the rest with fewer roads than 1 %
  of all, at least 5 and at most 50, are dropped, and so are dead ends
  shorter than 20 m.
- The text below the network credits OpenStreetMap with the date of the
  data and links to its copyright page, and while a town is open, the
  bottom right corner of the diagram shows "© OpenStreetMap contributors,
  ODbL" with links at all zoom levels.

Traffic drives on the right in all towns, and turn lanes are not loaded.

Tested on 2026-10-29 in Chrome without a GPU, at 10x with Show density
and the heads of the traffic lights, in frames per second with all layers, with only the map and the vehicles,
and with all layers but the map, in light mode (dark mode is the same
within a few frames per second):

| Town | Junctions | Roads | Cars | Opens in | All layers | Map and vehicles | Without map |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Zug, all streets | 409 | 519 | 120 | 0.4 s | 60 | 60 | 60 |
| Zurich, main and collector | 928 | 1,462 | 500 | 1.1 s | 30 | 60 | 30 |
| Zurich, all streets | 3,864 | 5,719 | 1,000 | 3.1 s | 11 | 47 | 13 |
| Los Angeles, 14 by 20 km, main and collector | 3,238 | 5,139 | 600 | 4.1 s | 7.5 | 50 | 8 |
| Los Angeles, 15 by 21 km, main and collector | 3,722 | 5,872 | 800 | 4.6 s | 6 | 40 | 7 |

Bern (all streets) has 2,002 junctions and 161 traffic lights. Without
the map, sections of Los Angeles with 4,679 junctions and 7,316 roads ran
at 7 frames per second and with 7,409 junctions and 11,548 roads at 4 and
took 7.9 s to open, which is why the limits are 4,000 junctions and 6,000
roads. All of Los Angeles is not loaded: its main roads alone have 7,899
junctions and 12,565 roads. The towns are built in 0.1 s (Zurich) to
1.5 s (Los Angeles) after loading. The map stays on the junctions within
a pixel at zoom levels from 3 % to 1,200 % and during the zoom preview
(median 0.2 to 0.6 pixels in Zug and Zurich), except for junctions that
were made of several close crossings, which are up to 10 m off theirs.

`tools/osm2drawio.js` builds the same network in Node from saved answers of
Nominatim and Overpass, eg. for new examples or tests:

```bash
node tools/osm2drawio.js --roads all --query lookup.json   # prints the Overpass query
node tools/osm2drawio.js --roads all lookup.json overpass.json town.drawio
```

### OpenStreetMap Data

The browser loads all data directly, as all services send
`Access-Control-Allow-Origin: *` and the requests need no preflight
(Overpass gets a form-encoded POST). As of October 2026:

- **Nominatim** (nominatim.openstreetmap.org) finds the town on submit
  (`featureType=settlement`, without states and countries) and returns its
  boundary (`lookup` with `polygon_geojson=1` and `polygon_threshold=0.0001`,
  about 10 m, 250 to 1,300 points for Zug, Zurich, Berlin and Los
  Angeles). Its [policy](https://operations.osmfoundation.org/policies/nominatim/)
  allows at most one request per second, which the page keeps, and no
  autocomplete; browsers identify the site with the Referer. Results and
  boundaries are cached.
- **Photon** (photon.komoot.io) suggests places while typing, from 3
  characters and 350 ms after the last key, under fair use.
- **Overpass API** loads the roads: the ways of the road classes in the
  bounding box of the town or section with their tags and nodes, the
  coordinates of the nodes and the nodes with traffic signals
  (`[timeout:180]`, the default of Overpass, `out body qt` and `out skel qt`),
  and in the same query the zones, each kind after a marker element
  (`make zone kind=...`): land use areas with `out ids bb qt` and places
  with `out ids center qt`, without tags or geometry, about 0.4 MB more for
  Zurich (6.3 MB, 48 s on 2026-10-29, mostly waiting for a busy server).
  A bounding box is faster for the servers than an area filter and the page
  needs the boundary to cut the roads anyway. Overpass answers runtime
  errors such as timeouts with status 200 and a `remark`, a full server with
  502, 503 or 504 and too many queries of the same address with 429. The
  page tries overpass-api.de, maps.mail.ru and overpass.private.coffee in turn,
  starting with the last that answered, waits up to 60 s for data from
  each, and after a pause of 10 s tries all again with 120 s, then reports
  the errors. Measured on 2026-10-29: Zug (all streets) 42 s and 1.6 MB,
  Bern (all streets) 33 to 39 s and 6.8 MB, Zurich (main and collector)
  33 s and 5.9 MB, (all streets) 36 s and 12 MB, and Los Angeles (main and
  collector) 40 s and 62 MB; overpass-api.de often answered 502 at
  capacity, overpass.private.coffee often not within 200 s and maps.mail.ru
  sometimes 504 after 50 s. A count query took 36 to 78 s, as long as
  loading the roads, so the size is estimated instead.
  overpass.osm.jp (certificate), overpass.kumi.systems and
  overpass.openstreetmap.ru (no answer) are not used, nor
  overpass.openstreetmap.fr, which answers fast with data from August 2026
  but whose wiki page says it stopped in 2022 and which refuses headless
  browsers as not "white-listed".
- **Tiles** of the small map and the map background come from
  tile.openstreetmap.org or the tile server of `tiles`, see
  [Map Background](#map-background).
- The data is © OpenStreetMap contributors under the
  [ODbL](https://www.openstreetmap.org/copyright). The panel, the small
  map, the corner of the diagram and the text in each loaded network say
  so.

[anvaka/city-roads](https://github.com/anvaka/city-roads) also loads whole
cities in the browser: it looks the name up with Nominatim, queries
`way[highway](area)` with `out skel` from the area of the boundary on one
server and the next on errors, without paging or a pause, and keeps the
roads as lines. Here the roads become a network for the simulation, with
the limits of the town, a section and the road classes to keep it small.

## Running Locally

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/alderg/traffic.git
cd traffic
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Debugging

Debug output is off by default. `?dev=1` or `?test=1` in the URL or the
Debug output checkbox in the panel turns it on; the checkbox does not
change the URL and, like the other display settings, is not kept when the
page reloads, and an old `?dev=0` is removed from the URL when the page
loads. All errors of the page, the editor and the simulation are logged with their
stack, also the errors that draw.io catches and shows in a dialog
(`EditorUi.handleError`, also for uncaught errors). Once a second, the
simulation writes a summary (cars driving, moving and standing, average
speed, overtakes in the oncoming lane and why they were aborted, steps and
time per step), the links and junctions with cars, the
cars that stand for 10 seconds or more with their place and the events of
the last second (spawns, lane changes, overtakes in the oncoming lane and
how they end, crossings, roundabouts, arrivals, reroutes, phases) with the type of the vehicles and their number and
average speed per type to the console, and a warning with the junctions when no
car moves. Each step it checks the cars that pass through the oncoming lane
and warns if one shares its cell with an oncoming car, is at the end of its
road or passes for longer than 60 steps, and it warns if the tail of a
truck found a cell taken, which must not happen (tailConflicts in the
summary). `?dev=1` or `?test=1` also passes `test=1` to the editor, which
then writes its own debug messages and has a Develop menu.

## How It Works

- `index.html`, `css/app.css` and `js/app.js` are the page. draw.io runs in
  an iframe on the same origin, served from the `drawio` submodule. The page
  gets the editor with `Draw.loadPlugin` and loads `js/roads.js`,
  `js/simulation.js` and `js/map.js` into the window of the editor. The editor starts in the
  Simple theme with the shapes and format panels closed (`ui=simple`,
  `sidebar=0`, `format=0`), and the View menu opens them. It follows the
  dark mode of the system (`dark=auto`), like the page. The tab on the edge
  of the panel of the page hides it.
- Each titled part of the panel is a section with `data-fold="<name>"`, a
  title `<h2>` with a button of class `fold` with the chevron and
  `aria-controls` of its body of class `fold-body`, and `data-folded="true"`
  if it starts folded (`initFolding` in `js/app.js`, which keeps the state
  in localStorage as `traffic-folded`). New sections of the panel, eg. for
  further settings, follow this pattern, and code that shows progress or
  errors in a folded section unfolds it with `setFolded(name, false)`.
- `css/app.css` has one visual system for the panel: color tokens for both
  themes (`--panel`, `--surface`, `--text`, `--label`, `--muted`, `--border`,
  `--separator`, `--accent`, `--focus`), 13 px text, one control height
  (`--control-height`, 28 px), and a grid of a label column
  (`--label-width`) and a control column for rows (`<label class="row">`
  with a `<span>` and the control), the legend, the statistics and the data
  of the vehicle, with tabular figures for numbers. Checkboxes are rows of
  class `check`, hints `hint` (`check-hint` under a checkbox), sliders
  `range` with their `output`, and buttons `primary` or plain. The
  statistics are rows of a name and a value with the text and line breaks of
  their lines. New controls use these classes, so that they look and work
  like the others, with `:focus-visible` for the keyboard.
- The favicon shows whether the simulation runs: a traffic light with the
  green lamp lit while the cars drive and the red one while they are
  paused (`img/favicon-running.svg` and `img/favicon-paused.svg`, with PNGs
  of 32 pixels for browsers without SVG favicons). `js/app.js` switches it
  with the state that the simulation reports, like the Start and Pause
  button, so that it follows every start and stop. The editor in its frame
  keeps its icon to itself.
- `js/roads.js` registers the road and roundabout shapes, which paint
  asphalt with edge lines, lane dividers, center lines, arrows on one-way
  roads and stop and give-way lines, and replaces the shape libraries with
  palettes of junctions and roads. Crossings with roads are painted as the
  asphalt between the ends of their roads with rounded corners and edge
  lines, traffic lights a bit wider with a small icon. Junctions have no
  fixed connection points, roads connect to their outline. Waypoints of
  roads inside the junction at either end are skipped in the points of the
  view (`hiddenPoints` of the edge state, which lie on the point before
  them, with their handles hidden), so that the shapes and the network of
  the simulation, which both read these points, enter the junction from the
  first waypoint outside, while the diagram keeps the waypoints. It
  connects the ends of roads that are dropped on junctions. Other draw.io
  apps paint roads as plain connectors.
- `js/osm.js` finds towns, loads and caches their roads and zones from
  OpenStreetMap and builds their networks as draw.io files, with the homes
  and jobs of the zones on their junctions, which the page opens like the
  examples (see [Loading Your Town](#loading-your-town)). It runs in the
  page, not in the editor, and in Node for `tools/osm2drawio.js`.
- `confirmLoad` in `js/app.js` asks to discard unsaved changes when a town
  or an example starts to load (see [Loading Your Town](#loading-your-town)),
  and `openFile` opens it once it has loaded if no newer load started, with
  `EditorUi.fileLoaded`, and fits it while the shapes are drawn into a
  copy of the draw pane outside of the document, which then replaces the
  pane (`drawOutsideDocument`). The document changes once instead of
  230,000 times for Northampton (3,565 junctions), whose 89,676 SVG
  elements are drawn twice, once to open and once to fit. Mutation
  observers get all changes of a task in one call, and content scripts of
  browser extensions that watch pages failed on that many with "Maximum
  call stack size exceeded". It also opens faster: 1.7 instead of 2.4 s in
  `fileLoaded` for Northampton on 2026-10-29, with the same drawing.
- `js/map.js` runs in the editor and shows the map and the notice of
  OpenStreetMap behind and on towns (see [Map Background](#map-background)).
- `js/simulation.js` builds the network from the cells of the current page,
  runs the model and paints the vehicles, the density of the lanes and the
  traffic lights into the overlay pane of the graph. Each vehicle is one
  path with the outline of its type and the windows cut out, at its place
  and turned in its direction, filled with the color of its speed, and
  shortened where its cells are shorter. Trucks are painted between the
  point of their head, which moves along its way like the cars, and the
  cell of their tail, which moves straight from where it was in the step.
  The outlines are made once per type, degree and length, as a new path
  paints faster than a new transform. Vehicles are in each cell that they
  take, in the cells of lanes and rings, with their tail also in the last
  cell of the lane before a crossing or in the ring where it left
  (`setTail`), so that every check of a free cell sees their length, and
  the ways through each crossing are made once with the ways that they
  touch (`Crossing.getWay`). It never changes the diagram, except for imports
  and the trips of a page that the panel sets. New cars get their trips
  from `pickTrip` with the weights of `buildTrips`, made once per network,
  by binary search in cumulative weights and the gravity factor by
  rejection, so that a trip costs as little as a random one and the route
  search after it. Trucks (`main` of their type) get theirs from the same
  model with only the junctions and gates of main roads (`getMain`), and
  their route search multiplies the cost of each link by the factor of its
  class (`getRoadClass`, `mainCosts`).
  Each color set of the speeds (`colorSets`) has stops for light mode
  against the road of light mode (#a3a8ad) and for dark mode against the
  road of dark mode (#3c4043), each at least 3:1 at every step, which
  become light-dark pairs; without Adapt colors, both are the stops of dark
  mode on the gray road, at least 3:1 to it too, except on the light map
  without the roads (the stops of light mode, or `map`). Further sets
  follow this pattern. The stop bars are always in the overlay, above the
  map and the roads, the heads of the traffic lights with the Traffic
  light heads layer.
- `drawio` is [jgraph/drawio](https://github.com/jgraph/drawio) at a release
  tag, without history. To update it by hand:

  ```bash
  git -C drawio fetch --depth 1 origin tag v32.6.1
  git -C drawio checkout v32.6.1
  git add drawio
  git commit -m "Update draw.io to v32.6.1"
  ```

- `.github/workflows/update-drawio.yml` keeps it on the latest release of
  jgraph/drawio, daily at 08:00 UTC, and only ever moves it forward: it
  updates only if the submodule is at an older release tag, so a newer
  version or a commit that is no release, set by hand, stays. The job
  `check` finds the release, the job `test` fetches only its tag into the
  submodule, checks that the files the page loads from draw.io are there
  and opens the page with `tools/smoke-test.js` (headless Chrome: the editor
  starts, the simulation attaches, the Town example opens and cars drive,
  without errors). Both have a read-only token that is not kept in the
  checkout, as they run code from outside: the release and the npm
  packages of the test. Only the job `update` can write, and it runs none
  of that: it points the submodule at the tested commit on the latest
  `main` without checking it out, if `main` still has the commit that was
  checked, commits "Update draw.io to <tag>" as github-actions[bot] and
  pushes it. Pushes with the `GITHUB_TOKEN` start no workflows, so it then
  starts `pages.yml` with `gh workflow run`. Actions are pinned by commit.
  One run at a time; GitHub keeps one more waiting and replaces it with a
  newer one. Start it by hand, also for a given tag, or as a dry run that
  checks and tests the release but commits nothing, with:

  ```bash
  gh workflow run update-drawio.yml
  gh workflow run update-drawio.yml -f tag=v32.6.1
  gh workflow run update-drawio.yml -f dry_run=true
  ```

  The smoke test runs locally against a served checkout:

  ```bash
  python3 -m http.server 8000 &
  npm install --no-save --prefix /tmp/smoke playwright-core@1.61.1
  NODE_PATH=/tmp/smoke/node_modules node tools/smoke-test.js http://localhost:8000/index.html
  ```

- `.github/workflows/pages.yml` publishes the page (`index.html`, `css`,
  `img`, `js` and `data`) and `drawio/src/main/webapp` to GitHub Pages on each push to `main` and when
  it is started (`workflow_dispatch`), eg. by the update of draw.io.

## License

Apache 2.0, like draw.io.
