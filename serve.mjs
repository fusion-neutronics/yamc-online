// A static server for dist/, with core's nuclear-data fixtures beside it.
//
//   node serve.mjs [--port 8000] [--no-isolation]
//
// Open http://localhost:8000/ to use the published data, or
// http://localhost:8000/?data=/fixtures/ to read core's test fixtures instead
// (offline, and what verify.mjs does). The fixtures are core's
// crates/yamc/tests, filled by `python3 scripts/fetch_test_fixtures.py` in core;
// set YAMC_FIXTURES to point elsewhere. Anything not there is looked for in
// .fixtures/, which `node scripts/fetch-fixtures.mjs` fills (with the
// transmutation chain too). They are endf-b8.1 only.
//
// The fixtures are served in the published release layout: a `latest.json`
// naming a release called `fixtures`, whose `manifest.json` lists every
// fixture file with its size and sha256, worked out here from the files
// themselves, so the wheel checks what it reads as it does against the origin.
//
// The page is served cross-origin isolated, as GitHub Pages serves it once
// coi-serviceworker has reloaded it, so Stop can interrupt Python.
// `--no-isolation` serves it without, to check the restart fallback.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
export const FIXTURES = resolve(process.env.YAMC_FIXTURES || fileURLToPath(new URL("../core/crates/yamc/tests/", import.meta.url)));
// What scripts/fetch-fixtures.mjs downloads, read after FIXTURES: core's
// fixtures carry no photon data for H or O.
export const FETCHED_FIXTURES = fileURLToPath(new URL("./.fixtures/", import.meta.url));

/// The fixture directory holding `<Name>.arrow` (or `transmutation/<subsection>.arrow`),
/// or the first if none does.
export function fixtureDir(name) {
  return [FIXTURES, FETCHED_FIXTURES].find((d) => existsSync(join(d, name))) || FIXTURES;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".whl": "application/zip",
};

const KEYWORD = "endf-b8.1";
const RELEASE = "fixtures";

/// The fixtures as one release: `files` maps each path in the release
/// (`neutron/Li6.arrow/reactions.arrow`, `photon/O.arrow/element.arrow`,
/// `transmutation/decay.arrow/nuclides.arrow`) to the file serving it, and
/// `latest` and `manifest` are the two index objects. Core keeps neutron
/// nuclides and photon elements side by side in one directory; a nuclide's
/// name carries its mass number and an element's does not. A name in both
/// fixture directories is read from the first. Built on first use.
let release = null;
function fixtureRelease() {
  if (release) return release;
  const files = new Map();
  const add = (releaseDir, dir) => {
    for (const f of readdirSync(dir)) {
      const file = join(dir, f);
      if (!/\.(arrow|json)$/.test(f) || !statSync(file).isFile()) continue;
      const path = `${releaseDir}/${f}`;
      if (!files.has(path)) files.set(path, file);
    }
  };
  for (const root of [FIXTURES, FETCHED_FIXTURES]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      if (!d.endsWith(".arrow") || !statSync(join(root, d)).isDirectory()) continue;
      add(`${/\d/.test(d) ? "neutron" : "photon"}/${d}`, join(root, d));
    }
    const chain = join(root, "transmutation");
    if (!existsSync(chain)) continue;
    for (const d of readdirSync(chain)) {
      if (d.endsWith(".arrow")) add(`transmutation/${d}`, join(chain, d));
    }
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const manifest = Buffer.from(JSON.stringify({
    schema: "yamc-data-manifest",
    keyword: KEYWORD,
    release: RELEASE,
    format_version: 2,
    files: [...files].sort().map(([path, file]) => {
      const bytes = readFileSync(file);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  }));
  const latest = Buffer.from(JSON.stringify({
    schema: "yamc-data-latest",
    keyword: KEYWORD,
    release: RELEASE,
    format_version: 2,
    manifest: `${RELEASE}/manifest.json`,
    manifest_bytes: manifest.length,
    manifest_sha256: sha256(manifest),
  }));
  release = { files, latest, manifest };
  return release;
}

/// Answer a `/fixtures/` request: the release index, or a fixture file by
/// its path in the release. Anything else is not in the fixtures.
function sendFixture(req, res, path, headers) {
  const rel = path.slice("/fixtures/".length);
  const { files, latest, manifest } = fixtureRelease();
  const index = { [`${KEYWORD}/latest.json`]: latest, [`${KEYWORD}/${RELEASE}/manifest.json`]: manifest }[rel];
  if (index) {
    res.writeHead(200, { ...headers, "Content-Type": "application/json", "Content-Length": index.length });
    return res.end(index);
  }
  const prefix = `${KEYWORD}/${RELEASE}/`;
  const file = rel.startsWith(prefix) && files.get(rel.slice(prefix.length));
  if (!file) return res.writeHead(404, headers).end("not in the fixtures");
  return sendFile(req, res, file, headers);
}

function staticPath(path) {
  const file = normalize(join(DIST, path.endsWith("/") ? `${path}index.html` : path));
  return file.startsWith(DIST) ? file : null;
}

/// Serve one file, honouring a `Range` header as the data origin does: one
/// range is a plain 206, several are a `multipart/byteranges` 206.
function sendFile(req, res, file, headers) {
  let size;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.writeHead(404, headers).end("not found");
    return;
  }
  const type = TYPES[extname(file)] || "application/octet-stream";
  const spec = req.headers.range && req.headers.range.match(/^bytes=(\d+-\d+(?:,\d+-\d+)*)$/);
  const ranges = spec
    ? spec[1].split(",").map((r) => r.split("-").map(Number)).map(([a, b]) => [a, Math.min(b, size - 1)])
    : [];
  if (ranges.length === 1) {
    const [start, end] = ranges[0];
    res.writeHead(206, { ...headers, "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res);
  } else if (ranges.length > 1) {
    const body = readFileSync(file);
    const boundary = "yamc-online-fixtures";
    const parts = ranges.map(([a, b]) => Buffer.concat([
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${a}-${b}/${size}\r\n\r\n`),
      body.subarray(a, b + 1),
    ]));
    const multipart = Buffer.concat([...parts, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    res.writeHead(206, { ...headers, "Content-Type": `multipart/byteranges; boundary=${boundary}`, "Content-Length": multipart.length });
    res.end(multipart);
  } else {
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": size });
    createReadStream(file).pipe(res);
  }
}

export function serve({ port = 8000, isolation = true } = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const headers = { "Cache-Control": "no-store" };
    if (isolation) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    if (path.startsWith("/fixtures/")) return sendFixture(req, res, path, headers);
    const file = staticPath(path);
    if (!file) return res.writeHead(403, headers).end();
    return sendFile(req, res, file, headers);
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8000;
  const server = await serve({ port, isolation: !args.includes("--no-isolation") });
  console.log(`http://localhost:${server.address().port}/  (fixtures: ${FIXTURES})`);
}
