import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import { Tooltip, type TooltipPlacement } from "../feedback/Tooltip";
import { useUiMessages } from "../intl/messages";
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";

export type DropdownPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "right-start";

export type DropdownActionBase = {
  class?: string;
  disabled?: boolean;
  icon?: string;
  image?: string;
  label: string;
  description?: string;
  variant?: "danger";
};

export type DropdownAction =
  | (DropdownActionBase & {
      action: () => void;
      href?: never;
      external?: never;
    })
  | (DropdownActionBase & {
      href: string;
      external?: boolean;
      action?: never;
    })
  | (DropdownActionBase & {
      disabled: true;
      action?: never;
      href?: never;
      external?: never;
    });

/** Declarative radio or checkbox row for compact action menus. */
export type DropdownChoice = DropdownActionBase & {
  action: () => void;
  checked: boolean | (() => boolean);
  choice: "checkbox" | "radio";
  closeOnSelect?: boolean;
  color?: string;
};

export type DropdownSection = {
  sectionLabel?: string;
  items: readonly (DropdownAction | DropdownChoice)[];
};

export type DropdownItem = DropdownAction | DropdownChoice | DropdownSection;

export type DropdownProps = {
  items: readonly DropdownItem[];
  children: JSX.Element;
  position?: DropdownPosition | (() => DropdownPosition);
  /** Menu width as a CSS length. Defaults to `12rem`. */
  width?: string;
  class?: string;
  menuClass?: string;
  onClose?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  label?: string;
  align?: "start" | "end";
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
  icon?: string;
  image?: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  variant?: "danger";
  href?: string;
  external?: boolean;
  onSelect?: () => void;
  class?: string;
};

type MenuContextValue = {
  close: (restoreFocus?: boolean) => void;
};

type DropdownContextValue = {
  disabled: () => boolean;
  menuId: string;
  open: () => boolean;
  registerTrigger: (element: HTMLButtonElement) => void;
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
          ].join(", "),
        ),
      )
    : [];

const focusMenuItem = (menu: HTMLElement | undefined, index: number): void => {
  const items = actionableItems(menu);
  if (items.length === 0) return;
  items[(index + items.length) % items.length]?.focus();
};

export const dropdownPosition = (
  trigger: DOMRect,
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

const itemContent = (props: { description?: string; icon?: string; image?: string; children: JSX.Element }): JSX.Element => (
  <>
    <Show when={props.image} fallback={<Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
      {(image) => <img class="k2b-dropdown__image" src={image()} alt="" />}
    </Show>
    <span class="k2b-dropdown__copy">
      <span>{props.children}</span>
      <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
    </span>
  </>
);

export function DropdownItem(props: DropdownItemProps): JSX.Element {
  const menu = useContext(MenuContext);
  const danger = () => props.danger || props.variant === "danger";
  const content = itemContent(props);

  return (
    <Show
      when={!props.disabled ? props.href : undefined}
      fallback={
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          class={`k2b-dropdown__item ${props.class ?? ""}`}
          data-danger={danger() ? "true" : undefined}
          disabled={props.disabled}
          aria-disabled={props.disabled ? "true" : undefined}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            menu?.close();
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
          role="menuitem"
          tabIndex={-1}
          class={`k2b-dropdown__item ${props.class ?? ""}`}
          data-danger={danger() ? "true" : undefined}
          onClick={() => {
            menu?.close(false);
            props.onSelect?.();
          }}
        >
          {content}
        </a>
      )}
    </Show>
  );
}

function DropdownChoiceItem(props: DropdownChoice): JSX.Element {
  const menu = useContext(MenuContext);
  const checked = () => (typeof props.checked === "function" ? props.checked() : props.checked);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the runtime role is always menuitemcheckbox or menuitemradio, both of which support aria-checked.
    <button
      type="button"
      role={props.choice === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={checked()}
      aria-disabled={props.disabled ? "true" : undefined}
      tabIndex={-1}
      class={`k2b-dropdown__item ${props.class ?? ""}`}
      data-selected={checked() ? "true" : undefined}
      disabled={props.disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (props.closeOnSelect !== false) menu?.close();
        props.action();
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
      <Show when={props.choice === "radio" && checked()}>
        <i class="ti ti-check k2b-dropdown__check" aria-hidden="true" />
      </Show>
    </button>
  );
}

export function DropdownItems(props: { items: readonly DropdownItem[]; close: (restoreFocus?: boolean) => void }): JSX.Element {
  const messages = useUiMessages();
  const renderItem = (item: DropdownAction | DropdownChoice): JSX.Element =>
    "choice" in item ? (
      <DropdownChoiceItem {...item} />
    ) : (
      <DropdownItem
        icon={item.icon}
        image={item.image}
        description={item.description}
        variant={item.variant}
        disabled={item.disabled}
        class={item.class}
        href={"href" in item ? item.href : undefined}
        external={"external" in item ? item.external : undefined}
        onSelect={"action" in item ? item.action : undefined}
      >
        {item.label}
      </DropdownItem>
    );

  return (
    <MenuContext.Provider value={{ close: props.close }}>
      <For each={props.items}>
        {(item, index) => (
          <Show when={"items" in item} fallback={renderItem(item as DropdownAction | DropdownChoice)}>
            <div
              class="k2b-dropdown__section"
              data-divided={index() > 0 ? "true" : undefined}
              role="group"
              aria-label={(item as DropdownSection).sectionLabel ?? messages().actions}
            >
              <Show when={(item as DropdownSection).sectionLabel}>{(label) => <div class="k2b-dropdown__label">{label()}</div>}</Show>
              <For each={(item as DropdownSection).items}>{renderItem}</For>
            </div>
          </Show>
        )}
      </For>
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
    "tooltip",
    "tooltipDelay",
    "tooltipPlacement",
    "type",
    "variant",
  ]);
  let target: HTMLButtonElement | undefined;
  const disabled = () => Boolean(context.disabled() || local.disabled);
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
        aria-haspopup="menu"
        aria-label={local.label}
        disabled={disabled()}
        tabIndex={disabled() ? -1 : local.tabIndex}
        onClick={click}
        onKeyDown={context.triggerKeyDown}
        type={local.type ?? "button"}
        class={`${local.iconOnly ? "k2b-icon-button" : ""} k2b-dropdown__trigger ${local.class ?? ""}`}
        size={local.size}
        variant={local.variant ?? (local.iconOnly ? "ghost" : undefined)}
        tooltip={local.tooltip}
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
        aria-haspopup="menu"
        aria-label={local.label}
        disabled={disabled()}
        tabIndex={disabled() ? -1 : local.tabIndex}
        onClick={click}
        onKeyDown={context.triggerKeyDown}
        type={local.type ?? "button"}
        class={`k2b-dropdown__trigger ${local.class ?? ""}`}
      >
        {local.children}
      </button>
      <Show when={local.tooltip !== false && local.tooltip !== undefined}>
        <Tooltip
          content={local.tooltip as JSX.Element}
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
  const id = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const menuId = `k2b-dropdown-${id}`;
  const [internalOpen, setInternalOpen] = createSignal(false);
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let mounted = false;
  let viewportListenersAttached = false;

  const isOpen = () => props.open ?? internalOpen();
  const position = (): DropdownPosition =>
    typeof props.position === "function" ? props.position() : (props.position ?? (props.align === "end" ? "bottom-left" : "bottom-right"));

  const place = () => {
    if (!triggerRef || !menuRef) return;
    const rect = dropdownPosition(triggerRef.getBoundingClientRect(), menuRef.getBoundingClientRect(), position(), {
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
  };
  const detachViewportListeners = () => {
    if (!viewportListenersAttached) return;
    viewportListenersAttached = false;
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
  };
  const close = (restoreFocus = true) => {
    if (menuRef?.matches(":popover-open")) menuRef.hidePopover();
    detachViewportListeners();
    if (restoreFocus) queueMicrotask(() => triggerRef?.focus());
  };
  const open = (focus: "first" | "last" | false = "first") => {
    if (props.disabled || !menuRef || menuRef.matches(":popover-open")) return;
    menuRef.showPopover();
    attachViewportListeners();
    place();
    queueMicrotask(() => {
      if (focus) focusMenuItem(menuRef, focus === "first" ? 0 : -1);
    });
  };
  const requestOpen = (next: boolean, focus: "first" | "last" | false = "first") => {
    if (props.disabled && next) return;
    if (props.open !== undefined) {
      props.onOpenChange?.(next);
      return;
    }
    if (next) open(focus);
    else close(false);
  };
  const handleMenuKeyDown = (event: KeyboardEvent) => {
    const items = actionableItems(menuRef);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(menuRef, current + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusMenuItem(menuRef, event.key === "Home" ? 0 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      requestOpen(false);
      queueMicrotask(() => triggerRef?.focus());
    } else if (event.key === "Tab") {
      requestOpen(false);
    }
  };

  const context: DropdownContextValue = {
    disabled: () => Boolean(props.disabled),
    menuId,
    open: isOpen,
    registerTrigger: (element) => {
      triggerRef = element;
    },
    toggle: () => requestOpen(!isOpen()),
    triggerKeyDown: (event) => {
      if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isOpen()) {
        focusMenuItem(menuRef, event.key === "ArrowUp" ? -1 : 0);
        return;
      }
      requestOpen(true, event.key === "ArrowUp" ? "last" : "first");
    },
  };

  createEffect(() => {
    const controlled = props.open;
    if (!mounted || controlled === undefined || !menuRef) return;
    if (controlled && !menuRef.matches(":popover-open")) open(false);
    if (!controlled && menuRef.matches(":popover-open")) close(false);
  });
  createEffect(() => {
    if (mounted && props.disabled) close(false);
  });
  onMount(() => {
    mounted = true;
    if (props.open) open(false);
    onCleanup(detachViewportListeners);
  });

  return (
    <DropdownContext.Provider value={context}>
      <span class={`k2b-dropdown ${props.class ?? ""}`}>
        {props.children}
        <div
          ref={menuRef}
          id={menuId}
          popover="auto"
          role="menu"
          aria-label={props.label ?? messages().dropdownMenu}
          class={`k2b-dropdown__menu ${props.menuClass ?? ""}`}
          style={props.width ? { "--k2b-dropdown-width": props.width } : undefined}
          data-position={position()}
          onKeyDown={handleMenuKeyDown}
          onToggle={(event) => {
            const nextOpen = (event as ToggleEvent).newState === "open";
            const wasOpen = internalOpen();
            setInternalOpen(nextOpen);
            if (nextOpen) attachViewportListeners();
            else detachViewportListeners();
            if (props.open === undefined || props.open !== nextOpen) props.onOpenChange?.(nextOpen);
            if (wasOpen && !nextOpen) props.onClose?.();
            if (!nextOpen && props.open === true) queueMicrotask(() => props.open === true && open(false));
          }}
        >
          <DropdownItems items={props.items} close={close} />
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
