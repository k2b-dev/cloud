import { retry } from "@k2b/sync/retry";
import { Button, dialogCore, NoticeCard, prompts, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { createGridsMetadataEventsProvider } from "./grids-metadata-events-provider";
import { workspaceMessages } from "./messages";
import { setWorkspaceLiveStatus, workspaceLiveStatus, workspaceResourceAppliedEvent } from "./workspace-live-state";
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
  const reload = async () => {
    // Explicitly warn about both modal and full-page drafts. Existing native
    // beforeunload guards remain active; no synthetic unload event is needed.
    if (await prompts.confirm(t().reloadDraftWarning, { title: t().reload })) window.location.reload();
  };

  onMount(() => {
    let disposed = false;
    let revoked = false;
    // Live failures inform in a toast, so the workspace never moves; a later successful check dismisses it.
    let failure: ToastHandle | null = null;
    const showFailure = () => {
      if (disposed || revoked || failure) return;
      failure = toast(t().liveUpdatesStoppedDetail, {
        title: t().liveUpdatesStopped,
        duration: 0,
        action: { label: t().reload, onClick: () => void reload() },
      });
    };
    const clearFailure = () => {
      failure?.dismiss();
      failure = null;
    };
    const revoke = () => {
      if (disposed || revoked) return;
      revoked = true;
      clearFailure();
      controller.dispose();
      setWorkspaceLiveStatus({ revoked: true, message: t().accessRevoked });
      dialogCore.close();
      // Sidebar is SSR-owned: hide its resource labels along with island content.
      const workspace = document.getElementById(`grids-workspace-${props.baseId}`);
      if (workspace) workspace.style.display = "none";
    };
    const controller = createWorkspaceRevisionController({
      initial: { ...(props.revision ?? { revision: "", resources: {} }), canWrite: props.canWrite, canAdmin: props.canAdmin },
      activeKeys: props.activeKeys,
      // A check that fails briefly (for example while the network returns with the tab) is retried before it counts as a failure.
      load: (signal) =>
        retry({
          signal,
          run: async () => {
            const response = await apiClient.workspace.revision.$get({ query: { baseId: props.baseId } }, { init: { signal } });
            if ([401, 403, 404].includes(response.status)) {
              revoke();
              throw new Error(t().accessRevoked);
            }
            if (!response.ok) throw new Error(t().liveMetadataFailed);
            return response.json();
          },
          after: ({ ctx }) => {
            if (ctx.error && !revoked && ctx.attempt < 3) ctx.reschedule({ delayMs: ctx.expBackoff({ baseMs: 150, maxMs: 1_000 }) });
          },
        }),
      apply: (state) => {
        if (revoked) return;
        clearFailure();
        if (state.revoked) return revoke();
        setChanged(state.changed);
      },
      markApplied: (cursor) => provider.markApplied(cursor),
      onError: showFailure,
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
        showFailure();
        controller.check();
      },
    });
    provider.connect();
    // Short ids are unique across Bases, so no Base check is needed here.
    const applied = (raw: Event) => {
      const { key, revision } = (raw as CustomEvent<{ key: string; revision: string }>).detail;
      controller.acknowledge(key, revision);
      controller.check();
    };
    document.addEventListener(workspaceResourceAppliedEvent, applied);
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
      document.removeEventListener(workspaceResourceAppliedEvent, applied);
      controller.dispose();
      provider.dispose();
      clearFailure();
      setWorkspaceLiveStatus({ revoked: false, message: "" });
    });
  });

  return (
    <Show when={changed() || workspaceLiveStatus().revoked}>
      <div class="mb-[var(--ui-space-shell)] shrink-0" role="status">
        <NoticeCard icon="ti ti-refresh" title={workspaceLiveStatus().revoked ? t().accessDenied : t().workspaceChanged}>
          <p>{workspaceLiveStatus().revoked ? t().accessRevoked : t().structureChanged}</p>
          <Button variant="secondary" class="mt-3" onClick={() => void reload()}>
            {t().reload}
          </Button>
        </NoticeCard>
      </div>
    </Show>
  );
}
