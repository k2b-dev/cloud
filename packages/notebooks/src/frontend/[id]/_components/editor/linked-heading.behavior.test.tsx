import { describe, expect, test } from "bun:test";
import type { EditorView } from "@codemirror/view";
import { createCodeMirror } from "solid-codemirror";
import { type Accessor, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { createLinkedHeadingJump, type LinkedHeading } from "./linked-heading";

const markdown = "# Guide\n\nIntro\n\n## Restore\n\nSteps";
/** What Book answers for `markdown`: `## Restore` on line 5. */
const book = { markdown, headings: [{ id: "heading-restore", line: 5 }] };

/** Mounts an editor the way the note editor wires the jump; each Book request waits until the test answers it. */
const mount = (initial: LinkedHeading | null = null) => {
  const dom = createDomTestHarness();
  const [linkedHeading, setLinkedHeading] = createSignal<LinkedHeading | null>(initial);
  const requests: { signal: AbortSignal; answer: () => Promise<void> }[] = [];
  let jump!: ReturnType<typeof createLinkedHeadingJump>;
  let view!: Accessor<EditorView | undefined>;
  const dispose = render(() => {
    const { ref, createExtension, editorView } = createCodeMirror({ value: markdown });
    view = editorView;
    jump = createLinkedHeadingJump({
      noteId: "note01",
      linkedHeading,
      view: editorView,
      focus: false,
      loadHeadings: (signal) =>
        new Promise((resolve) => {
          requests.push({ signal, answer: () => (resolve(book), new Promise((done) => setTimeout(done, 0))) });
        }),
    });
    createExtension(jump.extension);
    return <div ref={ref} />;
  }, dom.root);
  return {
    jump,
    requests,
    setLinkedHeading,
    caret: () => view()!.state.selection.main.head,
    line: (number: number) => view()!.state.doc.line(number).from,
    dispatch: (spec: Parameters<EditorView["dispatch"]>[0]) => view()!.dispatch(spec),
    [Symbol.dispose]: () => {
      dispose();
      dom.cleanup();
    },
  };
};

describe("note editor linked heading", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("the address a note opens with moves the caret to the line Book gives the heading", async () => {
    using editor = mount({ noteId: "note01", id: "heading-restore" });
    expect(editor.jump.open()).toBe(true);
    await editor.requests[0]!.answer();
    expect(editor.caret()).toBe(editor.line(5));
  });

  test("an address for another note or without a heading opens nothing", () => {
    using other = mount({ noteId: "note02", id: "heading-restore" });
    expect(other.jump.open()).toBe(false);
    using plain = mount();
    expect(plain.jump.open()).toBe(false);
    expect([...other.requests, ...plain.requests]).toEqual([]);
  });

  test("a later link moves to its heading, and to the top when Book has no such heading", async () => {
    using editor = mount();
    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    await editor.requests[0]!.answer();
    expect(editor.caret()).toBe(editor.line(5));

    editor.setLinkedHeading({ noteId: "note01", id: "heading-missing" });
    await editor.requests[1]!.answer();
    expect(editor.caret()).toBe(0);
  });

  test("a jump still waiting for Book no longer applies once the address names no heading of this note", async () => {
    using editor = mount();
    editor.dispatch({ selection: { anchor: 3 } });
    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    // Back to the note's own entry, as the navigation coordinator reports it.
    editor.setLinkedHeading(null);
    expect(editor.requests[0]!.signal.aborted).toBe(true);
    await editor.requests[0]!.answer();
    expect(editor.caret()).toBe(3);

    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    editor.setLinkedHeading({ noteId: "note02", id: "heading-restore" });
    expect(editor.requests[1]!.signal.aborted).toBe(true);
    await editor.requests[1]!.answer();
    expect(editor.caret()).toBe(3);
  });

  test("a newer link, moving the caret, or typing cancels a waiting jump", async () => {
    using editor = mount();
    editor.dispatch({ selection: { anchor: 3 } });
    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    editor.setLinkedHeading({ noteId: "note01", id: "heading-missing" });
    expect(editor.requests[0]!.signal.aborted).toBe(true);
    await editor.requests[0]!.answer();
    expect(editor.caret()).toBe(3);
    await editor.requests[1]!.answer();
    expect(editor.caret()).toBe(0);

    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    editor.dispatch({ selection: { anchor: 3 }, userEvent: "select" });
    expect(editor.requests[2]!.signal.aborted).toBe(true);
    await editor.requests[2]!.answer();
    expect(editor.caret()).toBe(3);

    editor.setLinkedHeading({ noteId: "note01", id: "heading-restore" });
    editor.dispatch({ changes: { from: 3, insert: "x" }, selection: { anchor: 4 }, userEvent: "input.type" });
    expect(editor.requests[3]!.signal.aborted).toBe(true);
    await editor.requests[3]!.answer();
    expect(editor.caret()).toBe(4);
  });
});
