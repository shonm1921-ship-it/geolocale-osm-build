#!/usr/bin/env python3
"""Shrink a built own-data file without changing any answer the score queries get.

Lines keep their kind and name, with coordinates at 5 decimals (about 1 m); lamps keep only
their tag; places keep all their tags. Then VACUUM.
    python3 -I scripts/owndata/slim.py <owndata.sqlite>
"""
import json, sqlite3, sys
DROP_PREFIX = ("contact:", "phone", "email", "fax", "wikidata", "wikipedia", "brand:wikidata", "brand:wikipedia",
               "operator:wikidata", "network:wikidata", "check_date", "payment:", "survey", "level", "toilets",
               "wheelchair", "internet_access", "fee", "smoking", "outdoor_seating", "delivery", "takeaway", "capacity",
               "building:", "roof:", "height", "start_date", "source:", "ref", "layer", "indoor", "entrance",
               "drive_through", "air_conditioning", "website:", "url", "facebook", "instagram", "image", "lit",
               "covered", "access", "parking", "bicycle", "dog", "highchair", "changing_table", "description:",
               "old_name", "not:", "was:", "disused:", "note:", "fixme")
db = sqlite3.connect(sys.argv[1])
before = sum(r[0] for r in db.execute("select sum(pgsize) from dbstat"))
rows = db.execute("select id, tags from places").fetchall()
upd = []
for pid, t in rows:
    tags = json.loads(t)
    if tags.get("highway") == "street_lamp" and not any(k in tags for k in ("amenity", "shop", "leisure", "tourism")):
        slim = {"highway": "street_lamp"}
    else:
        # Places keep every tag build.py kept: the app reads more of them than it looks
        # (brand:wikidata for chains, wheelchair, access, website), checked 2026-10-21.
        slim = tags
    upd.append((json.dumps(slim, ensure_ascii=False, separators=(",", ":")), pid))
db.executemany("update places set tags=? where id=?", upd)
lrows = db.execute("select id, kv, tags, geom from lines").fetchall()
lupd = []
for lid, kv, t, g in lrows:
    tags = json.loads(t); k, v = kv.split("=", 1)
    slim = {k: v, **({"name": tags["name"]} if "name" in tags else {})}
    geom = [[round(a, 5), round(b, 5)] for a, b in json.loads(g)]
    dedup = [p for i, p in enumerate(geom) if i == 0 or p != geom[i - 1]]
    lupd.append((json.dumps(slim, ensure_ascii=False, separators=(",", ":")), json.dumps(dedup, separators=(",", ":")), lid))
db.executemany("update lines set tags=?, geom=? where id=?", lupd)
db.commit()
db.execute("vacuum")
after = sum(r[0] for r in db.execute("select sum(pgsize) from dbstat"))
print(f"{before/1048576:.1f} MB -> {after/1048576:.1f} MB")
