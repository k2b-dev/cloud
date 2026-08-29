import { logger } from "@valentinkolb/cloud/services";
import { gridsService } from "../../../service";
import { latestMetadataEventCursor } from "../../../service/metadata-events";
import { latestRecordEventCursor } from "../../../service/record-events";
import { resolveWorkspaceMessages } from "./messages";
import { loadWorkspaceRequest } from "./workspace-request-state";
import { loadWorkspaceRoute } from "./workspace-route-state";
import type { GridsWorkspaceState, LoadWorkspaceParams } from "./workspace-state-model";

export type { GridsWorkspaceState } from "./workspace-state-model";

const log = logger("grids:workspace-state");

type WorkspaceStateDeps = {
  latestMetadataEventCursor: (baseId: string) => Promise<string | null>;
  latestRecordEventCursor: (baseId: string) => Promise<string | null>;
};

const defaultDeps: WorkspaceStateDeps = {
  latestMetadataEventCursor,
  latestRecordEventCursor,
};

const loadEventCursor = async (stream: "metadata" | "records", load: () => Promise<string | null>): Promise<string | null> => {
  try {
    return await load();
  } catch (error) {
    log.warn("Could not capture workspace event cursor", {
      stream,
      error: error instanceof Error ? error.message : String(error),
    });
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
  const [metadataCursor, recordCursor] = await Promise.all([
    loadEventCursor("metadata", () => deps.latestMetadataEventCursor(base.id)),
    loadEventCursor("records", () => deps.latestRecordEventCursor(base.id)),
  ]);
  const request = await loadWorkspaceRequest(params, base, { metadata: metadataCursor, records: recordCursor });
  if ("kind" in request) return request;
  return loadWorkspaceRoute(request);
};
