import { createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { dropdownPosition } from "../actions/Dropdown";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { useUiMessages } from "../intl/messages";

/** One container a person can switch to, such as a notebook, a space, or a mailbox. */
export type AppWorkspaceSwitcherOption = {
  id: string;
  label: string;
  /** One secondary fact, such as a mailbox's address. */
  description?: string;
  /** Tabler icon class; without it the row takes the switcher's icon. */
  icon?: string;
  /** Tints the icon; without it the app accent does. */
  color?: string;
  href: string;
};

/** A row below the containers, such as "New notebook" or "All notebooks". */
export type AppWorkspaceSwitcherAction = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
} & ({ href: string; action?: never } | { action: () => void; href?: never });

export type AppWorkspaceSidebarSwitcherProps = {
  /** The current container's ID among `options`. */
  currentId: string;
  /** The current container's name. */
  label: string;
  /** One secondary fact under the name, such as a mailbox's address. */
  description?: string;
  icon: string;
  /** Tints the icon; without it the app accent does. */
  color?: string;
  /** Names the button's purpose and its panel, such as "Switch notebook". */
  switchLabel: string;
  /** Every container the person can switch to, the current one included; `undefined` until they are loaded. */
  options?: readonly AppWorkspaceSwitcherOption[];
  /** Shown in place of the options when loading them failed; the panel offers to try again through `onLoad`. */
  error?: string;
  /**
   * Asks for `options` while they are `undefined`: when a pointer or the focus first reaches the button, so the list
   * is usually there when the panel opens, on every opening, and from the panel's retry. Ignore repeated calls while a
   * request runs.
   */
  onLoad?: () => void;
  actions?: readonly AppWorkspaceSwitcherAction[];
  /** Sizes the switcher in its place, such as `flex-1` beside a button in one row. */
  class?: string;
};

/** From this many containers the panel scrolls, so it offers a search field. */
export const APP_WORKSPACE_SWITCHER_SEARCH_FROM = 8;

const iconClass = (icon: string) => (icon.split(/\s+/).includes("ti") ? icon : `ti ${icon}`);
const tint = (color: string | undefined) => (color ? { "--k2b-sidebar-switcher-color": color } : undefined);
const plainClick = (event: MouseEvent) => event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

/**
 * The current container at the top of a sidebar: its icon, name, and an optional fact, with a chevron that opens the
 * other containers, a search field when there are many, and actions such as "New …" and "All …". The rows are links,
 * so a container also opens in a new tab. In a collapsed rail it shows only the icon and opens beside the rail.
 */
export function AppWorkspaceSidebarSwitcher(props: AppWorkspaceSidebarSwitcherProps): JSX.Element {
  const messages = useUiMessages();
  const id = `k2b-sidebar-switcher-${createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  let keyboardOpened = true;
  /** Whether the panel was open when a press on the button began; the press itself light-dismisses it first. */
  let openAtPress: boolean | undefined;

  const searchable = () => (props.options?.length ?? 0) >= APP_WORKSPACE_SWITCHER_SEARCH_FROM;
  const visible = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const options = props.options ?? [];
    if (!needle) return options;
    return options.filter((option) => [option.label, option.description].some((part) => part?.toLocaleLowerCase().includes(needle)));
  });
  const load = () => {
    if (props.options === undefined) props.onLoad?.();
  };

  // The collapsed rail is a narrow column from 64 rem, so the panel opens beside it instead of below.
  const inRail = () =>
    Boolean(
      trigger?.closest('[data-sidebar-collapsed="true"] .k2b-app-workspace__sidebar[data-workspace-collapsible="true"]') &&
        window.matchMedia("(min-width: 64rem)").matches,
    );
  const place = () => {
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    // As wide as the sidebar row and never narrower than a menu, so long names keep their words; fixed while open,
    // so filtering never changes the panel's width.
    panel.style.setProperty("--k2b-sidebar-switcher-width", `${inRail() ? 0 : Math.round(rect.width)}px`);
    const position = dropdownPosition(rect, panel.getBoundingClientRect(), inRail() ? "right-start" : "bottom-right", {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
  };
  const reposition = () => open() && place();
  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("resize", reposition);
    window[method]("scroll", reposition, true);
  };
  // Server rendering cleans up too, where no window exists.
  onCleanup(() => isServer || listen(false));

  const rows = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-switcher-row]:not([aria-disabled='true'])")) : []);
  const focusRow = (index: number) => {
    const all = rows();
    if (all.length) all[(index + all.length) % all.length]?.focus();
  };
  const show = (focus: "start" | "end" = "start") => {
    if (!panel || panel.matches(":popover-open")) return;
    load();
    keyboardOpened = ringOnReturn(trigger);
    setQuery("");
    panel.showPopover();
    setOpen(true);
    listen(true);
    place();
    queueMicrotask(() => {
      // On touch the search field waits for a tap, so the keyboard does not cover the list on opening.
      if (searchable() && focus === "start" && !window.matchMedia("(pointer: coarse)").matches) search?.focus();
      else if (focus === "end") focusRow(-1);
      // While the list loads, the panel holds focus, so arriving rows do not move it.
      else (panel?.querySelector<HTMLElement>('[aria-current="true"]') ?? (props.options ? rows()[0] : panel))?.focus();
    });
  };
  const hide = (restoreFocus: boolean) => {
    if (restoreFocus) returnFocus(trigger, keyboardOpened);
    if (panel?.matches(":popover-open")) panel.hidePopover();
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const all = rows();
    const index = all.indexOf(target);
    if (event.key === "Escape") {
      // The panel closes alone; an overlay sidebar around it stays open.
      event.preventDefault();
      event.stopPropagation();
      hide(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if ((event.key === "Home" || event.key === "End") && target !== search) {
      event.preventDefault();
      focusRow(event.key === "Home" ? 0 : -1);
    } else if (event.key === "Enter" && target === search) {
      event.preventDefault();
      panel?.querySelector<HTMLElement>("[data-switcher-option]")?.click();
    } else if (
      search &&
      target !== search &&
      event.key.length === 1 &&
      event.key !== " " &&
      !(event.metaKey || event.ctrlKey || event.altKey)
    ) {
      // Typing anywhere in a long list searches it.
      event.preventDefault();
      setQuery(query() + event.key);
      search.focus();
    }
  };

  return (
    <div class={`k2b-sidebar-switcher ${props.class ?? ""}`} data-description={props.description ? "" : undefined}>
      <button
        ref={trigger}
        type="button"
        class="k2b-sidebar-switcher__trigger"
        aria-label={props.label}
        aria-describedby={`${id}-purpose`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={id}
        // The full name for a truncated title and for the icon in a collapsed rail.
        title={props.label}
        onPointerEnter={load}
        onFocus={load}
        onPointerDown={() => (openAtPress = panel?.matches(":popover-open"))}
        onClick={() => {
          const wasOpen = openAtPress ?? panel?.matches(":popover-open");
          openAtPress = undefined;
          if (wasOpen) hide(false);
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (open()) focusRow(event.key === "ArrowDown" ? 0 : -1);
          else show(event.key === "ArrowDown" ? "start" : "end");
        }}
      >
        <span class="k2b-sidebar-switcher__icon" style={tint(props.color)} aria-hidden="true">
          <i class={iconClass(props.icon)} />
        </span>
        <span class="k2b-sidebar-switcher__copy" aria-hidden="true">
          <span>{props.label}</span>
          <Show when={props.description}>{(description) => <small>{description()}</small>}</Show>
        </span>
        <i class="ti ti-selector k2b-sidebar-switcher__chevron" aria-hidden="true" />
        <span id={`${id}-purpose`} class="k2b-sr-only">
          {[props.description, props.switchLabel].filter(Boolean).join(", ")}
        </span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        tabIndex={-1}
        role="dialog"
        aria-label={props.switchLabel}
        class="k2b-sidebar-switcher__panel"
        onKeyDown={onPanelKeyDown}
        onFocusOut={(event) => {
          const next = event.relatedTarget as Node | null;
          // Tabbing out closes the panel; focus that leaves the window keeps it.
          if (next && !panel?.contains(next) && next !== trigger) hide(false);
        }}
        onToggle={(event) => {
          if ((event as ToggleEvent).newState === "open") return;
          setOpen(false);
          listen(false);
        }}
      >
        <Show when={searchable()}>
          <div class="k2b-choice-search k2b-sidebar-switcher__search">
            <i class="ti ti-search" aria-hidden="true" />
            <input
              ref={search}
              type="search"
              data-switcher-row
              value={query()}
              placeholder={messages().search}
              aria-label={messages().searchLabel}
              aria-controls={`${id}-options`}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
        </Show>
        <ul id={`${id}-options`} class="k2b-sidebar-switcher__options">
          <Show
            when={props.options}
            fallback={
              <li class="k2b-choice-status" role="status" data-tone={props.error ? "danger" : undefined}>
                <Show
                  when={props.error}
                  fallback={
                    <>
                      <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                      <span>{messages().loading}</span>
                    </>
                  }
                >
                  {(error) => (
                    <>
                      <span>{error()}</span>
                      <button type="button" data-switcher-row onClick={() => props.onLoad?.()}>
                        {messages().retry}
                      </button>
                    </>
                  )}
                </Show>
              </li>
            }
          >
            <For
              each={visible()}
              fallback={
                <li class="k2b-choice-status" role="status">
                  {messages().noResults}
                </li>
              }
            >
              {(option) => {
                const current = () => option.id === props.currentId;
                return (
                  <li>
                    <a
                      href={option.href}
                      class="k2b-dropdown__item k2b-sidebar-switcher__option"
                      data-switcher-row
                      data-switcher-option
                      aria-current={current() ? "true" : undefined}
                      onClick={(event) => {
                        // The open container is already here: choosing it only closes the panel.
                        if (current() && plainClick(event)) {
                          event.preventDefault();
                          hide(true);
                        } else if (plainClick(event)) hide(false);
                      }}
                    >
                      <span class="k2b-sidebar-switcher__option-icon" style={tint(option.color ?? props.color)} aria-hidden="true">
                        <i class={iconClass(option.icon ?? props.icon)} />
                      </span>
                      <span class="k2b-dropdown__copy">
                        <span>{option.label}</span>
                        <Show when={option.description}>{(description) => <small>{description()}</small>}</Show>
                      </span>
                      <i class="ti ti-check k2b-dropdown__check" data-hidden={current() ? undefined : "true"} aria-hidden="true" />
                    </a>
                  </li>
                );
              }}
            </For>
          </Show>
        </ul>
        <Show when={props.actions?.length}>
          <ul class="k2b-sidebar-switcher__actions">
            <For each={props.actions}>
              {(item) => (
                <li>
                  <Show
                    when={item.href}
                    fallback={
                      <button
                        type="button"
                        class="k2b-dropdown__item"
                        data-switcher-row
                        disabled={item.disabled}
                        aria-disabled={item.disabled ? "true" : undefined}
                        onClick={() => {
                          hide(false);
                          item.action?.();
                        }}
                      >
                        <i class={iconClass(item.icon)} aria-hidden="true" />
                        <span class="k2b-dropdown__copy">
                          <span>{item.label}</span>
                        </span>
                      </button>
                    }
                  >
                    {(href) => (
                      <a
                        href={item.disabled ? undefined : href()}
                        class="k2b-dropdown__item"
                        data-switcher-row
                        aria-disabled={item.disabled ? "true" : undefined}
                        onClick={(event) => plainClick(event) && hide(false)}
                      >
                        <i class={iconClass(item.icon)} aria-hidden="true" />
                        <span class="k2b-dropdown__copy">
                          <span>{item.label}</span>
                        </span>
                      </a>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
