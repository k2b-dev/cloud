export type SharedTextActor = { kind: "user" | "service_account"; id: string };

/** Actor is optional so events retained from older deployments remain readable. */
export type SharedTextEvent = {
  kind: "sync" | "awareness";
  payload: string;
  originNodeId: string;
  originPeerId: string | null;
  actor?: SharedTextActor;
};
export type SharedTextSyncEvent = SharedTextEvent & { kind: "sync" };
export type SharedTextContributor = SharedTextActor & { lastContributedAt: Date };

/** The store anchors legacy cursors to this log before returning a snapshot. */
export type SharedTextStoredState = {
  state: Uint8Array | null;
  cursor: string | null;
  restoreRevision: string;
  text: string | null;
};
export type SharedTextSaveInput = {
  state: Uint8Array;
  text: string;
  cursor: string;
  restoreRevision: string;
  requestedAt: number;
  actor: SharedTextActor | null;
  contributors: SharedTextContributor[];
};
export type SharedTextSnapshot = { state: Uint8Array | null; text: string | null; cursor: string | null };
/** A disjoint edit in the original document's UTF-16 coordinates. */
export type SharedTextChange = { from: number; to: number; insert: string };

export type SharedTextEditResult<Saved> =
  | { status: "notFound" }
  | { status: "unchanged"; text: string }
  | { status: "syncFailed"; error: unknown }
  | { status: "persistFailed"; cursor: string; error: unknown }
  | { status: "edited"; text: string; cursor: string; saved: Saved };

export type SharedTextStore<Saved, Context> = {
  load(docId: string, options: { signal?: AbortSignal }): Promise<SharedTextStoredState | null>;
  save(docId: string, input: SharedTextSaveInput, context: Context | undefined): Promise<Saved>;
};
