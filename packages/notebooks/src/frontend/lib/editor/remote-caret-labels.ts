import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

// Long enough to read a name after the caret stops, short enough that a pause in typing clears the text it covers.
export const REMOTE_CARET_LABEL_IDLE_MS = 3_000;
export const REMOTE_CARET_IDLE_CLASS = "cm-ySelectionCaretIdle";

const hasCursor = (cursor: unknown): cursor is { anchor: object; head: object } =>
  typeof cursor === "object" &&
  cursor !== null &&
  "anchor" in cursor &&
  typeof cursor.anchor === "object" &&
  cursor.anchor !== null &&
  "head" in cursor &&
  typeof cursor.head === "object" &&
  cursor.head !== null;

export const remoteCaretLabels = (ytext: Y.Text, awareness: Awareness): Extension => {
  if (!ytext.doc) throw new Error("Remote caret labels require a Y.Text attached to a document");
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
        this.apply();
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
      };

      apply() {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        const now = Date.now();
        const activeHeads = new Set<number>();
        let nextDeadline = Infinity;
        for (const lastActive of this.lastActive.values()) {
          const deadline = lastActive + REMOTE_CARET_LABEL_IDLE_MS;
          if (deadline > now) nextDeadline = Math.min(nextDeadline, deadline);
        }
        for (const [client, state] of awareness.getStates()) {
          if (client === doc.clientID || !hasCursor(state.cursor)) continue;
          const lastActive = this.lastActive.get(client);
          if (lastActive === undefined || now - lastActive >= REMOTE_CARET_LABEL_IDLE_MS) continue;
          const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), doc);
          if (!head || head.type !== ytext) continue;
          activeHeads.add(head.index);
        }
        // Widgets reuse DOM and carry no client id; overlapping carets share visibility.
        for (const element of this.view.contentDOM.querySelectorAll(".cm-ySelectionCaret")) {
          element.classList.toggle(REMOTE_CARET_IDLE_CLASS, !activeHeads.has(this.view.posAtDOM(element)));
        }
        if (nextDeadline !== Infinity) this.timer = setTimeout(() => this.apply(), nextDeadline - now);
      }

      destroy() {
        awareness.off("change", this.onAwarenessChange);
        ytext.unobserve(this.onTextChange);
        doc.off("afterTransaction", this.onTransaction);
        if (this.timer !== undefined) clearTimeout(this.timer);
      }
    },
  );

  // Plugin updates run before the DOM is updated; listeners run after it, before paint.
  return [plugin, EditorView.updateListener.of(({ view }) => view.plugin(plugin)?.apply())];
};
