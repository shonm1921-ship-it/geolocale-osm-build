// The box each pilot city needs: every neighbourhood centre the app scores, plus the farthest
// radius a score query asks about (7 km for hospitals and universities) and a little more.
//   node scripts/owndata/boxes.mjs tokyo bangkok ...   -> "city:s,w,n,e" per line
import { createServer } from "vite";
const vite = await createServer({ root: process.cwd(), logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const { NEIGHBORHOODS_LIGHT } = await vite.ssrLoadModule("/src/data/cities/neighborhoodsLight.ts");
const props = { ...(await vite.ssrLoadModule("/src/data/bangkok.ts").catch(() => ({}))), ...(await vite.ssrLoadModule("/src/data/lisbon.ts").catch(() => ({}))) };
const MARGIN_M = 7500;
for (const id of process.argv.slice(2)) {
  let pts = (NEIGHBORHOODS_LIGHT[id] ?? []).map(([, lat, lng]) => [lat, lng]);
  const extra = props[`${id.toUpperCase()}_NEIGHBORHOOD_CENTERS`];
  if (extra) pts = pts.concat(Object.values(extra).map((c) => [c.lat, c.lng]));
  if (!pts.length) { console.error(`no centres for ${id}`); continue; }
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const dLat = MARGIN_M / 111320, dLng = MARGIN_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const s = Math.min(...pts.map((p) => p[0])) - dLat, n = Math.max(...pts.map((p) => p[0])) + dLat;
  const w = Math.min(...pts.map((p) => p[1])) - dLng, e = Math.max(...pts.map((p) => p[1])) + dLng;
  console.log(`${id}:${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}  # ${pts.length} centres`);
}
await vite.close();
