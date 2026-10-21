// Plan the worldwide build: every atlas city's box, and the smallest Geofabrik region that
// holds all of it (a leaf region where one fits, so as little as possible is downloaded).
//   node scripts/owndata/plan.mjs <geofabrik-index-v1.json> <out-plan.json>
import { createServer } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
const [INDEX, OUT] = process.argv.slice(2);
const vite = await createServer({ root: process.cwd(), logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const { CITIES_LIGHT } = await vite.ssrLoadModule("/src/data/cities/light.ts");
const { NEIGHBORHOODS_LIGHT } = await vite.ssrLoadModule("/src/data/cities/neighborhoodsLight.ts");
const extra = { ...(await vite.ssrLoadModule("/src/data/bangkok.ts").catch(() => ({}))), ...(await vite.ssrLoadModule("/src/data/lisbon.ts").catch(() => ({}))) };
await vite.close();
const MARGIN_M = 7500;
const boxOf = (c) => {
  let pts = (NEIGHBORHOODS_LIGHT[c.id] ?? []).map(([, lat, lng]) => [lat, lng]);
  const ex = extra[`${c.id.toUpperCase()}_NEIGHBORHOOD_CENTERS`];
  if (ex) pts = pts.concat(Object.values(ex).map((p) => [p.lat, p.lng]));
  pts.push([c.lat, c.lng]);
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const dLat = MARGIN_M / 111320, dLng = MARGIN_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
  return { s: Math.min(...pts.map((p) => p[0])) - dLat, n: Math.max(...pts.map((p) => p[0])) + dLat,
           w: Math.min(...pts.map((p) => p[1])) - dLng, e: Math.max(...pts.map((p) => p[1])) + dLng, centres: pts.length };
};
// Point in a GeoJSON MultiPolygon (ray casting; holes respected).
const inRing = (x, y, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
  const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const inMulti = (x, y, mp) => mp.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h)));
const ringArea = (r) => Math.abs(r.reduce((a, [x1, y1], i) => { const [x2, y2] = r[(i + 1) % r.length]; return a + x1 * y2 - x2 * y1; }, 0) / 2);
const idx = JSON.parse(readFileSync(INDEX, "utf8")).features.filter((f) => f.geometry && f.properties.urls?.pbf);
const regions = idx.map((f) => ({ id: f.properties.id, parent: f.properties.parent ?? null, pbf: f.properties.urls.pbf,
  mp: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
  area: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).reduce((a, p) => a + ringArea(p[0]), 0) }));
const hasChildren = new Set(regions.map((r) => r.parent).filter(Boolean));
const topOf = (id) => { let r = regions.find((x) => x.id === id); while (r?.parent && regions.find((x) => x.id === r.parent)) r = regions.find((x) => x.id === r.parent); return r?.id ?? id; };
const plan = { cities: [], unplaced: [] };
for (const c of CITIES_LIGHT) {
  const b = boxOf(c);
  // A city near a border is built from each region its box reaches: a 7 x 7 grid of points,
  // each placed in the smallest region holding it. Points at sea fall in no region and add none.
  const set = new Map();
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const x = b.w + ((b.e - b.w) * j) / 6, y = b.s + ((b.n - b.s) * i) / 6;
    // Leaf regions only: a parent's children cover its land, so a point that only a parent
    // holds is at sea, and taking the parent would download a whole country for a coastline.
    const fit = regions.filter((r) => !hasChildren.has(r.id) && inMulti(x, y, r.mp)).sort((a, z) => a.area - z.area)[0];
    if (fit) set.set(fit.id, fit);
  }
  const row = { city: c.id, name: c.name, country: c.country, s: +b.s.toFixed(4), w: +b.w.toFixed(4), n: +b.n.toFixed(4), e: +b.e.toFixed(4), centres: b.centres };
  if (set.size) plan.cities.push({ ...row, regions: [...set.keys()], continent: topOf([...set.keys()][0]) });
  else plan.unplaced.push(row);
}
const byRegion = {};
for (const c of plan.cities) for (const id of c.regions) {
  const r = regions.find((x) => x.id === id);
  (byRegion[id] ??= { region: id, pbf: r.pbf, continent: topOf(id), cities: [] }).cities.push(c.city);
}
plan.regions = Object.values(byRegion);
writeFileSync(OUT, JSON.stringify(plan, null, 1));
console.log(`${plan.cities.length} cities placed in ${plan.regions.length} regions; ${plan.unplaced.length} not inside any single region`);
console.log("unplaced sample:", plan.unplaced.slice(0, 12).map((u) => `${u.city} (${u.country})`).join(", "));
