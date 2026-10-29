# Traffic Simulation

Cars driving on a road network that you draw in [draw.io](https://www.drawio.com).
Try it at https://www.alderg.com/traffic/.

This is a port of sim.traffic, a traffic simulation written in Java at ETH
Zurich in 2000, to the browser. The road network is a draw.io diagram, so
you can draw, edit, open and save it with the full editor while the cars
are driving.

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
  by 3 seconds of yellow. The lights show their state while the simulation
  runs.
- A roundabout (`shape=roundabout`) is a ring road where traffic circulates
  counterclockwise, with 1 to 3 lanes (`lanes`). Cars give way to the ring
  when they enter.
- Free ends of roads join the junction they are on or other free ends
  nearby, else cars can start and end there.
- The Selection section of the panel shows the selected junctions and
  roads: the type of junctions (crossing, traffic light, roundabout), the
  green time of traffic lights with their cycle, the lanes of roundabouts,
  the lanes per direction and direction of roads, and for one road each
  lane with its direction and turns. Changes apply at once, also while
  cars are driving, and can be undone.
- 1 unit is 1 meter and 1 step is 1 second. Curved connectors and
  waypoints are followed.

Changes to the diagram take effect while the simulation is running. Cars on
removed roads leave, the others keep their routes or look for new ones.

## Model

Each lane is a row of cells of 7.5 m with the Nagel-Schreckenberg update:
accelerate, brake to the gap, dawdle, move. Cars keep their lane. They
change to the next lane when their lane does not allow their next turn,
into smaller gaps closer to the end, to the left to pass slower cars, and
back to the right when there is space, each only if no car is close behind
there. Crossings let as many cars pass per step as their widest incoming
road has lanes and take the incoming roads in turns. Cars only pass from
lanes that allow their turn and drive through crossings on a curve at one
cell per step (27 km/h) to a lane of the next road that suits their turn
and the turn after it. Roundabouts are rings of lanes of cells at one cell
per step; cars enter the outer lane when it is free before the entry, move
inward for exits far away and back out before their exit, and leave where
their next road starts. Cars drive from a random junction to another on
the fastest route under the current speeds with the turns that the lanes
allow (Dijkstra on the roads) and look for another route after waiting 60
seconds at a junction.

The examples are the networks of the Java version: Small, Race, Axhausen and
Portland (8548 crossings). `tools/net2drawio.py` converts its `.net` files,
and the Import button inserts them into the current diagram.

## Running Locally

```bash
git clone --recurse-submodules --shallow-submodules https://github.com/alderg/traffic.git
cd traffic
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How It Works

- `index.html`, `css/app.css` and `js/app.js` are the page. draw.io runs in
  an iframe on the same origin, served from the `drawio` submodule. The page
  gets the editor with `Draw.loadPlugin` and loads `js/roads.js` and
  `js/simulation.js` into the window of the editor. The editor starts in the
  Simple theme with the shapes and format panels closed (`ui=simple`,
  `sidebar=0`, `format=0`), and the View menu opens them. It follows the
  dark mode of the system (`dark=auto`), like the page. The tab on the edge
  of the panel of the page hides it.
- `js/roads.js` registers the road and roundabout shapes, which paint
  asphalt with edge lines, lane dividers, center lines, arrows on one-way
  roads and stop and give-way lines, and replaces the shape libraries with
  palettes of junctions and roads. Crossings with roads are painted as the
  asphalt between the ends of their roads with rounded corners and edge
  lines, traffic lights a bit wider with a small icon. Junctions have no
  fixed connection points, roads connect to their outline. It connects the ends of
  roads that are dropped on junctions. Other draw.io apps paint roads as
  plain connectors.
- `js/simulation.js` builds the network from the cells of the current page,
  runs the model and paints the cars, the density of the lanes and the
  traffic lights into the overlay pane of the graph. It never changes the
  diagram, except for imports.
- `drawio` is [jgraph/drawio](https://github.com/jgraph/drawio) at a release
  tag. To update it:

  ```bash
  git -C drawio fetch --depth 1 origin tag v32.6.2
  git -C drawio checkout v32.6.2
  git add drawio
  git commit -m "Updates draw.io to 32.6.2"
  ```

- `.github/workflows/pages.yml` publishes the page and
  `drawio/src/main/webapp` to GitHub Pages on each push to `main`.

## License

Apache 2.0, like draw.io.
