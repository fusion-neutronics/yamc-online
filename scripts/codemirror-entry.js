// Everything the page takes from CodeMirror, bundled into one ES module by
// scripts/vendor-codemirror.mjs. The page imports from the bundle, never from
// npm, so a build needs no node_modules.
export { EditorView, basicSetup } from "codemirror";
export { keymap } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { indentWithTab } from "@codemirror/commands";
export { python } from "@codemirror/lang-python";
export { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
export { tags } from "@lezer/highlight";
