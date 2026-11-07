import { EditorView, ViewPlugin } from "@codemirror/view";
import { findTables, gridLine } from "@k2b/ui/text-editor/model";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";

// These identities have already been assigned by Mail's trusted awareness transport.
const peerSchema = z.object({
  user: z.object({ name: z.string().min(1), color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  cursor: z.object({ head: z.object({}).passthrough(), anchor: z.object({}).passthrough() }),
});
export const mailDraftPeers = (text: Y.Text, awareness: Awareness) => {
  const peers: { name: string; color: string; position: number }[] = [];
  if (!text.doc) return peers;
  for (const [clientId, value] of awareness.getStates()) {
    if (clientId === text.doc.clientID) continue;
    const peer = peerSchema.safeParse(value);
    if (!peer.success) continue;
    try {
      const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(peer.data.cursor.head), text.doc);
      if (position?.type === text) peers.push({ ...peer.data.user, position: position.index });
    } catch {
      /* An expired/deleted cursor never makes another cell appear occupied. */
    }
  }
  return peers;
};

/** Decorate the existing table grid without touching its editable text or rebuilding widgets. */
export const mailDraftTablePresence = (text: Y.Text, awareness: Awareness) => [
  EditorView.baseTheme({
    ".k2b-ste-cell[data-mail-peer]": {
      position: "relative",
      boxShadow: "inset 0 0 0 2px var(--mail-peer-color)",
      backgroundColor: "var(--mail-peer-fill)",
    },
    ".k2b-ste-cell[data-mail-peer]::after": {
      content: "attr(data-mail-peer)",
      position: "absolute",
      right: "2px",
      top: "-13px",
      fontSize: "10px",
      lineHeight: "13px",
      backgroundColor: "var(--mail-peer-color)",
      color: "white",
      padding: "0 3px",
      borderRadius: "3px",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      zIndex: "2",
    },
  }),
  ViewPlugin.fromClass(
    class {
      frame = 0;
      disposed = false;
      constructor(readonly view: EditorView) {
        awareness.on("change", this.schedule);
        text.doc?.on("afterTransaction", this.schedule);
        this.schedule();
      }
      schedule = () => {
        if (this.frame || this.disposed) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          if (this.disposed) return;
          const tables = findTables(this.view.state.doc.toString()),
            peers = mailDraftPeers(text, awareness);
          for (const cell of this.view.dom.querySelectorAll<HTMLElement>(".k2b-ste-cell")) {
            delete cell.dataset.mailPeer;
            cell.style.removeProperty("--mail-peer-color");
            cell.style.removeProperty("--mail-peer-fill");
            cell.removeAttribute("aria-description");
            const wrap = cell.closest<HTMLElement>(".k2b-ste-table");
            if (!wrap) continue;
            let from: number;
            try {
              from = this.view.posAtDOM(wrap);
            } catch {
              continue;
            }
            const table = tables.find((table) => table.from === from);
            const range = table && gridLine(table, Number(cell.dataset.r))?.cells[Number(cell.dataset.c)];
            if (!range) continue;
            const present = peers.filter((peer) => peer.position >= range.from && peer.position <= range.to);
            if (!present.length) continue;
            cell.dataset.mailPeer = present.map((peer) => peer.name).join(", ");
            cell.setAttribute("aria-description", cell.dataset.mailPeer);
            cell.style.setProperty("--mail-peer-color", present[0]!.color);
            cell.style.setProperty("--mail-peer-fill", `${present[0]!.color}22`);
          }
        });
      };
      update() {
        this.schedule();
      }
      destroy() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        awareness.off("change", this.schedule);
        text.doc?.off("afterTransaction", this.schedule);
      }
    },
  ),
];
