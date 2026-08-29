import { useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { createDeferredWorkspaceReload } from "./deferred-workspace-reload";
import { createGridsMetadataEventsProvider } from "./grids-metadata-events-provider";
import { notifyWorkspaceLiveUpdateFailure } from "./live-update-feedback";

export default function WorkspaceMetadataRefresh(props: { baseId: string; initialCursor: string | null }) {
  const locale = useLocale();

  onMount(() => {
    const refresh = createDeferredWorkspaceReload(() => window.location.reload());
    let connectedOnce = false;
    const provider = createGridsMetadataEventsProvider({
      baseId: props.baseId,
      initialCursor: props.initialCursor,
      locale: locale(),
      onReady: () => {
        if (connectedOnce) refresh.schedule();
        connectedOnce = true;
      },
      onEvent: (cursor) => {
        provider.markApplied(cursor);
        refresh.schedule();
      },
      onRevoked: refresh.reloadNow,
      onFatal: (error) => notifyWorkspaceLiveUpdateFailure("metadata", error),
    });
    provider.connect();

    onCleanup(() => {
      refresh.dispose();
      provider.dispose();
    });
  });

  return null;
}
