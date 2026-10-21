# GeoLocale OpenStreetMap build scripts

How [GeoLocale](https://geolocale.io) turns OpenStreetMap extracts into per-city SQLite files of
the places it uses to score neighbourhoods and show what is nearby.

- `plan.mjs` maps each city's area to the smallest [Geofabrik](https://download.geofabrik.de/)
  regions that cover it.
- `build.py` reads a region's `.osm.pbf` with [pyosmium](https://osmcode.org/pyosmium/) and
  writes, per city, the places of the kinds listed in `POI_KV`, water and major roads, and a
  building-count grid, into SQLite with an R*Tree index. A place inside several cities' areas
  is stored in each.
- `slim.py` trims line geometry to about 1 m and vacuums.
- `world.mjs` runs it all region by region and publishes each city.

**Data © OpenStreetMap contributors, under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).** The files
these scripts produce are a Derivative Database of OpenStreetMap; this repository is the means
to recreate them from the public extracts.
