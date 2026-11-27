import { Button, dialogCore, NoticeCard, prompts, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { workspaceMessages } from "./messages";
import { workspaceLiveStatus } from "./workspace-live-state";
import { startWorkspaceMetadataRefresh } from "./workspace-metadata-refresh";

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
    // Live failures inform in a toast, so the workspace never moves; a later successful check dismisses it while the socket lives.
    let failure: ToastHandle | null = null;
    const stop = startWorkspaceMetadataRefresh(
      { ...props, text: { accessRevoked: t().accessRevoked, liveMetadataFailed: t().liveMetadataFailed } },
      {
        changed: setChanged,
        showFailure: () => {
          failure = toast(t().liveUpdatesStoppedDetail, {
            title: t().liveUpdatesStopped,
            duration: 0,
            action: { label: t().reload, onClick: () => void reload() },
          });
        },
        clearFailure: () => {
          failure?.dismiss();
          failure = null;
        },
        revoked: () => {
          dialogCore.close();
          // Sidebar is SSR-owned: hide its resource labels along with island content.
          const workspace = document.getElementById(`grids-workspace-${props.baseId}`);
          if (workspace) workspace.style.display = "none";
        },
      },
    );
    onCleanup(stop);
  });

  return (
    <Show when={changed() || workspaceLiveStatus().revoked}>
      <div class="mb-[var(--ui-space-shell)] shrink-0" role="status">
        <NoticeCard tone="warning" title={workspaceLiveStatus().revoked ? t().accessDenied : t().workspaceChanged}>
          <p>{workspaceLiveStatus().revoked ? t().accessRevoked : t().structureChanged}</p>
          <Button variant="secondary" class="mt-3" onClick={() => void reload()}>
            {t().reload}
          </Button>
        </NoticeCard>
      </div>
    </Show>
  );
}
