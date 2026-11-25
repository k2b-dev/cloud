import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Dialog, Nav, Notice, useToast, Workspace } from "@k2b/ui/v2";
import { type Accessor, createContext, createSignal, type JSX, onCleanup, onMount, Show, useContext } from "solid-js";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import type { NavigationState } from "../workspace/navigation-catalog";
import { workspaceLiveStatus } from "../workspace/workspace-live-state";
import { startWorkspaceMetadataRefresh } from "../workspace/workspace-metadata-refresh";
import { createGridsNav, type GridsNav } from "./grids-nav";
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

export type GridsFrameProps = {
  state: NavigationState;
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
        revoked: () => {},
      },
    );
    onCleanup(stop);
  });
  const live: GridsLive = { changed, revoked: () => workspaceLiveStatus().revoked, reload, nav };
  return (
    <GridsLiveContext.Provider value={live}>
      <V2WorkspaceNavigation label={props.state.base.name} groups={nav.groups()} foot={nav.foot()} />
      <Workspace
        sidebar={<Nav title={t().sidebar} icon="table" groups={nav.groups()} foot={nav.foot()} />}
        sidebarLabel={t().sidebarWidth}
        head={props.head}
        primary={props.primary}
        detail={props.detail}
        detailEmpty={props.detailEmpty}
      >
        {props.children}
      </Workspace>
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
