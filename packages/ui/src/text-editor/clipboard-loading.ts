import { type EditorView, ViewPlugin } from "@codemirror/view";
import { htmlClipboardReady, loadHtmlClipboard } from "./clipboard";
import type { TableHost } from "./table";

/** Load the HTML sanitizer only when needed, before either paste consumer runs.
 * A delayed paste never overwrites edits made while its parser was loading.
 */
export const clipboardLoading = (getHost: (view: EditorView) => TableHost | null) =>
  ViewPlugin.define((view) => {
    let disposed = false;
    let pending = false;
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
      // Only one delayed paste is retained. Further attempts keep their input in
      // the existing visible recovery surface instead of building an input queue.
      if (pending) {
        host?.onRecovery(text || html);
        return;
      }
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      clipboard.setData("text/html", html);
      for (const file of data.files) clipboard.items.add(file);
      const target = event.target;
      const doc = view.state.doc;
      const selection = view.state.selection;
      const focused = view.dom.ownerDocument.activeElement;
      const native = view.dom.ownerDocument.getSelection();
      const range = native?.rangeCount ? native.getRangeAt(0).cloneRange() : null;
      pending = true;
      void loadHtmlClipboard()
        .then(() => {
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
            view.state.readOnly ||
            view.state.doc !== doc ||
            !view.state.selection.eq(selection) ||
            view.dom.ownerDocument.activeElement !== focused ||
            !sameRange ||
            !(target instanceof HTMLElement) ||
            !target.isConnected
          ) {
            host?.onRecovery(text || html);
            return;
          }
          // CodeMirror and the cell widget run their normal limit, conversion and
          // selection logic. No untrusted HTML is mounted by this loader.
          target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
        })
        .catch(() => host?.onRecovery(text || html))
        .finally(() => {
          pending = false;
        });
    };
    view.dom.addEventListener("paste", paste, true);
    return {
      destroy() {
        disposed = true;
        view.dom.removeEventListener("paste", paste, true);
      },
    };
  });
