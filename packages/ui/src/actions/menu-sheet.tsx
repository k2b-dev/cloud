import { type JSX, onCleanup, onMount } from "solid-js";
import { dialogCore } from "../feedback/dialog-core";
import { LocaleProvider } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";
import { type DropdownAction, type DropdownChoice, type DropdownItem, DropdownItems, focusRowSegment } from "./Dropdown";

/** Phones, where a menu opens as a bottom sheet instead of beside its trigger. */
export const PHONE_SHEET_QUERY = "(max-width: 47.999rem)";

export const prefersMenuSheet = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches;

type SheetEntry = DropdownAction | DropdownChoice;
type SheetItem = SheetEntry | { items: readonly SheetEntry[] };

/**
 * The sheet's items hand their action to `run` instead of running it while the sheet closes: `dialogCore` settles the
 * sheet after it left the history, and only then may an action navigate or open the next dialog.
 * A choice or action that keeps the menu open runs at once.
 */
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
    if (!action || ("closeOnSelect" in item && item.closeOnSelect === false)) return item;
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
function SheetMenu(props: { items: readonly DropdownItem[]; label: string; close: () => void; dialog: HTMLDialogElement }): JSX.Element {
  let menu!: HTMLDivElement;
  const focus = (index: number) => {
    const items = menuItems(menu);
    items[(index + items.length) % items.length]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const items = menuItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") focus(current + 1);
    else if (event.key === "ArrowUp") focus(current < 0 ? -1 : current - 1);
    else if (event.key === "Home" || event.key === "End") focus(event.key === "Home" ? 0 : -1);
    else if (!focusRowSegment(items, event.key)) return;
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
    <div ref={menu} class="k2b-gesture-menu__sheet-menu" role="menu" aria-label={props.label} onKeyDown={onKeyDown}>
      <DropdownItems items={props.items} close={() => props.close()} />
    </div>
  );
}

export type MenuSheetOptions = {
  items: readonly DropdownItem[];
  /** Names the sheet and its menu. */
  label: string;
  /** The render locale of the opener; the sheet renders outside its tree. */
  locale: string;
  /** Shown above the menu, for example a row of quick reactions. `close` closes the sheet. */
  top?: (close: () => void) => JSX.Element;
  signal?: AbortSignal;
};

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
              <SheetMenu items={afterClose(options.items, choose)} label={options.label} close={() => close()} dialog={context.dialog} />
            </BottomSheet.Body>
          </BottomSheet>
        </LocaleProvider>
      ),
      { ...bottomSheetOptions, ariaLabel: options.label, history: true, signal: options.signal },
    )
    .then(() => chosen?.());
};
