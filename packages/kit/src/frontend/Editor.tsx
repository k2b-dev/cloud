import { highlight } from "@k2b/stdlib";
import { AutocompleteEditor } from "@k2b/ui";
import { createEffect } from "solid-js";
import { LIMITS } from "../contracts";

type Snapshot = {
  text: string;
  start: number;
  end: number;
};
export function Editor(props: { path: string; content: string; onChange: (text: string) => void; onSave: () => void }) {
  let textarea: HTMLTextAreaElement;
  let known = props.content;
  let before: Snapshot = { text: known, start: 0, end: 0 };
  let inputType = "",
    group = "";
  const undo: Snapshot[] = [],
    redo: Snapshot[] = [];
  const snapshot = (): Snapshot => ({ text: known, start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0 });
  const trim = (stack: Snapshot[]) => {
    let bytes = 0;
    for (let i = stack.length - 1; i >= 0; i--) {
      bytes += stack[i]!.text.length * 2;
      if (bytes > LIMITS.sourceBytes) {
        stack.splice(0, i + 1);
        break;
      }
    }
  };
  createEffect(() => {
    if (props.content !== known) {
      known = props.content;
      undo.length = 0;
      redo.length = 0;
      group = "";
    }
  });
  function restore(from: Snapshot[], to: Snapshot[]) {
    const value = from.pop();
    if (!value) return;
    to.push(snapshot());
    trim(to);
    group = "";
    known = value.text;
    props.onChange(value.text);
    textarea.value = value.text;
    textarea.setSelectionRange(value.start, value.end);
  }
  return (
    <div
      role="group"
      class="kit-code"
      onPointerDown={() => {
        group = "";
      }}
      onFocusOut={() => {
        group = "";
      }}
      onKeyDown={(event) => {
        if (event.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          props.onSave();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
          event.preventDefault();
          if (event.shiftKey || event.key.toLowerCase() === "y") restore(redo, undo);
          else restore(undo, redo);
        } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key)) group = "";
      }}
    >
      <AutocompleteEditor
        aria-label={props.path}
        value={props.content}
        textareaRef={(element) => {
          textarea = element;
          element.addEventListener("beforeinput", (event) => {
            if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
              event.preventDefault();
              if (event.inputType === "historyUndo") restore(undo, redo);
              else restore(redo, undo);
              return;
            }
            before = snapshot();
            inputType = event.inputType;
          });
        }}
        onValueChange={(text) => {
          if (text === known) return;
          const typing = (inputType === "insertText" || inputType === "insertCompositionText") && before.start === before.end;
          if (!typing || group !== "typing") {
            undo.push(before);
            trim(undo);
          }
          group = typing ? "typing" : "";
          redo.length = 0;
          known = text;
          props.onChange(text);
        }}
        highlight={highlight.presets.code}
        fill
        spellcheck={false}
        variant="paper"
      />
    </div>
  );
}
