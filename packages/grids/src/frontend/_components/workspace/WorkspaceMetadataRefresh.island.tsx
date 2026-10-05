import { liveConnection } from "@k2b/cloud/browser/live";
import { retry } from "@k2b/sync/retry";
import { Button, dialogCore, NoticeCard, prompts, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { GridsMetadataLiveEventSchema } from "../../../live-events";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
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
    // Once live updates stopped, a later successful check cannot mean they are back.
    let liveEnded = false;
    // Live failures inform in a toast, so the workspace never moves; a later successful check dismisses it while the socket lives.
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
        if (!liveEnded) clearFailure();
        if (state.revoked) return revoke();
        setChanged(state.changed);
      },
      onError: showFailure,
    });
    // An update only says that the structure or access changed; the revision check decides what that means here.
    const subscription = liveConnection("/api/grids/live").subscribe(
      "metadata",
      { base: props.baseId },
      {
        cursor: props.initialCursor,
        parse: (data) => GridsMetadataLiveEventSchema.parse(data),
        apply: async () => controller.check(),
        resync: async () => controller.check(true),
        revoked: revoke,
        unavailable: () => {
          liveEnded = true;
          showFailure();
          controller.check();
        },
      },
    );
    // Short ids are unique across Bases, so no Base check is needed here.
    const applied = (raw: Event) => {
      const { key, revision } = (raw as CustomEvent<{ key: string; revision: string }>).detail;
      controller.acknowledge(key, revision);
      controller.check();
    };
    document.addEventListener(workspaceResourceAppliedEvent, applied);
    onCleanup(() => {
      disposed = true;
      document.removeEventListener(workspaceResourceAppliedEvent, applied);
      controller.dispose();
      subscription.close();
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
