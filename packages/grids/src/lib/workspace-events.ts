const GRIDS_STREAM_CURSOR_PATTERN = /^s6t\.[a-zA-Z0-9_-]+\.\d+$/;

export const isGridsStreamCursor = (value: unknown): value is string =>
  typeof value === "string" && GRIDS_STREAM_CURSOR_PATTERN.test(value);

export const gridsWorkspace = {
  wsType: {
    recordsSubscribe: "grids.records.subscribe",
    recordsReady: "grids.records.ready",
    recordsEvent: "grids.records.event",
    recordsError: "grids.records.error",
    recordsRevoked: "grids.records.revoked",
    metadataSubscribe: "grids.metadata.subscribe",
    metadataReady: "grids.metadata.ready",
    metadataEvent: "grids.metadata.event",
    metadataError: "grids.metadata.error",
    metadataRevoked: "grids.metadata.revoked",
    workflowRunsSubscribe: "grids.workflow-runs.subscribe",
    workflowRunsReady: "grids.workflow-runs.ready",
    workflowRunsEvent: "grids.workflow-runs.event",
    workflowRunsError: "grids.workflow-runs.error",
    workflowRunsRevoked: "grids.workflow-runs.revoked",
  },
  streamCursorPattern: GRIDS_STREAM_CURSOR_PATTERN,
} as const;
