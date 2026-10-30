import { isolateHistory } from "@codemirror/commands";
import { Compartment, type EditorState, type Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TextEditorController, TextEditorControls } from "@k2b/ui/text-editor";
import { type Accessor, createEffect, createSignal, getOwner, onCleanup, untrack } from "solid-js";

/**
 * One command a person can run on the editor. The toolbar, the bubble menu and the slash menu render the same
 * actions; each place gets its own list. `run` receives the view after the place restored the selection it acted on.
 */
export type EditorAction = {
  id: string;
  /** Tabler icon class without the leading `ti `, such as `ti-bold`. */
  icon: string;
  label: string;
  /** CodeMirror key spec, such as `Mod-b`; places only show it, the keymap binds it. */
  shortcut?: string;
  run: (view: EditorView) => void | Promise<void>;
  /** Pressed state, for toggles such as bold. */
  isActive?: (state: EditorState) => boolean;
  /** `false` greys the action out and ignores presses. Every action is off in a read-only editor. */
  isEnabled?: (state: EditorState) => boolean;
};

/**
 * Keep a command's edits apart from the surrounding typing in the undo history: close the open undo item before it
 * and again after its last edit, also when the command waits for a picker first. Edits inside the command group as
 * the history groups them; a command that should undo at once dispatches one transaction. A view destroyed meanwhile
 * ignores the closing transaction.
 */
export const asUndoStep = (view: EditorView, run: () => void | Promise<void>) => {
  view.dispatch({ annotations: isolateHistory.of("before") });
  const close = () => view.dispatch({ annotations: isolateHistory.of("after") });
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (error) {
    close();
    throw error;
  }
  if (result) return result.finally(close);
  close();
};

type Slot = { compartment: Compartment; value: Extension; joined: boolean };

export type EditorHandle = {
  /** The mounted view; `undefined` before `<Editor>` mounted and after it unmounted. */
  view: Accessor<EditorView | undefined>;
  /** The view's latest state; every document, selection or focus change updates it. */
  state: Accessor<EditorState | undefined>;
  /** Whether the editor itself or one of its places has focus. */
  focused: Accessor<boolean>;
  /** Table controls of the shared text editor, for toolbars that edit tables. */
  controls: Accessor<TextEditorControls | undefined>;
  controller: Accessor<TextEditorController | undefined>;
  /**
   * Add an extension to the view, also before it mounts. A function is tracked: its later values reconfigure only
   * its own slot. The slot leaves the view again when the calling owner is disposed. Changes reach a mounted view one
   * microtask later, so a factory may read signals that change during an editor update.
   */
  use: (extension: Extension | (() => Extension)) => void;
  /** Run an action apart from surrounding edits in the undo history and keep focus in the editor; disabled actions do nothing. */
  run: (action: Pick<EditorAction, "run" | "isEnabled">) => void | Promise<void>;
  isActive: (action: Pick<EditorAction, "isActive">) => boolean;
  isEnabled: (action: Pick<EditorAction, "isEnabled">) => boolean;
  /** Everything `<Editor>` passes to the view. Hosts mounting `TextEditor` themselves add this to its extensions. */
  extension: () => Extension;
  /**
   * Hand a mounted view to the handle; `<Editor>` does this from `onReady`. A host that mounts the view itself also
   * passes the text editor's controller and table controls when it has them.
   */
  attach: (view: EditorView, parts?: { controller?: TextEditorController; controls?: TextEditorControls }) => void;
  /** Forget a view that is being destroyed; a newer attached view stays. */
  detach: (view: EditorView) => void;
};

/**
 * Shared state of one editor. `<Editor>` mounts the view; `<Toolbar>`, `<BubbleMenu>` and `<SlashMenu>` read and
 * change it from wherever the host places them. There is no second document model: the state is CodeMirror's.
 */
export function createEditor(): EditorHandle {
  const [view, setView] = createSignal<EditorView>();
  const [state, setState] = createSignal<EditorState>();
  const [focused, setFocused] = createSignal(false);
  const [controller, setController] = createSignal<TextEditorController>();
  const [controls, setControls] = createSignal<TextEditorControls>();
  const slots = new Set<Slot>();
  // CodeMirror refuses a dispatch while it updates the view, and a plugin that throws there is switched off for good,
  // such as the Yjs binding. A slot's factory may run inside such an update when it reads a signal that a plugin or
  // listener wrote, so slots reach the view one microtask later, together, after the update finished.
  const pending = new Set<Slot>();
  const flush = () => {
    const current = untrack(view);
    if (!current) return;
    const ready = [...pending];
    pending.clear();
    if (!current.dom.isConnected) return;
    const effects = ready.map((slot) => {
      if (slot.joined) return slot.compartment.reconfigure(slot.value);
      slot.joined = true;
      return StateEffect.appendConfig.of(slot.compartment.of(slot.value));
    });
    if (effects.length) current.dispatch({ effects });
  };
  const schedule = (slot: Slot) => {
    if (!pending.size) queueMicrotask(flush);
    pending.add(slot);
  };
  // Listeners run inside the dispatch of whoever changed the view, maybe a host effect. They only write signals: a
  // read here would subscribe that effect to every editor update, and its next dispatch would run it again.
  const tracker = EditorView.updateListener.of((update) => {
    setState(update.state);
    if (update.focusChanged) setFocused(update.view.hasFocus);
  });

  const use = (extension: Extension | (() => Extension)) => {
    const slot: Slot = { compartment: new Compartment(), value: [], joined: false };
    slots.add(slot);
    if (typeof extension === "function")
      createEffect(() => {
        slot.value = extension();
        schedule(slot);
      });
    else {
      slot.value = extension;
      // A place added after the view mounted joins its configuration.
      if (untrack(view)) schedule(slot);
    }
    if (getOwner())
      onCleanup(() => {
        slots.delete(slot);
        // A whole editor that unmounts disposes its places in the same pass; a view torn down meanwhile keeps its
        // configuration, so no listener reads a field that just left. A place that leaves a living editor goes.
        slot.value = [];
        if (slot.joined) schedule(slot);
        else pending.delete(slot);
      });
  };

  const run = (action: Pick<EditorAction, "run" | "isEnabled">) => {
    const current = view();
    if (!current || !isEnabled(action)) return;
    const returnFocus = () => {
      // A command may already have handed focus into a table cell or a picker.
      if (current.dom.isConnected && !current.dom.contains(current.dom.ownerDocument.activeElement)) current.focus();
    };
    return asUndoStep(current, () => {
      const result = action.run(current);
      if (!result) return returnFocus();
      return result.finally(returnFocus);
    });
  };

  const isActive = (action: Pick<EditorAction, "isActive">) => {
    const current = state();
    return !!current && !!action.isActive?.(current);
  };
  const isEnabled = (action: Pick<EditorAction, "isEnabled">) => {
    const current = state();
    // CodeMirror's read-only facet stops typing, not dispatched changes, so actions check it here.
    return !!current && !current.readOnly && action.isEnabled?.(current) !== false;
  };

  return {
    view,
    state,
    focused,
    controls,
    controller,
    use,
    run,
    isActive,
    isEnabled,
    extension: () => [
      tracker,
      [...slots].map((slot) => {
        slot.joined = true;
        return slot.compartment.of(slot.value);
      }),
    ],
    attach(next, parts) {
      setController(parts?.controller);
      setControls(parts?.controls);
      setView(next);
      setState(next.state);
      setFocused(next.hasFocus);
      // Values that changed before the view existed reach it now.
      if (pending.size) queueMicrotask(flush);
    },
    detach(old) {
      if (untrack(view) !== old) return;
      setView(undefined);
      setController(undefined);
      setControls(undefined);
      setFocused(false);
    },
  };
}
