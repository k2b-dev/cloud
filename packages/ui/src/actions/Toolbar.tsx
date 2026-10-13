import { createContext, type JSX, onCleanup, onMount, useContext } from "solid-js";

export type ToolbarProps = {
  children: JSX.Element;
  label: string;
  orientation?: "horizontal" | "vertical";
  wrap?: boolean;
  class?: string;
};

export type ToolbarGroupProps = { children: JSX.Element; label?: string; class?: string };
export type ToolbarSeparatorProps = { class?: string };

type ToolbarComponent = ((props: ToolbarProps) => JSX.Element) & {
  Group: (props: ToolbarGroupProps) => JSX.Element;
  Separator: (props: ToolbarSeparatorProps) => JSX.Element;
  Spacer: () => JSX.Element;
};

type ToolbarOrientation = NonNullable<ToolbarProps["orientation"]>;

const defaultToolbarOrientation: () => ToolbarOrientation = () => "horizontal";
const ToolbarOrientationContext = createContext(defaultToolbarOrientation);

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
  const controls = () =>
    Array.from(root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")).filter((item) => {
      const nested = item.closest('[role="menu"], [role="listbox"], [role="dialog"], [popover]');
      return !nested || !root.contains(nested);
    });
  const items = () => controls().filter((item) => !item.matches(":disabled") && item.getClientRects().length > 0);
  const sync = () => {
    const available = items();
    if (!last || !available.includes(last)) last = available[0];
    for (const item of controls()) item.tabIndex = item === last ? 0 : -1;
  };
  const focusin = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && items().includes(event.target)) {
      last = event.target;
      sync();
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const available = items();
    const target = event.target;
    if (!(target instanceof HTMLElement) || !available.includes(target)) return;
    if (
      target.matches("textarea, select") ||
      target.isContentEditable ||
      (target instanceof HTMLInputElement && !/^(button|checkbox|radio|reset|submit|image|color|file|range)$/.test(target.type))
    )
      return;
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
    last = available[next];
    sync();
    last?.focus();
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "class", "style"] });
  root.addEventListener("focusin", focusin);
  sync();
  return {
    keydown,
    cleanup: () => {
      observer.disconnect();
      root.removeEventListener("focusin", focusin);
    },
  };
};

export const Toolbar = Object.assign(
  (props: ToolbarProps): JSX.Element => {
    const orientation = () => props.orientation ?? "horizontal";
    let root!: HTMLDivElement;
    let navigation: ReturnType<typeof rovingFocus> | undefined;
    onMount(() => {
      navigation = rovingFocus(root, orientation);
      onCleanup(navigation.cleanup);
    });

    return (
      <ToolbarOrientationContext.Provider value={orientation}>
        <div
          ref={root}
          onKeyDown={(event) => navigation?.keydown(event)}
          class={`k2b-toolbar ${props.class ?? ""}`}
          role="toolbar"
          aria-label={props.label}
          aria-orientation={orientation()}
          data-orientation={orientation()}
          data-wrap={props.wrap ? "true" : undefined}
        >
          {props.children}
        </div>
      </ToolbarOrientationContext.Provider>
    );
  },
  { Group: ToolbarGroup, Separator: ToolbarSeparator, Spacer: ToolbarSpacer },
) as ToolbarComponent;

export default Toolbar;
