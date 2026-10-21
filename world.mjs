// Build every atlas city's own-data file, region by region, and publish each to the public data
// repository (shonm1921-ship-it/geolocale-osm-data) as soon as all of its regions are done.
// Resumable: state lives in <work>/state.json; re-run to continue where it stopped.
//
//   node scripts/owndata/world.mjs <work-dir> <data-repo-clone> [--only region,region]
//
// Per region: download the Geofabrik .osm.pbf, build every city that reaches into it
// (build.py, merging cities that span regions), delete the download. Per finished city:
// slim.py, upload as a release asset (one release per continent), add it to manifest.json,
// push. /api/overpass reads the manifest, so a published city answers without a deploy.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// build.py and slim.py sit beside this file, both in the app repository (scripts/owndata/) and
// in the data repository (build/), where the weekly GitHub Actions refresh runs it.
const SCRIPTS = process.env.OWNDATA_SCRIPTS || dirname(fileURLToPath(import.meta.url));
const [WORK, REPO] = process.argv.slice(2).map((p) => resolve(p));
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > 0 ? process.argv[onlyIdx + 1].split(",") : null;
// --worker i/n: this process builds one share of the regions. Regions joined by a city that
// spans them stay in the same share (a city is merged from its regions by one process), and
// shares are balanced by download size. Each worker has its own state and its own clone of the
// data repo; all workers skip what state.json (the single-process run) already did.
const wIdx = process.argv.indexOf("--worker");
const [WORKER, WORKERS] = wIdx > 0 ? process.argv[wIdx + 1].split("/").map(Number) : [0, 1];
const OWNER_REPO = "shonm1921-ship-it/geolocale-osm-data";
const PY = process.env.OWNDATA_PYTHON || join(process.env.TMPDIR, "osmvenv/bin/python");
const UA = "GeoLocale own-data build (https://geolocale.io)";
const DEMO = ["tokyo", "bangkok", "lisbon", "telaviv", "seoul", "london", "neworleans"];

const plan = JSON.parse(readFileSync(existsSync(join(WORK, "plan.json")) ? join(WORK, "plan.json") : join(REPO, "plan.json"), "utf8"));
// What is published now, to compare a rebuild against before it replaces anything.
let previous = {};
try { previous = Object.fromEntries((JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).cities ?? []).map((c) => [c.city, c])); } catch { /* first build */ }
/** A rebuild that lost more than this share of a city's places is held back, not published:
 *  a truncated or broken extract must not replace a good file. */
const MAX_DROP = 0.3;
const basePath = join(WORK, "state.json");
const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : { regionsDone: [], published: {} };
const statePath = WORKERS > 1 ? join(WORK, `state-${WORKER}.json`) : basePath;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { regionsDone: [], published: {} };
if (WORKERS > 1) {
  state.regionsDone = [...new Set([...base.regionsDone, ...state.regionsDone])];
  state.published = { ...base.published, ...state.published };
}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1));
const cityById = Object.fromEntries(plan.cities.map((c) => [c.city, c]));
const citiesDir = join(WORK, "cities") + "/";
mkdirSync(citiesDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `w${WORKER}`, ...a);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26, ...opts }).toString();

// Demo cities' regions first, then the regions that finish the most cities per gigabyte.
// Shares: union regions that a city spans, then hand the groups out largest first to the
// lightest share.
const parent = Object.fromEntries(plan.regions.map((r) => [r.region, r.region]));
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
for (const c of plan.cities) for (const r of c.regions.slice(1)) parent[find(r)] = find(c.regions[0]);
const groups = {};
for (const r of plan.regions) (groups[find(r.region)] ??= []).push(r);
const load = Array(WORKERS).fill(0), shareOf = {};
for (const g of Object.values(groups).sort((a, b) => b.reduce((t, r) => t + r.bytes, 0) - a.reduce((t, r) => t + r.bytes, 0))) {
  const w = load.indexOf(Math.min(...load));
  load[w] += g.reduce((t, r) => t + r.bytes, 0);
  for (const r of g) shareOf[r.region] = w;
}
const regions = [...plan.regions].sort((a, b) => {
  const da = a.cities.some((c) => DEMO.includes(c)) ? 0 : 1, db = b.cities.some((c) => DEMO.includes(c)) ? 0 : 1;
  return da - db || b.cities.length / Math.max(b.bytes, 1) - a.cities.length / Math.max(a.bytes, 1);
}).filter((r) => (!ONLY || ONLY.includes(r.region)) && shareOf[r.region] === WORKER);

const releases = new Set();
function ensureRelease(tag) {
  if (releases.has(tag)) return;
  try { run("gh", ["release", "view", tag, "--repo", OWNER_REPO]); }
  catch { run("gh", ["release", "create", tag, "--repo", OWNER_REPO, "--title", `Cities: ${tag.replace(/^cities-/, "")}`,
    "--notes", "Per-city OpenStreetMap extracts for GeoLocale. Data © OpenStreetMap contributors, ODbL 1.0."]); }
  releases.add(tag);
}

function publish(cityId) {
  const c = cityById[cityId];
  const file = join(citiesDir, `${cityId}.sqlite`);
  if (!existsSync(file)) { log(`no file for ${cityId}`); return; }
  run("python3", ["-I", join(SCRIPTS, "slim.py"), file]);
  const meta = JSON.parse(run(PY, ["-c", `import sqlite3,json;d=sqlite3.connect(${JSON.stringify(file)});r=d.execute("select osm_date,places,lines,buildings,source from meta where city=?",(${JSON.stringify(cityId)},)).fetchone();print(json.dumps(r))`]));
  const before = previous[cityId]?.places;
  if (before && meta[1] < before * (1 - MAX_DROP)) {
    log(`held back ${cityId}: ${meta[1]} places against ${before} published; the published file stays`);
    unlinkSync(file);
    state.heldBack = { ...(state.heldBack ?? {}), [cityId]: { now: meta[1], before } };
    return;
  }
  const tag = `cities-${c.continent}`;
  ensureRelease(tag);
  run("gh", ["release", "upload", tag, file, "--repo", OWNER_REPO, "--clobber"]);
  const bytes = statSync(file).size;
  state.published[cityId] = { city: cityId, name: c.name, country: c.country, s: c.s, w: c.w, n: c.n, e: c.e,
    osm_date: meta[0], places: meta[1], lines: meta[2], buildings: meta[3], source: meta[4], bytes,
    url: `https://github.com/${OWNER_REPO}/releases/download/${tag}/${cityId}.sqlite` };
  unlinkSync(file);
  log(`published ${cityId} ${(bytes / 1e6).toFixed(1)} MB ${meta[1]} places`);
}

function pushManifest() {
  // Other workers push too: start from what the repository has, add ours, retry on a race.
  for (let t = 1; t <= 4; t++) {
    try { run("git", ["-C", REPO, "pull", "-q", "--rebase"]); } catch { /* offline: next region retries */ }
    let theirs = [];
    try { theirs = JSON.parse(readFileSync(join(REPO, "manifest.json"), "utf8")).cities ?? []; } catch { /* first */ }
    const merged = Object.fromEntries(theirs.map((c) => [c.city, c]));
    Object.assign(merged, state.published);
    if (writeManifest(Object.values(merged))) return;
  }
}

function writeManifest(list) {
  const cities = list.sort((a, b) => a.city.localeCompare(b.city));
  writeFileSync(join(REPO, "manifest.json"), JSON.stringify({ generated: new Date().toISOString(),
    licence: "Data © OpenStreetMap contributors, ODbL 1.0", cities }, null, 1));
  run("git", ["-C", REPO, "add", "manifest.json"]);
  try { run("git", ["-C", REPO, "commit", "-q", "-m", `Manifest: ${cities.length} cities`]); } catch { return true; }
  try { run("git", ["-C", REPO, "push", "-q"]); return true; }
  catch { run("git", ["-C", REPO, "reset", "-q", "--hard", "HEAD~1"]); return false; }
}

for (const r of regions) {
  if (state.regionsDone.includes(r.region)) continue;
  const pbf = join(WORK, `region-${WORKER}.osm.pbf`);
  log(`region ${r.region} ${(r.bytes / 1e6).toFixed(0)} MB, cities ${r.cities.join(" ")}`);
  let ok = false;
  for (let t = 1; t <= 3 && !ok; t++) {
    try { run("curl", ["-sSfL", "--retry", "3", "-A", UA, "-o", pbf, r.pbf], { timeout: 3 * 3600_000 }); ok = true; }
    catch (e) { log(`download failed (${t}) ${r.region}: ${String(e.message).slice(0, 120)}`); }
  }
  if (!ok) continue;
  // A city with a file from an earlier region keeps it and adds to it.
  const append = r.cities.filter((c) => existsSync(join(citiesDir, `${c}.sqlite`)));
  const boxes = r.cities.map((id) => { const c = cityById[id]; return `${id}:${c.s},${c.w},${c.n},${c.e}`; });
  try {
    const out = run(PY, [join(SCRIPTS, "build.py"), pbf, citiesDir, ...boxes],
      { env: { ...process.env, OWNDATA_APPEND: append.join(",") }, timeout: 6 * 3600_000 });
    log(out.trim().slice(0, 300));
  } catch (e) { log(`build failed ${r.region}: ${String(e.stderr ?? e.message).slice(-300)}`); try { unlinkSync(pbf); } catch {} continue; }
  try { unlinkSync(pbf); } catch {}
  state.regionsDone.push(r.region);
  for (const id of r.cities) {
    const c = cityById[id];
    if (state.published[id]) continue;
    if (c.regions.every((x) => state.regionsDone.includes(x))) {
      try { publish(id); } catch (e) { log(`publish failed ${id}: ${String(e.stderr ?? e.message).slice(-200)}`); }
    }
  }
  save();
  try { pushManifest(); } catch (e) { log(`manifest push failed: ${String(e.message).slice(0, 160)}`); }
}
log(`worker ${WORKER}/${WORKERS} done: ${Object.keys(state.published).length} of ${plan.cities.length} cities published`);
