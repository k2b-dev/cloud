import { deserialize as deserializeProps, serialize as serializeProps } from "seroval";
import type { Component, JSX, ParentProps } from "solid-js";
import { children, createContext, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import {
  type DesktopEnvironment,
  type DesktopWindowDescriptor,
  desktop,
  desktopWindowDescriptorKind,
  readDesktopWindowDescriptor,
} from "./index";

export type DesktopRouteProps<Params extends Record<string, string> = Record<string, string>> = {
  params: Params;
  path: string;
  searchParams: URLSearchParams;
};

export type DesktopRouteDefinition = {
  path: string;
  component: Component<DesktopRouteProps>;
};

export type DesktopRouterProps = ParentProps<{
  routes?: DesktopRouteDefinition[];
  fallback?: Component<{ path: string }>;
}>;

type DesktopRouteMarker = DesktopRouteDefinition & { kind: "desktop-route" };

type DesktopWindowComponent = Component<any>;

type DesktopWindowRegistry<Definitions extends Record<string, DesktopWindowComponent>> = {
  readonly __desktopWindowDefinitions: Definitions;
} & {
  [Name in keyof Definitions]: Definitions[Name] extends Component<infer Props> ? (props: Props) => JSX.Element : never;
};

export const defineDesktopWindows = <Definitions extends Record<string, DesktopWindowComponent>>(
  definitions: Definitions,
): DesktopWindowRegistry<Definitions> => {
  const registry: Record<string, unknown> = {};
  Object.defineProperty(registry, "__desktopWindowDefinitions", { value: definitions, enumerable: false });

  for (const name of Object.keys(definitions)) {
    registry[name] = (props: Record<string, unknown>) =>
      ({
        kind: desktopWindowDescriptorKind,
        name,
        props: serializeProps(props ?? {}),
      }) satisfies DesktopWindowDescriptor as unknown as JSX.Element;
  }

  return registry as DesktopWindowRegistry<Definitions>;
};

export function DesktopWindowHost<Definitions extends Record<string, DesktopWindowComponent>>(
  props: ParentProps<{ windows: DesktopWindowRegistry<Definitions> }>,
) {
  const [nativeDescriptor, setNativeDescriptor] = createSignal<DesktopWindowDescriptor | null>(readDesktopWindowDescriptor());
  const [ready, setReady] = createSignal(Boolean(nativeDescriptor()));
  onMount(() => {
    void desktop.window
      .current()
      .then(setNativeDescriptor)
      .finally(() => setReady(true));
  });
  const descriptor = createMemo(() => nativeDescriptor());
  const component = createMemo(() => {
    const current = descriptor();
    return current ? props.windows.__desktopWindowDefinitions[current.name] : null;
  });
  const windowProps = createMemo(() => {
    const current = descriptor();
    if (!current) return {};
    return deserializeProps<Record<string, unknown>>(current.props);
  });

  return createMemo(() => {
    if (!ready()) return null;
    const WindowComponent = component();
    return WindowComponent ? <Dynamic component={WindowComponent} {...windowProps()} /> : props.children;
  }) as unknown as JSX.Element;
}

const routeEvent = "cloud-desktop:navigation";

const currentPath = () => {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
};

const routeScore = (path: string) =>
  path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith(":")).length;

const matchRoute = (pattern: string, pathname: string): Record<string, string> | null => {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index]!;
    const pathSegment = pathSegments[index]!;
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) return null;
  }
  return params;
};

const readLocation = () => {
  const url = typeof window === "undefined" ? new URL("http://desktop.local/") : new URL(window.location.href);
  return {
    pathname: url.pathname,
    search: url.search,
    path: `${url.pathname}${url.search}`,
    searchParams: url.searchParams,
  };
};

export const useDesktopLocation = () => {
  const [location, setLocation] = createSignal(readLocation());

  onMount(() => {
    const update = () => setLocation(readLocation());
    window.addEventListener("popstate", update);
    window.addEventListener(routeEvent, update);
    onCleanup(() => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(routeEvent, update);
    });
  });

  return location;
};

export function Route(props: DesktopRouteDefinition): JSX.Element {
  return { kind: "desktop-route", path: props.path, component: props.component } satisfies DesktopRouteMarker as unknown as JSX.Element;
}

const isRouteMarker = (value: unknown): value is DesktopRouteMarker =>
  Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "desktop-route");

export function DesktopRouter(props: DesktopRouterProps) {
  const location = useDesktopLocation();
  const resolved = children(() => props.children);
  const routeDefinitions = createMemo(() => {
    const childRoutes = [resolved()].flat(Number.POSITIVE_INFINITY).filter(isRouteMarker) as unknown as DesktopRouteDefinition[];
    return ([...(props.routes ?? []), ...childRoutes] satisfies DesktopRouteDefinition[]).sort(
      (a, b) => routeScore(b.path) - routeScore(a.path),
    );
  });

  const match = createMemo(() => {
    const loc = location();
    for (const route of routeDefinitions()) {
      const params = matchRoute(route.path, loc.pathname);
      if (params) return { route, params, location: loc };
    }
    return null;
  });

  return createMemo(() => {
    const selected = match();
    if (!selected) {
      return props.fallback ? <Dynamic component={props.fallback} path={currentPath()} /> : null;
    }
    return (
      <Dynamic
        component={selected.route.component}
        params={selected.params}
        path={selected.location.path}
        searchParams={selected.location.searchParams}
      />
    );
  }) as unknown as JSX.Element;
}

export type DesktopLinkProps = Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  href: string;
  replace?: boolean;
  onClick?: JSX.EventHandlerUnion<HTMLAnchorElement, MouseEvent>;
};

const shouldHandleClick = (event: MouseEvent, anchor: HTMLAnchorElement): boolean => {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  return new URL(anchor.href, window.location.href).origin === window.location.origin;
};

export function Link(props: DesktopLinkProps) {
  const rest = () => {
    const { href: _href, replace: _replace, onClick: _onClick, ...anchorProps } = props;
    return anchorProps;
  };

  return (
    <a
      {...rest()}
      href={props.href}
      onClick={(event) => {
        if (typeof props.onClick === "function") {
          props.onClick(event as MouseEvent & { currentTarget: HTMLAnchorElement; target: Element });
        }
        if (!shouldHandleClick(event, event.currentTarget)) return;
        event.preventDefault();
        desktop.navigate(props.href, { replace: props.replace });
      }}
    />
  );
}

type ContextMenuState = {
  open: (event: MouseEvent) => void;
  close: () => void;
  isOpen: () => boolean;
  x: () => number;
  y: () => number;
};

const ContextMenuContext = createContext<ContextMenuState>();

type ContextMenuComponent = ((props: ParentProps) => JSX.Element) & {
  Trigger: (props: ParentProps<{ class?: string }>) => JSX.Element;
  Content: (props: ParentProps<{ class?: string }>) => JSX.Element;
  Item: (props: ParentProps<{ onSelect?: () => void; destructive?: boolean; disabled?: boolean; icon?: string }>) => JSX.Element;
  Divider: () => JSX.Element;
};

export const ContextMenu: ContextMenuComponent = ((props: ParentProps) => {
  const [open, setOpen] = createSignal(false);
  const [coords, setCoords] = createSignal({ x: 0, y: 0 });
  const close = () => setOpen(false);

  onMount(() => {
    const onPointer = () => close();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <ContextMenuContext.Provider
      value={{
        open: (event) => {
          event.preventDefault();
          event.stopPropagation();
          setCoords({ x: event.clientX, y: event.clientY });
          setOpen(true);
        },
        close,
        isOpen: open,
        x: () => coords().x,
        y: () => coords().y,
      }}
    >
      {props.children}
    </ContextMenuContext.Provider>
  );
}) as ContextMenuComponent;

const useContextMenu = () => {
  const value = useContext(ContextMenuContext);
  if (!value) throw new Error("ContextMenu components must be used inside <ContextMenu>.");
  return value;
};

ContextMenu.Trigger = (props) => {
  const menu = useContextMenu();
  return (
    <div class={props.class} role="group" onContextMenu={menu.open}>
      {props.children}
    </div>
  );
};

ContextMenu.Content = (props) => {
  const menu = useContextMenu();
  return (
    <Show when={menu.isOpen()}>
      <Portal>
        <div
          role="menu"
          class={`fixed z-50 w-56 max-w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-zinc-300/60 bg-white/95 py-1 text-sm text-zinc-900 shadow-lg ring-1 ring-black/5 backdrop-blur-sm dark:border-zinc-600/50 dark:bg-zinc-950/95 dark:text-zinc-100 ${props.class ?? ""}`}
          style={{
            left: `${Math.min(menu.x(), window.innerWidth - 232)}px`,
            top: `${Math.min(menu.y(), window.innerHeight - 320)}px`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
};

ContextMenu.Item = (props) => {
  const menu = useContextMenu();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      class={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-zinc-900 ${
        props.destructive ? "text-red-600 dark:text-red-400" : "text-zinc-800 dark:text-zinc-100"
      }`}
      onClick={() => {
        props.onSelect?.();
        menu.close();
      }}
    >
      <Show when={props.icon}>
        <i class={`${props.icon} text-sm`} />
      </Show>
      <span>{props.children}</span>
    </button>
  );
};

ContextMenu.Divider = () => <div role="separator" class="h-2" />;

const DESKTOP_WORKSPACE_SIDEBAR = Symbol("DesktopWorkspace.Sidebar");
const DESKTOP_WORKSPACE_TOPBAR = Symbol("DesktopWorkspace.TopBar");
const DESKTOP_WORKSPACE_MAIN = Symbol("DesktopWorkspace.Main");
const DESKTOP_WORKSPACE_RIGHT = Symbol("DesktopWorkspace.Right");
const DESKTOP_WORKSPACE_BOTTOM = Symbol("DesktopWorkspace.Bottom");
const DESKTOP_WORKSPACE_SIDEBAR_RAIL = Symbol("DesktopWorkspace.SidebarRail");
const DESKTOP_WORKSPACE_RIGHT_RAIL = Symbol("DesktopWorkspace.RightRail");
const DESKTOP_WORKSPACE_BOTTOM_RAIL = Symbol("DesktopWorkspace.BottomRail");

type DesktopWorkspaceSlotKind =
  | typeof DESKTOP_WORKSPACE_SIDEBAR
  | typeof DESKTOP_WORKSPACE_TOPBAR
  | typeof DESKTOP_WORKSPACE_MAIN
  | typeof DESKTOP_WORKSPACE_RIGHT
  | typeof DESKTOP_WORKSPACE_BOTTOM
  | typeof DESKTOP_WORKSPACE_SIDEBAR_RAIL
  | typeof DESKTOP_WORKSPACE_RIGHT_RAIL
  | typeof DESKTOP_WORKSPACE_BOTTOM_RAIL;

type DesktopWorkspaceSlot = {
  readonly kind: DesktopWorkspaceSlotKind;
  children?: JSX.Element;
};

export type DesktopWorkspacePanel = "left" | "right" | "bottom";
export type DesktopWorkspacePanelMode = "open" | "rail" | "hidden";

export type DesktopWorkspacePanelController = {
  open: () => void;
  rail: () => void;
  hide: () => void;
  toggle: () => void;
  mode: () => DesktopWorkspacePanelMode;
};

export type DesktopWorkspaceResizablePaneProps = ParentProps<{
  class?: string;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  resizable?: boolean;
  railAt?: number;
  restoreSize?: number;
}>;

export type DesktopWorkspacePaneProps = ParentProps<{
  class?: string;
}>;

export type DesktopWorkspaceRailProps = ParentProps<{
  class?: string;
  size?: number;
}>;

export type DesktopWorkspaceTopBarProps = ParentProps<{
  class?: string;
  drag?: boolean;
}>;

export type DesktopWorkspaceSidebarProps = DesktopWorkspaceResizablePaneProps & {
  trafficLightsInset?: boolean;
  title?: string;
};

type DesktopWorkspaceSidebarSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceSidebarProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_SIDEBAR;
  };

type DesktopWorkspaceTopBarSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceTopBarProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_TOPBAR;
  };

type DesktopWorkspaceMainSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspacePaneProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_MAIN;
  };

type DesktopWorkspaceRightSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceResizablePaneProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_RIGHT;
  };

type DesktopWorkspaceBottomSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceResizablePaneProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_BOTTOM;
  };

type DesktopWorkspaceSidebarRailSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceRailProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_SIDEBAR_RAIL;
  };

type DesktopWorkspaceRightRailSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceRailProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_RIGHT_RAIL;
  };

type DesktopWorkspaceBottomRailSlot = DesktopWorkspaceSlot &
  Omit<DesktopWorkspaceRailProps, "children"> & {
    readonly kind: typeof DESKTOP_WORKSPACE_BOTTOM_RAIL;
  };

export type DesktopWorkspaceProps = ParentProps<{
  class?: string;
  storageKey?: string;
  topBarHeight?: number;
}>;

type DesktopWorkspaceComponent = ((props: DesktopWorkspaceProps) => JSX.Element) & {
  Sidebar: (props: DesktopWorkspaceSidebarProps) => JSX.Element;
  TopBar: (props: DesktopWorkspaceTopBarProps) => JSX.Element;
  Main: (props: DesktopWorkspacePaneProps) => JSX.Element;
  Right: (props: DesktopWorkspaceResizablePaneProps) => JSX.Element;
  Bottom: (props: DesktopWorkspaceResizablePaneProps) => JSX.Element;
  SidebarRail: (props: DesktopWorkspaceRailProps) => JSX.Element;
  RightRail: (props: DesktopWorkspaceRailProps) => JSX.Element;
  BottomRail: (props: DesktopWorkspaceRailProps) => JSX.Element;
  DragRegion: (props: ParentProps<{ class?: string }>) => JSX.Element;
  NoDrag: (props: ParentProps<{ class?: string }>) => JSX.Element;
};

const isDesktopWorkspaceSlot = (value: unknown): value is DesktopWorkspaceSlot =>
  Boolean(value && typeof value === "object" && "kind" in value);

const collectDesktopWorkspaceSlots = (value: unknown): DesktopWorkspaceSlot[] => {
  if (Array.isArray(value)) return value.flatMap(collectDesktopWorkspaceSlots);
  return isDesktopWorkspaceSlot(value) ? [value] : [];
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const readStoredPaneSize = (storageKey: string | undefined, pane: string, fallback: number): number => {
  if (!storageKey || typeof window === "undefined") return fallback;
  const stored = Number(window.localStorage.getItem(`cloud-desktop-workspace:${storageKey}:${pane}`));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
};

const writeStoredPaneSize = (storageKey: string | undefined, pane: string, value: number) => {
  if (!storageKey || typeof window === "undefined") return;
  window.localStorage.setItem(`cloud-desktop-workspace:${storageKey}:${pane}`, String(Math.round(value)));
};

const startDesktopResize = (event: PointerEvent, onMove: (dx: number, dy: number) => void) => {
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  const move = (next: PointerEvent) => onMove(next.clientX - startX, next.clientY - startY);
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
};

const desktopWorkspaceGap = 8;
const desktopResizeHandleClass = "absolute z-20 transition-colors hover:bg-blue-400/20 active:bg-blue-400/30 dark:hover:bg-blue-400/15";
const desktopRestoreHandleClass =
  "absolute z-30 opacity-0 transition-[opacity,background-color] hover:opacity-100 hover:bg-blue-400/25 active:bg-blue-400/35 dark:hover:bg-blue-400/20";

let currentPanels: Partial<Record<DesktopWorkspacePanel, DesktopWorkspacePanelController>> = {};

const requirePanel = (panel: DesktopWorkspacePanel): DesktopWorkspacePanelController => {
  const controller = currentPanels[panel];
  if (!controller) throw new Error(`No active DesktopWorkspace panel registered for "${panel}".`);
  return controller;
};

export const workspace = {
  panel(panel: DesktopWorkspacePanel): DesktopWorkspacePanelController {
    return {
      open: () => requirePanel(panel).open(),
      rail: () => requirePanel(panel).rail(),
      hide: () => requirePanel(panel).hide(),
      toggle: () => requirePanel(panel).toggle(),
      mode: () => currentPanels[panel]?.mode() ?? "hidden",
    };
  },
};

export const DesktopWorkspace = ((props: DesktopWorkspaceProps) => {
  const resolved = children(() => props.children);
  const slots = createMemo(() => collectDesktopWorkspaceSlots(resolved()));
  const sidebar = createMemo(() => slots().find((slot): slot is DesktopWorkspaceSidebarSlot => slot.kind === DESKTOP_WORKSPACE_SIDEBAR));
  const topBar = createMemo(() => slots().find((slot): slot is DesktopWorkspaceTopBarSlot => slot.kind === DESKTOP_WORKSPACE_TOPBAR));
  const main = createMemo(() => slots().find((slot): slot is DesktopWorkspaceMainSlot => slot.kind === DESKTOP_WORKSPACE_MAIN));
  const right = createMemo(() => slots().find((slot): slot is DesktopWorkspaceRightSlot => slot.kind === DESKTOP_WORKSPACE_RIGHT));
  const bottom = createMemo(() => slots().find((slot): slot is DesktopWorkspaceBottomSlot => slot.kind === DESKTOP_WORKSPACE_BOTTOM));
  const sidebarRail = createMemo(() =>
    slots().find((slot): slot is DesktopWorkspaceSidebarRailSlot => slot.kind === DESKTOP_WORKSPACE_SIDEBAR_RAIL),
  );
  const rightRail = createMemo(() =>
    slots().find((slot): slot is DesktopWorkspaceRightRailSlot => slot.kind === DESKTOP_WORKSPACE_RIGHT_RAIL),
  );
  const bottomRail = createMemo(() =>
    slots().find((slot): slot is DesktopWorkspaceBottomRailSlot => slot.kind === DESKTOP_WORKSPACE_BOTTOM_RAIL),
  );

  const topBarHeight = () => props.topBarHeight ?? 44;
  const [sidebarSize, setSidebarSize] = createSignal(readStoredPaneSize(props.storageKey, "sidebar", sidebar()?.defaultSize ?? 280));
  const [rightSize, setRightSize] = createSignal(readStoredPaneSize(props.storageKey, "right", right()?.defaultSize ?? 320));
  const [bottomSize, setBottomSize] = createSignal(readStoredPaneSize(props.storageKey, "bottom", bottom()?.defaultSize ?? 180));
  const [sidebarMode, setSidebarMode] = createSignal<DesktopWorkspacePanelMode>(sidebar() ? "open" : "hidden");
  const [rightMode, setRightMode] = createSignal<DesktopWorkspacePanelMode>(right() ? "open" : "hidden");
  const [bottomMode, setBottomMode] = createSignal<DesktopWorkspacePanelMode>(bottom() ? "open" : "hidden");

  const sidebarOpen = () => sidebarMode() === "open" && Boolean(sidebar());
  const rightOpen = () => rightMode() === "open" && Boolean(right());
  const bottomOpen = () => bottomMode() === "open" && Boolean(bottom());
  const sidebarRailOpen = () => sidebarMode() === "rail" && Boolean(sidebarRail());
  const rightRailOpen = () => rightMode() === "rail" && Boolean(rightRail());
  const bottomRailOpen = () => bottomMode() === "rail" && Boolean(bottomRail());
  const sidebarColumnSize = () => (sidebarOpen() ? sidebarSize() : sidebarRailOpen() ? (sidebarRail()?.size ?? 52) : 0);
  const rightColumnSize = () => (rightOpen() ? rightSize() : rightRailOpen() ? (rightRail()?.size ?? 48) : 0);
  const bottomRowSize = () => (bottomOpen() ? bottomSize() : bottomRailOpen() ? (bottomRail()?.size ?? 40) : 0);

  const gridStyle = () =>
    [
      `grid-template-columns:${sidebarColumnSize()}px minmax(0,1fr) ${rightColumnSize()}px`,
      `grid-template-rows:${topBar() ? `${topBarHeight()}px` : "0px"} minmax(0,1fr) ${bottomRowSize()}px`,
    ].join(";");
  const mainGridColumn = () => `${sidebarColumnSize() > 0 ? "2" : "1"} / ${rightColumnSize() > 0 ? "3" : "4"}`;
  const bottomGridColumn = () => `${sidebarColumnSize() > 0 ? "2" : "1"} / 4`;

  const topBarTrafficLightInset = () => Boolean(sidebar() && !sidebarOpen() && (sidebar()?.trafficLightsInset ?? true));

  const shouldRail = (pane: DesktopWorkspaceResizablePaneProps | undefined, size: number) =>
    Boolean(pane?.railAt !== undefined && size <= pane.railAt);

  const restoreSidebar = () => {
    const pane = sidebar();
    if (!pane) return;
    const next = clamp(pane.restoreSize ?? sidebarSize(), pane.minSize ?? 200, pane.maxSize ?? 480);
    setSidebarSize(next);
    writeStoredPaneSize(props.storageKey, "sidebar", next);
    setSidebarMode("open");
  };

  const restoreRight = () => {
    const pane = right();
    if (!pane) return;
    const next = clamp(pane.restoreSize ?? rightSize(), pane.minSize ?? 240, pane.maxSize ?? 560);
    setRightSize(next);
    writeStoredPaneSize(props.storageKey, "right", next);
    setRightMode("open");
  };

  const restoreBottom = () => {
    const pane = bottom();
    if (!pane) return;
    const next = clamp(pane.restoreSize ?? bottomSize(), pane.minSize ?? 120, pane.maxSize ?? 420);
    setBottomSize(next);
    writeStoredPaneSize(props.storageKey, "bottom", next);
    setBottomMode("open");
  };

  const railSidebar = () => setSidebarMode(sidebarRail() ? "rail" : "hidden");
  const railRight = () => setRightMode(rightRail() ? "rail" : "hidden");
  const railBottom = () => setBottomMode(bottomRail() ? "rail" : "hidden");
  const hideSidebar = () => setSidebarMode("hidden");
  const hideRight = () => setRightMode("hidden");
  const hideBottom = () => setBottomMode("hidden");

  currentPanels = {
    left: {
      open: restoreSidebar,
      rail: railSidebar,
      hide: hideSidebar,
      toggle: () => (sidebarOpen() ? railSidebar() : restoreSidebar()),
      mode: sidebarMode,
    },
    right: {
      open: restoreRight,
      rail: railRight,
      hide: hideRight,
      toggle: () => (rightOpen() ? railRight() : restoreRight()),
      mode: rightMode,
    },
    bottom: {
      open: restoreBottom,
      rail: railBottom,
      hide: hideBottom,
      toggle: () => (bottomOpen() ? railBottom() : restoreBottom()),
      mode: bottomMode,
    },
  };

  onCleanup(() => {
    if (currentPanels.left?.open === restoreSidebar) currentPanels = {};
  });

  const resizeSidebar = (event: PointerEvent) => {
    const pane = sidebar();
    if (!pane?.resizable) return;
    const start = sidebarOpen() ? sidebarSize() : sidebarColumnSize();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    startDesktopResize(event, (dx) => {
      const raw = start + dx;
      if (shouldRail(pane, raw)) {
        railSidebar();
        return;
      }
      setSidebarMode("open");
      const next = clamp(raw, pane.minSize ?? 200, pane.maxSize ?? 480);
      setSidebarSize(next);
      writeStoredPaneSize(props.storageKey, "sidebar", next);
    });
  };

  const resizeRight = (event: PointerEvent) => {
    const pane = right();
    if (!pane?.resizable) return;
    const start = rightOpen() ? rightSize() : rightColumnSize();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    startDesktopResize(event, (dx) => {
      const raw = start - dx;
      if (shouldRail(pane, raw)) {
        railRight();
        return;
      }
      setRightMode("open");
      const next = clamp(raw, pane.minSize ?? 240, pane.maxSize ?? 560);
      setRightSize(next);
      writeStoredPaneSize(props.storageKey, "right", next);
    });
  };

  const resizeBottom = (event: PointerEvent) => {
    const pane = bottom();
    if (!pane?.resizable) return;
    const start = bottomOpen() ? bottomSize() : bottomRowSize();
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    startDesktopResize(event, (_dx, dy) => {
      const raw = start - dy;
      if (shouldRail(pane, raw)) {
        railBottom();
        return;
      }
      setBottomMode("open");
      const next = clamp(raw, pane.minSize ?? 120, pane.maxSize ?? 420);
      setBottomSize(next);
      writeStoredPaneSize(props.storageKey, "bottom", next);
    });
  };

  return (
    <div
      class={`desktop-workspace relative grid h-full min-h-0 gap-x-2 overflow-hidden bg-zinc-100 dark:bg-zinc-950 ${props.class ?? ""}`}
      style={gridStyle()}
    >
      <Show when={sidebar()}>
        {(slot) => (
          <aside
            class={`${sidebarOpen() ? "flex" : "hidden"} desktop-workspace-sidebar row-span-3 min-h-0 min-w-0 flex-col overflow-hidden bg-white dark:bg-zinc-950 ${slot().class ?? ""}`}
            style="grid-column:1;grid-row:1 / 4"
          >
            <Show when={slot().trafficLightsInset ?? true}>
              <DesktopWorkspace.DragRegion class="flex h-12 shrink-0 items-center pl-24 pr-3">
                <Show when={slot().title}>
                  <p class="min-w-0 truncate text-sm font-semibold text-primary">{slot().title}</p>
                </Show>
              </DesktopWorkspace.DragRegion>
            </Show>
            {slot().children}
          </aside>
        )}
      </Show>

      <Show when={sidebarRailOpen() ? sidebarRail() : undefined}>
        {(slot) => (
          <aside
            class={`desktop-workspace-sidebar-rail min-h-0 min-w-0 overflow-hidden bg-white dark:bg-zinc-950 ${slot().class ?? ""}`}
            style="grid-column:1;grid-row:2 / 4"
          >
            {slot().children}
          </aside>
        )}
      </Show>

      <Show when={topBar()}>
        {(slot) => (
          <header
            class={`desktop-workspace-topbar mr-2 min-w-0 ${slot().class ?? ""}`}
            style={`grid-column:${sidebarOpen() ? "2 / 4" : "1 / 4"};grid-row:1;padding-left:${topBarTrafficLightInset() ? "76px" : "0px"};${
              slot().drag ? "-webkit-app-region:drag" : ""
            }`}
          >
            {slot().children}
          </header>
        )}
      </Show>

      <main
        class={`desktop-workspace-main min-h-0 min-w-0 overflow-hidden ${topBar() ? "" : "mt-2"} ${bottomOpen() ? "" : "mb-2"} ${main()?.class ?? ""}`}
        style={`grid-column:${mainGridColumn()};grid-row:2`}
      >
        {main()?.children}
      </main>

      <Show when={rightOpen() ? right() : undefined}>
        {(slot) => (
          <aside
            class={`desktop-workspace-right mr-2 min-h-0 min-w-0 overflow-hidden ${topBar() ? "" : "mt-2"} ${bottomOpen() ? "" : "mb-2"} ${
              slot().class ?? ""
            }`}
            style="grid-column:3;grid-row:2"
          >
            {slot().children}
          </aside>
        )}
      </Show>

      <Show when={rightRailOpen() ? rightRail() : undefined}>
        {(slot) => (
          <aside
            class={`desktop-workspace-right-rail min-h-0 min-w-0 overflow-hidden ${topBar() ? "" : "mt-2"} ${bottomOpen() ? "" : "mb-2"} ${
              slot().class ?? ""
            }`}
            style="grid-column:3;grid-row:2"
          >
            {slot().children}
          </aside>
        )}
      </Show>

      <Show when={bottomOpen() ? bottom() : undefined}>
        {(slot) => (
          <section
            class={`desktop-workspace-bottom mt-2 mr-2 mb-2 min-h-0 min-w-0 overflow-hidden ${slot().class ?? ""}`}
            style={`grid-column:${bottomGridColumn()};grid-row:3`}
          >
            {slot().children}
          </section>
        )}
      </Show>

      <Show when={bottomRailOpen() ? bottomRail() : undefined}>
        {(slot) => (
          <section
            class={`desktop-workspace-bottom-rail min-h-0 min-w-0 overflow-hidden ${slot().class ?? ""}`}
            style={`grid-column:${bottomGridColumn()};grid-row:3`}
          >
            {slot().children}
          </section>
        )}
      </Show>

      <Show when={sidebar()?.resizable && (sidebarOpen() || sidebarRailOpen())}>
        <div
          class={`${desktopResizeHandleClass} top-0 bottom-0 w-2 cursor-col-resize ${sidebarRailOpen() ? "rounded-tr-full" : ""}`}
          style={{
            left: `${sidebarColumnSize()}px`,
            top: sidebarRailOpen() ? `${topBar() ? topBarHeight() : 0}px` : "0px",
          }}
          onPointerDown={resizeSidebar}
        />
      </Show>
      <Show when={sidebarMode() === "hidden"}>
        <button
          type="button"
          aria-label="Show sidebar"
          title="Show sidebar"
          class={`${desktopRestoreHandleClass} top-0 bottom-0 left-0 w-3`}
          style="cursor:e-resize"
          onClick={restoreSidebar}
        />
      </Show>
      <Show when={right()?.resizable && (rightOpen() || rightRailOpen())}>
        <div
          class={`${desktopResizeHandleClass} w-2 rounded-full cursor-col-resize`}
          style={{
            right: `${rightColumnSize()}px`,
            top: `${topBar() ? topBarHeight() : 0}px`,
            bottom: `${bottomRowSize()}px`,
          }}
          onPointerDown={resizeRight}
        />
      </Show>
      <Show when={rightMode() === "hidden" && Boolean(right())}>
        <button
          type="button"
          aria-label="Show right panel"
          title="Show right panel"
          class={`${desktopRestoreHandleClass} w-3 rounded-full`}
          style={{
            right: "0px",
            top: `${topBar() ? topBarHeight() : 0}px`,
            bottom: `${bottomRowSize()}px`,
            cursor: "w-resize",
          }}
          onClick={restoreRight}
        />
      </Show>
      <Show when={bottom()?.resizable && (bottomOpen() || bottomRailOpen())}>
        <div
          class={`${desktopResizeHandleClass} h-2 rounded-full cursor-row-resize`}
          style={{
            left: `${sidebarColumnSize() > 0 ? sidebarColumnSize() + desktopWorkspaceGap : 0}px`,
            right: "0px",
            bottom: `${bottomOpen() ? bottomSize() - desktopWorkspaceGap : bottomRowSize()}px`,
          }}
          onPointerDown={resizeBottom}
        />
      </Show>
      <Show when={bottomMode() === "hidden" && Boolean(bottom())}>
        <button
          type="button"
          aria-label="Show bottom panel"
          title="Show bottom panel"
          class={`${desktopRestoreHandleClass} h-3 rounded-full`}
          style={{
            left: `${sidebarColumnSize() > 0 ? sidebarColumnSize() + desktopWorkspaceGap : 0}px`,
            right: "0px",
            bottom: "0px",
            cursor: "n-resize",
          }}
          onClick={restoreBottom}
        />
      </Show>
    </div>
  );
}) as DesktopWorkspaceComponent;

DesktopWorkspace.Sidebar = (props: DesktopWorkspaceSidebarProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_SIDEBAR, ...props }) satisfies DesktopWorkspaceSidebarSlot as unknown as JSX.Element;

DesktopWorkspace.TopBar = (props: DesktopWorkspaceTopBarProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_TOPBAR, ...props }) satisfies DesktopWorkspaceTopBarSlot as unknown as JSX.Element;

DesktopWorkspace.Main = (props: DesktopWorkspacePaneProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_MAIN, ...props }) satisfies DesktopWorkspaceMainSlot as unknown as JSX.Element;

DesktopWorkspace.Right = (props: DesktopWorkspaceResizablePaneProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_RIGHT, ...props }) satisfies DesktopWorkspaceRightSlot as unknown as JSX.Element;

DesktopWorkspace.Bottom = (props: DesktopWorkspaceResizablePaneProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_BOTTOM, ...props }) satisfies DesktopWorkspaceBottomSlot as unknown as JSX.Element;

DesktopWorkspace.SidebarRail = (props: DesktopWorkspaceRailProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_SIDEBAR_RAIL, ...props }) satisfies DesktopWorkspaceSidebarRailSlot as unknown as JSX.Element;

DesktopWorkspace.RightRail = (props: DesktopWorkspaceRailProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_RIGHT_RAIL, ...props }) satisfies DesktopWorkspaceRightRailSlot as unknown as JSX.Element;

DesktopWorkspace.BottomRail = (props: DesktopWorkspaceRailProps): JSX.Element =>
  ({ kind: DESKTOP_WORKSPACE_BOTTOM_RAIL, ...props }) satisfies DesktopWorkspaceBottomRailSlot as unknown as JSX.Element;

DesktopWorkspace.DragRegion = (props: ParentProps<{ class?: string }>) => (
  <div class={props.class} style="-webkit-app-region:drag">
    {props.children}
  </div>
);

DesktopWorkspace.NoDrag = (props: ParentProps<{ class?: string }>) => (
  <div class={props.class} style="-webkit-app-region:no-drag">
    {props.children}
  </div>
);

export function TitleBar(props: ParentProps<{ title?: string; class?: string }>) {
  return (
    <div class={`flex min-h-10 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800 ${props.class ?? ""}`}>
      <WindowControls />
      <Show when={props.title}>
        <p class="min-w-0 flex-1 truncate text-sm font-medium text-primary">{props.title}</p>
      </Show>
      {props.children}
    </div>
  );
}

export function WindowControls(props: { class?: string }) {
  const env = () => desktop.env as DesktopEnvironment;
  return (
    <div class={`flex items-center gap-2 ${props.class ?? ""}`}>
      <For
        each={[
          { label: "Close", class: "bg-red-500", action: () => desktop.window.close() },
          { label: "Minimize", class: "bg-amber-400", action: () => desktop.window.minimize() },
          { label: "Maximize", class: "bg-emerald-500", action: () => desktop.window.maximize() },
        ]}
      >
        {(item) => (
          <button
            type="button"
            aria-label={item.label}
            title={item.label}
            class={`h-3 w-3 rounded-full ${item.class} ${env().runtime === "browser" ? "opacity-50" : ""}`}
            onClick={() => void item.action().catch(() => undefined)}
          />
        )}
      </For>
    </div>
  );
}
