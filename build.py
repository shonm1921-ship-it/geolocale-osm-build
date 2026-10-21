#!/usr/bin/env python3
"""Build our own copy of the OpenStreetMap features the neighbourhood scores ask about.

For each city: read the region's .osm.pbf (Geofabrik, ODbL), keep only what lies inside the
city's box and only the features the score queries name, and append them to one SQLite file
the /api/overpass function answers from (api/_owndata.ts).

  places  nodes and way centres carrying amenity/shop/leisure/tourism/railway/station/
          healthcare tags, with their tags (bulky free-text tags dropped)
  lines   water, major roads, railways, runways, with geometry (water areas as outlines)
  lamps   highway=street_lamp nodes (stored as places)
  bgrid   building counts per ~110 m cell (the "how mapped is this area" probe asks a count)

  osmvenv/bin/python scripts/owndata/build.py <region.osm.pbf> <out.sqlite> <city>:<s>,<w>,<n>,<e> [...]

Re-running for a city replaces that city's rows. The source date is recorded per city.
"""
import json, math, os, sqlite3, sys, time
import osmium

PBF, OUT = sys.argv[1], sys.argv[2]
PER_CITY = OUT.endswith("/")
CITIES = []
for a in sys.argv[3:]:
    cid, box = a.split(":")
    s, w, n, e = map(float, box.split(","))
    CITIES.append((cid, s, w, n, e))

# Exactly the selectors the score queries name (src/lib/placesDistances.ts DENSE/SPARSE,
# src/lib/communities.ts COMMUNITY_SELECTORS, the lamp probe). Nothing else is kept: on Tel Aviv
# the parking spaces, benches and bins the app never asks about were most of the file.
# Since 2026-10-21 also every primary selector Discover and the nearby card ask about
# (src/lib/osmSelectors.ts OSM_SELECTORS), so those answer from the file too.
SHOP_KINDS = ("clothes shoes boutique bag fashion_accessories jewelry jewellery watches cosmetics perfumery electronics "
              "mobile_phone computer camera hifi appliance books stationery gift toys games sports outdoor bicycle "
              "variety_store second_hand florist optician art music musical_instrument furniture houseware "
              "interior_decoration kitchen lighting hardware doityourself").split()
POI_KV = {
    *(("amenity", v) for v in ("cafe", "restaurant", "fast_food", "bar", "pub", "nightclub", "pharmacy", "spa",
                               "marketplace", "theatre", "arts_centre", "cinema", "police", "school", "university",
                               "college", "hospital", "clinic", "doctors", "place_of_worship", "bank", "atm", "dentist",
                               "kindergarten", "childcare", "veterinary", "charging_station", "bicycle_rental",
                               "coworking_space", "townhall", "gym")),
    *(("shop", v) for v in ("convenience", "supermarket", "massage", "mall", "department_store", "wholesale", *SHOP_KINDS)),
    *(("leisure", v) for v in ("fitness_centre", "spa", "park", "garden", "beach_resort", "sports_centre", "dog_park")),
    *(("tourism", v) for v in ("attraction", "viewpoint", "museum", "gallery", "hotel", "resort", "motel", "apartment", "chalet")),
    *(("healthcare", v) for v in ("clinic", "dentist")),
    *(("building", v) for v in ("office", "civic", "public")),
    ("railway", "station"), ("station", "subway"), ("station", "light_rail"), ("highway", "street_lamp"),
    ("natural", "beach"), ("club", "fitness"), ("office", "coworking"), ("man_made", "tower"), ("historic", "castle"),
}
KINDS = sorted(f"{k}={v}" for k, v in POI_KV)
POI_KEYS = ()
LINE_KV = {("natural", "water"), ("water", "lake"), ("waterway", "river"), ("waterway", "canal"),
           ("highway", "motorway"), ("highway", "trunk"), ("highway", "primary"),
           ("railway", "rail"), ("aeroway", "runway")}
DROP = ("description", "note", "fixme", "FIXME", "source", "created_by", "image", "mapillary",
        "wikimedia_commons", "check_date", "survey:date", "opening_hours:covid19")
CELL = 0.001  # ~110 m

def cities_of(lat, lng):
    """EVERY city whose box holds the point. Boxes overlap (Tel Aviv, Ramat Gan, Herzliya and
    Ra'anana share most of theirs), and a place filed under only the first of them left the
    others missing it: Ra'anana came out with 78 places on 2026-10-21, before this."""
    return [c[0] for c in CITIES if c[1] <= lat <= c[3] and c[2] <= lng <= c[4]]

def keep_tags(tags):
    return {k: v for k, v in tags.items() if not k.startswith(DROP) and len(v) < 300}

POI_KEYSET = sorted({k for k, _ in POI_KV})

def is_poi(tags):
    for k in POI_KEYSET:
        v = tags.get(k)
        if v is not None and (k, v) in POI_KV:
            return True
    return False

def line_kv(tags):
    return [f"{k}={v}" for k, v in LINE_KV if tags.get(k) == v]

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(city TEXT PRIMARY KEY, source TEXT, osm_date TEXT, built TEXT, s REAL, w REAL, n REAL, e REAL, places INT, lines INT, buildings INT);
CREATE TABLE IF NOT EXISTS places(id INTEGER PRIMARY KEY, city TEXT, type TEXT, osm_id INTEGER, lat REAL, lng REAL, tags TEXT);
CREATE TABLE IF NOT EXISTS place_kv(place INTEGER, kv TEXT);
CREATE INDEX IF NOT EXISTS place_kv_kv ON place_kv(kv, place);
CREATE VIRTUAL TABLE IF NOT EXISTS place_idx USING rtree(id, s, n, w, e);
CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY, city TEXT, osm_id INTEGER, kv TEXT, tags TEXT, geom TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS line_idx USING rtree(id, s, n, w, e);
CREATE TABLE IF NOT EXISTS bgrid(city TEXT, i INTEGER, j INTEGER, n INTEGER, PRIMARY KEY(city, i, j));
CREATE UNIQUE INDEX IF NOT EXISTS places_osm ON places(city, type, osm_id);
CREATE UNIQUE INDEX IF NOT EXISTS lines_osm ON lines(city, osm_id, kv);
"""
# A city whose box crosses into a neighbouring region is built from each region in turn
# (scripts/owndata/world.mjs). OWNDATA_APPEND names the cities whose rows from an earlier
# region must be kept and added to, not replaced. An element both extracts carry is stored once.
APPEND = set(filter(None, os.environ.get("OWNDATA_APPEND", "").split(",")))
DBS = {}
def dbfor(cid):
    """One file per city (OUT ending in /), or one shared file."""
    key = cid if PER_CITY else ""
    if key not in DBS:
        con = sqlite3.connect(f"{OUT}{cid}.sqlite" if PER_CITY else OUT)
        con.executescript(SCHEMA)
        cols = [r[1] for r in con.execute("PRAGMA table_info(meta)")]
        if "kinds" not in cols:
            con.execute("ALTER TABLE meta ADD COLUMN kinds TEXT")
        DBS[key] = con
    return DBS[key]

for c in CITIES:
    db = dbfor(c[0])
    cid = c[0]
    if cid in APPEND:
        continue
    ids = [r[0] for r in db.execute("SELECT id FROM places WHERE city=?", (cid,))]
    db.executemany("DELETE FROM place_idx WHERE id=?", [(i,) for i in ids])
    db.executemany("DELETE FROM place_kv WHERE place=?", [(i,) for i in ids])
    db.execute("DELETE FROM places WHERE city=?", (cid,))
    lids = [r[0] for r in db.execute("SELECT id FROM lines WHERE city=?", (cid,))]
    db.executemany("DELETE FROM line_idx WHERE id=?", [(i,) for i in lids])
    db.execute("DELETE FROM lines WHERE city=?", (cid,))
    db.execute("DELETE FROM bgrid WHERE city=?", (cid,))

counts = {c[0]: {"places": 0, "lines": 0, "buildings": 0} for c in CITIES}
grid = {}

def add_place(cid, typ, osm_id, lat, lng, tags):
    db = dbfor(cid)
    t = keep_tags(tags)
    cur = db.execute("INSERT OR IGNORE INTO places(city,type,osm_id,lat,lng,tags) VALUES(?,?,?,?,?,?)",
                     (cid, typ, osm_id, round(lat, 7), round(lng, 7), json.dumps(t, ensure_ascii=False, separators=(",", ":"))))
    if not cur.rowcount:
        return
    pid = cur.lastrowid
    db.execute("INSERT INTO place_idx VALUES(?,?,?,?,?)", (pid, lat, lat, lng, lng))
    kvs = {f"{k}={v}" for k, v in t.items() if (k, v) in POI_KV}
    db.executemany("INSERT INTO place_kv VALUES(?,?)", [(pid, kv) for kv in kvs])
    counts[cid]["places"] += 1

class H(osmium.SimpleHandler):
    def node(self, n):
        if not n.tags:
            return
        lat, lng = n.location.lat, n.location.lon
        if not is_poi(n.tags):
            return
        tags = None
        for cid in cities_of(lat, lng):
            tags = tags or dict(n.tags)
            add_place(cid, "node", n.id, lat, lng, tags)

    def way(self, w):
        tags = w.tags
        if not tags:
            return
        building = "building" in tags
        poi = is_poi(tags)
        lkv = line_kv(tags)
        if not (building or poi or lkv):
            return
        try:
            pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            return
        if not pts:
            return
        clat = sum(p[0] for p in pts) / len(pts)
        clng = sum(p[1] for p in pts) / len(pts)
        cids = cities_of(clat, clng)
        lcids = cids
        if lkv:
            # A long line may cross into a city while its middle lies outside: it belongs to every
            # city any of its points falls in.
            seen = []
            for a, b in pts:
                for c in cities_of(a, b):
                    if c not in seen:
                        seen.append(c)
            lcids = seen
        if not cids and not lcids:
            return
        d = dict(tags)
        for cid in cids:
            if building:
                key = (cid, int(math.floor(clat / CELL)), int(math.floor(clng / CELL)))
                grid[key] = grid.get(key, 0) + 1
                counts[cid]["buildings"] += 1
            if poi:
                add_place(cid, "way", w.id, clat, clng, d)
        for cid, kv in [(c, kv) for c in lcids for kv in lkv]:
            db = dbfor(cid)
            geom = [[round(a, 6), round(b, 6)] for a, b in pts]
            cur = db.execute("INSERT OR IGNORE INTO lines(city,osm_id,kv,tags,geom) VALUES(?,?,?,?,?)",
                             (cid, w.id, kv, json.dumps(keep_tags(dict(tags)), ensure_ascii=False, separators=(",", ":")), json.dumps(geom, separators=(",", ":"))))
            if not cur.rowcount:
                continue
            lats = [p[0] for p in pts]; lngs = [p[1] for p in pts]
            db.execute("INSERT INTO line_idx VALUES(?,?,?,?,?)", (cur.lastrowid, min(lats), max(lats), min(lngs), max(lngs)))
            counts[cid]["lines"] += 1

t0 = time.time()
h = H()
h.apply_file(PBF, locations=True, idx="flex_mem")
for (c, i, j), n in grid.items():
    dbfor(c).execute("INSERT INTO bgrid VALUES(?,?,?,?) ON CONFLICT(city,i,j) DO UPDATE SET n = n + excluded.n", (c, i, j, n))
osm_date = osmium.io.Reader(PBF, osmium.osm.osm_entity_bits.NOTHING).header().get("osmosis_replication_timestamp") or ""
for cid, s, w, n, e in CITIES:
    db = dbfor(cid)
    if cid in APPEND:
        prev = db.execute("SELECT source, places, lines, buildings FROM meta WHERE city=?", (cid,)).fetchone()
        if prev:
            counts[cid] = {"places": db.execute("SELECT count(*) FROM places WHERE city=?", (cid,)).fetchone()[0],
                           "lines": db.execute("SELECT count(*) FROM lines WHERE city=?", (cid,)).fetchone()[0],
                           "buildings": prev[3] + counts[cid]["buildings"]}
            src = prev[0] + "+" + PBF.split("/")[-1]
            db.execute("UPDATE meta SET source=?, places=?, lines=?, buildings=?, osm_date=min(osm_date, ?) WHERE city=?",
                       (src, counts[cid]["places"], counts[cid]["lines"], counts[cid]["buildings"], osm_date, cid))
            continue
    db.execute("INSERT OR REPLACE INTO meta(city,source,osm_date,built,s,w,n,e,places,lines,buildings,kinds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
               (cid, PBF.split("/")[-1], osm_date, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), s, w, n, e,
                counts[cid]["places"], counts[cid]["lines"], counts[cid]["buildings"], json.dumps(KINDS)))
for con in DBS.values():
    con.commit()
print(json.dumps({"seconds": round(time.time() - t0, 1), "osm_date": osm_date, "counts": counts}))
