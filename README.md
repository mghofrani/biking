# Train & Trail

**Melbourne bike rides with a train at each end.** Put your bike on a train, ride a trail, and catch a different train home.

Live site: https://mghofrani.github.io/biking/

The map shows Melbourne's bike trails and the metro train network together. Pick where you're starting and where you want to finish (from the list, "near me", or by tapping the map). Then choose how far out the first train should take you (**Nearby** 4–25 min, **Suburbs** 25–45 min, **Far out** 45–80 min) and how far you want to ride. Every suggestion has the same shape: **train out → ride one or more trails → train home**. For example:

> Train Anzac → Hughesdale (Pakenham/Cranbourne line, 17 min) · ride 17 km on Station Trail › Gardiners Creek › Anniversary Trail › Darebin Creek Trail · train Alphington → Flinders Street (Hurstbridge line, 19 min)

On the map, the chosen ride's train legs are drawn as railway track in each line's colour, and the bike route in orange. Small train and bike icons travel along each leg in the direction you'll go. With "reduce motion" turned on in the phone's settings, the icons stay still.

Each ride can be opened in Google Maps (cycling directions) or downloaded as a GPX file for Strava, Komoot or a bike computer. The URL holds the current ride, so you can share it.

- **Your location:** the target button on the map shows a blue dot that follows you, with a ring for GPS accuracy. **Near me** picks your closest station.
- **Install as an app:** on Android Chrome, open the menu (⋮) and choose **Install app** (or "Add to Home screen" on iPhone Safari). It opens full screen like an app, and pages you've already loaded keep working without a connection.

Both need the site to be served over **https**, which GitHub Pages provides. Browsers don't allow location or installing on plain `http://` addresses.

Only trains are used, because bikes are allowed on Melbourne's metro trains but not on trams or (most) buses.

## How it works

```
data-raw/trails.kml ─┐                         ┌─ data/trails.json   trail lines + stats
                     ├─ scripts/build-data.mjs ┼─ data/network.json  stations, lines, track, travel times
data-raw/gtfs-metro ─┘                         ├─ data/graph.json    links joining trails to each other / to stations
                                               └─ data/rides.json    every station → station ride of 8–80 km
```

1. **Trail network.** Each trail from the KML is simplified and split into nodes every ≤30 m. Trails less than 25 m apart are joined at junctions, and trail ends are joined by short on-road links (≤400 m) to nearby trails. Each station connects to every trail within 1 km (counted as on-road riding).
2. **Rides.** From every station near a trail, a shortest-path search ([js/ridegraph.js](js/ridegraph.js)) finds the route to every other such station. Road metres cost double, so routes stay on trails. Rides of 8–80 km with little road riding are saved.
3. **Trains.** The GTFS timetable gives each line's stopping pattern and typical all-stops travel time between stations ([js/trains.js](js/trains.js)). Each change of train adds an 8-minute allowance.
4. **Suggestions** (in the browser, [js/app.js](js/app.js)). For your start and finish stations, a ride qualifies if it's in the chosen distance band and its first train trip falls within the chosen "train out" time. Rides are then ranked with a mild preference for a shorter trip home, little road riding, and distances near the middle of each band. The top results are spread across different trails and start stations, with at most two that finish right at your destination (so most days are train → ride → train). A daily random factor means "Today's pick" changes each day, and **Shuffle** gives new ideas.

There is no build step and no framework: plain HTML, CSS and JavaScript modules with [Leaflet](https://leafletjs.com/), served as static files by GitHub Pages.

## Run it locally

```bash
node scripts/serve.mjs 8080
```

Then open http://localhost:8080/.

A phone on the same Wi-Fi can open `http://<your-PC's-IP>:8080/`, but on that plain-http address location and "Install app" are switched off by the browser. To test those on a phone before publishing, connect it by USB and use Chrome's port forwarding:

1. On the phone, turn on **Developer options → USB debugging**.
2. On the PC, open `chrome://inspect/#devices` in Chrome and click **Port forwarding**. Forward port `8080` to `localhost:8080`.
3. On the phone, open `http://localhost:8080/`. Chrome treats `localhost` as secure, so both features work.

The app icons in `icons/` are drawn by `node scripts/make-icons.mjs`.

## Updating the data

Train timetables change, so rebuild every few months.

1. Download the GTFS Schedule zip from https://opendata.transport.vic.gov.au/dataset/gtfs-schedule. The metro train feed is `2/google_transit.zip` inside it. Unzip that into `data-raw/gtfs-metro/`.
2. Put the trails KML at `data-raw/trails.kml`.
3. Run:

```bash
node scripts/build-data.mjs
```

`data-raw/` is git-ignored because it is large. Only the generated `data/*.json` files are committed.

## Deploying on GitHub Pages

1. Create a repository called `biking` on GitHub, then push this folder to it.
2. In the repository, go to **Settings → Pages**. Under **Build and deployment**, set the source to **Deploy from a branch**, choose `main` and `/ (root)`, and save.
3. After a minute or two the site is live at https://mghofrani.github.io/biking/.

## Data & credits

- Trail lines and stats: [Melbourne Bike Trails](https://melbournebiketrails.yolasite.com/) (KML). Only the line geometry, length, time and difficulty are used. The site's descriptions and photos are not copied.
- Train network and timetable: [Transport Victoria GTFS Schedule](https://opendata.transport.vic.gov.au/dataset/gtfs-schedule), CC BY 4.0.
- Base map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Tiles are recoloured in the browser (`recolour` in [js/app.js](js/app.js)): parks, woods and water keep their green and blue, and roads, buildings and labels go grey.

## Ideas for later

- V/Line trains (bikes are allowed) to reach trails further out, e.g. Geelong, Ballarat, Seymour.
- Live disruptions from the GTFS Realtime service-alerts feed, to flag rides that need a rail replacement bus.
- Elevation profiles and a "flat rides only" filter.
- Loop rides that start and finish at the same station by different trails.
