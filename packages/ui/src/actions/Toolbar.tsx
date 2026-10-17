import { createContext, createEffect, createSignal, type JSX, onCleanup, onMount, Show, sharedConfig, useContext } from "solid-js";
import { isServer } from "solid-js/web";
import { Kbd } from "../content/Kbd";
import { useLocale } from "../intl/locale";
import { formatShortcut, type KeyboardPlatform, keyboardPlatform } from "../intl/shortcut";
import { IconButton } from "./Button";
import { Dropdown, type DropdownAction } from "./Dropdown";
import { useToolbarMessages } from "./toolbar-messages";

export type ToolbarProps = {
  children: JSX.Element;
  label: string;
  orientation?: "horizontal" | "vertical";
  wrap?: boolean;
  /** `floating` floats the toolbar at the bottom of its column. Defaults to `inline`. */
  variant?: "inline" | "floating";
  class?: string;
};

export type ToolbarActionProps = {
  /** Accessible name, tooltip text, and the row label in the More menu. */
  label: string;
  /** Icon class, such as "ti ti-archive". */
  icon: string;
  /** Shortcut hint, tooltip suffix, and aria-keyshortcuts; does not register a shortcut handler. */
  keys?: string;
  /** 1 is most important. Larger numbers move first; ties move later DOM actions first. Omit to keep fixed. */
  priority?: number;
  disabled?: boolean;
  onClick?: () => void;
};
export type ToolbarLabelProps = { children: JSX.Element; class?: string };

export type ToolbarGroupProps = { children: JSX.Element; label?: string; class?: string };
export type ToolbarSeparatorProps = { class?: string };

type ToolbarComponent = ((props: ToolbarProps) => JSX.Element) & {
  Action: (props: ToolbarActionProps) => JSX.Element;
  Label: (props: ToolbarLabelProps) => JSX.Element;
  Group: (props: ToolbarGroupProps) => JSX.Element;
  Separator: (props: ToolbarSeparatorProps) => JSX.Element;
  Spacer: () => JSX.Element;
};

type ToolbarOrientation = NonNullable<ToolbarProps["orientation"]>;

const defaultToolbarOrientation: () => ToolbarOrientation = () => "horizontal";
const ToolbarOrientationContext = createContext(defaultToolbarOrientation);

// `item` is created once per action: the More menu keys its rows by identity, so a remeasure keeps a focused row.
type RegisteredAction = { element: HTMLButtonElement; props: ToolbarActionProps; item: DropdownAction };
const ToolbarActionsContext = createContext<(action: RegisteredAction) => () => void>();
const overflowAttribute = "data-overflow";
const hide = (element: Element) => element.setAttribute(overflowAttribute, "hidden");
const reveal = (element: Element) => element.removeAttribute(overflowAttribute);

// ARIA uses language-independent key names, unlike the translated tooltip and caps.
const ariaShortcut = (keys: string | undefined, platform: KeyboardPlatform): string | undefined => {
  if (!keys || !formatShortcut(keys, { platform, locale: "en" }).keys.length) return undefined;
  const input = keys.trim().toLowerCase();
  const plus = input === "+" || input.endsWith("++");
  const parts = (plus ? input.slice(0, -1) : input).split("+");
  // ARIA separates keys with "+", so the plus key itself is named "plus".
  const key = plus ? "plus" : parts.pop() || "space";
  if (plus) parts.pop();
  const names: Record<string, string> = {
    mod: platform === "apple" ? "Meta" : "Control",
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    enter: "Enter",
    delete: "Delete",
    space: "Space",
    tab: "Tab",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    plus: "plus",
  };
  const final = key.length === 1 || /^f(?:[1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : names[key];
  return final ? [...new Set(parts.map((part) => names[part])), final].join("+") : undefined;
};

const ToolbarAction = (props: ToolbarActionProps): JSX.Element => {
  const register = useContext(ToolbarActionsContext);
  const locale = useLocale();
  const [platform, setPlatform] = createSignal<KeyboardPlatform>(isServer || sharedConfig.context ? "other" : keyboardPlatform());
  onMount(() => setPlatform(keyboardPlatform()));
  const tooltip = () => {
    const shortcut = props.keys ? formatShortcut(props.keys, { platform: platform(), locale: locale() }).label : "";
    return shortcut ? `${props.label} (${shortcut})` : props.label;
  };
  return (
    <IconButton
      ref={(element) => {
        const item: DropdownAction = {
          get label() {
            return props.label;
          },
          get icon() {
            return props.icon;
          },
          get disabled() {
            return props.disabled;
          },
          action: () => props.onClick?.(),
        };
        const unregister = register?.({ element, props, item });
        if (unregister) onCleanup(unregister);
      }}
      class="k2b-toolbar__action"
      label={props.label}
      variant="ghost"
      tooltip={tooltip()}
      aria-keyshortcuts={ariaShortcut(props.keys, platform())}
      data-priority={props.priority}
      disabled={props.disabled}
      onClick={() => props.onClick?.()}
    >
      <i class={props.icon} aria-hidden="true" />
      <Show when={props.keys}>{(keys) => <Kbd keys={keys()} class="k2b-kbd-hint k2b-toolbar__hint" />}</Show>
    </IconButton>
  );
};

const ToolbarLabel = (props: ToolbarLabelProps): JSX.Element => (
  <span class={`k2b-toolbar__label ${props.class ?? ""}`}>{props.children}</span>
);

const ToolbarGroup = (props: ToolbarGroupProps): JSX.Element => (
  <div class={`k2b-toolbar__group ${props.class ?? ""}`} role="group" aria-label={props.label}>
    {props.children}
  </div>
);

const ToolbarSeparator = (props: ToolbarSeparatorProps): JSX.Element => {
  const toolbarOrientation = useContext(ToolbarOrientationContext);
  const separatorOrientation = () => (toolbarOrientation() === "horizontal" ? "vertical" : "horizontal");

  return (
    <span
      class={`k2b-toolbar__separator ${props.class ?? ""}`}
      role="separator"
      aria-orientation={separatorOrientation()}
      data-orientation={separatorOrientation()}
    />
  );
};

const ToolbarSpacer = (): JSX.Element => <span class="k2b-toolbar__spacer" aria-hidden="true" />;

const rovingFocus = (root: HTMLDivElement, orientation: () => ToolbarOrientation) => {
  let last: HTMLElement | undefined;
  const setLast = (item: HTMLElement | undefined) => {
    if (item === last) return;
    if (last) resizeObserver.unobserve(last);
    last = item;
    if (last) resizeObserver.observe(last);
  };
  const controls = () =>
    Array.from(root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")).filter((item) => {
      if (
        item.matches("textarea, select") ||
        item.isContentEditable ||
        (item.matches("input") && !/^(button|checkbox|reset|submit|image|color|file)$/i.test(item.getAttribute("type") ?? "text"))
      )
        return false;
      const nested = item.closest('[role="menu"], [role="listbox"], [role="dialog"], [popover]');
      return !nested || !root.contains(nested);
    });
  const items = () =>
    controls().filter(
      (item) => !item.matches(":disabled") && !item.closest('[data-overflow="hidden"]') && item.getClientRects().length > 0,
    );
  const sync = () => {
    const available = items();
    if (!last || !available.includes(last)) setLast(available[0]);
    for (const item of controls()) item.tabIndex = item === last ? 0 : -1;
  };
  const focusin = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && items().includes(event.target)) {
      setLast(event.target);
      sync();
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const available = items();
    const target = event.target;
    if (!(target instanceof HTMLElement) || !available.includes(target)) return;
    const forward = orientation() === "vertical" ? "ArrowDown" : getComputedStyle(root).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = orientation() === "vertical" ? "ArrowUp" : forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
    const index = available.indexOf(target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? available.length - 1
          : event.key === forward
            ? (index + 1) % available.length
            : event.key === backward
              ? (index + available.length - 1) % available.length
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setLast(available[next]);
    sync();
    last?.focus();
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "class", "style", overflowAttribute],
  });
  const resizeObserver = new ResizeObserver(sync);
  resizeObserver.observe(root);
  root.addEventListener("focusin", focusin);
  sync();
  return {
    keydown,
    sync,
    cleanup: () => {
      observer.disconnect();
      resizeObserver.disconnect();
      root.removeEventListener("focusin", focusin);
    },
  };
};

/**
 * All measurement writes are DOM attributes: reactive writes do not flush during onMount. More is never toggled while
 * measuring: hiding it, even for a moment, can make the browser drop focus from it or from its open menu. An idle More
 * stays out of the flow but keeps its box, so its width is always known.
 */
const measureOverflow = (
  root: HTMLDivElement,
  more: HTMLDivElement,
  actions: RegisteredAction[],
  available: number,
): RegisteredAction[] => {
  for (const element of root.querySelectorAll(`[${overflowAttribute}]`)) if (element !== more) reveal(element);
  const children = Array.from(root.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== more,
  );
  const visible = (element: Element) => !element.matches("[popover]") && element.getClientRects().length > 0;
  const separator = (element: Element) => element.classList.contains("k2b-toolbar__separator");
  const item = (element: Element) => !separator(element) && !element.classList.contains("k2b-toolbar__spacer");
  // Separators are tidied in DOM order with More, the last control, counted as shown when `withMore` is set.
  const all = Array.from(root.children).filter((element): element is HTMLElement => element instanceof HTMLElement);
  const tidy = (withMore: boolean) => {
    for (const group of root.querySelectorAll(".k2b-toolbar__group")) {
      reveal(group);
      if (!Array.from(group.children).some(visible)) hide(group);
    }
    for (const child of children) if (separator(child)) reveal(child);
    const shown = (element: HTMLElement) => (element === more ? withMore : visible(element));
    let preceding = false;
    for (let index = 0; index < all.length; index++) {
      const child = all[index]!;
      if (!shown(child)) continue;
      if (separator(child)) {
        const following = all.slice(index + 1).some((next) => item(next) && shown(next));
        if (!preceding || !following) hide(child);
        else preceding = false;
      } else if (item(child)) preceding = true;
    }
  };
  const style = getComputedStyle(root);
  const edges = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce(
    (sum, value) => sum + (Number.parseFloat(value) || 0),
    0,
  );
  const gap = Number.parseFloat(style.columnGap) || 0;
  // A label may shrink in an overfull pill; measure its untruncated width (up to its cap) so actions move before the
  // count or title truncates.
  const width = (child: HTMLElement) => {
    // Separators carry inline margins, which bounding boxes leave out.
    const childStyle = getComputedStyle(child);
    const box =
      child.getBoundingClientRect().width +
      (Number.parseFloat(childStyle.marginLeft) || 0) +
      (Number.parseFloat(childStyle.marginRight) || 0);
    if (!child.classList.contains("k2b-toolbar__label")) return box;
    const cap = Number.parseFloat(childStyle.maxWidth);
    return Math.max(box, Math.min(child.scrollWidth, Number.isNaN(cap) ? Number.POSITIVE_INFINITY : cap));
  };
  const moreWidth = width(more) + gap;
  const used = (withMore: boolean) => {
    const shown = children.filter(visible);
    return shown.reduce((sum, child) => sum + width(child), edges) + gap * Math.max(0, shown.length - 1) + (withMore ? moreWidth : 0);
  };
  // Stable sort retains DOM order for the menu, but removes later actions first on a priority tie.
  const candidates = actions
    // An action its application hides, even with `visibility: hidden`, must not reappear as a More row.
    .filter(
      (action) =>
        action.props.priority !== undefined && visible(action.element) && getComputedStyle(action.element).visibility !== "hidden",
    )
    .reverse()
    .sort((a, b) => b.props.priority! - a.props.priority!);
  let movedAny = false;
  tidy(false);
  for (const action of candidates) {
    if (used(movedAny) <= available) break;
    hide(action.element);
    movedAny = true;
    tidy(true);
  }
  // More changes only here, and only when its state changes.
  if (movedAny) reveal(more);
  else if (!more.hasAttribute(overflowAttribute)) hide(more);
  return actions.filter((action) => action.element.hasAttribute(overflowAttribute));
};

export const Toolbar = Object.assign(
  (props: ToolbarProps): JSX.Element => {
    // The variant decides the DOM shape, so it is read once.
    const floating = props.variant === "floating";
    const orientation = () => (floating ? "horizontal" : (props.orientation ?? "horizontal"));
    const messages = useToolbarMessages();
    const actions = new Set<RegisteredAction>();
    const [revision, setRevision] = createSignal(0);
    const [moved, setMoved] = createSignal<RegisteredAction[]>([]);
    let root!: HTMLDivElement;
    let strip: HTMLDivElement | undefined;
    let more: HTMLDivElement | undefined;
    let trigger: HTMLButtonElement | undefined;
    let mounted = false;
    let navigation: ReturnType<typeof rovingFocus> | undefined;
    // Only the floating variant moves actions into More; inline toolbars keep every action in place.
    const measure = () => {
      if (!mounted || !strip || !more) return;
      const style = getComputedStyle(strip);
      const available = strip.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      if (available <= 0) return;
      const ordered = [...actions].sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      const focused = document.activeElement;
      // Cleared before measuring so the pending `visibility: hidden` does not hide every action from the check
      // below; the whole measurement still runs before the next paint.
      root.removeAttribute("data-overflow-pending");
      const next = measureOverflow(root, more, ordered, available);
      setMoved((previous) =>
        previous.length === next.length && previous.every((action, index) => action === next[index]) ? previous : next,
      );
      navigation?.sync();
      // Focus on an action that moved, on a menu row whose action came back, or on a More that disappeared goes to
      // More, or to the toolbar's tab stop when nothing is left in More. Inside an effect the menu rows update after
      // this function returns, so the check waits for that flush; a microtask still runs before the next paint.
      queueMicrotask(() => {
        const lost =
          next.some((action) => action.element === focused) ||
          (focused instanceof HTMLElement && !focused.isConnected) ||
          (focused === trigger && !next.length);
        if (lost) (next.length ? trigger : root.querySelector<HTMLElement>('[tabindex="0"]'))?.focus();
      });
    };
    const register = (action: RegisteredAction) => {
      actions.add(action);
      setRevision((value) => value + 1);
      return () => {
        actions.delete(action);
        setRevision((value) => value + 1);
      };
    };
    if (floating)
      createEffect(() => {
        revision();
        for (const action of actions) {
          // Content and priority changes can affect intrinsic widths as well as menu rows.
          void action.props.priority;
          void action.props.label;
          void action.props.icon;
          void action.props.keys;
        }
        measure();
      });
    onMount(() => {
      mounted = true;
      navigation = rovingFocus(root, orientation);
      onCleanup(() => {
        mounted = false;
        navigation?.cleanup();
      });
      if (!strip) return;
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(strip);
      observer.observe(root);
      const mutations = new MutationObserver(measure);
      // Visibility an application sets also counts. Measurement writes only data attributes, which stay unobserved.
      mutations.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "class", "style"],
      });
      onCleanup(() => {
        observer.disconnect();
        mutations.disconnect();
      });
    });
    const menuItems = (): DropdownAction[] => moved().map((action) => action.item);
    const content = (
      <ToolbarOrientationContext.Provider value={orientation}>
        <ToolbarActionsContext.Provider value={floating ? register : undefined}>
          <div
            ref={root}
            onKeyDown={(event) => navigation?.keydown(event)}
            class={`k2b-toolbar ${props.class ?? ""}`}
            role="toolbar"
            aria-label={props.label}
            aria-orientation={orientation()}
            data-orientation={orientation()}
            data-variant={floating ? "floating" : undefined}
            data-wrap={!floating && props.wrap ? "true" : undefined}
            data-overflow-pending={floating ? "" : undefined}
          >
            {props.children}
            <Show when={floating}>
              <div ref={more} class="k2b-toolbar__more" data-overflow="hidden">
                <Dropdown.Root
                  items={menuItems()}
                  position="top-left"
                  label={messages().moreActions}
                  // An open menu closes when its last row returns to the toolbar.
                  disabled={moved().length === 0}
                >
                  <Dropdown.Trigger ref={trigger} iconOnly label={messages().moreActions}>
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </div>
            </Show>
          </div>
        </ToolbarActionsContext.Provider>
      </ToolbarOrientationContext.Provider>
    );
    return floating ? (
      <div ref={strip} class="k2b-toolbar-float">
        {content}
      </div>
    ) : (
      content
    );
  },
  { Action: ToolbarAction, Label: ToolbarLabel, Group: ToolbarGroup, Separator: ToolbarSeparator, Spacer: ToolbarSpacer },
) as ToolbarComponent;

export default Toolbar;
