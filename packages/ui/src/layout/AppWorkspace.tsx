import { Link, type LinkNavigateEvent, type NavigationScrollMode } from "@k2b/ssr/nav";
import {
  children,
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import { installAppWorkspaceController } from "./app-workspace-controller";
import {
  APP_WORKSPACE_DETAIL_DEFAULT,
  APP_WORKSPACE_DETAIL_MAX,
  APP_WORKSPACE_DETAIL_MIN,
  APP_WORKSPACE_DRAWER_DEFAULT,
  APP_WORKSPACE_DRAWER_MAX,
  APP_WORKSPACE_DRAWER_MIN,
  APP_WORKSPACE_PANE_DEFAULT,
  APP_WORKSPACE_PANE_MAX,
  APP_WORKSPACE_PANE_MIN,
  APP_WORKSPACE_SIDEBAR_COLLAPSED,
  APP_WORKSPACE_SIDEBAR_DEFAULT,
  APP_WORKSPACE_SIDEBAR_MAX,
  APP_WORKSPACE_SIDEBAR_MIN,
  type AppWorkspaceLayoutState,
  appWorkspaceLayoutStyle,
  appWorkspacePanelVariable,
} from "./app-workspace-state";
import { assertStableUiId, assertUniqueStableUiIds } from "./stable-id";

const ResizeContext = createContext(true);
const LayoutStateContext = createContext<AppWorkspaceLayoutState | null>(null);
type SidebarMode = "desktop" | "mobile";
const SidebarModeContext = createContext<SidebarMode>("desktop");
const MAIN_PANE = Symbol("AppWorkspace.MainPane");
const SIDEBAR_MOBILE_TRIGGER = Symbol("AppWorkspace.SidebarMobileTrigger");
const SIDEBAR_MOBILE = Symbol("AppWorkspace.SidebarMobile");
const SIDEBAR_DESKTOP = Symbol("AppWorkspace.SidebarDesktop");
const SIDEBAR_ITEM_ICON = Symbol("AppWorkspace.SidebarItemIcon");
const SIDEBAR_ITEM_LABEL = Symbol("AppWorkspace.SidebarItemLabel");
const SIDEBAR_ITEM_META = Symbol("AppWorkspace.SidebarItemMeta");
const SIDEBAR_ITEM_ACTION = Symbol("AppWorkspace.SidebarItemAction");
const NAV_TREE_ITEM = Symbol("AppWorkspace.NavTree.Item");

type MainPaneSlot = {
  kind: typeof MAIN_PANE;
  props: AppWorkspaceMainPaneProps;
  domId: string;
};
type SidebarMobileTriggerSlot = AppWorkspaceSidebarMobileTriggerProps & { kind: typeof SIDEBAR_MOBILE_TRIGGER };
type SidebarChildSlot =
  | SidebarMobileTriggerSlot
  | { kind: typeof SIDEBAR_MOBILE; children: JSX.Element }
  | { kind: typeof SIDEBAR_DESKTOP; children: JSX.Element };
type SidebarItemSlot =
  | (AppWorkspaceSidebarItemIconProps & { kind: typeof SIDEBAR_ITEM_ICON })
  | (AppWorkspaceSidebarItemLabelProps & { kind: typeof SIDEBAR_ITEM_LABEL })
  | (AppWorkspaceSidebarItemMetaProps & { kind: typeof SIDEBAR_ITEM_META })
  | (AppWorkspaceSidebarItemActionProps & { kind: typeof SIDEBAR_ITEM_ACTION });
type NavTreeItemSlot = AppWorkspaceNavTreeItemProps & { kind: typeof NAV_TREE_ITEM };

const flatten = (value: unknown): unknown[] => {
  // Solid control-flow components such as <For> expose their rendered value
  // through an accessor. Compound slots may therefore be nested behind a
  // function even after `children()` resolves the outer collection.
  if (typeof value === "function") return flatten(value());
  if (Array.isArray(value)) return value.flatMap(flatten);
  return value === null || value === undefined || typeof value === "boolean" ? [] : [value];
};
const mainPaneSlot = (value: unknown): value is MainPaneSlot =>
  Boolean(value && typeof value === "object" && "kind" in value && (value as MainPaneSlot).kind === MAIN_PANE);
const sidebarChildSlot = (value: unknown): value is SidebarChildSlot =>
  Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      [SIDEBAR_MOBILE_TRIGGER, SIDEBAR_MOBILE, SIDEBAR_DESKTOP].includes((value as SidebarChildSlot).kind),
  );
const sidebarItemSlot = (value: unknown): value is SidebarItemSlot =>
  Boolean(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      [SIDEBAR_ITEM_ICON, SIDEBAR_ITEM_LABEL, SIDEBAR_ITEM_META, SIDEBAR_ITEM_ACTION].includes((value as SidebarItemSlot).kind),
  );
const navTreeItemSlot = (value: unknown): value is NavTreeItemSlot =>
  Boolean(value && typeof value === "object" && "kind" in value && (value as NavTreeItemSlot).kind === NAV_TREE_ITEM);

type ResizeHandleProps = {
  kind: "sidebar" | "pane" | "detail" | "drawer";
  edge: "start" | "end";
  controls?: string;
  panelId?: string;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  shadow?: boolean;
  label?: string;
  style?: JSX.CSSProperties;
};

function ResizeHandle(props: ResizeHandleProps): JSX.Element {
  return (
    <button
      type="button"
      class="k2b-app-workspace__resize"
      role="separator"
      aria-label={
        props.label ??
        (props.kind === "sidebar"
          ? "Resize navigation"
          : props.kind === "pane"
            ? "Resize workspace pane"
            : props.kind === "detail"
              ? "Resize detail panel"
              : "Resize bottom drawer")
      }
      aria-controls={props.controls}
      aria-orientation={props.kind === "drawer" ? "horizontal" : "vertical"}
      aria-valuemin={props.minSize}
      aria-valuemax={props.maxSize}
      aria-valuenow={props.defaultSize}
      data-app-workspace-resize={props.kind}
      data-workspace-panel-id={props.panelId}
      data-workspace-resize-edge={props.edge}
      data-workspace-resize-shadow={props.shadow ? "true" : undefined}
      data-workspace-default-size={props.defaultSize}
      data-workspace-min-size={props.minSize}
      data-workspace-max-size={props.maxSize}
      style={props.style}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export type AppWorkspaceProps = {
  children: JSX.Element;
  class?: string;
  resizable?: boolean;
  /**
   * Restores a persisted layout when the workspace mounts. Persistence itself
   * stays app-owned — the package reads and writes nothing on its own — but
   * the resize handles work without it.
   */
  layoutState?: () => AppWorkspaceLayoutState | null | undefined;
  /** Called with the full layout whenever a resize settles. Persist it here. */
  onLayoutChange?: (state: AppWorkspaceLayoutState) => void;
  /**
   * Opt out of the built-in controller. Only needed when the application calls
   * `installAppWorkspaceController` itself — installing twice would double up
   * every listener.
   */
  controller?: false;
};
export type AppWorkspaceLayoutStateProviderProps = {
  children: JSX.Element;
  state: AppWorkspaceLayoutState | null | undefined;
};
export type AppWorkspaceContentProps = { children: JSX.Element; class?: string };
export type AppWorkspaceMainProps = {
  children: JSX.Element;
  class?: string;
  mobilePane?: string;
  scroll?: boolean;
  scrollPreserveKey?: string | false;
  "aria-busy"?: boolean | "true" | "false";
};
export type AppWorkspaceMainPaneProps = {
  id: string;
  label: string;
  surface?: "default" | "navigation";
  open?: boolean;
  resizable?: boolean;
  resizeShadow?: boolean;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  class?: string;
  scroll?: boolean;
  children: JSX.Element;
};
export type AppWorkspaceDetailWidth = "sm" | "md" | "lg" | "xl";
export type AppWorkspaceDetailProps = {
  children: JSX.Element;
  open: boolean;
  id: string;
  class?: string;
  width?: AppWorkspaceDetailWidth;
  viewTransitionName?: string;
  resizable?: boolean;
  minWidth?: number;
  maxWidth?: number;
};
export type AppWorkspaceBottomDrawerHeight = "sm" | "md" | "lg";
export type AppWorkspaceBottomDrawerProps = {
  children: JSX.Element;
  open: boolean;
  id: string;
  class?: string;
  height?: AppWorkspaceBottomDrawerHeight;
  minHeight?: number;
  maxHeight?: number;
  viewTransitionName?: string;
  resizable?: boolean;
};
export type AppWorkspaceSidebarProps = {
  children: JSX.Element;
  class?: string;
  resizable?: boolean;
  resizeShadow?: boolean;
  collapsible?: boolean;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
};
export type AppWorkspaceSidebarMobileTriggerProps = { label: string };
export type AppWorkspaceSidebarMobileProps = { children: JSX.Element };
export type AppWorkspaceSidebarMobileItemsProps = {
  children: JSX.Element;
  scrollPreserveKey?: string | false;
};
export type AppWorkspaceSidebarVisibility = "always" | "expanded" | "collapsed";
export type AppWorkspaceSidebarAccessoryVisibility = "always" | "hover";
export type AppWorkspaceSidebarBodyProps = {
  children: JSX.Element;
  class?: string;
  scrollPreserveKey?: string | false;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};
export type AppWorkspaceSidebarSectionProps = AppWorkspaceSidebarBodyProps & {
  title?: string;
  actions?: JSX.Element;
};
export type AppWorkspaceSidebarItemTone = "default" | "success" | "danger";
export type AppWorkspaceSidebarIconActionTone = "default" | "success" | "danger";
export type AppWorkspaceSidebarItemProps = {
  children: JSX.Element;
  href?: string;
  /** Document navigation by default; opt into enhanced navigation only when the owning island applies the target state. */
  navigation?: "enhanced" | "document";
  replace?: boolean;
  scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  onClick?: (event: MouseEvent) => void;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  icon?: string;
  meta?: JSX.Element;
  metaVisibility?: AppWorkspaceSidebarAccessoryVisibility;
  actions?: JSX.Element;
  tone?: AppWorkspaceSidebarItemTone;
  title?: string;
  viewTransitionName?: string;
  class?: string;
  depth?: number;
  actionIcon?: string;
  actionLabel?: string;
  onActionClick?: (event: MouseEvent) => void;
  data?: Record<string, string | number | boolean | null | undefined>;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};
export type AppWorkspaceSidebarIconGridProps = AppWorkspaceSidebarBodyProps & { title?: string; columns?: 2 | 3 };
export type AppWorkspaceSidebarIconActionProps = {
  href?: string | null;
  /** Document navigation by default; opt into enhanced navigation only when the owning island applies the target state. */
  navigation?: "enhanced" | "document";
  replace?: boolean;
  scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  icon: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  tone?: AppWorkspaceSidebarIconActionTone;
  viewTransitionName?: string;
  onClick?: (event: MouseEvent) => void;
  sidebarMode?: AppWorkspaceSidebarVisibility;
};
export type AppWorkspaceSidebarItemIconProps = { icon?: string; children?: JSX.Element };
export type AppWorkspaceSidebarItemLabelProps = { children: JSX.Element; marquee?: boolean };
export type AppWorkspaceSidebarItemMetaProps = {
  children: JSX.Element;
  visibility?: AppWorkspaceSidebarAccessoryVisibility;
};
export type AppWorkspaceSidebarItemActionProps = {
  icon?: string;
  label: string;
  /** Hide the action on fine pointers until the row is hovered or keyboard-focused. */
  visibility?: AppWorkspaceSidebarAccessoryVisibility;
  href?: string;
  navigation?: "enhanced" | "document";
  onSelect?: (event: MouseEvent) => void;
  children?: JSX.Element;
};
export type AppWorkspaceSidebarItemActionsProps = {
  children: JSX.Element;
  visibility?: AppWorkspaceSidebarAccessoryVisibility;
};
export type AppWorkspaceNavTreeProps = {
  children: JSX.Element;
  ariaLabel: string;
  selectedId?: string | null;
  expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[];
  onSelectedIdChange?: (id: string) => void;
  onExpandedIdsChange?: (ids: readonly string[]) => void;
  indented?: boolean;
  class?: string;
};
export type AppWorkspaceNavTreeItemProps = {
  id: string;
  label: JSX.Element;
  children?: JSX.Element;
  href?: string;
  /** Document navigation by default; opt into enhanced navigation only when the owning island applies the target state. */
  navigation?: "enhanced" | "document";
  replace?: boolean;
  scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  onSelect?: (event: MouseEvent) => void;
  disabled?: boolean;
  icon?: string;
  /** Replaces `icon` while this branch is expanded and makes the icon the disclosure target. */
  expandedIcon?: string;
  meta?: JSX.Element;
  metaVisibility?: AppWorkspaceSidebarAccessoryVisibility;
  actions?: JSX.Element;
  tone?: AppWorkspaceSidebarItemTone;
  title?: string;
  viewTransitionName?: string;
  class?: string;
  onDragEnter?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDragOver?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDragLeave?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
  onDrop?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>;
};
type AppWorkspaceNavTreeComponent = ((props: AppWorkspaceNavTreeProps) => JSX.Element) & {
  Item: (props: AppWorkspaceNavTreeItemProps) => JSX.Element;
};

const modeAttrs = (mode?: AppWorkspaceSidebarVisibility) => (mode && mode !== "always" ? { "data-sidebar-mode": mode } : {});
/** Same rule as `modeAttrs`, for the un-prefixed `data` bag on sidebar items. */
const modeData = (mode?: AppWorkspaceSidebarVisibility) => (mode && mode !== "always" ? { "sidebar-mode": mode } : {});
const scrollAttrs = (key?: string | false) => (key ? { "data-scroll-preserve": key } : {});
const iconClass = (icon: string | undefined, fallback = "ti-circle") => (icon?.startsWith("ti ") ? icon : `ti ${icon || fallback}`);

function AppWorkspaceMainPane(props: AppWorkspaceMainPaneProps): JSX.Element {
  return {
    kind: MAIN_PANE,
    props,
    domId: `k2b-workspace-pane-${createUniqueId()}`,
  } satisfies MainPaneSlot as unknown as JSX.Element;
}

function AppWorkspaceMain(props: AppWorkspaceMainProps): JSX.Element {
  const rootResizable = useContext(ResizeContext);
  const resolved = children(() => props.children);
  const values = createMemo(() => flatten(resolved()));
  const paneIds = createMemo(() => {
    const ids = values()
      .filter(mainPaneSlot)
      .map((slot) => slot.props.id);
    assertUniqueStableUiIds(ids, "AppWorkspace.MainPane id");
    return ids;
  });
  const regions = createMemo(() => {
    const all = values();
    const primary = all.filter((value) => !mainPaneSlot(value));
    const primaryIndex = all.findIndex((value) => !mainPaneSlot(value));
    let inserted = false;
    const result: Array<{ type: "primary"; index: number; children: unknown[] } | { type: "pane"; index: number; slot: MainPaneSlot }> = [];
    all.forEach((value, index) => {
      if (mainPaneSlot(value)) {
        if (value.props.open !== false) result.push({ type: "pane", index, slot: value });
      } else if (!inserted) {
        inserted = true;
        result.push({ type: "primary", index: primaryIndex, children: primary });
      }
    });
    return result;
  });
  const anchorRegion = createMemo(() => regions().find((candidate) => candidate.type === "primary") ?? regions()[0]);
  // Presence of a MainPane slot — not of an *open* one — decides the split
  // layout. Deriving it from `regions()` made a workspace whose panes are all
  // closed fall back to `resolved()`, which renders the raw slot objects.
  const hasPanes = createMemo(() => paneIds().length > 0);

  return (
    <div
      class={`k2b-app-workspace__main ${hasPanes() ? "has-panes" : ""} ${props.class ?? ""}`}
      data-mobile-pane={props.mobilePane}
      data-scroll={props.scroll === false ? "false" : undefined}
      aria-busy={props["aria-busy"]}
      {...scrollAttrs(props.scrollPreserveKey)}
    >
      <Show when={hasPanes()} fallback={resolved() as JSX.Element}>
        {regions().flatMap((region) => {
          const anchor = anchorRegion();
          const activeMobilePane = props.mobilePane ?? (anchor?.type === "pane" ? anchor.slot.props.id : "main");
          if (region.type === "primary") {
            return (
              <div
                class="k2b-app-workspace__main-primary"
                data-workspace-main-region="main"
                data-workspace-mobile-active={activeMobilePane === "main" ? "true" : "false"}
              >
                {region.children as JSX.Element}
              </div>
            );
          }
          const pane = region.slot;
          const panelId = assertStableUiId(pane.props.id, "AppWorkspace.MainPane id");
          const variable = appWorkspacePanelVariable("pane", panelId);
          const isAnchor = region === anchor;
          const resizable = !isAnchor && (pane.props.resizable ?? rootResizable);
          const defaultSize = pane.props.defaultSize ?? APP_WORKSPACE_PANE_DEFAULT;
          const minSize = pane.props.minSize ?? APP_WORKSPACE_PANE_MIN;
          const maxSize = Math.max(minSize, pane.props.maxSize ?? APP_WORKSPACE_PANE_MAX);
          const content = (
            <section
              id={pane.domId}
              class={`k2b-app-workspace__main-pane ${isAnchor ? "is-primary" : ""} ${pane.props.class ?? ""}`}
              aria-label={pane.props.label}
              data-workspace-main-region={pane.props.id}
              data-workspace-mobile-active={activeMobilePane === pane.props.id ? "true" : "false"}
              data-workspace-panel-id={panelId}
              data-workspace-resizable={resizable ? "true" : "false"}
              data-surface={pane.props.surface === "navigation" ? "navigation" : undefined}
              data-scroll={pane.props.scroll === false ? "false" : undefined}
              style={isAnchor ? undefined : { "--k2b-workspace-panel-size": `var(${variable}, ${defaultSize}px)` }}
            >
              {pane.props.children}
            </section>
          );
          if (!resizable) return content;
          const before = region.index < (anchor?.index ?? 0);
          const handle = (
            <ResizeHandle
              kind="pane"
              edge={before ? "end" : "start"}
              controls={pane.domId}
              panelId={panelId}
              defaultSize={defaultSize}
              minSize={minSize}
              maxSize={maxSize}
              shadow={pane.props.resizeShadow !== false}
              label={`Resize ${pane.props.label}`}
            />
          );
          return before ? [content, handle] : [handle, content];
        })}
      </Show>
    </div>
  );
}

function AppWorkspaceDetail(props: AppWorkspaceDetailProps): JSX.Element {
  const rootResizable = useContext(ResizeContext);
  const panelId = () => assertStableUiId(props.id, "AppWorkspace.Detail id");
  const domId = () => `k2b-workspace-detail-${panelId()}`;
  const variable = () => appWorkspacePanelVariable("detail", panelId());
  // Cloud's `detailDefaultWidth`. These feed `aria-valuenow` and the
  // `var(…, Npx)` first-paint fallback, so they are behaviour, not taste.
  const widths = { sm: 288, md: 384, lg: 480, xl: 544 };
  const defaultWidth = () => widths[props.width ?? "md"] ?? APP_WORKSPACE_DETAIL_DEFAULT;
  const minWidth = () => props.minWidth ?? APP_WORKSPACE_DETAIL_MIN;
  const maxWidth = () => Math.max(minWidth(), props.maxWidth ?? APP_WORKSPACE_DETAIL_MAX);
  const resizable = () => props.resizable ?? rootResizable;
  return (
    <>
      <Show when={resizable()}>
        <ResizeHandle
          kind="detail"
          edge="start"
          controls={domId()}
          panelId={panelId()}
          defaultSize={defaultWidth()}
          minSize={minWidth()}
          maxSize={maxWidth()}
          shadow
          style={{ "--k2b-workspace-panel-size": `var(${variable()}, ${defaultWidth()}px)` }}
        />
      </Show>
      <aside
        id={domId()}
        class={`k2b-app-workspace__detail ${props.class ?? ""}`}
        data-width={props.width ?? "md"}
        data-workspace-panel-id={panelId()}
        data-workspace-resizable={resizable() ? "true" : "false"}
        hidden={!props.open}
        style={{
          "--k2b-workspace-panel-size": `var(${variable()}, ${defaultWidth()}px)`,
          "view-transition-name": props.viewTransitionName,
        }}
      >
        {props.children}
      </aside>
    </>
  );
}

function AppWorkspaceBottomDrawer(props: AppWorkspaceBottomDrawerProps): JSX.Element {
  const rootResizable = useContext(ResizeContext);
  const panelId = () => assertStableUiId(props.id, "AppWorkspace.BottomDrawer id");
  const domId = () => `k2b-workspace-drawer-${panelId()}`;
  const variable = () => appWorkspacePanelVariable("drawer", panelId());
  // Cloud's `drawerDefaultHeight`.
  const heights = { sm: 192, md: 240, lg: 320 };
  const defaultHeight = () => heights[props.height ?? "md"] ?? APP_WORKSPACE_DRAWER_DEFAULT;
  const minHeight = () => props.minHeight ?? APP_WORKSPACE_DRAWER_MIN;
  const maxHeight = () => Math.max(minHeight(), props.maxHeight ?? APP_WORKSPACE_DRAWER_MAX);
  const resizable = () => props.resizable ?? rootResizable;
  return (
    <>
      <Show when={resizable()}>
        <ResizeHandle
          kind="drawer"
          edge="start"
          controls={domId()}
          panelId={panelId()}
          defaultSize={defaultHeight()}
          minSize={minHeight()}
          maxSize={maxHeight()}
          shadow
          style={{ "--k2b-workspace-panel-size": `var(${variable()}, ${defaultHeight()}px)` }}
        />
      </Show>
      <aside
        id={domId()}
        class={`k2b-app-workspace__drawer ${props.class ?? ""}`}
        data-height={props.height ?? "md"}
        data-workspace-panel-id={panelId()}
        data-workspace-resizable={resizable() ? "true" : "false"}
        hidden={!props.open}
        style={{
          "--k2b-workspace-panel-size": `var(${variable()}, ${defaultHeight()}px)`,
          "view-transition-name": props.viewTransitionName,
        }}
      >
        {props.children}
      </aside>
    </>
  );
}

const AppWorkspaceSidebarMobileTrigger = (props: AppWorkspaceSidebarMobileTriggerProps): JSX.Element =>
  ({ kind: SIDEBAR_MOBILE_TRIGGER, ...props }) satisfies SidebarMobileTriggerSlot as unknown as JSX.Element;

function AppWorkspaceSidebar(props: AppWorkspaceSidebarProps): JSX.Element {
  const rootResizable = useContext(ResizeContext);
  const resizable = () => props.resizable ?? rootResizable;
  const defaultSize = () => props.defaultSize ?? APP_WORKSPACE_SIDEBAR_DEFAULT;
  const minSize = () => props.minSize ?? (props.collapsible ? APP_WORKSPACE_SIDEBAR_COLLAPSED : APP_WORKSPACE_SIDEBAR_MIN);
  const maxSize = () => props.maxSize ?? APP_WORKSPACE_SIDEBAR_MAX;
  const generatedId = createUniqueId();
  const domId = `k2b-workspace-sidebar-${generatedId}`;
  const resolved = children(() => props.children);
  const slots = createMemo(() => flatten(resolved()).filter(sidebarChildSlot));
  const mobileTrigger = createMemo(() => slots().find((slot): slot is SidebarMobileTriggerSlot => slot.kind === SIDEBAR_MOBILE_TRIGGER));
  const mobile = createMemo(() => slots().find((slot) => slot.kind === SIDEBAR_MOBILE));
  const desktop = createMemo(() => slots().find((slot) => slot.kind === SIDEBAR_DESKTOP));
  return (
    <>
      <Show when={mobileTrigger() && mobile()}>
        <nav class="k2b-app-workspace__sidebar-mobile" aria-label={mobileTrigger()!.label}>
          <details>
            <summary>
              <span class="k2b-app-workspace__sidebar-mobile-trigger">
                <i class="ti ti-menu-2" aria-hidden="true" />
                <span>{mobileTrigger()!.label}</span>
              </span>
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </summary>
            <SidebarModeContext.Provider value="mobile">{mobile()!.children}</SidebarModeContext.Provider>
          </details>
        </nav>
      </Show>
      <aside
        id={domId}
        class={`k2b-app-workspace__sidebar ${props.class ?? ""}`}
        aria-label={mobileTrigger()?.label}
        data-workspace-resizable={resizable() ? "true" : "false"}
        data-workspace-collapsible={props.collapsible ? "true" : "false"}
      >
        <div class="k2b-app-workspace__sidebar-desktop">
          <SidebarModeContext.Provider value="desktop">{desktop()?.children}</SidebarModeContext.Provider>
        </div>
      </aside>
      <Show when={resizable()}>
        <ResizeHandle
          kind="sidebar"
          edge="end"
          controls={domId}
          defaultSize={defaultSize()}
          minSize={minSize()}
          maxSize={maxSize()}
          shadow={props.resizeShadow !== false}
        />
      </Show>
    </>
  );
}

const AppWorkspaceSidebarMobile = (props: AppWorkspaceSidebarMobileProps): JSX.Element =>
  ({ kind: SIDEBAR_MOBILE, children: props.children }) as unknown as JSX.Element;
const AppWorkspaceSidebarDesktop = (props: { children: JSX.Element }): JSX.Element =>
  ({ kind: SIDEBAR_DESKTOP, children: props.children }) as unknown as JSX.Element;
const AppWorkspaceSidebarMobileItems = (props: AppWorkspaceSidebarMobileItemsProps) => (
  <div class="k2b-app-workspace__sidebar-mobile-items" {...scrollAttrs(props.scrollPreserveKey)}>
    {props.children}
  </div>
);
const AppWorkspaceSidebarBody = (props: AppWorkspaceSidebarBodyProps) => (
  <div
    class={`k2b-app-workspace__sidebar-body ${props.class ?? ""}`}
    {...scrollAttrs(props.scrollPreserveKey)}
    {...modeAttrs(props.sidebarMode)}
  >
    {props.children}
  </div>
);
const AppWorkspaceSidebarMobileBody = (props: AppWorkspaceSidebarBodyProps) => (
  <div
    class={`k2b-app-workspace__sidebar-mobile-body ${props.class ?? ""}`}
    {...scrollAttrs(props.scrollPreserveKey)}
    {...modeAttrs(props.sidebarMode)}
  >
    {props.children}
  </div>
);
const AppWorkspaceSidebarFooter = (props: AppWorkspaceSidebarBodyProps) => (
  <footer class={`k2b-app-workspace__sidebar-footer ${props.class ?? ""}`} {...modeAttrs(props.sidebarMode)}>
    {props.children}
  </footer>
);
const AppWorkspaceSidebarSection = (props: AppWorkspaceSidebarSectionProps) => (
  <section class={`k2b-app-workspace__sidebar-section ${props.class ?? ""}`} {...modeAttrs(props.sidebarMode)}>
    <Show when={props.title || props.actions}>
      <header class="k2b-app-workspace__sidebar-section-header">
        <Show when={props.title}>{(title) => <h2>{title()}</h2>}</Show>
        <Show when={props.actions}>
          <div class="k2b-app-workspace__sidebar-section-actions">{props.actions}</div>
        </Show>
      </header>
    </Show>
    {props.children}
  </section>
);

const AppWorkspaceSidebarItemIcon = (props: AppWorkspaceSidebarItemIconProps): JSX.Element =>
  ({ kind: SIDEBAR_ITEM_ICON, ...props }) as unknown as JSX.Element;
const AppWorkspaceSidebarItemLabel = (props: AppWorkspaceSidebarItemLabelProps): JSX.Element =>
  ({ kind: SIDEBAR_ITEM_LABEL, ...props }) as unknown as JSX.Element;
const AppWorkspaceSidebarItemMeta = (props: AppWorkspaceSidebarItemMetaProps): JSX.Element =>
  ({ kind: SIDEBAR_ITEM_META, ...props }) as unknown as JSX.Element;
const AppWorkspaceSidebarItemAction = (props: AppWorkspaceSidebarItemActionProps): JSX.Element =>
  ({ kind: SIDEBAR_ITEM_ACTION, ...props }) as unknown as JSX.Element;
const AppWorkspaceSidebarItemActions = (props: AppWorkspaceSidebarItemActionsProps): JSX.Element => (
  <div class="k2b-app-workspace__sidebar-item-actions" data-visibility={props.visibility === "hover" ? "hover" : undefined}>
    {props.children}
  </div>
);

type AppWorkspaceSidebarRowProps = {
  children: JSX.Element;
  actions?: JSX.Element;
  hasActions: boolean;
  href?: string;
  navigation?: "enhanced" | "document";
  replace?: boolean;
  scroll?: NavigationScrollMode;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
  onClick?: (event: MouseEvent) => void;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  tone?: AppWorkspaceSidebarItemTone;
  title?: string;
  viewTransitionName?: string;
  class?: string;
  depth?: number;
  tabIndex?: number;
  mode: SidebarMode;
  data?: Record<string, string | number | boolean | null | undefined>;
};

/** Shared visual and semantic row frame for flat sidebar items and tree items. */
function AppWorkspaceSidebarRow(props: AppWorkspaceSidebarRowProps): JSX.Element {
  const className = () =>
    `k2b-app-workspace__sidebar-item ${props.hasActions ? "has-action" : ""} ${props.active ? (props.activeClass ?? "is-active") : ""} ${props.class ?? ""}`;
  const data = () =>
    Object.fromEntries(
      Object.entries(props.data ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [`data-${key}`, String(value)]),
    );
  const common = () => ({
    class: className(),
    title: props.title,
    "data-tone": props.tone,
    "data-mode": props.mode,
    style: {
      "view-transition-name": props.viewTransitionName,
      "--k2b-sidebar-item-depth": props.depth === undefined ? undefined : String(Math.max(0, props.depth)),
    },
    ...data(),
  });
  const current = () => (props.active ? ("page" as const) : undefined);

  if (props.hasActions) {
    if (!props.href || props.disabled) {
      return (
        <div {...common()} data-disabled={props.disabled ? "true" : undefined}>
          <button
            type="button"
            class="k2b-app-workspace__sidebar-item-main"
            tabIndex={props.tabIndex}
            disabled={props.disabled}
            onClick={props.onClick}
          >
            {props.children}
          </button>
          {props.actions}
        </div>
      );
    }
    if (props.navigation !== "enhanced") {
      return (
        <div {...common()}>
          <a
            href={props.href}
            class="k2b-app-workspace__sidebar-item-main"
            tabIndex={props.tabIndex}
            aria-current={current()}
            onClick={props.onClick}
          >
            {props.children}
          </a>
          {props.actions}
        </div>
      );
    }
    return (
      <div {...common()}>
        <Link
          href={props.href}
          class="k2b-app-workspace__sidebar-item-main"
          tabIndex={props.tabIndex}
          aria-current={current()}
          replace={props.replace}
          scroll={props.scroll}
          onNavigate={props.onNavigate}
          onClick={props.onClick}
        >
          {props.children}
        </Link>
        {props.actions}
      </div>
    );
  }
  if (!props.href || props.disabled) {
    return (
      <button type="button" {...common()} tabIndex={props.tabIndex} disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </button>
    );
  }
  if (props.navigation !== "enhanced") {
    return (
      <a href={props.href} {...common()} tabIndex={props.tabIndex} aria-current={current()} onClick={props.onClick}>
        {props.children}
      </a>
    );
  }
  return (
    <Link
      href={props.href}
      {...common()}
      tabIndex={props.tabIndex}
      aria-current={current()}
      replace={props.replace}
      scroll={props.scroll}
      onNavigate={props.onNavigate}
      onClick={props.onClick}
    >
      {props.children}
    </Link>
  );
}

function AppWorkspaceSidebarItem(props: AppWorkspaceSidebarItemProps): JSX.Element {
  const mode = useContext(SidebarModeContext);
  const resolved = children(() => props.children);
  const resolvedActions = children(() => props.actions);
  const values = createMemo(() => flatten(resolved()));
  const slots = createMemo(() => values().filter(sidebarItemSlot));
  const iconSlot = createMemo(
    () =>
      slots().find((slot) => slot.kind === SIDEBAR_ITEM_ICON) as
        | (AppWorkspaceSidebarItemIconProps & { kind: typeof SIDEBAR_ITEM_ICON })
        | undefined,
  );
  const labelSlot = createMemo(
    () =>
      slots().find((slot) => slot.kind === SIDEBAR_ITEM_LABEL) as
        | (AppWorkspaceSidebarItemLabelProps & { kind: typeof SIDEBAR_ITEM_LABEL })
        | undefined,
  );
  const metaSlot = createMemo(
    () =>
      slots().find((slot) => slot.kind === SIDEBAR_ITEM_META) as
        | (AppWorkspaceSidebarItemMetaProps & { kind: typeof SIDEBAR_ITEM_META })
        | undefined,
  );
  const actionSlot = createMemo(
    () =>
      slots().find((slot) => slot.kind === SIDEBAR_ITEM_ACTION) as
        | (AppWorkspaceSidebarItemActionProps & { kind: typeof SIDEBAR_ITEM_ACTION })
        | undefined,
  );
  const legacy = createMemo(() => values().filter((value) => !sidebarItemSlot(value)));
  const label = () => labelSlot()?.children ?? (legacy().length === 1 ? legacy()[0] : legacy());
  const icon = () => iconSlot()?.icon ?? props.icon;
  const iconContent = () => iconSlot()?.children;
  const meta = () => metaSlot()?.children ?? props.meta;
  const metaVisibility = () => metaSlot()?.visibility ?? props.metaVisibility;
  const customActions = () => resolvedActions();
  const hasCustomActions = () => Boolean(customActions());
  const hasAction = () => Boolean(actionSlot() || props.actionIcon || hasCustomActions());
  const mainContent = (
    <>
      <Show when={iconContent() || icon()}>
        <span class="k2b-app-workspace__sidebar-item-icon" aria-hidden="true">
          {iconContent() ?? <i class={iconClass(icon())} />}
        </span>
      </Show>
      {/* The inner text span is what the marquee translates; the controller
          measures its `scrollWidth` against the clipping outer span. */}
      <span class="k2b-app-workspace__sidebar-item-label" data-marquee={labelSlot()?.marquee === false ? undefined : "true"}>
        <span class="k2b-app-workspace__sidebar-item-label-text">{label() as JSX.Element}</span>
      </span>
      <Show when={meta()}>
        {(value) => (
          <span class="k2b-app-workspace__sidebar-item-meta" data-visibility={metaVisibility() === "hover" ? "hover" : undefined}>
            {value()}
          </span>
        )}
      </Show>
    </>
  );
  const singleAction = () => {
    const slot = actionSlot();
    if (!slot && !props.actionIcon) return null;
    const content = slot?.children ?? <i class={iconClass(slot?.icon ?? props.actionIcon, "ti-dots")} />;
    const label = slot?.label ?? props.actionLabel ?? "Row action";
    const select = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      slot?.onSelect?.(event);
      props.onActionClick?.(event);
    };
    // A row action that is a link must still navigate — only the row's own
    // click handling is suppressed.
    const follow = (event: MouseEvent) => {
      event.stopPropagation();
      slot?.onSelect?.(event);
      props.onActionClick?.(event);
    };
    return slot?.href ? (
      <a
        href={slot.href}
        class="k2b-app-workspace__sidebar-item-action"
        data-visibility={slot.visibility === "hover" ? "hover" : undefined}
        aria-label={label}
        onClick={follow}
      >
        {content}
      </a>
    ) : (
      <button
        type="button"
        class="k2b-app-workspace__sidebar-item-action"
        data-visibility={slot?.visibility === "hover" ? "hover" : undefined}
        aria-label={label}
        onClick={select}
      >
        {content}
      </button>
    );
  };
  const actions = () => (
    <>
      {customActions()}
      {singleAction()}
    </>
  );
  return (
    <AppWorkspaceSidebarRow
      mode={mode}
      hasActions={hasAction()}
      href={props.href}
      navigation={props.navigation}
      replace={props.replace}
      scroll={props.scroll}
      onNavigate={props.onNavigate}
      onClick={props.onClick}
      active={props.active}
      activeClass={props.activeClass}
      disabled={props.disabled}
      tone={props.tone}
      title={props.title}
      viewTransitionName={props.viewTransitionName}
      class={props.class}
      depth={props.depth}
      actions={actions()}
      data={{
        ...props.data,
        ...modeData(props.sidebarMode),
        "has-actions": hasCustomActions() ? "true" : undefined,
        "action-visibility": actionSlot()?.visibility === "hover" ? "hover" : undefined,
      }}
    >
      {mainContent}
    </AppWorkspaceSidebarRow>
  );
}

const navTreeItems = (value: unknown): NavTreeItemSlot[] => flatten(value).filter(navTreeItemSlot);

const AppWorkspaceNavTreeItem = (props: AppWorkspaceNavTreeItemProps): JSX.Element =>
  ({ kind: NAV_TREE_ITEM, ...props }) as unknown as JSX.Element;

const AppWorkspaceNavTree = ((props: AppWorkspaceNavTreeProps) => {
  const mode = useContext(SidebarModeContext);
  let root: HTMLDivElement | undefined;
  const resolved = children(() => props.children);
  const roots = createMemo(() => navTreeItems(resolved()));
  const [uncontrolledExpandedIds, setUncontrolledExpandedIds] = createSignal<string[]>([...new Set(props.defaultExpandedIds ?? [])]);
  const [focusedId, setFocusedId] = createSignal<string | null>(props.selectedId ?? null);
  const expandedIds = createMemo(() => new Set(props.expandedIds ?? uncontrolledExpandedIds()));
  const isExpanded = (id: string) => expandedIds().has(id);

  const setExpanded = (id: string, expanded: boolean) => {
    const next = new Set(expandedIds());
    if (expanded) next.add(id);
    else next.delete(id);
    const value = [...next];
    if (props.expandedIds === undefined) setUncontrolledExpandedIds(value);
    props.onExpandedIdsChange?.(value);
  };

  const visibleIds = createMemo(() => {
    const result: string[] = [];
    const visit = (items: readonly NavTreeItemSlot[]) => {
      for (const item of items) {
        if (item.disabled) continue;
        result.push(item.id);
        const nested = navTreeItems(item.children);
        if (nested.length > 0 && isExpanded(item.id)) visit(nested);
      }
    };
    visit(roots());
    return result;
  });

  const tabStopId = () => {
    const visible = visibleIds();
    const focused = focusedId();
    if (focused && visible.includes(focused)) return focused;
    if (props.selectedId && visible.includes(props.selectedId)) return props.selectedId;
    return visible[0] ?? null;
  };

  const treeItemElements = () =>
    Array.from(root?.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]") ?? []).filter(
      (element) => element.getAttribute("aria-disabled") !== "true",
    );
  const focusItem = (id: string | null) => {
    if (!id) return;
    const element = treeItemElements().find((candidate) => candidate.dataset.k2bNavTreeId === id);
    element?.focus({ preventScroll: true });
  };

  const renderItems = (value: unknown, depth: number, parentId?: string): JSX.Element => (
    <For each={navTreeItems(value)}>
      {(item) => {
        const nested = createMemo(() => navTreeItems(item.children));
        const hasChildren = () => nested().length > 0;
        const selected = () => props.selectedId === item.id;
        let treeItem: HTMLDivElement | undefined;

        const activate = (event: MouseEvent) => {
          if (item.disabled) return;
          treeItem?.focus({ preventScroll: true });
          setFocusedId(item.id);
          if (hasChildren() && !item.href && !item.onSelect && !props.onSelectedIdChange) {
            setExpanded(item.id, !isExpanded(item.id));
            return;
          }
          props.onSelectedIdChange?.(item.id);
          item.onSelect?.(event);
        };
        const toggle = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (!item.disabled && hasChildren()) setExpanded(item.id, !isExpanded(item.id));
        };
        const onRowClick = (event: MouseEvent) => {
          if ((event.target as Element | null)?.closest("[data-k2b-nav-tree-toggle]")) {
            toggle(event);
            return;
          }
          activate(event);
        };
        const rowControl = () => {
          const firstChild = treeItem?.firstElementChild as HTMLElement | null | undefined;
          if (!firstChild?.classList.contains("has-action")) return firstChild;
          return firstChild.firstElementChild as HTMLElement | null;
        };
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.target !== event.currentTarget) return;
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const items = treeItemElements();
          const index = items.indexOf(event.currentTarget as HTMLElement);
          if (event.key === "ArrowDown" && index >= 0) {
            event.preventDefault();
            items[Math.min(items.length - 1, index + 1)]?.focus({ preventScroll: true });
            return;
          }
          if (event.key === "ArrowUp" && index >= 0) {
            event.preventDefault();
            items[Math.max(0, index - 1)]?.focus({ preventScroll: true });
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            items[0]?.focus({ preventScroll: true });
            return;
          }
          if (event.key === "End") {
            event.preventDefault();
            items.at(-1)?.focus({ preventScroll: true });
            return;
          }
          if (event.key === "ArrowRight" && hasChildren()) {
            event.preventDefault();
            if (!isExpanded(item.id)) setExpanded(item.id, true);
            else queueMicrotask(() => focusItem(nested()[0]?.id ?? null));
            return;
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (hasChildren() && isExpanded(item.id)) setExpanded(item.id, false);
            else focusItem(parentId ?? null);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            rowControl()?.click();
          }
        };
        const usesIconDisclosure = () => hasChildren() && Boolean(item.icon && item.expandedIcon);
        const rowIcon = () => (usesIconDisclosure() && isExpanded(item.id) ? item.expandedIcon : item.icon);
        const rowContent = (
          <>
            <Show when={rowIcon()}>
              <span
                class="k2b-app-workspace__sidebar-item-icon"
                data-k2b-nav-tree-toggle={usesIconDisclosure() ? "" : undefined}
                aria-hidden="true"
              >
                <i class={iconClass(rowIcon())} />
              </span>
            </Show>
            <span class="k2b-app-workspace__sidebar-item-label">
              <span class="k2b-app-workspace__sidebar-item-label-text">{item.label}</span>
            </span>
            <Show when={item.meta !== undefined}>
              <span
                class={`k2b-app-workspace__sidebar-item-meta ${hasChildren() ? "" : "k2b-app-workspace__nav-tree-leaf-meta"}`}
                data-visibility={item.metaVisibility === "hover" ? "hover" : undefined}
              >
                {item.meta}
              </span>
            </Show>
            <Show when={hasChildren() && !usesIconDisclosure()}>
              <span class="k2b-app-workspace__nav-tree-toggle" data-k2b-nav-tree-toggle aria-hidden="true">
                <i class={`ti ${isExpanded(item.id) ? "ti-chevron-down" : "ti-chevron-right"}`} />
              </span>
            </Show>
          </>
        );
        const row = () => (
          <AppWorkspaceSidebarRow
            mode={mode}
            hasActions={Boolean(item.actions)}
            href={item.href}
            navigation={item.navigation}
            replace={item.replace}
            scroll={item.scroll}
            onNavigate={item.onNavigate}
            onClick={onRowClick}
            active={selected()}
            disabled={item.disabled}
            tone={item.tone}
            title={item.title}
            viewTransitionName={item.viewTransitionName}
            class={`k2b-app-workspace__nav-tree-row ${item.class ?? ""}`}
            depth={props.indented === false ? 0 : depth}
            tabIndex={-1}
            actions={item.actions}
            data={{ "has-actions": item.actions ? "true" : undefined }}
          >
            {rowContent}
          </AppWorkspaceSidebarRow>
        );

        return (
          <div
            ref={treeItem}
            class="k2b-app-workspace__nav-tree-node"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected()}
            aria-expanded={hasChildren() ? isExpanded(item.id) : undefined}
            aria-disabled={item.disabled ? "true" : undefined}
            tabIndex={item.disabled ? -1 : tabStopId() === item.id ? 0 : -1}
            data-k2b-nav-tree-id={item.id}
            data-k2b-nav-tree-parent-id={parentId}
            onFocus={() => setFocusedId(item.id)}
            onKeyDown={onKeyDown}
            onDragEnter={item.onDragEnter}
            onDragOver={item.onDragOver}
            onDragLeave={item.onDragLeave}
            onDrop={item.onDrop}
          >
            {row()}
            <Show when={hasChildren() && isExpanded(item.id)}>
              <div class="k2b-app-workspace__nav-tree-group" role="group">
                {renderItems(nested(), depth + 1, item.id)}
              </div>
            </Show>
          </div>
        );
      }}
    </For>
  );

  return (
    <div ref={root} class={`k2b-app-workspace__nav-tree ${props.class ?? ""}`} role="tree" aria-label={props.ariaLabel}>
      {renderItems(roots(), 0)}
    </div>
  );
}) as AppWorkspaceNavTreeComponent;

AppWorkspaceNavTree.Item = AppWorkspaceNavTreeItem;

const AppWorkspaceSidebarIconGrid = (props: AppWorkspaceSidebarIconGridProps) => (
  <section class={`k2b-app-workspace__sidebar-icon-grid-wrap ${props.class ?? ""}`} {...modeAttrs(props.sidebarMode)}>
    <Show when={props.title}>{(title) => <h2>{title()}</h2>}</Show>
    <div class="k2b-app-workspace__sidebar-icon-grid" data-columns={props.columns ?? 2}>
      {props.children}
    </div>
  </section>
);

const AppWorkspaceSidebarIconAction = (props: AppWorkspaceSidebarIconActionProps) => {
  const content = <i class={iconClass(props.icon)} aria-hidden="true" />;
  const attrs = () => ({
    class: `k2b-app-workspace__sidebar-icon-action ${props.active ? "is-active" : ""}`,
    title: props.label,
    "aria-label": props.label,
    "data-tone": props.tone,
    style: { "view-transition-name": props.viewTransitionName },
    ...modeAttrs(props.sidebarMode),
  });
  if (!props.href || props.disabled)
    return (
      <button type="button" {...attrs()} disabled={props.disabled} onClick={props.onClick}>
        {content}
      </button>
    );
  if (props.navigation !== "enhanced")
    return (
      <a href={props.href} {...attrs()} onClick={props.onClick}>
        {content}
      </a>
    );
  return (
    <Link
      href={props.href}
      {...attrs()}
      replace={props.replace}
      scroll={props.scroll}
      onNavigate={props.onNavigate}
      onClick={props.onClick}
    >
      {content}
    </Link>
  );
};

type AppWorkspaceComponent = ((props: AppWorkspaceProps) => JSX.Element) & {
  LayoutStateProvider: (props: AppWorkspaceLayoutStateProviderProps) => JSX.Element;
  Content: (props: AppWorkspaceContentProps) => JSX.Element;
  Main: (props: AppWorkspaceMainProps) => JSX.Element;
  MainPane: (props: AppWorkspaceMainPaneProps) => JSX.Element;
  Detail: (props: AppWorkspaceDetailProps) => JSX.Element;
  BottomDrawer: (props: AppWorkspaceBottomDrawerProps) => JSX.Element;
  Sidebar: (props: AppWorkspaceSidebarProps) => JSX.Element;
  SidebarMobileTrigger: (props: AppWorkspaceSidebarMobileTriggerProps) => JSX.Element;
  SidebarMobile: (props: AppWorkspaceSidebarMobileProps) => JSX.Element;
  SidebarMobileItems: (props: AppWorkspaceSidebarMobileItemsProps) => JSX.Element;
  SidebarMobileBody: (props: AppWorkspaceSidebarBodyProps) => JSX.Element;
  SidebarDesktop: (props: { children: JSX.Element }) => JSX.Element;
  SidebarSection: (props: AppWorkspaceSidebarSectionProps) => JSX.Element;
  SidebarBody: (props: AppWorkspaceSidebarBodyProps) => JSX.Element;
  SidebarFooter: (props: AppWorkspaceSidebarBodyProps) => JSX.Element;
  SidebarItem: (props: AppWorkspaceSidebarItemProps) => JSX.Element;
  SidebarItemIcon: (props: AppWorkspaceSidebarItemIconProps) => JSX.Element;
  SidebarItemLabel: (props: AppWorkspaceSidebarItemLabelProps) => JSX.Element;
  SidebarItemMeta: (props: AppWorkspaceSidebarItemMetaProps) => JSX.Element;
  SidebarItemAction: (props: AppWorkspaceSidebarItemActionProps) => JSX.Element;
  SidebarItemActions: (props: AppWorkspaceSidebarItemActionsProps) => JSX.Element;
  NavTree: AppWorkspaceNavTreeComponent;
  SidebarIconGrid: (props: AppWorkspaceSidebarIconGridProps) => JSX.Element;
  SidebarIconAction: (props: AppWorkspaceSidebarIconActionProps) => JSX.Element;
};

const AppWorkspace = ((props: AppWorkspaceProps) => {
  let root: HTMLDivElement | undefined;
  const serverLayoutState = useContext(LayoutStateContext);
  const initialLayoutState = () => props.layoutState?.() ?? serverLayoutState;

  // The resize handles are inert markup until the controller is attached, so
  // the workspace attaches it itself and scopes it to this root. `onMount`
  // never runs during SSR, and the disposer removes every listener. A host
  // shell may own one document-level controller for SSR and hydrated roots;
  // its marker keeps controller ownership singular without app-level props.
  onMount(() => {
    if (props.controller === false || !root || root.closest("[data-k2b-app-workspace-controller]")) return;
    onCleanup(
      installAppWorkspaceController({
        root,
        readState: () => (props.layoutState ? props.layoutState() : serverLayoutState),
        writeState: (state) => props.onLayoutChange?.(state),
      }),
    );
  });

  return (
    <ResizeContext.Provider value={props.resizable !== false}>
      <div
        ref={root}
        class={`k2b-app-workspace ${props.class ?? ""}`}
        data-k2b-app-workspace
        data-sidebar-collapsed={
          initialLayoutState()?.sidebarCollapsed === undefined ? undefined : String(initialLayoutState()?.sidebarCollapsed)
        }
        data-workspace-resizable={props.resizable === false ? "false" : "true"}
        style={appWorkspaceLayoutStyle(initialLayoutState())}
      >
        {props.children}
      </div>
    </ResizeContext.Provider>
  );
}) as AppWorkspaceComponent;

AppWorkspace.LayoutStateProvider = (props) => (
  <LayoutStateContext.Provider value={props.state ?? null}>{props.children}</LayoutStateContext.Provider>
);
AppWorkspace.Content = (props) => <div class={`k2b-app-workspace__content ${props.class ?? ""}`}>{props.children}</div>;
AppWorkspace.Main = AppWorkspaceMain;
AppWorkspace.MainPane = AppWorkspaceMainPane;
AppWorkspace.Detail = AppWorkspaceDetail;
AppWorkspace.BottomDrawer = AppWorkspaceBottomDrawer;
AppWorkspace.Sidebar = AppWorkspaceSidebar;
AppWorkspace.SidebarMobileTrigger = AppWorkspaceSidebarMobileTrigger;
AppWorkspace.SidebarMobile = AppWorkspaceSidebarMobile;
AppWorkspace.SidebarMobileItems = AppWorkspaceSidebarMobileItems;
AppWorkspace.SidebarMobileBody = AppWorkspaceSidebarMobileBody;
AppWorkspace.SidebarDesktop = AppWorkspaceSidebarDesktop;
AppWorkspace.SidebarSection = AppWorkspaceSidebarSection;
AppWorkspace.SidebarBody = AppWorkspaceSidebarBody;
AppWorkspace.SidebarFooter = AppWorkspaceSidebarFooter;
AppWorkspace.SidebarItem = AppWorkspaceSidebarItem;
AppWorkspace.SidebarItemIcon = AppWorkspaceSidebarItemIcon;
AppWorkspace.SidebarItemLabel = AppWorkspaceSidebarItemLabel;
AppWorkspace.SidebarItemMeta = AppWorkspaceSidebarItemMeta;
AppWorkspace.SidebarItemAction = AppWorkspaceSidebarItemAction;
AppWorkspace.SidebarItemActions = AppWorkspaceSidebarItemActions;
AppWorkspace.NavTree = AppWorkspaceNavTree;
AppWorkspace.SidebarIconGrid = AppWorkspaceSidebarIconGrid;
AppWorkspace.SidebarIconAction = AppWorkspaceSidebarIconAction;

export default AppWorkspace;
