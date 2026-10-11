import { Annotation, EditorSelection, type Extension } from "@codemirror/state";
import { BlockType, EditorView, type LayerMarker, layer, RectangleMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

// Long enough to read a name after the caret stops, short enough that a pause in typing clears the text it covers.
export const REMOTE_CARET_LABEL_IDLE_MS = 3_000;
export const REMOTE_CARET_IDLE_CLASS = "cm-remoteCaret-idle";

const hasCursor = (cursor: unknown): cursor is { anchor: object; head: object } =>
  typeof cursor === "object" &&
  cursor !== null &&
  "anchor" in cursor &&
  typeof cursor.anchor === "object" &&
  cursor.anchor !== null &&
  "head" in cursor &&
  typeof cursor.head === "object" &&
  cursor.head !== null;

const remoteCursorsAnnotation = Annotation.define<boolean>();

class RemoteSelectionMarker implements LayerMarker {
  constructor(
    readonly rect: RectangleMarker,
    readonly color: string,
  ) {}

  eq(other: LayerMarker) {
    return other instanceof RemoteSelectionMarker && this.rect.eq(other.rect) && this.color === other.color;
  }

  draw() {
    const dom = this.rect.draw();
    dom.style.backgroundColor = this.color;
    return dom;
  }

  update(dom: HTMLElement, old: LayerMarker) {
    if (!(old instanceof RemoteSelectionMarker)) return false;
    this.rect.update(dom, old.rect);
    dom.style.backgroundColor = this.color;
    return true;
  }
}

class RemoteCaretMarker implements LayerMarker {
  constructor(
    readonly rect: RectangleMarker,
    readonly color: string,
    readonly name: string,
    readonly idle: boolean,
  ) {}

  eq(other: LayerMarker) {
    return (
      other instanceof RemoteCaretMarker &&
      this.rect.eq(other.rect) &&
      this.color === other.color &&
      this.name === other.name &&
      this.idle === other.idle
    );
  }

  draw() {
    const dom = this.rect.draw();
    const dot = document.createElement("div");
    dot.className = "cm-remoteCaretDot";
    const label = document.createElement("div");
    label.className = "cm-remoteCaretLabel";
    dom.append(dot, label);
    this.patch(dom);
    return dom;
  }

  update(dom: HTMLElement, old: LayerMarker) {
    if (!(old instanceof RemoteCaretMarker)) return false;
    this.rect.update(dom, old.rect);
    this.patch(dom);
    return true;
  }

  private patch(dom: HTMLElement) {
    dom.style.setProperty("--remote-color", this.color);
    dom.classList.toggle(REMOTE_CARET_IDLE_CLASS, this.idle);
    const label = dom.querySelector(".cm-remoteCaretLabel");
    if (label) label.textContent = this.name;
  }
}

const remoteCursorTheme = EditorView.theme({
  ".cm-remoteCaretLayer, .cm-remoteSelectionLayer": { pointerEvents: "none" },
  ".cm-remoteCaret": { position: "absolute", width: "2px", marginLeft: "-1px", backgroundColor: "var(--remote-color)" },
  // The name flag meets the top of the caret and continues its left edge.
  ".cm-remoteCaretLabel": {
    position: "absolute",
    left: "0",
    bottom: "100%",
    padding: "0 4px",
    borderRadius: "4px 4px 4px 0",
    backgroundColor: "var(--remote-color)",
    color: "#fff",
    font: "500 11px/15px var(--font-sans)",
    whiteSpace: "nowrap",
    userSelect: "none",
    opacity: "1",
    transition: "none",
  },
  // An idle caret keeps a dot as the hover target for its name.
  ".cm-remoteCaretDot": {
    position: "absolute",
    left: "-2px",
    top: "-3px",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "var(--remote-color)",
    opacity: "0",
  },
  // Only a visible dot takes the pointer; an invisible one would swallow presses on the text below it.
  ".cm-remoteCaret-idle .cm-remoteCaretDot": { opacity: "1", pointerEvents: "auto" },
  ".cm-remoteCaret-idle:not(:hover) .cm-remoteCaretLabel": { opacity: "0", transition: "opacity 300ms ease-out" },
  "@media (prefers-reduced-motion: reduce)": { ".cm-remoteCaret-idle:not(:hover) .cm-remoteCaretLabel": { transition: "none" } },
});

export const remoteCursors = (ytext: Y.Text, awareness: Awareness): Extension => {
  if (!ytext.doc) throw new Error("Remote cursors require a Y.Text attached to a document");
  const doc = ytext.doc;

  const plugin = ViewPlugin.fromClass(
    class {
      lastActive = new Map<number, number>();
      cursorKeys = new Map<number, string>();
      nullCursors = new Set<number>();
      deletions: { position: Y.RelativePosition; time: number }[] = [];
      timer: ReturnType<typeof setTimeout> | undefined;

      constructor(readonly view: EditorView) {
        this.trackCursors([...awareness.getStates().keys()]);
        awareness.on("change", this.onAwarenessChange);
        ytext.observe(this.onTextChange);
        doc.on("afterTransaction", this.onTransaction);
        this.apply();
      }

      trackCursors(clients: number[]) {
        for (const client of clients) {
          if (client === doc.clientID) continue;
          const cursor: unknown = awareness.getStates().get(client)?.cursor;
          if (!hasCursor(cursor)) {
            this.nullCursors.add(client);
            continue;
          }
          if (this.nullCursors.delete(client)) {
            const now = Date.now();
            this.pruneDeletions(now);
            const position = Y.createRelativePositionFromJSON(cursor.head);
            const head = Y.createAbsolutePositionFromRelativePosition(position, doc);
            const deletion = this.deletions.findIndex(({ position: deleted }) => {
              if (Y.compareRelativePositions(position, deleted)) return true;
              const absolute = Y.createAbsolutePositionFromRelativePosition(deleted, doc);
              return head?.type === ytext && absolute?.type === ytext && head.index === absolute.index;
            });
            if (deletion !== -1) {
              this.lastActive.set(client, now);
              this.deletions.splice(deletion, 1);
            }
          }
          const key = JSON.stringify([cursor.anchor, cursor.head]);
          if (this.cursorKeys.get(client) === key) continue;
          this.cursorKeys.set(client, key);
          this.lastActive.set(client, Date.now());
        }
      }

      onAwarenessChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        this.trackCursors([...added, ...updated]);
        // Keep the key when a cursor is nulled: republishing it is not activity.
        for (const client of removed) {
          this.lastActive.delete(client);
          this.cursorKeys.delete(client);
          this.nullCursors.delete(client);
        }
        if ([...added, ...updated, ...removed].some((client) => client !== doc.clientID)) {
          this.apply();
          this.redraw();
        }
      };

      pruneDeletions(now: number) {
        this.deletions = this.deletions.filter(({ time }) => now - time < REMOTE_CARET_LABEL_IDLE_MS);
      }

      onTextChange = (event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.local) return;
        const now = Date.now();
        let index = 0;
        for (const op of event.delta) {
          if (op.retain !== undefined) index += op.retain;
          if (op.insert !== undefined) index += typeof op.insert === "string" ? op.insert.length : 1;
          if (op.delete === undefined) continue;
          let matched = false;
          for (const [client, state] of awareness.getStates()) {
            if (client === doc.clientID || !hasCursor(state.cursor)) continue;
            const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), doc);
            if (head?.type !== ytext || head.index !== index) continue;
            this.lastActive.set(client, now);
            matched = true;
          }
          if (!matched) {
            // The deletion can arrive before an idle sender republishes its cursor.
            this.pruneDeletions(now);
            this.deletions.push({ position: Y.createRelativePositionFromTypeIndex(ytext, index), time: now });
          }
        }
      };

      onTransaction = (transaction: Y.Transaction) => {
        if (transaction.local) return;
        // The clients whose clocks advanced wrote this update.
        for (const [client, clock] of transaction.afterState) {
          if (clock > (transaction.beforeState.get(client) ?? 0)) this.lastActive.set(client, Date.now());
        }
        // Yjs observers have already dispatched the view update before this event.
        this.apply();
        this.redraw();
      };

      apply() {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        const now = Date.now();
        let nextDeadline = Infinity;
        for (const lastActive of this.lastActive.values()) {
          const deadline = lastActive + REMOTE_CARET_LABEL_IDLE_MS;
          if (deadline > now) nextDeadline = Math.min(nextDeadline, deadline);
        }
        if (nextDeadline !== Infinity)
          this.timer = setTimeout(() => {
            this.apply();
            this.redraw();
          }, nextDeadline - now);
      }

      redraw() {
        this.view.dispatch({ annotations: remoteCursorsAnnotation.of(true) });
      }

      update(update: ViewUpdate) {
        if (!update.selectionSet && !update.docChanged && !update.focusChanged) return;
        const localState = awareness.getLocalState();
        if (localState !== null) {
          const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
          const selection = hasFocus ? update.state.selection.main : null;
          const cursor: unknown = localState.cursor;
          const currentAnchor = hasCursor(cursor) ? Y.createRelativePositionFromJSON(cursor.anchor) : null;
          const currentHead = hasCursor(cursor) ? Y.createRelativePositionFromJSON(cursor.head) : null;
          if (selection !== null) {
            const anchor = Y.createRelativePositionFromTypeIndex(ytext, selection.anchor);
            const head = Y.createRelativePositionFromTypeIndex(ytext, selection.head);
            if (
              !currentAnchor ||
              !currentHead ||
              !Y.compareRelativePositions(currentAnchor, anchor) ||
              !Y.compareRelativePositions(currentHead, head)
            ) {
              awareness.setLocalStateField("cursor", { anchor, head });
            }
          } else if (cursor != null && hasFocus) {
            awareness.setLocalStateField("cursor", null);
          }
        }
      }

      destroy() {
        awareness.off("change", this.onAwarenessChange);
        ytext.unobserve(this.onTextChange);
        doc.off("afterTransaction", this.onTransaction);
        if (this.timer !== undefined) clearTimeout(this.timer);
      }
    },
  );

  const clients = (view: EditorView) => {
    const result: { anchor: number; head: number; color: string; name: string; idle: boolean }[] = [];
    for (const [client, state] of awareness.getStates()) {
      const cursor: unknown = state.cursor;
      if (client === doc.clientID || !hasCursor(cursor)) continue;
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), doc);
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
      if (anchor?.type !== ytext || head?.type !== ytext) continue;
      const user: unknown = state.user;
      const color = typeof user === "object" && user !== null && "color" in user && typeof user.color === "string" ? user.color : "#30bced";
      const name = typeof user === "object" && user !== null && "name" in user && typeof user.name === "string" ? user.name : "Anonymous";
      const lastActive = view.plugin(plugin)?.lastActive.get(client);
      result.push({
        anchor: anchor.index,
        head: head.index,
        color,
        name,
        idle: lastActive === undefined || Date.now() - lastActive >= REMOTE_CARET_LABEL_IDLE_MS,
      });
    }
    return result;
  };
  const update = (update: ViewUpdate) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.transactions.some((tr) => tr.annotation(remoteCursorsAnnotation));

  return [
    plugin,
    layer({
      above: false,
      class: "cm-remoteSelectionLayer",
      update,
      markers: (view) =>
        clients(view).flatMap(({ anchor, head, color }) =>
          anchor === head
            ? []
            : RectangleMarker.forRange(view, "cm-remoteSelection", EditorSelection.range(anchor, head)).map(
                (rect) => new RemoteSelectionMarker(rect, color + "33"),
              ),
        ),
    }),
    layer({
      above: true,
      class: "cm-remoteCaretLayer",
      update,
      markers: (view) =>
        clients(view).flatMap(({ anchor, head, color, name, idle }) => {
          const block = view.lineBlockAt(head);
          if (block.type === BlockType.WidgetRange) {
            if (head < view.viewport.from || head > view.viewport.to) return [];
            const base = view.scrollDOM.getBoundingClientRect();
            const edge = view.contentDOM.getBoundingClientRect();
            const padding = parseFloat(getComputedStyle(view.contentDOM).paddingLeft);
            const rect = new RectangleMarker(
              "cm-remoteCaret",
              edge.left + padding - base.left + view.scrollDOM.scrollLeft,
              view.documentTop + block.top - base.top + view.scrollDOM.scrollTop,
              null,
              view.defaultLineHeight,
            );
            return [new RemoteCaretMarker(rect, color, name, idle)];
          }
          return RectangleMarker.forRange(view, "cm-remoteCaret", EditorSelection.cursor(head, head > anchor ? -1 : 1)).map(
            (rect) => new RemoteCaretMarker(rect, color, name, idle),
          );
        }),
    }),
    remoteCursorTheme,
  ];
};
