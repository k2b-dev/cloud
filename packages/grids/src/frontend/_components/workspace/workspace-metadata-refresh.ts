import { liveConnection } from "@k2b/cloud/browser/live";
import { retry } from "@k2b/sync/retry";
import { apiClient } from "../../../api/client";
import { GridsMetadataLiveEventSchema } from "../../../live-events";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { setWorkspaceLiveStatus, workspaceResourceAppliedEvent } from "./workspace-live-state";
import { createWorkspaceRevisionController } from "./workspace-revision-controller";

export type WorkspaceMetadataRefreshOptions = {
  baseId: string;
  initialCursor: string | null;
  revision?: WorkspaceRevision;
  activeKeys: string[];
  canWrite: boolean;
  canAdmin: boolean;
  /** Words for a revoked access and a failed revision check, in the page's language. */
  text: { accessRevoked: string; liveMetadataFailed: string };
};

/** What the page shows for the workspace's live state; v1 and v2 screens render it their own way. */
export type WorkspaceMetadataRefreshView = {
  /** The structure or access the page shows changed: offer a reload. */
  changed: (changed: boolean) => void;
  /** Live updates stopped or a check keeps failing: say so without moving the page, with a way to reload. */
  showFailure: () => void;
  clearFailure: () => void;
  /** Access was revoked: hide the workspace's content and close open dialogs. */
  revoked: () => void;
};

/**
 * Follows the base's structure and access while the page is open: the metadata live channel says that something
 * changed, a revision check (retried briefly) decides what that means for the page. Returns the cleanup.
 */
export function startWorkspaceMetadataRefresh(options: WorkspaceMetadataRefreshOptions, view: WorkspaceMetadataRefreshView): () => void {
  let disposed = false;
  let revoked = false;
  // Once live updates stopped, a later successful check cannot mean they are back.
  let liveEnded = false;
  let failing = false;
  const showFailure = () => {
    if (disposed || revoked || failing) return;
    failing = true;
    view.showFailure();
  };
  const clearFailure = () => {
    if (!failing) return;
    failing = false;
    view.clearFailure();
  };
  const revoke = () => {
    if (disposed || revoked) return;
    revoked = true;
    clearFailure();
    controller.dispose();
    setWorkspaceLiveStatus({ revoked: true, message: options.text.accessRevoked });
    view.revoked();
  };
  const controller = createWorkspaceRevisionController({
    initial: { ...(options.revision ?? { revision: "", resources: {} }), canWrite: options.canWrite, canAdmin: options.canAdmin },
    activeKeys: options.activeKeys,
    // A check that fails briefly (for example while the network returns with the tab) is retried before it counts as a failure.
    load: (signal) =>
      retry({
        signal,
        run: async () => {
          const response = await apiClient.workspace.revision.$get({ query: { baseId: options.baseId } }, { init: { signal } });
          if ([401, 403, 404].includes(response.status)) {
            revoke();
            throw new Error(options.text.accessRevoked);
          }
          if (!response.ok) throw new Error(options.text.liveMetadataFailed);
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
      view.changed(state.changed);
    },
    onError: showFailure,
  });
  // An update only says that the structure or access changed; the revision check decides what that means here.
  // Each check compares the whole revision with the page's, so a later check covers every update acknowledged
  // before it, and a check that keeps failing shows the failure.
  const subscription = liveConnection("/api/grids/live").subscribe(
    "metadata",
    { base: options.baseId },
    {
      cursor: options.initialCursor,
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
  // Without the page's cursor the subscription starts at the current position, so the revision is checked once.
  if (options.initialCursor === null) controller.check();
  // Short ids are unique across Bases, so no Base check is needed here.
  const applied = (raw: Event) => {
    const { key, revision } = (raw as CustomEvent<{ key: string; revision: string }>).detail;
    controller.acknowledge(key, revision);
    controller.check();
  };
  document.addEventListener(workspaceResourceAppliedEvent, applied);
  return () => {
    disposed = true;
    document.removeEventListener(workspaceResourceAppliedEvent, applied);
    controller.dispose();
    subscription.close();
    clearFailure();
    setWorkspaceLiveStatus({ revoked: false, message: "" });
  };
}
