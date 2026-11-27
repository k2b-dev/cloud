import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { dialogCore, useLocale } from "@k2b/ui";
import { type Action, Dialog, Nav, type NavSwitcher, Notice, useToast, Workspace } from "@k2b/ui/v2";
import { type Accessor, createContext, createSignal, type JSX, onCleanup, onMount, Show, useContext } from "solid-js";
import { isServer } from "solid-js/web";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import type { BaseChoices } from "../../base-choices";
import { withParam } from "../overview/bases-query";
import CreateBaseDialog, { type BaseTemplate, BLANK } from "../overview/CreateBaseDialog";
import type { NavigationState } from "../workspace/navigation-catalog";
import { workspaceLiveStatus } from "../workspace/workspace-live-state";
import { startWorkspaceMetadataRefresh } from "../workspace/workspace-metadata-refresh";
import { createGridsNav, type GridsNav } from "./grids-nav";
import { KIND_MARKS } from "./kind-marks";
import { frameMessages } from "./messages";

/** What the base page knows about its live state, for the screens inside the frame. */
type GridsLive = {
  /** The structure or access the page shows changed since it loaded. */
  changed: Accessor<boolean>;
  revoked: () => boolean;
  reload: () => Promise<void>;
  nav: GridsNav;
};

const GridsLiveContext = createContext<GridsLive>();

export const useGridsFrame = (): GridsLive => {
  const live = useContext(GridsLiveContext);
  if (!live) throw new Error("useGridsFrame needs a GridsFrame around it");
  return live;
};

/** What the switcher needs: the bases to switch to, and the templates and address of the dialog that makes one. */
export type GridsBases = BaseChoices & {
  templates: BaseTemplate[];
  /** The way the create dialog opens with (`?new=`), or null while it is closed. */
  create: string | null;
  /** Whether the person may make a base. */
  canCreate: boolean;
};

export type GridsFrameProps = {
  state: NavigationState;
  /** The switcher between bases at the top of the sidebar, and the dialog that makes a base. */
  bases?: GridsBases;
  /** The keys of what the page shows, for the revision check (`table:<id>`, `view:<id>`, …). */
  activeKeys: string[];
  revision?: WorkspaceRevision;
  head: JSX.Element;
  primary?: Action;
  detail?: true | number;
  detailEmpty?: { icon: string; text: string };
  children: JSX.Element;
};

/**
 * The frame of every v2 page of a base: the base's places in the sidebar and the phone's menu, the head and the
 * columns of the page, and the live state of the base's structure (`LiveNotice` shows it in the page's column).
 */
export default function GridsFrame(props: GridsFrameProps) {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const toast = useToast();
  const nav = createGridsNav(props.state);
  const [changed, setChanged] = createSignal(false);
  const reload = async () => {
    if (await Dialog.confirm({ title: t().reloadTitle, description: t().reloadDescription, confirm: t().reload, cancel: t().cancel }))
      window.location.reload();
  };
  onMount(() => {
    const stop = startWorkspaceMetadataRefresh(
      {
        baseId: props.state.base.id,
        initialCursor: props.state.liveCursor,
        revision: props.state.workspaceRevision,
        activeKeys: props.activeKeys,
        canWrite: props.state.canCreateTables,
        canAdmin: props.state.canManageBase,
        text: { accessRevoked: t().accessRevoked, liveMetadataFailed: t().liveMetadataFailed },
      },
      {
        changed: setChanged,
        // k2b-ui gap: a toast cannot stay until dismissed; v1 kept "live updates stopped" open with its reload.
        showFailure: () => toast(t().liveUpdatesStopped, { status: "bad", retry: () => window.location.reload() }),
        clearFailure: () => {},
        // as in v1: a form or dialog that was open closes with the access it needed
        revoked: () => dialogCore.close(),
      },
    );
    onCleanup(stop);
  });
  const live: GridsLive = { changed, revoked: () => workspaceLiveStatus().revoked, reload, nav };

  // The dialog that makes a base stands in the address (`?new=`) of the base's home, so reload and back keep it.
  const home = `/app/grids/${props.state.base.id}`;
  const here = () => (isServer ? home : `${location.pathname}${location.search}`);
  const [create, setCreate] = createSignal(props.bases?.create ?? null);
  const openCreate = (event: LinkNavigateEvent, way: string) => {
    event.push(withParam(here(), "new", way), { scroll: "manual" });
    setCreate(way);
  };
  const closeCreate = () => {
    history.replaceState(history.state, "", withParam(here(), "new", null));
    setCreate(null);
  };
  onMount(() => {
    const restore = () => setCreate(new URL(location.href).searchParams.get("new"));
    addEventListener("popstate", restore);
    onCleanup(() => removeEventListener("popstate", restore));
  });
  const way = (label: string, icon: string, start: string): Action => ({
    label,
    icon,
    href: withParam(home, "new", start),
    onNavigate: (event: LinkNavigateEvent) => openCreate(event, start),
  });
  const switcher = (bases: GridsBases): NavSwitcher => {
    const option = (group: string) => (base: { id: string; name: string }) => ({
      label: base.name,
      href: `/app/grids/${base.id}`,
      ...KIND_MARKS.base,
      group,
      current: base.id === props.state.base.id,
    });
    const template = bases.templates[0];
    return {
      label: t().switchBase,
      current: { label: props.state.base.name, ...KIND_MARKS.base },
      options: [...bases.recent.map(option(t().recentlyOpened)), ...bases.others.map(option(t().allBases))],
      search: t().searchBase,
      noMatch: t().noBaseMatches,
      more: (hidden) => t().moreBases({ count: hidden, formatted: new Intl.NumberFormat(locale()).format(hidden) }),
      actions: bases.canCreate
        ? [way(t().newBase, "plus", BLANK), ...(template ? [way(t().fromTemplate, "template", template.id)] : [])]
        : [],
    };
  };
  return (
    <GridsLiveContext.Provider value={live}>
      <V2WorkspaceNavigation
        label={props.state.base.name}
        groups={nav.groups()}
        foot={nav.foot()}
        switcher={props.bases ? switcher(props.bases) : undefined}
      />
      <Workspace
        sidebar={
          <Nav
            title={t().sidebar}
            icon="table"
            switcher={props.bases ? switcher(props.bases) : undefined}
            groups={nav.groups()}
            foot={nav.foot()}
          />
        }
        sidebarLabel={t().sidebarWidth}
        head={props.head}
        primary={props.primary}
        detail={props.detail}
        detailEmpty={props.detailEmpty}
      >
        {props.children}
      </Workspace>
      <Show when={props.bases}>{(bases) => <CreateBaseDialog start={create()} templates={bases().templates} onClose={closeCreate} />}</Show>
    </GridsLiveContext.Provider>
  );
}

/** The base's changed structure or revoked access, at the top of a page's column. */
export function LiveNotice() {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const live = useGridsFrame();
  return (
    <Show when={live.changed() || live.revoked()}>
      <Show
        when={live.revoked()}
        fallback={
          <Notice
            tone="warn"
            title={t().workspaceChanged}
            actions={[{ label: t().reload, icon: "refresh", onClick: () => void live.reload() }]}
          >
            {t().structureChanged}
          </Notice>
        }
      >
        <Notice tone="bad" title={t().accessDenied}>
          {t().accessRevoked}
        </Notice>
      </Show>
    </Show>
  );
}
