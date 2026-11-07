import { createEffect, createSignal, createUniqueId, type JSX, on } from "solid-js";
import { CommandList, commandListKey, commandOptionId, createCommandNavigator } from "./CommandList";
import type { CommandSource } from "./command-items";
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
  /** Receives the `text` of a chosen entry, such as a snippet the host inserts at its caret. */
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
      onPick: (item) => {
        // Read before closing: closing resets the list.
        const { text, onSelect } = item;
        shell.close();
        if (text !== undefined) props.onInsert?.(text);
        else onSelect?.();
      },
      onStep: () => setQuery(""),
    });
    createEffect(
      on(shell.open, (open) => {
        if (open) return;
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
          aria-activedescendant={nav.entries().length ? commandOptionId(listId, nav.active()) : undefined}
          autocomplete="off"
          spellcheck={false}
          enterkeyhint="go"
          placeholder={nav.step()?.next?.label ?? props.search}
          value={query()}
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
      width="20rem"
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
