import { Button, dialogCore, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { createGridsMetadataEventsProvider } from "./grids-metadata-events-provider";
import { workspaceMessages } from "./messages";
import { setWorkspaceLiveStatus, workspaceLiveStatus } from "./workspace-live-state";
import { createWorkspaceRevisionController } from "./workspace-revision-controller";

export default function WorkspaceMetadataRefresh(props: {
  baseId: string;
  initialCursor: string | null;
  revision?: WorkspaceRevision;
  activeKeys: string[];
  canWrite: boolean;
  canAdmin: boolean;
}) {
  const locale = useLocale();
  const t = () => workspaceMessages.resolve([locale()]).t;
  const [changed, setChanged] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const reload = async () => {
    // Explicitly warn about both modal and full-page drafts. Existing native
    // beforeunload guards remain active; no synthetic unload event is needed.
    if (await prompts.confirm(t().reloadDraftWarning, { title: t().reload })) window.location.reload();
  };

  onMount(() => {
    let disposed = false;
    let revoked = false;
    const revoke = () => {
      if (disposed || revoked) return;
      revoked = true;
      controller.dispose();
      setWorkspaceLiveStatus({ blocked: true, revoked: true, message: t().accessRevoked });
      dialogCore.close();
      // Sidebar is SSR-owned: hide its resource labels along with island content.
      const workspace = document.getElementById(`grids-workspace-${props.baseId}`);
      if (workspace) workspace.style.display = "none";
    };
    const controller = createWorkspaceRevisionController({
      initial: { ...(props.revision ?? { revision: "", resources: {} }), canWrite: props.canWrite, canAdmin: props.canAdmin },
      activeKeys: props.activeKeys,
      load: async (signal) => {
        const response = await apiClient.workspace.revision.$get({ query: { baseId: props.baseId } }, { init: { signal } });
        if ([401, 403, 404].includes(response.status)) {
          revoke();
          throw new Error(t().accessRevoked);
        }
        if (!response.ok) throw new Error(t().liveMetadataFailed);
        return response.json();
      },
      apply: (state) => {
        if (revoked) return;
        setFailed(false);
        if (state.revoked) return revoke();
        setChanged(state.changed);
        setWorkspaceLiveStatus({ blocked: state.blocked, revoked: false, message: t().structureWriteBlocked });
      },
      markApplied: (cursor) => provider.markApplied(cursor),
      onError: () => setFailed(true),
    });
    const provider = createGridsMetadataEventsProvider({
      baseId: props.baseId,
      initialCursor: props.initialCursor,
      locale: locale(),
      onReady: controller.check,
      onEvent: controller.check,
      onError: (error) => controller.check(error.code === "resync_required" ? null : undefined),
      onRevoked: revoke,
      onFatal: () => {
        setFailed(true);
        controller.check();
      },
    });
    provider.connect();
    const applied = (raw: Event) => {
      const { baseId, key, revision } = (raw as CustomEvent<{ baseId: string; key: string; revision: string }>).detail;
      if (baseId !== props.baseId) return;
      controller.acknowledge(key, revision);
      controller.check();
    };
    document.addEventListener("grids:workspace-resource-applied", applied);
    // Detect missed best-effort publications, without reloading record data.
    const recheck = () => {
      if (!revoked && document.visibilityState === "visible") controller.check();
    };
    const timer = setInterval(recheck, 30_000);
    document.addEventListener("visibilitychange", recheck);
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", recheck);
      document.removeEventListener("grids:workspace-resource-applied", applied);
      controller.dispose();
      provider.dispose();
      setWorkspaceLiveStatus({ blocked: false, revoked: false, message: "" });
    });
  });

  return (
    <Show when={changed() || failed() || workspaceLiveStatus().revoked}>
      <div class="p-3" role="status">
        <NoticeCard
          icon="ti ti-refresh"
          title={workspaceLiveStatus().revoked ? t().accessDenied : failed() && !changed() ? t().liveMetadataFailed : t().workspaceChanged}
        >
          <p>
            {workspaceLiveStatus().revoked
              ? t().accessRevoked
              : workspaceLiveStatus().blocked
                ? t().structureWriteBlocked
                : failed()
                  ? t().liveUpdatesStoppedDetail
                  : t().structureChanged}
          </p>
          <Button variant="secondary" class="mt-3" onClick={() => void reload()}>
            {t().reload}
          </Button>
        </NoticeCard>
      </div>
    </Show>
  );
}
