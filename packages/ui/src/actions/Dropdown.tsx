import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  type JSX,
  mergeProps,
  onCleanup,
  onMount,
  Show,
  splitProps,
  untrack,
  useContext,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { Tooltip, type TooltipPlacement, useLabelTooltip } from "../feedback/Tooltip";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { KeyedFor } from "../internal/keyed-for";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant, iconTitle } from "./Button";
import { focusMenuRow, focusRowSegment } from "./menu-rows";
import { MenuSearch, type MenuSearchApi } from "./menu-search";
import { openMenuSheet, prefersMenuSheet } from "./menu-sheet";

// Resolved outside JSX: a conditional attribute compiles to a lazy memo, which would be created inside the click handler.
const selectAction = (item: { action?: () => void }) => item.action;
const closeOnSelectOf = (item: DropdownAction) => ("closeOnSelect" in item ? item.closeOnSelect : undefined);
const hrefOf = (item: DropdownAction) => ("href" in item ? item.href : undefined);
const externalOf = (item: DropdownAction) => ("external" in item ? item.external : undefined);

export type DropdownPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "right-start";
/** Where a menu opened without its trigger appears: an element, or any box such as a point inside one. */
export type DropdownAnchor = { getBoundingClientRect(): Pick<DOMRect, "left" | "top" | "right" | "bottom"> };
/** Where focus returns as a menu opened by `openAt` closes, read at that moment when it is a function. */
export type DropdownReturnFocus = HTMLElement | (() => HTMLElement | undefined);

export type DropdownActionBase = {
  class?: string;
  disabled?: boolean;
  icon?: string;
  image?: string;
  label: string;
  /**
   * Accessible name when it must say more than the visible label, such as the current value and what the next
   * activation does. It must contain the visible label.
   */
  ariaLabel?: string;
  description?: string;
  /** Quiet trailing information, such as a count. */
  trailing?: JSX.Element;
  /** `danger` for destructive entries; `accent` for the entry most people want, such as creating a blank item. */
  variant?: "danger" | "accent";
};

export type DropdownAction =
  | (DropdownActionBase & {
      action: () => void;
      /**
       * Set `false` for an action that changes a value in place, such as cycling a setting: the menu stays open and
       * the focus stays on the row. Defaults to `true`.
       */
      closeOnSelect?: boolean;
      /**
       * In a phone sheet, run while the tap still counts as the person's gesture, before the sheet closes, as browsers
       * require for clipboard writes. Other actions run after the sheet has left the history. Such an action must
       * not navigate or open a dialog.
       */
      immediate?: boolean;
      href?: never;
      external?: never;
    })
  | (DropdownActionBase & {
      href: string;
      external?: boolean;
      /** Runs on a plain click instead of following the link; modified clicks, middle-click, and the link's menu keep it. */
      action?: () => void;
    })
  | (DropdownActionBase & {
      disabled: true;
      action?: never;
      href?: never;
      external?: never;
    });

/** A second, smaller action at the end of a row, such as "Only" beside a checkbox; it keeps the menu open. */
export type DropdownSecondaryAction = {
  label: string;
  /** Accessible name when the visible label alone does not say what it acts on, such as "Only Team Logistik". */
  ariaLabel?: string;
  action: () => void;
};

/** Declarative radio or checkbox row for compact action menus. */
export type DropdownChoice = DropdownActionBase & {
  action: () => void;
  checked: boolean | (() => boolean);
  choice: "checkbox" | "radio";
  href?: string;
  closeOnSelect?: boolean;
  color?: string;
  /**
   * A second action at the end of the row. It shows while the row is hovered or focused, always on a touch screen,
   * and keeps its place when hidden, so the row never changes width. Right and Left move between the two.
   */
  secondary?: DropdownSecondaryAction;
};

export type DropdownSection = {
  sectionLabel?: string;
  /**
   * `row` sets a few short radio choices, such as a sort direction, side by side as one segmented row. Give it a
   * `sectionLabel`: the label names the choice above the row and for screen readers.
   */
  layout?: "row";
  /** A quiet action at the end of the section label, such as "All"; it needs a `sectionLabel` and keeps the menu open. */
  labelAction?: DropdownSecondaryAction;
  items: readonly (DropdownAction | DropdownChoice)[];
};

export type DropdownItem = DropdownAction | DropdownChoice | DropdownSection;

/** A search field above the entries, for a menu long enough that finding an entry takes reading. */
export type DropdownSearch = {
  /** Names the field and is its placeholder unless `placeholder` is set, such as "Find template". */
  label: string;
  placeholder?: string;
  /**
   * The entries for a query that is not blank. Defaults to the actions and choices whose label or description contains
   * the query, kept in their sections.
   */
  filter?: (query: string) => readonly DropdownItem[];
  /** What a screen reader hears after the query changes; defaults to the number of matching entries. */
  status?: (query: string, matches: number) => string;
};

export type DropdownProps = {
  items: readonly DropdownItem[];
  /** The `Dropdown.Trigger`; leave it out for a menu opened through `attach` or `openAt`. */
  children?: JSX.Element;
  position?: DropdownPosition | (() => DropdownPosition);
  /** Larger menu rows and typography for touch. Defaults to `default`. */
  variant?: "default" | "touch";
  /**
   * Exact menu width as a CSS length. Without it the menu sizes to its longest
   * entry: at least `12rem` (`18rem` for touch), at most the viewport width
   * less `1rem` per side, where longer entries wrap.
   */
  width?: string;
  class?: string;
  menuClass?: string;
  onClose?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  label?: string;
  align?: "start" | "end";
  /**
   * `sheet` opens the same items as a bottom sheet on phones (below 48rem) instead of a menu beside the trigger.
   * Defaults to `menu`. A controlled menu (`open`) always stays a menu.
   */
  phone?: "menu" | "sheet";
  /** Content above the phone sheet's menu. `close` dismisses it with normal history and focus restoration. */
  sheetTop?: (close: () => void) => JSX.Element;
  /**
   * Renders the entries only once the menu first opens, for a menu repeated on every row of a long list: the page
   * then carries each row's trigger, not each row's entries. Fixed for the menu's lifetime.
   */
  lazy?: boolean;
  /**
   * Receives `open`, which shows the menu without its trigger beside `anchor`, as for a context menu, a key or a
   * grip. Focus returns to `returnFocus` when the menu or sheet closes; pass a function when an entry can move the
   * place focus belongs to. Phones get the sheet as from the trigger.
   */
  openAt?: (open: (anchor: DropdownAnchor, returnFocus?: DropdownReturnFocus) => void) => void;
  /** Receives `close`, which closes the menu or sheet and returns focus. */
  closeWith?: (close: () => void) => void;
  /**
   * Puts a search field above the entries. Focus starts in the field; Up and Down move through the matching entries,
   * Enter chooses one, and the first stays marked while the query changes.
   */
  search?: DropdownSearch;
  /**
   * Adopts an element rendered elsewhere as the trigger, such as a server-rendered link: a plain click, Enter, Space,
   * Up, or Down opens the menu, while a modified or middle click keeps the link. The element gets `aria-expanded` and
   * `aria-controls`; render `aria-haspopup` with it, so the server HTML already says it opens a menu. Read once on mount.
   */
  attach?: () => HTMLElement | null | undefined;
  /** `tile` sets every entry's icon on a quiet square, for menus whose icons tell entries apart, such as templates. */
  icons?: "plain" | "tile";
};

export type DropdownTriggerProps = Omit<
  ButtonProps,
  "aria-controls" | "aria-expanded" | "aria-haspopup" | "children" | "disabled" | "onClick" | "onKeyDown"
> & {
  children: JSX.Element;
  /** Use `plain` when a specialized component class owns the complete visual treatment. */
  appearance?: "button" | "plain";
  disabled?: boolean;
  iconOnly?: boolean;
  label?: string;
  size?: ButtonSize;
  tooltip?: JSX.Element | false;
  tooltipDelay?: number;
  tooltipPlacement?: TooltipPlacement;
  variant?: ButtonVariant;
};

export type DropdownItemProps = {
  children: JSX.Element;
  closeOnSelect?: boolean;
  ariaLabel?: string;
  icon?: string;
  image?: string;
  description?: string;
  /** Quiet trailing information, such as a count. */
  trailing?: JSX.Element;
  disabled?: boolean;
  danger?: boolean;
  variant?: "danger" | "accent";
  href?: string;
  external?: boolean;
  /** Runs when the item is chosen. With `href`, a plain click runs it instead of following the link. */
  onSelect?: () => void;
  class?: string;
};

type MenuContextValue = {
  close: (restoreFocus?: boolean) => void;
  /** `option` inside a searchable menu's list box, whose field keeps the focus. */
  role: "menuitem" | "option";
};

type DropdownContextValue = {
  disabled: () => boolean;
  menuId: string;
  open: () => boolean;
  popup: () => "dialog" | "menu";
  registerTrigger: (element: HTMLElement) => void;
  toggle: () => void;
  triggerKeyDown: JSX.EventHandlerUnion<HTMLButtonElement, KeyboardEvent>;
};

const MenuContext = createContext<MenuContextValue>();
const DropdownContext = createContext<DropdownContextValue>();

const actionableItems = (menu: HTMLElement | undefined): HTMLElement[] =>
  menu
    ? Array.from(
        menu.querySelectorAll<HTMLElement>(
          [
            "[role='menuitem']:not([aria-disabled='true'])",
            "[role='menuitemcheckbox']:not([aria-disabled='true'])",
            "[role='menuitemradio']:not([aria-disabled='true'])",
            "[role='option']:not([aria-disabled='true'])",
          ].join(", "),
        ),
      )
    : [];

const focusMenuItem = (menu: HTMLElement | undefined, index: number): void => {
  const items = actionableItems(menu).filter((item) => !item.classList.contains("k2b-dropdown__secondary"));
  if (items.length === 0) return;
  items[(index + items.length) % items.length]?.focus();
};

export const dropdownPosition = (
  trigger: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  menu: Pick<DOMRect, "width" | "height">,
  position: DropdownPosition,
  viewport: { width: number; height: number },
  gap = 4,
): { left: number; top: number } => {
  let left = trigger.left;
  let top = trigger.bottom + gap;

  if (position === "bottom-left" || position === "top-left") left = trigger.right - menu.width;
  if (position === "top-right" || position === "top-left") top = trigger.top - menu.height - gap;
  if (position === "right-start") {
    left = trigger.right + gap;
    top = trigger.top;
  }

  return {
    left: Math.max(8, Math.min(left, viewport.width - menu.width - 8)),
    top: Math.max(8, Math.min(top, viewport.height - menu.height - 8)),
  };
};

const itemContent = (props: {
  description?: string;
  icon?: string;
  image?: string;
  trailing?: JSX.Element;
  children: JSX.Element;
}): JSX.Element => (
  <>
    <Show when={props.image} fallback={<Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
      {(image) => <img class="k2b-dropdown__image" src={image()} alt="" />}
    </Show>
    <span class="k2b-dropdown__copy">
      <span>{props.children}</span>
      <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
    </span>
    {props.trailing}
  </>
);

export function DropdownItem(props: DropdownItemProps): JSX.Element {
  const menu = useContext(MenuContext);
  const danger = () => props.danger || props.variant === "danger";
  const role = () => menu?.role ?? "menuitem";
  const content = itemContent(props);

  return (
    <Show
      when={!props.disabled ? props.href : undefined}
      fallback={
        <button
          type="button"
          role={role()}
          aria-label={props.ariaLabel}
          tabIndex={-1}
          class={`k2b-dropdown__item ${props.class ?? ""}`}
          data-danger={danger() ? "true" : undefined}
          data-accent={props.variant === "accent" ? "true" : undefined}
          disabled={props.disabled}
          aria-disabled={props.disabled ? "true" : undefined}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (props.closeOnSelect !== false) menu?.close();
            props.onSelect?.();
          }}
        >
          {content}
        </button>
      }
    >
      {(href) => (
        <a
          href={href()}
          target={props.external ? "_blank" : undefined}
          rel={props.external ? "noopener noreferrer" : undefined}
          role={role()}
          aria-label={props.ariaLabel}
          tabIndex={-1}
          class={`k2b-dropdown__item ${props.class ?? ""}`}
          data-danger={danger() ? "true" : undefined}
          data-accent={props.variant === "accent" ? "true" : undefined}
          onClick={(event) => {
            // With `onSelect`, a plain click runs it in place of the link; a modified click keeps its browser meaning.
            if (props.onSelect && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
              event.preventDefault();
              menu?.close();
              props.onSelect();
              return;
            }
            menu?.close(false);
          }}
        >
          {content}
        </a>
      )}
    </Show>
  );
}

function DropdownChoiceItem(props: DropdownChoice): JSX.Element {
  return (
    <Show when={props.secondary} fallback={<DropdownChoiceRow {...props} />}>
      {(secondary) => (
        <div class="k2b-dropdown__pair">
          <DropdownChoiceRow {...props} />
          <DropdownSecondaryButton {...secondary()} class="k2b-dropdown__secondary" />
        </div>
      )}
    </Show>
  );
}

function DropdownSecondaryButton(props: DropdownSecondaryAction & { class: string }): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      class={props.class}
      aria-label={props.ariaLabel}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.action();
      }}
    >
      {props.label}
    </button>
  );
}

function DropdownChoiceRow(props: DropdownChoice): JSX.Element {
  const menu = useContext(MenuContext);
  const checked = () => (typeof props.checked === "function" ? props.checked() : props.checked);
  let element: HTMLElement | undefined;
  return (
    <Dynamic
      ref={(node: HTMLAnchorElement | HTMLButtonElement) => {
        element = node;
      }}
      component={!props.disabled && props.href ? "a" : "button"}
      href={!props.disabled ? props.href : undefined}
      type={!props.disabled && props.href ? undefined : "button"}
      role={menu?.role === "option" ? "option" : props.choice === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
      aria-label={props.ariaLabel}
      aria-checked={checked()}
      aria-disabled={props.disabled ? "true" : undefined}
      tabIndex={-1}
      class={`k2b-dropdown__item ${props.class ?? ""}`}
      data-selected={checked() ? "true" : undefined}
      disabled={props.disabled}
      onClick={(event: MouseEvent) => {
        if (props.href && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
          menu?.close(false);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (props.closeOnSelect !== false) menu?.close();
        props.action();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        // A link answers only Enter; as a menu choice it also answers Space, like the button form.
        if (event.key !== " " || props.disabled || !props.href) return;
        event.preventDefault();
        element?.click();
      }}
    >
      <Show when={props.choice === "checkbox"}>
        <span class="k2b-dropdown__checkbox" aria-hidden="true">
          <Show when={checked()}>
            <i class="ti ti-check" />
          </Show>
        </span>
      </Show>
      <Show when={props.image} fallback={<Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
        {(image) => <img class="k2b-dropdown__image" src={image()} alt="" />}
      </Show>
      <Show when={props.color}>
        {(color) => <span class="k2b-dropdown__color" style={{ "--k2b-dropdown-color": color() }} aria-hidden="true" />}
      </Show>
      <span class="k2b-dropdown__copy">
        <span>{props.label}</span>
        <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
      </span>
      {props.trailing}
      {/* Always present for radios, so selecting the widest entry cannot widen a content-sized menu. */}
      <Show when={props.choice === "radio"}>
        <i class="ti ti-check k2b-dropdown__check" data-hidden={checked() ? undefined : "true"} aria-hidden="true" />
      </Show>
    </Dynamic>
  );
}

export function DropdownItems(props: {
  items: readonly DropdownItem[];
  close: (restoreFocus?: boolean) => void;
  role?: "menuitem" | "option";
}): JSX.Element {
  const messages = useUiMessages();
  // Rows read their current item: a host that rebuilds equal items while the menu is open keeps each row element (#2140).
  const renderItem = (item: () => DropdownAction | DropdownChoice): JSX.Element => {
    const initial = untrack(item);
    if ("choice" in initial) return <DropdownChoiceItem {...mergeProps(() => item() as DropdownChoice)} />;
    const action = () => item() as DropdownAction;
    return (
      <DropdownItem
        ariaLabel={action().ariaLabel}
        closeOnSelect={closeOnSelectOf(action())}
        icon={action().icon}
        image={action().image}
        description={action().description}
        trailing={action().trailing}
        variant={action().variant}
        disabled={action().disabled}
        class={action().class}
        href={hrefOf(action())}
        external={externalOf(action())}
        onSelect={selectAction(action())}
      >
        {action().label}
      </DropdownItem>
    );
  };

  return (
    <MenuContext.Provider value={{ close: props.close, role: props.role ?? "menuitem" }}>
      <KeyedFor each={props.items} by={(item) => ("items" in item ? `section:${item.sectionLabel ?? ""}` : `item:${item.label}`)}>
        {(current, index) => {
          const item = current();
          return (
            <Show when={"items" in item} fallback={renderItem(current as () => DropdownAction | DropdownChoice)}>
              <div
                class="k2b-dropdown__section"
                data-divided={index() > 0 ? "true" : undefined}
                role="group"
                // A row of choices is no set of actions: without a label it stays unnamed rather than misnamed.
                aria-label={
                  (current() as DropdownSection).sectionLabel ??
                  ((current() as DropdownSection).layout === "row" ? undefined : messages().actions)
                }
              >
                <Show when={(current() as DropdownSection).sectionLabel}>
                  {(label) => (
                    <Show when={(current() as DropdownSection).labelAction} fallback={<div class="k2b-dropdown__label">{label()}</div>}>
                      {(action) => (
                        <div class="k2b-dropdown__label k2b-dropdown__label--action">
                          <span>{label()}</span>
                          <DropdownSecondaryButton {...action()} class="k2b-dropdown__label-action" />
                        </div>
                      )}
                    </Show>
                  )}
                </Show>
                <Show
                  when={(current() as DropdownSection).layout === "row"}
                  fallback={
                    <KeyedFor each={(current() as DropdownSection).items} by={(row) => row.label}>
                      {renderItem}
                    </KeyedFor>
                  }
                >
                  <div class="k2b-dropdown__row">
                    <KeyedFor each={(current() as DropdownSection).items} by={(row) => row.label}>
                      {renderItem}
                    </KeyedFor>
                  </div>
                </Show>
              </div>
            </Show>
          );
        }}
      </KeyedFor>
    </MenuContext.Provider>
  );
}

function DropdownTrigger(props: DropdownTriggerProps): JSX.Element {
  const context = useContext(DropdownContext);
  if (!context) throw new Error("Dropdown.Trigger must be used inside Dropdown.Root");
  const [local, rest] = splitProps(props, [
    "appearance",
    "children",
    "class",
    "disabled",
    "iconOnly",
    "label",
    "ref",
    "size",
    "tabIndex",
    "title",
    "tooltip",
    "tooltipDelay",
    "tooltipPlacement",
    "type",
    "variant",
  ]);
  let target: HTMLButtonElement | undefined;
  const disabled = () => Boolean(context.disabled() || local.disabled);
  // An icon-only trigger shows its label as a hint, like IconButton.
  const tooltip = useLabelTooltip(
    () => local.tooltip,
    () => (local.iconOnly ? (local.title ?? local.label) : undefined),
  );
  const register = (element: HTMLButtonElement) => {
    target = element;
    context.registerTrigger(element);
    if (typeof local.ref === "function") local.ref(element);
  };
  const click: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.stopPropagation();
    context.toggle();
  };

  if (local.appearance !== "plain") {
    return (
      <Button
        {...rest}
        ref={register}
        aria-controls={context.menuId}
        aria-expanded={context.open()}
        aria-haspopup={context.popup()}
        aria-label={local.label}
        disabled={disabled()}
        tabIndex={disabled() ? -1 : local.tabIndex}
        onClick={click}
        onKeyDown={context.triggerKeyDown}
        type={local.type ?? "button"}
        class={`${local.iconOnly ? "k2b-icon-button" : ""} k2b-dropdown__trigger ${local.class ?? ""}`}
        size={local.size}
        variant={local.variant ?? (local.iconOnly ? "ghost" : undefined)}
        title={iconTitle(local.title, tooltip())}
        tooltip={tooltip()}
        tooltipDelay={local.tooltipDelay}
        tooltipPlacement={local.tooltipPlacement}
      >
        {local.children}
      </Button>
    );
  }

  return (
    <>
      <button
        {...rest}
        ref={register}
        aria-controls={context.menuId}
        aria-expanded={context.open()}
        aria-haspopup={context.popup()}
        aria-label={local.label}
        disabled={disabled()}
        tabIndex={disabled() ? -1 : local.tabIndex}
        onClick={click}
        onKeyDown={context.triggerKeyDown}
        type={local.type ?? "button"}
        class={`k2b-dropdown__trigger ${local.class ?? ""}`}
        title={iconTitle(local.title, tooltip())}
      >
        {local.children}
      </button>
      <Show when={tooltip() !== false && tooltip() !== undefined}>
        <Tooltip
          content={tooltip() as JSX.Element}
          target={() => target}
          delay={local.tooltipDelay}
          disabled={disabled()}
          placement={local.tooltipPlacement}
        />
      </Show>
    </>
  );
}

/** Accessible top-layer menu with explicit trigger ownership. */
function DropdownRoot(props: DropdownProps): JSX.Element {
  const messages = useUiMessages();
  const locale = useLocale();
  /** The open phone sheet's cancel switch: it closes when the menu goes or is disabled, as the popover does. */
  let sheet: AbortController | undefined;
  const id = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const menuId = `k2b-dropdown-${id}`;
  const [internalOpen, setInternalOpen] = createSignal(false);
  const [entriesShown, setEntriesShown] = createSignal(!props.lazy);
  let triggerRef: HTMLElement | undefined;
  const [query, setQuery] = createSignal("");
  let searchApi: MenuSearchApi | undefined;
  /** Set while the menu is open from `openAt`: it appears beside `anchor`, and focus returns to `origin`. */
  let anchor: DropdownAnchor | undefined;
  let origin: DropdownReturnFocus | undefined;
  const originElement = () => (typeof origin === "function" ? origin() : origin);
  let menuRef: HTMLDivElement | undefined;
  let triggerRing = true;
  let mounted = false;
  /** Where a key on the trigger asked the focus to go; a controlled menu opens later, in its owner's update. */
  let keyFocus: "first" | "last" | false = false;
  let viewportListenersAttached = false;
  let resizeObserver: ResizeObserver | undefined;

  const isOpen = () => props.open ?? internalOpen();
  const position = (): DropdownPosition =>
    typeof props.position === "function" ? props.position() : (props.position ?? (props.align === "end" ? "bottom-left" : "bottom-right"));

  const place = () => {
    const at = anchor ?? triggerRef;
    if (!at || !menuRef) return;
    const rect = dropdownPosition(at.getBoundingClientRect(), menuRef.getBoundingClientRect(), position(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    menuRef.style.left = `${rect.left}px`;
    menuRef.style.top = `${rect.top}px`;
  };
  const reposition = () => {
    if (isOpen()) place();
  };
  const attachViewportListeners = () => {
    if (viewportListenersAttached) return;
    viewportListenersAttached = true;
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    // A content-sized menu changes size when its items change while it is open.
    if (menuRef && typeof ResizeObserver !== "undefined") {
      resizeObserver ??= new ResizeObserver(reposition);
      resizeObserver.observe(menuRef);
    }
  };
  const detachViewportListeners = () => {
    if (!viewportListenersAttached) return;
    viewportListenersAttached = false;
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    resizeObserver?.disconnect();
  };
  const close = (restoreFocus = true) => {
    // Before hiding, so the popover does not return focus on its own.
    if (restoreFocus) returnFocus(originElement() ?? triggerRef, triggerRing);
    if (menuRef?.matches(":popover-open")) menuRef.hidePopover();
    setQuery("");
    // Like `open`, expose the closed state now: the toggle event can arrive after the next key press, and a trigger
    // that still reads as open would ignore Enter (Escape, then Enter at once, must reopen).
    setInternalOpen(false);
    detachViewportListeners();
  };
  const open = (focus: "first" | "last" | false = "first") => {
    if (props.disabled || !menuRef || menuRef.matches(":popover-open")) return;
    triggerRing = ringOnReturn(originElement() ?? triggerRef);
    // A lazy menu's entries exist before it shows, so it places and focuses them as any other.
    setEntriesShown(true);
    menuRef.showPopover();
    // The toggle event arrives a task later; expose the open state before focus moves into the menu.
    setInternalOpen(true);
    attachViewportListeners();
    place();
    queueMicrotask(() => {
      if (!focus) return;
      if (searchApi) searchApi.focus(focus);
      else focusMenuItem(menuRef, focus === "first" ? 0 : -1);
    });
  };
  const requestOpen = (next: boolean, focus: "first" | "last" | false = "first") => {
    if (props.disabled && next) return;
    if (props.open !== undefined) {
      props.onOpenChange?.(next);
      return;
    }
    if (next && props.phone === "sheet" && prefersMenuSheet()) {
      if (sheet) return;
      const current = new AbortController();
      sheet = current;
      // A sheet opened without its trigger returns focus to its own target, which an entry may have moved,
      // rather than to whatever had focus as it opened.
      const anchored = origin !== undefined;
      const ring = anchored && ringOnReturn(originElement());
      if (anchored && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // The sheet is this menu's open state: the trigger reports it and the owner hears both ends.
      setInternalOpen(true);
      props.onOpenChange?.(true);
      void openMenuSheet({
        Items: DropdownItems,
        items: props.items,
        label: props.label ?? messages().dropdownMenu,
        locale: locale(),
        top: props.sheetTop,
        search: props.search,
        icons: props.icons,
        signal: current.signal,
      }).finally(() => {
        sheet = undefined;
        // An entry that moved focus elsewhere, such as into a field, keeps it.
        const target = anchored ? originElement() : undefined;
        const focused = document.activeElement;
        if (target?.isConnected && (!focused || focused === document.body)) returnFocus(target, ring);
        setInternalOpen(false);
        props.onOpenChange?.(false);
        props.onClose?.();
      });
      return;
    }
    if (next) open(focus);
    else close(false);
  };
  const handleMenuKeyDown = (event: KeyboardEvent) => {
    const items = actionableItems(menuRef);
    // A searchable menu's field keeps the focus and moves the marked entry itself.
    if (!props.search && (focusMenuRow(items, event.key) || focusRowSegment(items, event.key))) {
      event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      returnFocus(originElement() ?? triggerRef, triggerRing);
      requestOpen(false);
    } else if (event.key === "Tab") {
      requestOpen(false);
    }
  };

  const triggerKey = (event: KeyboardEvent) => {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) {
      if (searchApi) searchApi.focus(event.key === "ArrowUp" ? "last" : "first");
      else focusMenuItem(menuRef, event.key === "ArrowUp" ? -1 : 0);
      return;
    }
    anchor = origin = undefined;
    keyFocus = event.key === "ArrowUp" ? "last" : "first";
    requestOpen(true, keyFocus);
    keyFocus = false;
  };
  const toggle = () => {
    if (!isOpen()) anchor = origin = undefined;
    requestOpen(!isOpen());
  };

  const context: DropdownContextValue = {
    disabled: () => Boolean(props.disabled),
    menuId,
    open: isOpen,
    registerTrigger: (element) => {
      triggerRef = element;
    },
    toggle,
    popup: () => (props.search ? "dialog" : "menu"),
    triggerKeyDown: (event) => triggerKey(event),
  };

  createEffect(() => {
    const controlled = props.open;
    if (!mounted || controlled === undefined || !menuRef) return;
    if (controlled && !menuRef.matches(":popover-open")) open(keyFocus);
    if (!controlled && menuRef.matches(":popover-open")) close(false);
  });
  createEffect(() => {
    if (!props.disabled) return;
    sheet?.abort();
    if (mounted) close(false);
  });
  props.openAt?.((at, focus) => {
    if (isOpen()) return;
    anchor = at;
    origin = focus;
    requestOpen(true);
  });
  props.closeWith?.(() => {
    sheet?.abort();
    if (isOpen()) close();
  });
  onMount(() => {
    mounted = true;
    if (props.open) open(false);
    onCleanup(detachViewportListeners);
    const adopted = props.attach?.();
    if (!adopted) return;
    triggerRef = adopted;
    adopted.setAttribute("aria-controls", menuId);
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    adopted.addEventListener("click", onClick);
    adopted.addEventListener("keydown", triggerKey);
    createEffect(() => adopted.setAttribute("aria-expanded", String(isOpen())));
    onCleanup(() => {
      adopted.removeEventListener("click", onClick);
      adopted.removeEventListener("keydown", triggerKey);
    });
  });
  onCleanup(() => sheet?.abort());

  return (
    <DropdownContext.Provider value={context}>
      <span class={`k2b-dropdown ${props.class ?? ""}`}>
        {props.children}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menu, or dialog with search; both take a name. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a menu or dialog popup owns its keys. */}
        <div
          ref={menuRef}
          id={menuId}
          popover="auto"
          role={props.search ? "dialog" : "menu"}
          aria-label={props.label ?? messages().dropdownMenu}
          class={`k2b-dropdown__menu ${props.menuClass ?? ""}`}
          style={props.width ? { "--k2b-dropdown-width": props.width } : undefined}
          data-width={props.width ? "fixed" : undefined}
          data-variant={props.variant ?? "default"}
          data-icons={props.icons === "tile" ? "tile" : undefined}
          data-search={props.search ? "" : undefined}
          data-position={position()}
          onKeyDown={handleMenuKeyDown}
          onToggle={(event) => {
            const nextOpen = (event as ToggleEvent).newState === "open";
            const wasOpen = (event as ToggleEvent).oldState === "open";
            setInternalOpen(nextOpen);
            if (nextOpen) setEntriesShown(true);
            if (nextOpen) attachViewportListeners();
            else detachViewportListeners();
            if (props.open === undefined || props.open !== nextOpen) props.onOpenChange?.(nextOpen);
            // A light dismiss hides the menu with focus inside it; an opener without a trigger takes it back.
            const focused = document.activeElement;
            const target = wasOpen && !nextOpen ? originElement() : undefined;
            if (target?.isConnected && (!focused || focused === document.body || menuRef?.contains(focused)))
              returnFocus(target, triggerRing);
            if (wasOpen && !nextOpen) setQuery("");
            if (wasOpen && !nextOpen) props.onClose?.();
            if (!nextOpen && props.open === true) queueMicrotask(() => props.open === true && open(false));
          }}
        >
          <Show when={entriesShown()}>
            <Show when={props.search} fallback={<DropdownItems items={props.items} close={close} />}>
              {(search) => (
                <MenuSearch
                  Items={DropdownItems}
                  items={props.items}
                  search={search()}
                  label={props.label ?? messages().dropdownMenu}
                  query={query}
                  setQuery={setQuery}
                  close={close}
                  api={(api) => {
                    searchApi = api;
                    onCleanup(() => {
                      if (searchApi === api) searchApi = undefined;
                    });
                  }}
                />
              )}
            </Show>
          </Show>
        </div>
      </span>
    </DropdownContext.Provider>
  );
}

type DropdownComponent = ((props: DropdownProps) => JSX.Element) & {
  Root: (props: DropdownProps) => JSX.Element;
  Trigger: (props: DropdownTriggerProps) => JSX.Element;
  Item: (props: DropdownItemProps) => JSX.Element;
};

export const Dropdown = DropdownRoot as DropdownComponent;
Dropdown.Root = DropdownRoot;
Dropdown.Trigger = DropdownTrigger;
Dropdown.Item = DropdownItem;

export default Dropdown;
