import { logger } from "@k2b/cloud/services";
import { gridsService } from "../../../service";
import { gridsLive } from "../../../service/live";
import { loadWorkspaceRevision } from "../../../service/workspace-revision";
import { resolveWorkspaceMessages } from "./messages";
import { loadWorkspaceRequest } from "./workspace-request-state";
import { loadWorkspaceRoute } from "./workspace-route-state";
import type { GridsWorkspaceState, LoadWorkspaceParams } from "./workspace-state-model";

export type { GridsWorkspaceState } from "./workspace-state-model";

const log = logger("grids:workspace-state");

type WorkspaceStateDeps = {
  liveCursor: () => Promise<string | null>;
  loadRevision?: typeof loadWorkspaceRevision;
};

const defaultDeps: WorkspaceStateDeps = { liveCursor: gridsLive.cursor };

/** Without a cursor the page still renders; its live subscriptions start at the topic's position then. */
const loadLiveCursor = async (load: () => Promise<string | null>): Promise<string | null> => {
  try {
    return await load();
  } catch (error) {
    log.warn("Could not capture the workspace live cursor", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};

export const loadGridsWorkspaceState = async (
  params: LoadWorkspaceParams,
  deps: WorkspaceStateDeps = defaultDeps,
): Promise<GridsWorkspaceState> => {
  const t = resolveWorkspaceMessages(params.locale);
  const base = await gridsService.base.getByShortId(params.baseShortId);
  if (!base) return { kind: "notFound", title: t.notFound, message: t.baseNotFound };
  // Capture before loading the catalog: a concurrent schema edit must remain detectable.
  const liveCursor = await loadLiveCursor(deps.liveCursor);
  const revision = await (deps.loadRevision ?? loadWorkspaceRevision)(base.id);
  const request = await loadWorkspaceRequest(params, base, liveCursor);
  if ("kind" in request) return request;
  const state = await loadWorkspaceRoute(request);
  return state.kind === "ok" ? { ...state, workspaceRevision: revision } : state;
};
