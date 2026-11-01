import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { dialogCore } from "../feedback/dialog-core";
import { LocaleProvider } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";
import type { DropdownAction, DropdownChoice, DropdownItem, DropdownSearch } from "./Dropdown";
import { focusMenuRow, focusRowSegment } from "./menu-rows";
import { filterDropdownItems, MenuSearch } from "./menu-search";

/** Phones, where a menu opens as a bottom sheet instead of beside its trigger. */
export const PHONE_SHEET_QUERY = "(max-width: 47.999rem)";

export const prefersMenuSheet = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches;

type SheetEntry = DropdownAction | DropdownChoice;
type SheetItem = SheetEntry | { items: readonly SheetEntry[] };

/**
 * Follows a link the way a click on it would, so a page's own link handling, such as progressive navigation, still
 * applies; it runs only after the sheet has left the history.
 */
const followLink = (href: string) => {
  const link = document.createElement("a");
  link.href = href;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
};

/**
 * The sheet's items hand their action to `run` instead of running it while the sheet closes: `dialogCore` settles the
 * sheet after it left the history, and only then may an action navigate or open the next dialog.
 * A choice or action that keeps the menu open, or an `immediate` action, runs at once.
 */
const afterClose = <T extends DropdownItem>(items: readonly T[], run: (action: () => void) => void): T[] => {
  const entry = (item: SheetEntry): SheetEntry => {
    // A plain link would navigate while the sheet's history entry is still being removed, and that Back could
    // undo the navigation; a plain click instead follows it once the sheet is gone. Modified clicks and external
    // links keep the browser's own behavior.
    if (!item.action && "href" in item && item.href && !("external" in item && item.external)) {
      const href = item.href;
      return { ...item, action: () => run(() => followLink(href)) } as SheetEntry;
    }
    const action = item.action;
    if (!action || ("closeOnSelect" in item && item.closeOnSelect === false) || ("immediate" in item && item.immediate)) return item;
    return { ...item, action: () => run(action) } as SheetEntry;
  };
  return items.map((item) => {
    const sheetItem = item as SheetItem;
    return ("items" in sheetItem ? { ...sheetItem, items: sheetItem.items.map(entry) } : entry(sheetItem)) as T;
  });
};

const menuItems = (menu: HTMLElement): HTMLElement[] =>
  Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])"));

/**
 * The menu inside the sheet: the same items, at touch size, with arrow keys for a connected keyboard. Focus starts on
 * the sheet itself, which shows no ring on a phone; the first arrow key moves it into the menu.
 */
function SheetMenu(props: {
  Items: MenuSheetOptions["Items"];
  items: readonly DropdownItem[];
  label: string;
  close: () => void;
  dialog: HTMLDialogElement;
  icons?: "plain" | "tile";
}): JSX.Element {
  let menu!: HTMLDivElement;
  const onKeyDown = (event: KeyboardEvent) => {
    const items = menuItems(menu);
    if (!focusMenuRow(items, event.key) && !focusRowSegment(items, event.key)) return;
    event.preventDefault();
  };
  // Keys pressed on the sheet itself, while it is the top level of the shared dialog.
  const onSheetKeyDown = (event: KeyboardEvent) => {
    if (event.target === props.dialog && props.dialog.lastElementChild?.contains(menu)) onKeyDown(event);
  };
  onMount(() => {
    props.dialog.addEventListener("keydown", onSheetKeyDown);
    onCleanup(() => props.dialog.removeEventListener("keydown", onSheetKeyDown));
  });
  return (
    <div
      ref={menu}
      class="k2b-gesture-menu__sheet-menu"
      role="menu"
      aria-label={props.label}
      data-icons={props.icons === "tile" ? "tile" : undefined}
      onKeyDown={onKeyDown}
    >
      <props.Items items={props.items} close={() => props.close()} />
    </div>
  );
}

export type MenuSheetOptions = {
  /** Renders the rows: the dropdown's own `DropdownItems`, passed in so this module does not import it back. */
  Items: (props: { items: readonly DropdownItem[]; close: (restoreFocus?: boolean) => void }) => JSX.Element;
  items: readonly DropdownItem[];
  /** Names the sheet and its menu. */
  label: string;
  /** The render locale of the opener; the sheet renders outside its tree. */
  locale: string;
  /** Shown above the menu, for example a row of quick reactions. `close` closes the sheet. */
  top?: (close: () => void) => JSX.Element;
  search?: DropdownSearch;
  icons?: "plain" | "tile";
  signal?: AbortSignal;
};

/** A searchable menu in the sheet: the sheet's first field, so it takes the focus as the sheet opens, as in the menu. */
function SheetSearch(props: {
  Items: MenuSheetOptions["Items"];
  items: readonly DropdownItem[];
  search: DropdownSearch;
  wrap: <T extends DropdownItem>(items: readonly T[]) => T[];
  label: string;
  locale: string;
  close: () => void;
  icons?: "plain" | "tile";
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const filter = props.search.filter;
  return (
    <div
      class="k2b-gesture-menu__sheet-menu"
      role="dialog"
      aria-label={props.label}
      data-search=""
      data-icons={props.icons === "tile" ? "tile" : undefined}
    >
      <MenuSearch
        Items={props.Items}
        items={props.items}
        search={{
          ...props.search,
          // The sheet's own items are wrapped already; a host's filter returns its unwrapped entries.
          filter: (value) => (filter ? props.wrap(filter(value)) : filterDropdownItems(props.items, value, props.locale)),
        }}
        label={props.label}
        query={query}
        setQuery={setQuery}
        close={() => props.close()}
      />
    </div>
  );
}

/** Opens menu items as a bottom sheet; resolves after the sheet closed and the chosen action ran. */
export const openMenuSheet = (options: MenuSheetOptions): Promise<void> => {
  let chosen: (() => void) | undefined;
  const choose = (action: () => void) => {
    chosen = action;
  };
  return dialogCore
    .open<void>(
      (close, context) => (
        <LocaleProvider locale={options.locale}>
          <BottomSheet onDismiss={context.requestDismiss}>
            <BottomSheet.Body>
              {options.top?.(() => close())}
              <Show
                when={options.search}
                fallback={
                  <SheetMenu
                    Items={options.Items}
                    items={afterClose(options.items, choose)}
                    label={options.label}
                    close={() => close()}
                    dialog={context.dialog}
                    icons={options.icons}
                  />
                }
              >
                {(search) => (
                  <SheetSearch
                    Items={options.Items}
                    items={afterClose(options.items, choose)}
                    search={search()}
                    wrap={(items) => afterClose(items, choose)}
                    label={options.label}
                    locale={options.locale}
                    close={() => close()}
                    icons={options.icons}
                  />
                )}
              </Show>
            </BottomSheet.Body>
          </BottomSheet>
        </LocaleProvider>
      ),
      { ...bottomSheetOptions, ariaLabel: options.label, history: true, signal: options.signal },
    )
    .then(() => chosen?.());
};
