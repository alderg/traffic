# Traffic Simulation

Cars driving on a road network that you draw in [draw.io](https://www.drawio.com).
Try it at https://www.alderg.com/traffic/.

This is a port of sim.traffic, a traffic simulation written in Java at ETH
Zurich in 2000, to the browser. The road network is a draw.io diagram, so
you can draw, edit, open and save it with the full editor while the cars
are driving.

## Drawing Roads

- Shapes are crossings, connectors between them are roads.
- A connector with one arrow is a one-way road in the direction of the
  arrow. One with no or two arrows is a road in both directions, with a lane
  on the right of each direction.
- Add `trafficLight=10` to the style of a shape (Edit Style) for a traffic
  light that gives green to one approach axis at a time for 10 seconds.
- 1 unit is 1 meter and 1 step is 1 second. Curved connectors and
  waypoints are followed.

Changes to the diagram take effect while the simulation is running. Cars on
removed roads leave, the others keep their routes or look for new ones.

## Model

Each lane is a row of cells of 7.5 m with the Nagel-Schreckenberg update:
accelerate, brake to the gap, dawdle, move. Crossings let one car per step
pass and take the incoming lanes in turns. Cars drive from a random crossing
to another on the fastest route under the current speeds (Dijkstra) and look
for another route after waiting 60 seconds at a crossing.

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
  gets the editor with `Draw.loadPlugin` and loads `js/simulation.js` into
  the window of the editor.
- `js/simulation.js` builds the network from the cells of the current page,
  runs the model and paints the cars into the overlay pane of the graph. It
  never changes the diagram, except for imports.
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
