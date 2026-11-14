import { expect, spyOn, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, RangeSet, StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { katexExtension } from "./katex";
import { listsExtension } from "./lists";
import { markdownExtension } from "./markdown";
import { markupExtension } from "./markup";

const block = (i: number) =>
  `## Section ${i}\n\nText **bold** and *italic*, \`code\`, [link](https://example.com/${i}).\n\n- first\n- second\n  - child\n\n`;

test("markup code exclusion work is linear in document size", () => {
  const doc = Array.from({ length: 400 }, (_, i) => block(i)).join("");
  let state = EditorState.create({ doc, extensions: [markdownExtension()] });
  ensureSyntaxTree(state, doc.length, 1000);
  let steps = 0;
  const original = Array.prototype.some;
  const probe = spyOn(Array.prototype, "some").mockImplementation(function (this: unknown[], predicate, thisArg) {
    return original.call(this, (value, index, array) => {
      steps++;
      return predicate.call(thisArg, value, index, array);
    });
  });
  try {
    state = state.update({ effects: [] }).state;
    // Reconfiguration installs markup against the completely parsed tree.
    state = state.update({ effects: StateEffect.appendConfig.of(markupExtension()) }).state;
  } finally {
    probe.mockRestore();
  }
  console.log(`Code exclusion work: ${steps} comparisons for ${doc.split("\n").length} lines`);
  expect(steps).toBeLessThan(400 * 100);
});

test.each(["markup", "lists"])("%s decorates only changed Markdown blocks", (kind) => {
  const doc = Array.from({ length: 400 }, (_, i) => block(i)).join("");
  const extension = kind === "markup" ? markupExtension() : listsExtension();
  let state = EditorState.create({ doc, extensions: [markdownExtension(), extension] });
  ensureSyntaxTree(state, doc.length, 1000);
  state = state.update({}).state;
  const at = doc.indexOf("Text", Math.floor(doc.length / 2)) + 2;
  state = state.update({ selection: { anchor: at } }).state;
  const replace = spyOn(Decoration, "replace");
  const line = spyOn(Decoration, "line");
  let count: number;
  try {
    state = state.update({ changes: { from: at, insert: "x" }, selection: { anchor: at + 1 } }).state;
    ensureSyntaxTree(state, state.doc.length, 1000);
    state = state.update({}).state;
    count = replace.mock.calls.length + line.mock.calls.length;
  } finally {
    replace.mockRestore();
    line.mockRestore();
  }
  console.log(`${kind}: ${count} decorations built for a local keystroke`);
  expect(count).toBeLessThan(100);
});

test("a caret on an empty line does not invalidate the entire note", () => {
  const doc = Array.from({ length: 400 }, (_, i) => block(i)).join("");
  let state = EditorState.create({ doc, extensions: [markdownExtension(), markupExtension()] });
  ensureSyntaxTree(state, doc.length, 1000);
  state = state.update({}).state;
  const at = doc.indexOf("\n\n", Math.floor(doc.length / 2)) + 1;
  const probe = spyOn(Decoration, "replace");
  let count: number;
  try {
    state = state.update({ selection: { anchor: at } }).state;
    count = probe.mock.calls.length;
  } finally {
    probe.mockRestore();
  }
  expect(count).toBeLessThan(100);
});

test("math code exclusion uses a bounded lookup for each formula", () => {
  const doc = Array.from({ length: 400 }, () => "`code`\n\n$x$\n\n").join("");
  let state = EditorState.create({ doc, extensions: [markdownExtension()] });
  ensureSyntaxTree(state, doc.length, 1000);
  let steps = 0;
  const original = Array.prototype.some;
  const probe = spyOn(Array.prototype, "some").mockImplementation(function (this: unknown[], predicate, thisArg) {
    return original.call(this, (value, index, array) => {
      steps++;
      return predicate.call(thisArg, value, index, array);
    });
  });
  try {
    state = state.update({ effects: StateEffect.appendConfig.of(katexExtension()) }).state;
  } finally {
    probe.mockRestore();
  }
  expect(steps).toBeLessThan(400 * 100);
});

test("typing beside escaped punctuation does not rebuild every formula", () => {
  const doc = "C\\# text\n\n" + Array.from({ length: 100 }, () => "$x$\n\n").join("");
  let state = EditorState.create({ doc, extensions: [markdownExtension(), katexExtension()] });
  ensureSyntaxTree(state, doc.length, 1000);
  state = state.update({}).state;
  const probe = spyOn(Decoration, "replace");
  let count: number;
  try {
    state = state.update({ changes: { from: 3, insert: "x" } }).state;
    count = probe.mock.calls.length;
  } finally {
    probe.mockRestore();
  }
  expect(count).toBeLessThan(2);
});

test("math inside indented code stays literal", () => {
  let state = EditorState.create({ doc: "    $x$", extensions: [markdownExtension(), katexExtension()] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  state = state.update({}).state;
  const decorations = state.facet(EditorView.decorations);
  expect(decorations.every((set) => typeof set !== "function" && set.size === 0)).toBe(true);
});

test("bulk parsing filters decoration sets once, rather than once per block", () => {
  let state = EditorState.create({ doc: "", extensions: [markdownExtension(), markupExtension(), listsExtension()] });
  const doc = Array.from({ length: 400 }, (_, i) => block(i)).join("");
  const update = spyOn(RangeSet.prototype, "update");
  let count: number;
  try {
    state = state.update({ changes: { from: 0, insert: doc } }).state;
    ensureSyntaxTree(state, doc.length, 1000);
    state = state.update({}).state;
    count = update.mock.calls.length;
  } finally {
    update.mockRestore();
  }
  expect(count).toBeLessThan(20);
});

test("report long-note typing latency (informational, no wall-clock assertion)", () => {
  for (const sections of [200, 1000]) {
    const doc = Array.from({ length: sections }, (_, i) => block(i)).join("");
    let state = EditorState.create({ doc, extensions: [markdownExtension(), markupExtension(), listsExtension()] });
    ensureSyntaxTree(state, doc.length, 1000);
    state = state.update({}).state;
    const at = doc.indexOf("Text", Math.floor(doc.length / 2)) + 2;
    state = state.update({ selection: { anchor: at } }).state;
    const start = performance.now();
    for (let i = 0; i < 15; i++) {
      state = state.update({ changes: { from: at + i, insert: "x" }, selection: { anchor: at + i + 1 } }).state;
      ensureSyntaxTree(state, state.doc.length, 1000);
      state = state.update({}).state;
    }
    console.log(`${state.doc.lines} lines: ${((performance.now() - start) / 15).toFixed(2)} ms/keystroke`);
  }
});
