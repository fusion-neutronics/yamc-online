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

/// One GET with the browser's HTTP cache left on, as `{ status, body }`.
///
/// The release's files are served `immutable` for a year, so a file or range
/// fetched once is answered from the browser's cache afterwards: after a page
/// reload, and after Stop restarts Python, whose in-memory copies go with it.
/// latest.json, the one object that changes, is asked for with a new
/// release-check query each time, so nothing stale can be served.
async function get(target, range) {
  const response = await fetch(target, { headers: range == null ? {} : { Range: range } });
  // Only a success carries a body worth handing over, as in the synchronous
  // path.
  const body = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  return { status: response.status, body };
}

/// The spans of a multi-range `Range` value, `bytes=0-99,200-299`, or null for
/// one range, no range, or a form this does not split.
function spansOf(range) {
  if (range == null || !range.includes(",")) return null;
  const m = /^bytes=(.+)$/.exec(range.trim());
  if (!m) return null;
  const spans = m[1].split(",").map((p) => /^\s*(\d+)-(\d+)\s*$/.exec(p));
  return spans.every(Boolean) ? spans.map((p) => [Number(p[1]), Number(p[2])]) : null;
}

/// Parts in flight at once within one split request.
const PARTS_IN_FLIGHT = 16;

/// A multi-range GET as one single-range GET per span, answered with the
/// `multipart/byteranges` body the origin would have sent.
///
/// Browsers cache a single-range answer and not a multi-range one, which is
/// most of the bytes a run reads: asked this way, a second run of the same data
/// is answered from the cache. The body is what yamc's `parse_byteranges`
/// reads: the boundary on the first line, each part's offset in its
/// `Content-Range`. An origin that drops the Range header answers 200 with the
/// whole file, which is handed over as such, as a direct request's would be.
async function getSplit(target, spans) {
  const parts = new Array(spans.length);
  let next = 0;
  let whole = null;
  let failed = null;
  const lane = async () => {
    while (next < spans.length && !whole && !failed) {
      const i = next++;
      const [a, b] = spans[i];
      const r = await get(target, `bytes=${a}-${b}`);
      if (r.status === 200) whole = r;
      else if (r.status !== 206 || !r.body || r.body.length !== b - a + 1) failed = r;
      else parts[i] = r.body;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARTS_IN_FLIGHT, spans.length) }, lane));
  if (whole) return whole;
  if (failed) return { status: failed.status === 206 ? 0 : failed.status, body: null };
  const boundary = "yamc-online-split-range";
  const text = new TextEncoder();
  const chunks = [];
  spans.forEach(([a, b], i) => {
    chunks.push(text.encode(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${b}/*\r\n\r\n`), parts[i]);
  });
  chunks.push(text.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { status: 206, body };
}

async function answer(i, [url, range], ctl, arena, dataOrigin, alloc) {
  const target = url.startsWith(PUBLISHED_ORIGIN) ? dataOrigin + url.slice(PUBLISHED_ORIGIN.length) : url;
  const started = performance.now();
  let status = 0;
  let body = null;
  try {
    const spans = spansOf(range);
    ({ status, body } = spans ? await getSplit(target, spans) : await get(target, range));
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
  if (page) page.postMessage({ type: "fetch", url, range, status, bytes: status === 0 ? 0 : length, ms: performance.now() - started, batched: true });
}

async function batch({ requests, ctl, arena, dataOrigin }) {
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
