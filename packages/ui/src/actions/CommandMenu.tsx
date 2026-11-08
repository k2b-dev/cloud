import { createEffect, createSignal, createUniqueId, type JSX, on } from "solid-js";
import { replaceTextareaRange } from "../inputs/editor-dom";
import { CommandList, commandListKey, commandOptionId, createCommandNavigator } from "./CommandList";
import { dockCommandList, followComposer } from "./command-dock";
import { type CommandSource, commandPlace } from "./command-items";
import {
  Dropdown,
  type DropdownAnchor,
  type DropdownBody,
  type DropdownPosition,
  type DropdownReturnFocus,
  DropdownShell,
} from "./Dropdown";

export type CommandMenuProps = {
  /** The same entries as `MarkdownEditor`'s `commands`, so the slash menu, a "+" button, and a chip offer one list. */
  items: CommandSource;
  /** Names the menu and its first list, such as "Add to message". */
  label: string;
  /** Names the search field and is its hint, such as "Search commands". A second list shows its own label there. */
  search: string;
  /**
   * The field the commands act on, such as the composer's textarea beside a "+" button. Its text and selection are the
   * `context` of an `onSelect`, and `context.insert` and entries with `text` write into it as typing would.
   */
  target?: HTMLTextAreaElement | HTMLInputElement;
  /**
   * The composer box the menu docks to, as the slash list does: as wide as the box, just above it, or below it when
   * there is more room there. Without it, the menu opens beside its trigger.
   */
  dock?: HTMLElement;
  /** Receives inserted text when there is no `target`, such as a snippet the host places itself. */
  onInsert?: (text: string) => void;
  /** The `CommandMenu.Trigger`; leave it out for a menu opened through `openAt` or `attach`. */
  children?: JSX.Element;
  position?: DropdownPosition;
  align?: "start" | "end";
  /** Receives `open`, which shows the menu beside `anchor` without its trigger; focus returns to `returnFocus`. */
  openAt?: (open: (anchor: DropdownAnchor, returnFocus?: DropdownReturnFocus) => void) => void;
  /** Adopts an element rendered elsewhere, such as a server-rendered chip, as the trigger. */
  attach?: () => HTMLElement | null | undefined;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  class?: string;
};

/**
 * A searchable command list beside a trigger or an anchor, with the slash menu's entries and rows: groups, icons,
 * unavailable entries with their reason, and second lists. Focus stays in the search field; Up, Down, Home, and End
 * mark, Enter and Tab choose, Escape or Backspace in an empty field go back, and Escape in the first list closes.
 */
function CommandMenuRoot(props: CommandMenuProps): JSX.Element {
  const body: DropdownBody = (shell) => {
    const listId = `k2b-command-menu-${createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const [query, setQuery] = createSignal("");
    let input!: HTMLInputElement;
    const nav = createCommandNavigator({
      items: () => props.items,
      query,
      onText: (item) => {
        // Read before closing: closing resets the list.
        const text = item.text ?? "";
        const target = props.target;
        shell.close(!target);
        insert(text);
      },
      context: () => {
        const target = props.target;
        const value = target?.value ?? "";
        const start = target?.selectionStart ?? 0;
        return {
          ...commandPlace(value, start, start),
          selection: { start, end: target?.selectionEnd ?? start },
          insert: (text: string) => insert(text),
        };
      },
      active: shell.open,
      // The focus goes back to the trigger only from inside the menu: an entry that wrote into the target, or moved
      // the focus elsewhere itself, leaves it there.
      afterRun: () => shell.close(Boolean(input.closest(".k2b-dropdown__menu")?.contains(document.activeElement))),
      onStep: () => setQuery(""),
    });
    /** Writes into the target at its caret, as typing would, or hands the text to `onInsert`. */
    const insert = (text: string) => {
      const target = props.target;
      if (!target) return props.onInsert?.(text);
      replaceTextareaRange(target as HTMLTextAreaElement, target.selectionStart ?? 0, target.selectionEnd ?? 0, text);
    };
    createEffect(
      on(shell.open, (open) => {
        const menu = input.closest<HTMLElement>(".k2b-dropdown__menu");
        const dock = props.dock;
        if (open && dock && menu) {
          // A phone's keyboard moves the visible viewport, which the menu follows like the slash list.
          const follow = () => {
            if (menu.matches(":popover-open")) dockCommandList(menu, dock);
          };
          follow();
          const stop = followComposer(dock, follow);
          const closed = () => {
            if (!menu.matches(":popover-open")) {
              stop();
              menu.removeEventListener("toggle", closed);
            }
          };
          menu.addEventListener("toggle", closed);
          return;
        }
        if (open) {
          // The width it opened with stays its least, so filtering never narrows it.
          queueMicrotask(() => {
            if (menu?.matches(":popover-open")) menu.style.minWidth = `min(${menu.getBoundingClientRect().width}px, 100vw - 2rem)`;
          });
          return;
        }
        if (menu) menu.style.minWidth = "";
        // Closing the menu, with Escape or a press outside, stops a running command.
        nav.abort();
        nav.reset();
        setQuery("");
      }),
    );
    shell.api({
      focus: (mark) => {
        input.focus({ preventScroll: true });
        if (mark === "last") nav.edge("last");
      },
    });
    const search = (
      <label class="k2b-dropdown__search">
        <i class="ti ti-search" aria-hidden="true" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label={nav.step()?.next?.label ?? props.search}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            nav.entries()[nav.active()] && !nav.entries()[nav.active()]!.disabled ? commandOptionId(listId, nav.active()) : undefined
          }
          autocomplete="off"
          spellcheck={false}
          enterkeyhint="go"
          placeholder={nav.step()?.next?.label ?? props.search}
          value={query()}
          // While a command runs, the list waits for it; the query keeps the running entry in view.
          readOnly={nav.busy()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (!commandListKey(nav, event, query())) return;
            // Escape that left a second list, and Tab that chose, stay inside the menu.
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </label>
    );
    return <CommandList navigator={nav} id={listId} label={props.label} query={query} header={search} />;
  };

  return (
    <DropdownShell
      items={[]}
      body={body}
      label={props.label}
      menuClass="k2b-command-menu"
      placeMenu={props.dock ? (menu) => dockCommandList(menu, props.dock!) : undefined}
      position={props.position}
      align={props.align}
      openAt={props.openAt}
      attach={props.attach}
      onOpenChange={props.onOpenChange}
      disabled={props.disabled}
      class={props.class}
    >
      {props.children}
    </DropdownShell>
  );
}

type CommandMenuComponent = ((props: CommandMenuProps) => JSX.Element) & {
  Trigger: typeof Dropdown.Trigger;
};

export const CommandMenu = CommandMenuRoot as CommandMenuComponent;
CommandMenu.Trigger = Dropdown.Trigger;
