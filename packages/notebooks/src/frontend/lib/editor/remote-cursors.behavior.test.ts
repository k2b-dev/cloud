import { describe, expect, jest, spyOn, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const measurements: (() => void)[] = [];
const settle = async () => {
  for (const measure of measurements.splice(0)) measure();
};

const mount = async (seedCursors = false, text = "Collaborative notes") => {
  const dom = createDomTestHarness();
  // lib0 captures document at import time, so load caret widgets after the harness.
  const Y = await import("yjs");
  const { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
  const { yCollab } = await import("y-codemirror.next");
  const { REMOTE_CARET_IDLE_CLASS, remoteCursors } = await import("./remote-cursors");
  jest.useFakeTimers();
  const doc = new Y.Doc();
  const ytext = doc.getText("codemirror");
  ytext.insert(0, text);
  const awareness = new Awareness(doc);

  const remote = (name: string, color: string) => {
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
    const text = remoteDoc.getText("codemirror");
    const remoteAwareness = new Awareness(remoteDoc);
    remoteAwareness.setLocalStateField("user", { name, color });
    const publish = () => applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]), "remote");
    const setCursor = (head: number, anchor = head) => {
      const cursor = {
        anchor: Y.createRelativePositionFromTypeIndex(text, anchor),
        head: Y.createRelativePositionFromTypeIndex(text, head),
      };
      remoteAwareness.setLocalStateField("cursor", cursor);
      publish();
      return cursor;
    };
    const caret = async () => {
      await settle();
      const element = dom.root.querySelector<HTMLElement>(`.cm-remoteCaret[style*="${color}"]`);
      expect(element).not.toBeNull();
      return element!;
    };
    const idle = async () => (await caret()).classList.contains(REMOTE_CARET_IDLE_CLASS);
    return { doc: remoteDoc, text, awareness: remoteAwareness, publish, setCursor, caret, idle };
  };

  const ada = remote("Ada", "#ff0000");
  const grace = remote("Grace", "#0000ff");
  if (seedCursors) {
    ada.setCursor(2);
    grace.setCursor(10);
  }
  // happy-dom has no layout; run layer measurements with fixed cursor coordinates.
  const measuring = spyOn(EditorView.prototype, "requestMeasure").mockImplementation(function (this: EditorView, request) {
    if (request) measurements.push(() => request.write?.(request.read(this), this));
  });
  const view = new EditorView({
    parent: dom.root,
    doc: ytext.toString(),
    extensions: [yCollab(ytext, null), remoteCursors(ytext, awareness)],
  });
  // Layers draw after CodeMirror measures the document.
  spyOn(view, "coordsAtPos").mockImplementation((pos) => ({ left: pos * 8, right: pos * 8, top: 0, bottom: 20 }));
  view.dispatch({});
  return {
    view,
    awareness,
    applyRemoteUpdate: () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(ada.doc), "remote"),
    ada,
    grace,
    cleanup: () => {
      view.destroy();
      measuring.mockRestore();
      measurements.length = 0;
      awareness.destroy();
      ada.awareness.destroy();
      grace.awareness.destroy();
      doc.destroy();
      ada.doc.destroy();
      grace.doc.destroy();
      dom.cleanup();
      jest.useRealTimers();
    },
  };
};

describe("remote cursors", () => {
  if (isServer) {
    test.skip("remote cursors run with browser export conditions", () => {});
    return;
  }

  test("each joining client's label stays visible for exactly three seconds", async () => {
    const { ada, grace, cleanup } = await mount();
    try {
      ada.setCursor(2);
      expect(await ada.idle()).toBe(false);
      jest.advanceTimersByTime(1_000);
      grace.setCursor(10);
      expect(await grace.idle()).toBe(false);
      jest.advanceTimersByTime(1_999);
      expect(await ada.idle()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(false);
      expect((await ada.caret()).querySelector(".cm-remoteCaretLabel")?.textContent).toBe("Ada");
      jest.advanceTimersByTime(999);
      expect(await grace.idle()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("cursor and selection movement reactivate only that client's label", async () => {
    const { ada, grace, cleanup } = await mount();
    try {
      ada.setCursor(2);
      grace.setCursor(10);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
      ada.setCursor(3);
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      ada.setCursor(3, 1);
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("remote typing reactivates the label even when the relative cursor is unchanged", async () => {
    const { view, applyRemoteUpdate, ada, grace, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(2);
      grace.setCursor(10);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
      ada.text.insert(0, "New ");
      applyRemoteUpdate();
      expect(view.state.doc.toString()).toBe("New Collaborative notes");
      expect(JSON.stringify(ada.awareness.getLocalState()?.cursor)).toBe(JSON.stringify(cursor));
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("remote Backspace mid-text reactivates only that client's label", async () => {
    const { applyRemoteUpdate, ada, grace, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(5);
      grace.setCursor(10);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
      ada.text.delete(4, 1);
      applyRemoteUpdate();
      expect(JSON.stringify(ada.awareness.getLocalState()?.cursor)).toBe(JSON.stringify(cursor));
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("remote Backspace at the end of the document reactivates the label", async () => {
    const { applyRemoteUpdate, ada, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(ada.text.length);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      ada.text.delete(ada.text.length - 1, 1);
      applyRemoteUpdate();
      expect(JSON.stringify(ada.awareness.getLocalState()?.cursor)).toBe(JSON.stringify(cursor));
      expect(await ada.idle()).toBe(false);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("remote Backspace after nulling the cursor reactivates the republished caret", async () => {
    const { applyRemoteUpdate, ada, grace, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(5);
      grace.setCursor(10);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      ada.awareness.setLocalStateField("cursor", null);
      ada.publish();
      ada.text.delete(4, 1);
      applyRemoteUpdate();
      ada.awareness.setLocalStateField("cursor", cursor);
      ada.publish();
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a republished cursor pointing at deleted text matches by absolute position", async () => {
    const { applyRemoteUpdate, ada, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(4);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      ada.awareness.setLocalStateField("cursor", null);
      ada.publish();
      ada.text.delete(4, 1);
      applyRemoteUpdate();
      ada.awareness.setLocalStateField("cursor", cursor);
      ada.publish();
      expect(await ada.idle()).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("republishing the same cursor after a remembered deletion expires stays idle", async () => {
    const { applyRemoteUpdate, ada, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(5);
      jest.advanceTimersByTime(3_000);
      ada.awareness.setLocalStateField("cursor", null);
      ada.publish();
      ada.text.delete(4, 1);
      applyRemoteUpdate();
      jest.advanceTimersByTime(3_000);
      ada.awareness.setLocalStateField("cursor", cursor);
      ada.publish();
      expect(await ada.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("nulling and republishing the same cursor creates an immediately idle caret", async () => {
    const { view, ada, grace, cleanup } = await mount();
    try {
      const cursor = ada.setCursor(2);
      grace.setCursor(10);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      ada.awareness.setLocalStateField("cursor", null);
      ada.publish();
      await settle();
      expect(view.dom.querySelectorAll(".cm-remoteCaret")).toHaveLength(1);
      ada.awareness.setLocalStateField("cursor", cursor);
      ada.publish();
      expect(await ada.idle()).toBe(true);
      view.dispatch({ selection: { anchor: 5 } });
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("cursors already present when the editor mounts get their initial activity window", async () => {
    const { ada, grace, cleanup } = await mount(true);
    try {
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(false);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("overlapping carets idle independently", async () => {
    const { ada, grace, cleanup } = await mount();
    try {
      ada.setCursor(2);
      grace.setCursor(2);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
      ada.setCursor(2, 1);
      expect(await ada.idle()).toBe(false);
      expect(await grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(await ada.idle()).toBe(true);
      expect(await grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });
  test("publishes the local relative cursor when the editor is focused", async () => {
    const { view, awareness, cleanup } = await mount();
    const focused = spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      view.focus();
      view.dispatch({ selection: { anchor: 3, head: 7 } });
      const Y = await import("yjs");
      const text = awareness.doc.getText("codemirror");
      expect(awareness.getLocalState()?.cursor).toEqual({
        anchor: Y.createRelativePositionFromTypeIndex(text, 3),
        head: Y.createRelativePositionFromTypeIndex(text, 7),
      });
    } finally {
      focused.mockRestore();
      cleanup();
    }
  });

  test("remote redraws keep an idle-hidden local cursor hidden until the local selection moves", async () => {
    const { view, awareness, ada, cleanup } = await mount();
    const focused = spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      const { REMOTE_CARET_LABEL_IDLE_MS } = await import("./remote-cursors");
      view.focus();
      view.dispatch({ selection: { anchor: 3 } });
      awareness.setLocalStateField("cursor", null);
      ada.setCursor(2);
      expect(awareness.getLocalState()?.cursor).toBeNull();
      jest.advanceTimersByTime(REMOTE_CARET_LABEL_IDLE_MS + 1);
      expect(await ada.idle()).toBe(true);
      expect(awareness.getLocalState()?.cursor).toBeNull();
      view.dispatch({ selection: { anchor: 1 } });
      const Y = await import("yjs");
      const text = awareness.doc.getText("codemirror");
      expect(awareness.getLocalState()?.cursor).toEqual({
        anchor: Y.createRelativePositionFromTypeIndex(text, 1),
        head: Y.createRelativePositionFromTypeIndex(text, 1),
      });
    } finally {
      focused.mockRestore();
      cleanup();
    }
  });

  test("draws a remote multi-line selection in a layer without decorating lines", async () => {
    const { view, ada, cleanup } = await mount(false, "First line\nSecond line\nLast line");
    try {
      const lines = Array.from(view.contentDOM.querySelectorAll(".cm-line"), (line) => line.outerHTML);
      ada.setCursor(25, 2);
      await settle();
      expect(view.dom.querySelectorAll(".cm-remoteSelection").length).toBeGreaterThan(1);
      expect(Array.from(view.contentDOM.querySelectorAll(".cm-line"), (line) => line.outerHTML)).toEqual(lines);
      expect(view.contentDOM.querySelector(".cm-remoteSelection, .cm-yLineSelection, .cm-ySelection")).toBeNull();
    } finally {
      cleanup();
    }
  });
  test("keeps a remote caret inside a rendered table without an inline widget", async () => {
    const { view, ada, cleanup } = await mount(false, "Before\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n\nAfter");
    try {
      const { markdownExtension } = await import("./markdown");
      const { tablesExtension } = await import("./tables");
      const { refreshMarkdownDecorationsEffect } = await import("./_lib/cursor-zone-field");
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        effects: StateEffect.appendConfig.of([markdownExtension(), tablesExtension("n1")]),
      });
      forceParsing(view, view.state.doc.length, 5000);
      view.dispatch({ effects: refreshMarkdownDecorationsEffect.of() });
      expect(view.contentDOM.querySelector(".cm-table-widget")).not.toBeNull();
      ada.setCursor(view.state.doc.toString().indexOf("Alpha") + 2);
      expect((await ada.caret()).parentElement?.classList.contains("cm-remoteCaretLayer")).toBe(true);
      expect(view.contentDOM.querySelector(".cm-remoteCaret")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("uses the default name and color when user metadata is missing", async () => {
    const { view, ada, cleanup } = await mount();
    try {
      ada.awareness.setLocalStateField("user", null);
      ada.setCursor(2);
      await settle();
      const caret = view.dom.querySelector<HTMLElement>(".cm-remoteCaret");
      expect(caret?.style.getPropertyValue("--remote-color")).toBe("#30bced");
      expect(caret?.querySelector(".cm-remoteCaretLabel")?.textContent).toBe("Anonymous");
    } finally {
      cleanup();
    }
  });

  test("ignores a remote cursor that resolves into another shared text", async () => {
    const { view, applyRemoteUpdate, ada, cleanup } = await mount();
    try {
      const Y = await import("yjs");
      const text = ada.doc.getText("other");
      text.insert(0, "Another note");
      applyRemoteUpdate();
      const position = Y.createRelativePositionFromTypeIndex(text, 3);
      ada.awareness.setLocalStateField("cursor", { anchor: position, head: position });
      ada.publish();
      await settle();
      expect(view.dom.querySelector(".cm-remoteCaret")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
