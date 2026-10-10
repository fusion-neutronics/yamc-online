// A static server for dist/, with core's nuclear-data fixtures beside it.
//
//   node serve.mjs [--port 8000] [--no-isolation]
//
// Open http://localhost:8000/ to use the published data, or
// http://localhost:8000/?data=/fixtures/ to read core's test fixtures instead
// (offline, and what verify.mjs does). The fixtures are core's
// crates/yamc/tests, filled by `python3 scripts/fetch_test_fixtures.py` in core;
// set YAMC_FIXTURES to point elsewhere. They are endf-b8.1 only.
//
// The page is served cross-origin isolated, as GitHub Pages serves it once
// coi-serviceworker has reloaded it, so Stop can interrupt Python.
// `--no-isolation` serves it without, to check the restart fallback.

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
export const FIXTURES = resolve(process.env.YAMC_FIXTURES || fileURLToPath(new URL("../core/crates/yamc/tests/", import.meta.url)));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".whl": "application/zip",
};

/// Map `/fixtures/endf-b8.1/neutron/Li6.arrow/reactions.arrow` onto the
/// fixture tree, or null for anything the fixtures do not carry.
function fixturePath(path) {
  const m = path.match(/^\/fixtures\/endf-b8\.1\/neutron\/([A-Za-z0-9_]+\.arrow)\/([a-z_]+\.(?:arrow|json))$/);
  return m ? join(FIXTURES, m[1], m[2]) : null;
}

function staticPath(path) {
  const file = normalize(join(DIST, path.endsWith("/") ? `${path}index.html` : path));
  return file.startsWith(DIST) ? file : null;
}

/// Serve one file, honouring a single `bytes=a-b` Range as the data origin does.
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
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d+)-(\d+)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), size - 1);
    res.writeHead(206, { ...headers, "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res);
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
    if (path.startsWith("/fixtures/")) {
      const file = fixturePath(path);
      if (!file) return res.writeHead(404, headers).end("not in the fixtures");
      return sendFile(req, res, file, headers);
    }
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
