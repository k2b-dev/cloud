import { describe, expect, jest, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const mount = async (seedCursors = false) => {
  const dom = createDomTestHarness();
  // lib0 captures document at import time, so load caret widgets after the harness.
  const Y = await import("yjs");
  const { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
  const { yCollab } = await import("y-codemirror.next");
  const { REMOTE_CARET_IDLE_CLASS, remoteCaretLabels } = await import("./remote-caret-labels");
  jest.useFakeTimers();
  const doc = new Y.Doc();
  const ytext = doc.getText("codemirror");
  ytext.insert(0, "Collaborative notes");
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
    const caret = () => {
      const element = dom.root.querySelector<HTMLElement>(`.cm-ySelectionCaret[style*="${color}"]`);
      expect(element).not.toBeNull();
      return element!;
    };
    const idle = () => caret().classList.contains(REMOTE_CARET_IDLE_CLASS);
    return { doc: remoteDoc, text, awareness: remoteAwareness, publish, setCursor, caret, idle };
  };

  const ada = remote("Ada", "#ff0000");
  const grace = remote("Grace", "#0000ff");
  if (seedCursors) {
    ada.setCursor(2);
    grace.setCursor(10);
  }
  const view = new EditorView({
    parent: dom.root,
    doc: ytext.toString(),
    extensions: [yCollab(ytext, awareness), remoteCaretLabels(ytext, awareness)],
  });
  // y-codemirror creates remote decorations on the first view update.
  view.dispatch({});
  return {
    view,
    applyRemoteUpdate: () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(ada.doc), "remote"),
    ada,
    grace,
    cleanup: () => {
      view.destroy();
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

describe("remote caret labels", () => {
  if (isServer) {
    test.skip("remote caret labels run with browser export conditions", () => {});
    return;
  }

  test("each joining client's label stays visible for exactly three seconds", async () => {
    const { ada, grace, cleanup } = await mount();
    try {
      ada.setCursor(2);
      expect(ada.idle()).toBe(false);
      jest.advanceTimersByTime(1_000);
      grace.setCursor(10);
      expect(grace.idle()).toBe(false);
      jest.advanceTimersByTime(1_999);
      expect(ada.idle()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(false);
      expect(ada.caret().querySelector(".cm-ySelectionInfo")?.textContent).toBe("Ada");
      jest.advanceTimersByTime(999);
      expect(grace.idle()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(grace.idle()).toBe(true);
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
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
      ada.setCursor(3);
      expect(ada.idle()).toBe(false);
      expect(grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(ada.idle()).toBe(true);
      ada.setCursor(3, 1);
      expect(ada.idle()).toBe(false);
      expect(grace.idle()).toBe(true);
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
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
      ada.text.insert(0, "New ");
      applyRemoteUpdate();
      expect(view.state.doc.toString()).toBe("New Collaborative notes");
      expect(JSON.stringify(ada.awareness.getLocalState()?.cursor)).toBe(JSON.stringify(cursor));
      expect(ada.idle()).toBe(false);
      expect(grace.idle()).toBe(true);
      jest.advanceTimersByTime(3_000);
      expect(ada.idle()).toBe(true);
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
      expect(ada.idle()).toBe(true);
      ada.awareness.setLocalStateField("cursor", null);
      ada.publish();
      expect(view.contentDOM.querySelectorAll(".cm-ySelectionCaret")).toHaveLength(1);
      ada.awareness.setLocalStateField("cursor", cursor);
      ada.publish();
      expect(ada.idle()).toBe(true);
      view.dispatch({ selection: { anchor: 5 } });
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("cursors already present when the editor mounts get their initial activity window", async () => {
    const { ada, grace, cleanup } = await mount(true);
    try {
      expect(ada.idle()).toBe(false);
      expect(grace.idle()).toBe(false);
      jest.advanceTimersByTime(3_000);
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("overlapping carets stay visible while either client is active", async () => {
    const { ada, grace, cleanup } = await mount();
    try {
      ada.setCursor(2);
      grace.setCursor(2);
      jest.advanceTimersByTime(3_000);
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
      ada.setCursor(2, 1);
      expect(ada.idle()).toBe(false);
      expect(grace.idle()).toBe(false);
      jest.advanceTimersByTime(3_000);
      expect(ada.idle()).toBe(true);
      expect(grace.idle()).toBe(true);
    } finally {
      cleanup();
    }
  });
});
