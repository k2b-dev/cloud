import { type Accessor, createEffect, createMemo, createUniqueId, type JSX, on, onMount, Show } from "solid-js";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import type { DropdownItem, DropdownSearch } from "./Dropdown";

type Entry = Exclude<DropdownItem, { items: unknown }>;

const entriesOf = (items: readonly DropdownItem[]): Entry[] => items.flatMap((item) => ("items" in item ? item.items : [item]));

/** The actions and choices whose label or description contains the query, kept in their sections. */
export const filterDropdownItems = (items: readonly DropdownItem[], query: string, locale?: string): DropdownItem[] => {
  const needle = query.trim().toLocaleLowerCase(locale);
  const matches = (entry: Entry) => `${entry.label} ${entry.description ?? ""}`.toLocaleLowerCase(locale).includes(needle);
  return items.flatMap((item): DropdownItem[] => {
    if (!("items" in item)) return matches(item) ? [item] : [];
    const kept = item.items.filter(matches);
    return kept.length ? [{ ...item, items: kept }] : [];
  });
};

const optionsOf = (list: HTMLElement | undefined): HTMLElement[] =>
  list ? Array.from(list.querySelectorAll<HTMLElement>("[role='option']:not([aria-disabled='true'])")) : [];

export type MenuSearchApi = {
  /** Moves the focus into the field and marks the first or last entry. */
  focus: (mark: "first" | "last") => void;
};

/**
 * A search field over a list box of the menu's entries: the combobox pattern. The field keeps the focus, the marked
 * entry is its active descendant, and a polite status says how many entries match.
 */
export function MenuSearch(props: {
  Items: (props: { items: readonly DropdownItem[]; close: (restoreFocus?: boolean) => void; role?: "menuitem" | "option" }) => JSX.Element;
  items: readonly DropdownItem[];
  search: DropdownSearch;
  /** Names the list box. */
  label: string;
  query: Accessor<string>;
  setQuery: (query: string) => void;
  close: (restoreFocus?: boolean) => void;
  api?: (api: MenuSearchApi) => void;
}): JSX.Element {
  const messages = useUiMessages();
  const locale = useLocale();
  const id = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const listId = `k2b-dropdown-search-${id}`;
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let active = 0;
  const blank = () => props.query().trim() === "";
  const shown = createMemo(() =>
    blank() ? props.items : (props.search.filter?.(props.query()) ?? filterDropdownItems(props.items, props.query(), locale())),
  );
  const matches = () => entriesOf(shown()).filter((entry) => !entry.disabled).length;
  const status = () => (blank() ? "" : (props.search.status?.(props.query(), matches()) ?? messages().searchMatches({ count: matches() })));

  const mark = (index: number) => {
    // An entry that became disabled keeps no stale ID or mark.
    for (const stale of list.querySelectorAll<HTMLElement>("[role='option']")) {
      stale.removeAttribute("id");
      stale.removeAttribute("aria-selected");
      stale.removeAttribute("data-active");
    }
    const options = optionsOf(list);
    active = options.length ? (index + options.length) % options.length : 0;
    options.forEach((option, position) => {
      option.id = `${listId}-${position}`;
      option.setAttribute("aria-selected", String(position === active));
      option.toggleAttribute("data-active", position === active);
    });
    const current = options[active];
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  // A new query shows new entries: the first of them is marked again, after they rendered.
  createEffect(on(shown, () => queueMicrotask(() => mark(0)), { defer: true }));
  onMount(() => {
    mark(0);
    props.api?.({
      focus: (which) => {
        input.focus({ preventScroll: true });
        mark(which === "first" ? 0 : -1);
      },
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      mark(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      optionsOf(list)[active]?.click();
    }
  };

  return (
    <>
      <label class="k2b-dropdown__search">
        <i class="ti ti-search" aria-hidden="true" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label={props.search.label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck={false}
          enterkeyhint="go"
          placeholder={props.search.placeholder ?? props.search.label}
          value={props.query()}
          onInput={(event) => props.setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label={props.label}
        class="k2b-dropdown__list"
        // A press on an entry leaves the focus in the field, also for an entry that keeps the menu open.
        onMouseDown={(event) => event.preventDefault()}
        onPointerMove={(event) => {
          const option = (event.target as Element).closest<HTMLElement>("[role='option']");
          const index = option ? optionsOf(list).indexOf(option) : -1;
          if (index >= 0 && index !== active) mark(index);
        }}
      >
        <Show when={shown().length} fallback={<p class="k2b-dropdown__empty">{messages().noResults}</p>}>
          <props.Items items={shown()} close={props.close} role="option" />
        </Show>
      </div>
      <span class="k2b-sr-only" role="status">
        {status()}
      </span>
    </>
  );
}
