import type { EditorView } from "@codemirror/view";
import { files as browserFiles } from "@k2b/stdlib/browser";
import { IconButton } from "@k2b/ui";
import { type TextEditorController, textEditorCommands } from "@k2b/ui/text-editor";
import { createSignal, For, onCleanup } from "solid-js";
import { t } from "../state";
import { Icon, type IconName } from "./common";

const toggleTask = (view: EditorView) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const task = /^(\s*)[-*] \[[ xX]\] /.exec(line.text);
  const bullet = /^(\s*)[-*] /.exec(line.text);
  const insert = task
    ? { from: line.from + (task[1]?.length ?? 0), to: line.from + task[0].length, insert: "" }
    : bullet
      ? { from: line.from + bullet[0].length, insert: "[ ] " }
      : { from: line.from, insert: "- [ ] " };
  view.dispatch({ changes: insert, userEvent: "input.format" });
  view.focus();
  return true;
};

/**
 * Formatting above the phone keyboard. It shows while the editor has focus on a narrow screen and
 * follows the visual viewport, so it sits on the keyboard instead of behind it.
 */
export function Accessory(props: { editor: TextEditorController; onUndo: () => void; onFiles: (files: File[]) => void }) {
  const [on, setOn] = createSignal(false);
  const [bottom, setBottom] = createSignal(0);
  const view = props.editor.view;
  const sync = () => {
    const viewport = window.visualViewport;
    setBottom(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
  };
  const focusIn = () => {
    setOn(true);
    sync();
  };
  const focusOut = () =>
    queueMicrotask(() => {
      if (!view.dom.contains(document.activeElement) && !bar?.contains(document.activeElement)) setOn(false);
    });
  view.dom.addEventListener("focusin", focusIn);
  view.dom.addEventListener("focusout", focusOut);
  window.visualViewport?.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("scroll", sync);
  onCleanup(() => {
    view.dom.removeEventListener("focusin", focusIn);
    view.dom.removeEventListener("focusout", focusOut);
    window.visualViewport?.removeEventListener("resize", sync);
    window.visualViewport?.removeEventListener("scroll", sync);
  });
  let bar: HTMLDivElement | undefined;

  const actions: { icon: IconName; label: () => string; run: () => void }[] = [
    { icon: "ti-bold", label: () => t().fmtBold, run: () => textEditorCommands.bold(view) },
    { icon: "ti-italic", label: () => t().fmtItalic, run: () => textEditorCommands.italic(view) },
    { icon: "ti-h-2", label: () => t().fmtHeading, run: () => textEditorCommands.heading2(view) },
    { icon: "ti-list", label: () => t().fmtList, run: () => textEditorCommands.bulletList(view) },
    { icon: "ti-list-check", label: () => t().fmtTask, run: () => toggleTask(view) },
    {
      icon: "ti-hash",
      label: () => t().fmtTag,
      run: () => {
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: "#" }, selection: { anchor: at + 1 } });
        view.focus();
      },
    },
    {
      icon: "ti-photo",
      label: () => t().fmtImage,
      run: () =>
        void browserFiles
          .showFileDialog({ accept: "image/*,application/pdf", multiple: true })
          .then(props.onFiles)
          .catch(() => {}),
    },
    { icon: "ti-link", label: () => t().fmtLink, run: () => textEditorCommands.link(view) },
    { icon: "ti-arrow-back-up", label: () => t().undo, run: () => props.onUndo() },
  ];

  return (
    <div
      ref={bar}
      class="n-accessory"
      role="toolbar"
      aria-label={t().format}
      data-on={on() ? "" : undefined}
      style={{ transform: `translateY(${-bottom()}px)` }}
      // Taps keep the caret in the editor.
      onPointerDown={(event) => event.preventDefault()}
    >
      <For each={actions}>
        {(action) => (
          <IconButton variant="ghost" label={action.label()} onClick={action.run}>
            <Icon name={action.icon} />
          </IconButton>
        )}
      </For>
    </div>
  );
}
