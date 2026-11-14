import type { EditorSelection } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { htmlClipboardReady, loadHtmlClipboard } from "./clipboard";
import type { TableHost } from "./table";

type PendingPaste = {
  selection: EditorSelection;
  valid: boolean;
  edited: boolean;
  replaying: boolean;
  restore?: EditorSelection;
};

/** Preload on focus and map a delayed paste through edits at its original target. */
export const clipboardLoading = (getHost: (view: EditorView) => TableHost | null, syncSelection?: (view: EditorView) => void) =>
  ViewPlugin.define((view) => {
    let disposed = false;
    let pending: PendingPaste | undefined;
    const preload = () => {
      void loadHtmlClipboard().catch(() => {});
    };
    const paste = (event: ClipboardEvent) => {
      const host = getHost(view);
      const data = event.clipboardData;
      if (view.state.readOnly || htmlClipboardReady() || !data?.getData("text/html")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = data.getData("text/plain");
      const html = data.getData("text/html");
      if (text.length > (host?.maxLength ?? Infinity) || html.length > (host?.maxLength ?? Infinity)) {
        host?.onError("textTooLarge");
        return;
      }
      if (pending) {
        host?.onRecovery(text || html);
        return;
      }
      syncSelection?.(view);
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      clipboard.setData("text/html", html);
      for (const file of data.files) clipboard.items.add(file);
      const target = event.target;
      const focused = view.dom.ownerDocument.activeElement;
      const native = view.dom.ownerDocument.getSelection();
      const range = native?.rangeCount ? native.getRangeAt(0).cloneRange() : null;
      const queued: PendingPaste = {
        selection: view.state.selection,
        valid: true,
        edited: false,
        replaying: false,
      };
      pending = queued;
      void loadHtmlClipboard()
        .then(() => {
          // Publish a native cell selection before deciding if a newer gesture took over.
          if (!disposed) syncSelection?.(view);
          const current = view.dom.ownerDocument.getSelection();
          const currentRange = current?.rangeCount ? current.getRangeAt(0) : null;
          const sameRange =
            !range ||
            (currentRange &&
              range.startContainer === currentRange.startContainer &&
              range.endContainer === currentRange.endContainer &&
              range.startOffset === currentRange.startOffset &&
              range.endOffset === currentRange.endOffset);
          if (
            disposed ||
            !queued.valid ||
            view.state.readOnly ||
            view.dom.ownerDocument.activeElement !== focused ||
            (!queued.edited && !sameRange) ||
            !(target instanceof HTMLElement) ||
            !target.isConnected
          ) {
            host?.onRecovery(text || html);
            return;
          }
          // Both prose and table cells follow an explicit mapped source selection.
          // Keep later typing's caret by mapping it through the replay transaction.
          if (!view.state.selection.eq(queued.selection)) queued.restore = view.state.selection;
          queued.replaying = true;
          if (queued.edited) view.dispatch({ selection: queued.selection });
          target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
          if (queued.restore) view.dispatch({ selection: queued.restore });
        })
        .catch(() => host?.onRecovery(text || html))
        .finally(() => {
          pending = undefined;
        });
    };
    view.dom.addEventListener("focusin", preload);
    view.dom.addEventListener("paste", paste, true);
    return {
      update(update) {
        if (!pending) return;
        if (pending.replaying) {
          if (pending.restore) pending.restore = pending.restore.map(update.changes, 1);
          return;
        }
        for (const tr of update.transactions) {
          if (tr.docChanged) {
            tr.changes.iterChangedRanges((from, to) => {
              for (const range of pending!.selection.ranges) if (from < range.to && to > range.from) pending!.valid = false;
            });
            pending.selection = pending.selection.map(tr.changes, -1);
            pending.edited = true;
          } else if (tr.selection && !tr.state.selection.eq(pending.selection)) pending.valid = false;
        }
      },
      destroy() {
        disposed = true;
        view.dom.removeEventListener("focusin", preload);
        view.dom.removeEventListener("paste", paste, true);
      },
    };
  });
