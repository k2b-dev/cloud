import { EditorView } from "@codemirror/view";
import { Dropdown, type DropdownPosition, IconButton, Tooltip, Toolbar as UiToolbar, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { ariaShortcut, shortcutLabel } from "./actions";
import type { EditorAction, EditorHandle } from "./editor-state";
import { editorMessages } from "./messages";

/** A menu of actions behind one icon trigger, such as "More". */
export type ToolbarMenu = {
  kind: "menu";
  id: string;
  icon: string;
  label: string;
  sections: { label?: string; actions: EditorAction[] }[];
  position?: DropdownPosition;
  width?: string;
};
/** Host-rendered control that needs more than an action, such as a style picker; it reads the same handle. */
export type ToolbarCustom = { kind: "custom"; id: string; render: () => JSX.Element };
export type ToolbarItem = EditorAction | ToolbarMenu | ToolbarCustom;
export type ToolbarGroup = {
  label?: string;
  class?: string;
  /** Class of the separator after this group; the last group has none. */
  separatorClass?: string;
  items: ToolbarItem[];
};

export type ToolbarProps = {
  editor: EditorHandle;
  groups: ToolbarGroup[];
  /** Accessible name of the action row; defaults to "Formatting". */
  label?: string;
  /** Controls before and after the action row, such as navigation or a sync status. */
  start?: JSX.Element;
  end?: JSX.Element;
  class?: string;
  /** Class of the scrolling action row inside. */
  toolsClass?: string;
  /**
   * On touch screens with an open keyboard, lift the toolbar to the keyboard's top edge while the editor has focus,
   * and give up the same height in the page above it, so the caret line stays visible.
   */
  liftAboveKeyboard?: boolean;
};

const isMenu = (item: ToolbarItem): item is ToolbarMenu => "kind" in item && item.kind === "menu";
const isCustom = (item: ToolbarItem): item is ToolbarCustom => "kind" in item && item.kind === "custom";

/** One icon button for an action, with its shortcut in the tooltip and the pressed and disabled state of the editor. */
export function ToolbarButton(props: { editor: EditorHandle; action: EditorAction; size?: "xs" | "sm" }) {
  const locale = useLocale();
  const t = () => editorMessages.resolve([locale()]).t;
  const enabled = () => props.editor.isEnabled(props.action);
  return (
    <Tooltip.Anchor
      content={
        props.action.shortcut
          ? t().withShortcut({ label: props.action.label, keys: shortcutLabel(props.action.shortcut, locale()) })
          : props.action.label
      }
    >
      <IconButton
        label={props.action.label}
        tooltip={false}
        size={props.size ?? "xs"}
        aria-pressed={props.action.isActive ? (props.editor.isActive(props.action) ? "true" : "false") : undefined}
        aria-disabled={enabled() ? undefined : "true"}
        aria-keyshortcuts={props.action.shortcut ? ariaShortcut(props.action.shortcut) : undefined}
        onClick={() => void props.editor.run(props.action)}
        class="text-dimmed"
      >
        <i class={`ti ${props.action.icon} text-sm`} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}

function ToolbarMenuButton(props: { editor: EditorHandle; menu: ToolbarMenu; coarse: boolean }) {
  const locale = useLocale();
  // On touch screens a controlled menu opens on a tap without taking focus, so the note keeps focus and the keyboard.
  const [open, setOpen] = createSignal(false);
  return (
    <Dropdown.Root
      open={props.coarse ? open() : undefined}
      onOpenChange={setOpen}
      position={props.menu.position ?? "top-right"}
      width={props.menu.width}
      items={props.menu.sections.map((section) => ({
        sectionLabel: section.label,
        items: section.actions.map((action) => ({
          icon: `ti ${action.icon}`,
          label: action.label,
          description: action.shortcut ? shortcutLabel(action.shortcut, locale()) : undefined,
          disabled: !props.editor.isEnabled(action),
          action: () => void props.editor.run(action),
        })),
      }))}
    >
      <Dropdown.Trigger iconOnly label={props.menu.label} size="xs" class="text-dimmed" tooltip={props.menu.label}>
        <i class={`ti ${props.menu.icon} text-sm`} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

/**
 * A formatting toolbar for the shared editor, placed wherever the host wants it. Pressing a control keeps focus and
 * selection in the editor; every action is one undo step.
 */
export function Toolbar(props: ToolbarProps) {
  const locale = useLocale();
  const t = () => editorMessages.resolve([locale()]).t;
  const [coarse, setCoarse] = createSignal(false);
  const [lift, setLift] = createSignal(0);
  let root!: HTMLDivElement;

  onMount(() => {
    const pointer = window.matchMedia("(pointer: coarse)");
    setCoarse(pointer.matches);
    const viewport = window.visualViewport;
    let disposed = false;
    // A phone keyboard covers the bottom of the page and shrinks only the visual viewport. Fine pointers never lift.
    // Coarse pointers lift only after losing at least 15% of the page height, so the shortcuts bar of a hardware
    // keyboard does not lift it. While zoomed, the toolbar stays in flow.
    const measure = () => {
      if (disposed || !viewport || !props.liftAboveKeyboard) return;
      const view = props.editor.view();
      const focused =
        !!view && (view.hasFocus || view.contentDOM.contains(document.activeElement) || root.contains(document.activeElement));
      const inFlowBottom = root.getBoundingClientRect().bottom + lift();
      const pageHeight = document.documentElement.clientHeight;
      const keyboardOpen = viewport.scale === 1 && pageHeight - viewport.height > pageHeight * 0.15;
      const next = pointer.matches && focused && keyboardOpen ? Math.max(0, inFlowBottom - viewport.offsetTop - viewport.height) : 0;
      const previous = lift();
      if (Math.abs(next - previous) < 0.5) return;
      setLift(next);
      // A shorter page may hide the caret line; CodeMirror brings it back after it measured the new height.
      if (view && next > previous) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
    };
    const pointerChanged = () => {
      setCoarse(pointer.matches);
      measure();
    };
    // Picking an item returns focus to the trigger and then the editor within one task. Measuring between drops the lift.
    const afterFocus = () => queueMicrotask(measure);
    pointer.addEventListener("change", pointerChanged);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure);
    document.addEventListener("focusin", afterFocus);
    document.addEventListener("focusout", afterFocus);
    onCleanup(() => {
      disposed = true;
      pointer.removeEventListener("change", pointerChanged);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      document.removeEventListener("focusin", afterFocus);
      document.removeEventListener("focusout", afterFocus);
    });
    // A toolbar mounted with the keyboard already open lifts at once.
    measure();
  });

  return (
    // Pointer presses on any control, menu items included, keep focus and selection in the editor. A native listener,
    // because the menus are popovers inside this element and must not depend on delegation reaching them.
    <div
      ref={root}
      class={props.class ?? "k2b-editor-toolbar flex min-w-0 items-center gap-2 text-dimmed"}
      style={{ "margin-bottom": lift() ? `${lift()}px` : undefined }}
      on:mousedown={(event) => event.preventDefault()}
    >
      {props.start}
      <UiToolbar label={props.label ?? t().formatting} class={props.toolsClass ?? "no-scrollbar min-w-0 flex-1 overflow-x-auto"}>
        <For each={props.groups}>
          {(group, index) => (
            <>
              <UiToolbar.Group label={group.label} class={group.class ?? "shrink-0"}>
                <For each={group.items}>
                  {(item) =>
                    isCustom(item) ? (
                      item.render()
                    ) : isMenu(item) ? (
                      <ToolbarMenuButton editor={props.editor} menu={item} coarse={coarse()} />
                    ) : (
                      <ToolbarButton editor={props.editor} action={item} />
                    )
                  }
                </For>
              </UiToolbar.Group>
              <Show when={index() < props.groups.length - 1}>
                <UiToolbar.Separator class={group.separatorClass} />
              </Show>
            </>
          )}
        </For>
      </UiToolbar>
      {props.end}
    </div>
  );
}
