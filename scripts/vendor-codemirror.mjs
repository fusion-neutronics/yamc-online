// Rebuild vendor/codemirror.js from the versions pinned in package-lock.json.
//
// The bundle is committed, like the wheel, so `node build.mjs` and the Pages
// workflow need no npm install to produce the page. Run this after bumping a
// CodeMirror package:
//
//   npm ci && node scripts/vendor-codemirror.mjs

import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("./codemirror-entry.js", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "eof",
  outfile: new URL("../vendor/codemirror.js", import.meta.url).pathname,
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`vendor/codemirror.js  ${(bytes / 1024).toFixed(0)} kB`);
