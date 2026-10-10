// The page: an editor, a Python worker, and three tabs for what comes back.
//
// Everything Python runs in worker.js. This file owns the editor, the worker's
// lifecycle (start, stop, restart after a crash), and turning the worker's
// messages into the Output, Plots and Data tabs.

import {
  EditorView, basicSetup, keymap, EditorState, indentWithTab, python,
  HighlightStyle, syntaxHighlighting, tags,
} from "./codemirror.js";
import { PYODIDE_VERSION, WHEEL, CORE_COMMIT, EXAMPLES } from "./config.js";

const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const DRAFT_KEY = "yamc-online:draft";
// How long Stop waits for Python to notice the interrupt before restarting it.
// Python notices between bytecodes; a transport run is one call into Rust and
// does not, so the wait is only for scripts doing their own Python work.
const INTERRUPT_GRACE_MS = 1500;

const $ = (id) => document.getElementById(id);
const els = {
  example: $("example"),
  run: $("run"),
  stop: $("stop"),
  share: $("share"),
  download: $("download"),
  status: $("status"),
  output: $("output"),
  plots: $("plots"),
  plotCount: $("plot-count"),
  data: $("data"),
};

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

// Colours from CSS variables, so the editor follows the page's light and dark
// palettes rather than carrying a second theme.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword], color: "var(--tok-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--tok-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--tok-number)" },
  { tag: tags.comment, color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.definition(tags.variableName)), tags.definition(tags.className)], color: "var(--tok-def)" },
  { tag: [tags.standard(tags.variableName), tags.self], color: "var(--tok-builtin)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "var(--bg)", fontSize: ".85rem" },
  ".cm-content": { fontFamily: "var(--mono)", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
});

let saveTimer = null;
const editor = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      keymap.of([
        { key: "Mod-Enter", run: () => (run(), true), preventDefault: true },
        { key: "Shift-Enter", run: () => (run(), true), preventDefault: true },
        indentWithTab,
      ]),
      basicSetup,
      python(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => localStorage.setItem(DRAFT_KEY, code()), 400);
      }),
    ],
  }),
});

const code = () => editor.state.doc.toString();
function setCode(text) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

for (const [i, ex] of EXAMPLES.entries()) {
  els.example.add(new Option(ex.title, String(i)));
}
els.example.addEventListener("change", () => {
  const ex = EXAMPLES[Number(els.example.value)];
  const current = code();
  const untouched = !current.trim() || EXAMPLES.some((e) => e.code === current);
  if (untouched || confirm("Replace the code in the editor with this example?")) {
    setCode(ex.code);
  } else {
    els.example.value = String(EXAMPLES.findIndex((e) => e.code === current));
  }
});

// ---------------------------------------------------------------------------
// Share and download
// ---------------------------------------------------------------------------

// The code goes in the hash, deflated and base64url-encoded, so a link carries
// the whole script and the server never sees it.
async function encode(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decode(b64url) {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

els.share.addEventListener("click", async () => {
  const url = new URL(location.href);
  url.hash = `code=${await encode(code())}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url.href);
    setStatus("Link copied to the clipboard");
  } catch {
    setStatus("Link is in the address bar");
  }
});

els.download.addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([code()], { type: "text/x-python" }));
  a.download = "model.py";
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function selectTab(name) {
  for (const b of document.querySelectorAll("[role=tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  }
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
}
for (const b of document.querySelectorAll("[role=tab]")) {
  b.addEventListener("click", () => selectTab(b.dataset.tab));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// The transport prints a progress line every tenth of the run. Each one
// replaces the last rather than scrolling the useful output away.
let lastLine = null;
function appendOutput(text, kind) {
  const isProgress = kind === "stdout" && text.startsWith("Progress:");
  if (isProgress && lastLine && lastLine.dataset.progress) {
    lastLine.textContent = `${text}\n`;
    return;
  }
  const span = document.createElement("span");
  if (kind !== "stdout") span.className = kind;
  if (isProgress) span.dataset.progress = "1";
  span.textContent = `${text}\n`;
  els.output.append(span);
  lastLine = span;
  const body = els.output.parentElement;
  body.scrollTop = body.scrollHeight;
}

const FRAME_HEIGHT_REPORTER =
  "<script>new ResizeObserver(() => parent.postMessage(" +
  "{ yamcFrameHeight: document.documentElement.scrollHeight }, '*'))" +
  ".observe(document.documentElement);</script>";

// Frames only shrink to their content, never grow past the CSS height: a
// viewer that sizes itself to the frame would otherwise grow without end.
const frames = new Map();
window.addEventListener("message", (e) => {
  const height = e.data && e.data.yamcFrameHeight;
  if (typeof height !== "number") return;
  for (const frame of frames.keys()) {
    if (frame.contentWindow !== e.source) continue;
    const max = parseFloat(getComputedStyle(frame).maxHeight) || Infinity;
    frame.style.height = `${Math.min(height + 4, max)}px`;
  }
});

let plotCount = 0;
function addPlot(html, title) {
  if (plotCount === 0) els.plots.replaceChildren();
  plotCount += 1;
  els.plotCount.textContent = String(plotCount);
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  const label = document.createElement("span");
  label.textContent = title;
  const save = document.createElement("button");
  save.textContent = "Save .html";
  save.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `${title.replace(/[^\w.-]+/g, "_")}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  caption.append(label, save);
  // Sandboxed: scripts run, but in an opaque origin, so a plot cannot reach
  // the page, its storage, or the worker.
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = title;
  // The page cannot measure an opaque-origin frame, so the frame reports its
  // own height. A summary table is a few rows; without this it would sit in
  // the same tall box as an interactive viewer.
  frame.srcdoc = html + FRAME_HEIGHT_REPORTER;
  frames.set(frame, figure);
  figure.append(caption, frame);
  els.plots.append(figure);
}

function clearResults() {
  els.output.replaceChildren();
  lastLine = null;
  plotCount = 0;
  frames.clear();
  els.plotCount.textContent = "";
  els.plots.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.innerHTML = "Plots from <code>show()</code> and the last line of the script appear here.";
  els.plots.append(empty);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Per nuclide (or element, for photon data) across the session. Reruns read
// from the in-memory cache and add nothing, so this is what the page holds.
const fetched = new Map();
let runFetch = { requests: 0, bytes: 0 };
let memory = { heap: 0, held: 0 };
let session = { dataOrigin: "" };

function recordFetch(f) {
  // https://yamc-data.xsplot.com/<library>/<kind>/<Name>.arrow/<section>
  const parts = new URL(f.url).pathname.split("/").filter(Boolean);
  const [library, kind] = parts;
  const name = (parts[2] || f.url).replace(/\.arrow$/, "");
  const key = `${library}/${kind}/${name}`;
  const row = fetched.get(key) || { library, kind, name, requests: 0, bytes: 0, missing: 0 };
  row.requests += 1;
  row.bytes += f.bytes;
  if (f.status === 404) row.missing += 1;
  fetched.set(key, row);
  runFetch.requests += 1;
  runFetch.bytes += f.bytes;
  setStatus(`Fetching ${name} (${mb(runFetch.bytes)} so far)`);
  if (!document.querySelector('[data-panel="data"]').hidden) renderData();
}

function renderData() {
  const rows = [...fetched.values()].sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const requests = rows.reduce((s, r) => s + r.requests, 0);
  const parts = [];
  parts.push(`<p>Nuclear data is fetched from <code>${escapeHtml(session.dataOrigin)}</code> the first time a
    run needs it, only for the nuclides in the model's materials, and kept in memory so reruns fetch nothing.</p>`);
  parts.push(`<table><tbody>
    <tr><td>Downloaded this session</td><td class="num">${mb(total)}</td><td class="num">${requests} requests</td></tr>
    <tr><td>Held in memory as files</td><td class="num">${mb(memory.held)}</td><td></td></tr>
    <tr><td>Python heap</td><td class="num">${mb(memory.heap)}</td><td class="num">of about 2048 MB</td></tr>
  </tbody></table>`);
  if (memory.heap > 1.5 * 1073741824) {
    parts.push(`<p class="warn">The Python heap is close to the browser's limit. Fewer nuclides, or
      clearing the held data, leaves more room.</p>`);
  }
  parts.push(`<p><button id="clear-data" ${state === "ready" && memory.held ? "" : "disabled"}>Clear held data</button></p>`);
  if (rows.length) {
    parts.push(`<table><thead><tr><th>Nuclide</th><th>Library</th><th class="num">Requests</th><th class="num">Downloaded</th></tr></thead><tbody>`);
    for (const r of rows) {
      const kind = r.kind === "neutron" ? "" : ` (${escapeHtml(r.kind)})`;
      parts.push(`<tr><td>${escapeHtml(r.name)}${kind}</td><td>${escapeHtml(r.library)}</td>
        <td class="num">${r.requests}</td><td class="num">${mb(r.bytes)}</td></tr>`);
    }
    parts.push("</tbody></table>");
  } else {
    parts.push('<p class="empty">Nothing fetched yet.</p>');
  }
  parts.push(`<p class="note">yamc ${escapeHtml(session.yamc || "")}, Python ${escapeHtml(session.python || "")},
    Pyodide ${escapeHtml(session.pyodide || PYODIDE_VERSION)}, built from core
    <code>${escapeHtml(CORE_COMMIT.slice(0, 12))}</code>.</p>`);
  els.data.innerHTML = parts.join("");
  const clear = $("clear-data");
  if (clear) clear.addEventListener("click", () => worker.postMessage({ type: "clearData" }));
}
document.querySelector('[data-tab="data"]').addEventListener("click", renderData);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker = null;
let state = "booting"; // booting | ready | running
let interrupt = null;
let stopTimer = null;
let bootStarted = 0;

function setStatus(text) {
  els.status.textContent = text;
}

function setState(next) {
  state = next;
  els.run.disabled = state !== "ready";
  els.stop.disabled = state !== "running";
}

function startWorker() {
  setState("booting");
  bootStarted = performance.now();
  worker = new Worker("worker.js", { type: "module" });
  // An interrupt buffer needs SharedArrayBuffer, which needs cross-origin
  // isolation. Without it Stop falls back to restarting Python.
  interrupt = self.crossOriginIsolated ? new Uint8Array(new SharedArrayBuffer(1)) : null;
  const data = new URLSearchParams(location.search).get("data");
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    appendOutput(`The Python worker failed to start: ${e.message || "unknown error"}`, "stderr");
    setStatus("Python failed to start");
  };
  worker.postMessage({
    type: "init",
    pyodideBase: PYODIDE_BASE,
    wheelUrl: new URL(WHEEL, location.href).href,
    data: data ? new URL(data, location.href).href : null,
    interruptBuffer: interrupt,
  });
}

function restartWorker(reason) {
  worker.terminate();
  clearTimeout(stopTimer);
  appendOutput(reason, "note");
  // The held data went with the old worker's memory.
  fetched.clear();
  memory = { heap: 0, held: 0 };
  startWorker();
}

function onWorkerMessage(msg) {
  switch (msg.type) {
    case "status":
      setStatus(`${msg.text}...`);
      break;
    case "ready":
      session = msg;
      memory = msg.memory;
      setState("ready");
      setStatus(`Ready: yamc ${msg.yamc} on Python ${msg.python} ` +
        `(started in ${((performance.now() - bootStarted) / 1000).toFixed(1)} s)`);
      if (pendingRun) {
        pendingRun = false;
        run();
      }
      break;
    case "stdout":
    case "stderr":
      appendOutput(msg.text, msg.type);
      break;
    case "plot":
      addPlot(msg.html, msg.title);
      break;
    case "fetch":
      recordFetch(msg);
      break;
    case "done": {
      clearTimeout(stopTimer);
      memory = msg.memory;
      setState("ready");
      const fetchedNote = runFetch.requests ? `, fetched ${mb(runFetch.bytes)} of nuclear data` : "";
      setStatus(`${msg.ok ? "Finished" : "Failed"} in ${msg.seconds.toFixed(1)} s${fetchedNote}`);
      // Land on what the run produced: its plots if it drew any and did not
      // fail, otherwise the output, where an error would be.
      selectTab(msg.ok && plotCount ? "plots" : "output");
      if (interrupt) interrupt[0] = 0;
      break;
    }
    case "cleared":
      memory = msg.memory;
      fetched.clear();
      renderData();
      setStatus("Held nuclear data cleared");
      break;
    case "fatal":
      if (state === "booting") {
        // Restarting would only fail the same way, and forever: the CDN is
        // unreachable, or this browser cannot run Pyodide.
        appendOutput(`Python could not start: ${msg.message}`, "stderr");
        setStatus("Python could not start; reload to try again");
        break;
      }
      appendOutput(`Python stopped: ${msg.message}`, "stderr");
      restartWorker("Restarting Python. Downloaded nuclear data will be fetched again.");
      selectTab("output");
      break;
    default:
      break;
  }
}

let pendingRun = false;
function run() {
  if (state === "booting") {
    // Queue it: the click is a request, and Python is a few seconds away.
    pendingRun = true;
    setStatus("Run queued until Python has started...");
    return;
  }
  if (state !== "ready") return;
  clearResults();
  selectTab("output");
  runFetch = { requests: 0, bytes: 0 };
  setState("running");
  setStatus("Running...");
  worker.postMessage({ type: "run", code: code() });
}

function stop() {
  if (state !== "running") return;
  if (interrupt) {
    interrupt[0] = 2; // SIGINT
    setStatus("Stopping...");
    stopTimer = setTimeout(() => restartWorker("Stopped. Python was restarted."), INTERRUPT_GRACE_MS);
  } else {
    restartWorker("Stopped. Python was restarted.");
  }
}

els.run.addEventListener("click", run);
els.stop.addEventListener("click", stop);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function initialCode() {
  const hash = new URLSearchParams(location.hash.slice(1)).get("code");
  if (hash) {
    try {
      return await decode(hash);
    } catch {
      appendOutput("The link's code could not be read; showing the default example.", "stderr");
    }
  }
  return localStorage.getItem(DRAFT_KEY) || EXAMPLES[0].code;
}

setCode(await initialCode());
els.example.value = String(Math.max(0, EXAMPLES.findIndex((e) => e.code === code())));
startWorker();

// Exposed for verify.mjs, which drives the page through the same functions
// the buttons call.
window.yamcOnline = {
  run,
  stop,
  setCode,
  code,
  get state() { return state; },
  get plots() { return plotCount; },
  get fetched() { return [...fetched.values()]; },
};
