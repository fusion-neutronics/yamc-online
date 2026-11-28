// The Python worker's network, for the requests it makes in batches.
//
// The Python worker cannot await anything during a run: yamc's downloader is
// blocking Rust, so its requests used to be synchronous XMLHttpRequests made
// one after another, a round trip each. When the downloader has a batch of
// independent requests it hands all of them to this worker and blocks on
// `Atomics.wait`; this worker fetches them concurrently with ordinary async
// fetch(), writes each answer into shared memory, and wakes it.
//
// Message, Python worker to this worker:
//   { requests: [[url, range], ...], ctl, arena, dataOrigin }
// `ctl` is an Int32Array on a SharedArrayBuffer: ctl[0] counts the requests
// answered, and request i's status, offset and length are at 1 + 3i. `arena`
// is a growable SharedArrayBuffer the bodies are appended to. Status 0 means
// the request did not complete. Each answer is also reported to the page, on
// the port it handed over at start, as a `fetch` message.

const PUBLISHED_ORIGIN = "https://yamc-data.xsplot.com/";
// Requests in flight at once. The data origin speaks HTTP/2, so they share
// one connection, and a ranged request costs its round trip rather than its
// bytes: yani-online measured the same closure at 38 s with 12 in flight and
// 21 s with 48.
const CONCURRENCY = 32;

let page = null;

/// One GET, as `{ status, body, type }`.
async function get(target, range) {
  const response = await fetch(target, { headers: range == null ? {} : { Range: range } });
  // Only a success carries a body worth handing over, as in the synchronous
  // path.
  const body = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  return { status: response.status, body, type: response.headers.get("Content-Type") || "" };
}

/// The inclusive `[first, last]` spans of a `Range` value, `bytes=0-99,200-299`,
/// or null for no range or a form this does not read.
function spansOf(range) {
  if (range == null) return null;
  const m = /^bytes=(.+)$/.exec(range.trim());
  if (!m) return null;
  const spans = m[1].split(",").map((p) => /^\s*(\d+)-(\d+)\s*$/.exec(p));
  if (!spans.every(Boolean)) return null;
  const out = spans.map((p) => [Number(p[1]), Number(p[2])]);
  return out.every(([a, b]) => a <= b) ? out : null;
}

const CRLF = (body, i) => body[i] === 13 && body[i + 1] === 10;

/// A `multipart/byteranges` body as `[first, bytes]` parts, read as yamc's
/// `parse_byteranges` reads it: the boundary from the first line, each part's
/// length from its `Content-Range`, never by searching for the next boundary,
/// which binary data could contain. Null if it is not one.
function partsOf(body) {
  const lineEnd = (from) => {
    for (let i = from; i + 1 < body.length; i++) if (CRLF(body, i)) return i;
    return -1;
  };
  const text = (a, b) => new TextDecoder().decode(body.subarray(a, b));
  let pos = 0;
  while (CRLF(body, pos)) pos += 2;
  let end = lineEnd(pos);
  if (end < 0 || !text(pos, end).startsWith("--")) return null;
  pos = end + 2;
  const parts = [];
  for (;;) {
    let span = null;
    for (;;) {
      end = lineEnd(pos);
      if (end < 0) return null;
      const line = text(pos, end);
      pos = end + 2;
      if (line === "") break;
      const m = /^content-range:\s*bytes\s+(\d+)-(\d+)\//i.exec(line);
      if (m) span = [Number(m[1]), Number(m[2])];
    }
    if (!span) return null;
    const length = span[1] - span[0] + 1;
    if (pos + length > body.length) return null;
    parts.push([span[0], body.subarray(pos, pos + length)]);
    pos += length;
    while (CRLF(body, pos)) pos += 2;
    end = lineEnd(pos);
    const delimiter = text(pos, end < 0 ? body.length : end);
    if (!delimiter.startsWith("--")) return null;
    if (delimiter.endsWith("--")) return parts;
    pos = end + 2;
  }
}

/// `[first, bytes]` parts as the `multipart/byteranges` body the origin would
/// have sent for them.
function byteranges(parts) {
  const boundary = "yamc-online-stored-ranges";
  const text = new TextEncoder();
  const chunks = [];
  for (const [first, bytes] of parts) {
    chunks.push(text.encode(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n`
      + `Content-Range: bytes ${first}-${first + bytes.length - 1}/*\r\n\r\n`), bytes);
  }
  chunks.push(text.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

/// The release files and ranges fetched, kept across reloads and restarts in
/// the browser's Cache Storage, one entry per file, keyed by its URL, or per
/// range, keyed `<url>?bytes=<first>-<last>`.
///
/// Not the HTTP cache, which never keeps a multi-range answer, and keeps a
/// URL's single ranges in one entry that one request at a time can fill: with
/// each multi-range request split into single ranges (as this worker did), the
/// tokamak sent its 799 requests to the network again after a reload, and took
/// 8.7 s and 17.6 s to load its data where a fresh page took 10.6 s. A
/// release's files are immutable and named by release, so an entry never goes
/// stale; `prune` drops a library's other releases once a run shows which one
/// is current, and the browser drops entries under storage pressure, which
/// costs only a download again. Null where there is no Cache Storage.
const stored = (() => {
  if (typeof caches === "undefined") return null;
  let opened = null;
  const open = () => (opened ??= caches.open("yamc-online-data").catch(() => null));
  // The keys held, listed once: a fresh page's every range is a miss, and a
  // lookup each would cost a fresh run time for nothing.
  let listed = null;
  const held = () => (listed ??= open()
    .then(async (cache) => new Set(cache ? (await cache.keys()).map((request) => request.url) : []))
    .catch(() => new Set()));
  const key = (target, span) => (span ? `${target}?bytes=${span[0]}-${span[1]}` : target);
  const pruned = new Set();
  return {
    /// The bytes held for `span` of `target`, or for the whole file if null.
    async get(target, span) {
      try {
        const k = key(target, span);
        if (!(await held()).has(k)) return null;
        const hit = await (await open()).match(k);
        const bytes = hit ? new Uint8Array(await hit.arrayBuffer()) : null;
        return bytes && (!span || bytes.length === span[1] - span[0] + 1) ? bytes : null;
      } catch {
        return null;
      }
    },
    put(target, span, bytes) {
      const k = key(target, span);
      held().then((keys) => keys.add(k)).catch(() => {});
      open().then((cache) => cache && cache.put(k, new Response(bytes))).catch(() => {});
    },
    /// Drop what is held of `library`'s releases other than `release`, once
    /// per library: `<base><library>/<release>/...` is a release's file.
    prune(base, library, release) {
      const id = `${base}${library}`;
      if (pruned.has(id)) return;
      pruned.add(id);
      const prefix = `${id}/`;
      const keep = `${prefix}${release}/`;
      Promise.all([open(), held()]).then(([cache, keys]) => {
        for (const k of keys) {
          if (k.startsWith(prefix) && !k.startsWith(keep)) {
            keys.delete(k);
            if (cache) cache.delete(k).catch(() => {});
          }
        }
      }).catch(() => {});
    },
  };
})();

/// A ranged GET answered from `stored` where it holds the spans, with one
/// request to the network for the rest, as `{ status, body, downloaded,
/// cached }`: the bytes that came over the network and from storage.
///
/// The answer is what the origin would have sent: the bytes for one range, a
/// `multipart/byteranges` body for several, or, if the origin answers the rest
/// with the whole file, that. An answer this cannot read into the spans asked
/// for is fetched again as asked and handed over as it comes, uncached.
async function getStored(target, range, spans) {
  const parts = await Promise.all(spans.map((s) => stored.get(target, s)));
  const cached = parts.reduce((n, p) => n + (p ? p.length : 0), 0);
  const need = spans.flatMap((_, i) => (parts[i] ? [] : [i]));
  let downloaded = 0;
  if (need.length) {
    const asked = need.map((i) => spans[i]);
    const r = await get(target, `bytes=${asked.map(([a, b]) => `${a}-${b}`).join(",")}`);
    if (r.status !== 206 || !r.body) return r;
    const [a0, b0] = asked[0];
    const got = asked.length === 1 && r.body.length === b0 - a0 + 1
      ? [[a0, r.body]]
      : /^multipart\/byteranges/i.test(r.type) ? partsOf(r.body) : null;
    for (const i of need) {
      const [a, b] = spans[i];
      const part = got && got.find(([first, bytes]) => first <= a && b < first + bytes.length);
      if (!part) return get(target, range);
      parts[i] = part[1].subarray(a - part[0], b - part[0] + 1);
      stored.put(target, [a, b], parts[i]);
    }
    downloaded = r.body.length;
  }
  const body = spans.length === 1 ? parts[0] : byteranges(spans.map(([a], i) => [a, parts[i]]));
  return { status: 206, body, downloaded, cached };
}

/// A whole release file, from `stored` if it holds it, as `{ status, body,
/// downloaded, cached }`.
async function getWhole(target) {
  const held = await stored.get(target, null);
  if (held) return { status: 200, body: held, downloaded: 0, cached: held.length };
  const r = await get(target, null);
  if (r.status === 200 && r.body) stored.put(target, null, r.body);
  return r;
}

async function answer(i, [url, range], ctl, arena, dataOrigin, alloc) {
  const target = url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url;
  const started = performance.now();
  let status = 0;
  let body = null;
  let downloaded = 0;
  let cached = 0;
  try {
    // A release's file, <library>/<release>/<kind>/<Name>.arrow/<section>, is
    // kept; latest.json and the manifest are not.
    const [library, release, ...rest] = target.startsWith(dataOrigin) ? target.slice(dataOrigin.length).split("/") : [];
    const keep = stored && rest.length >= 2;
    if (keep) stored.prune(dataOrigin, library, release);
    const spans = keep && spansOf(range);
    ({ status, body, downloaded, cached = 0 } = spans ? await getStored(target, range, spans)
      : keep && range == null ? await getWhole(target)
        : await get(target, range));
    downloaded ??= body ? body.length : 0;
  } catch {
    status = 0;
  }
  let offset = 0;
  const length = body ? body.length : 0;
  if (body) {
    try {
      offset = alloc(length);
      new Uint8Array(arena, offset, length).set(body);
    } catch {
      // Bigger than a batch may hold, or memory ran out. Status 0 makes the
      // downloader ask for it again on its own, which goes the synchronous
      // way. Every request is answered whatever happens: the Python worker
      // is waiting for all of them.
      status = 0;
    }
  }
  ctl[1 + 3 * i] = status;
  ctl[2 + 3 * i] = offset;
  ctl[3 + 3 * i] = status === 0 ? 0 : length;
  Atomics.add(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  if (page) {
    page.postMessage({
      type: "fetch", url, range, status,
      bytes: status === 0 ? 0 : downloaded,
      cached: status === 0 ? 0 : cached,
      ms: performance.now() - started, batched: true,
    });
  }
}

async function batch({ requests, ctl, arena, dataOrigin }) {
  // Absolute, as Cache Storage lists its keys: `?data=/fixtures/` is relative.
  dataOrigin = new URL(dataOrigin, self.location.href).href;
  // The bodies are appended to the arena, which grows as they arrive. This
  // worker is one thread, so the allocation needs no lock.
  let used = 0;
  const alloc = (length) => {
    const need = used + length;
    if (need > arena.maxByteLength) throw new RangeError("the batch is full");
    if (need > arena.byteLength) arena.grow(Math.min(arena.maxByteLength, Math.max(need, 2 * arena.byteLength)));
    const offset = used;
    used = need;
    return offset;
  };
  let next = 0;
  const lane = async () => {
    while (next < requests.length) {
      const i = next++;
      await answer(i, requests[i], ctl, arena, dataOrigin, alloc);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, lane));
}

self.onmessage = (event) => {
  if (event.data.port) {
    page = event.data.port;
    return;
  }
  batch(event.data);
};
