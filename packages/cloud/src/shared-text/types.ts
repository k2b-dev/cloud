import type { SharedTextStructuralHistory } from "./structural-history";
export type SharedTextActor = { kind: "user" | "service_account"; id: string };

/** Actor is optional so events retained from older deployments remain readable. */
export type SharedTextEvent = {
  kind: "sync" | "awareness" | "freeze";
  payload: string;
  originNodeId: string;
  originPeerId: string | null;
  actor?: SharedTextActor;
  /** Echoed only by authorized server actions, for the initiating browser's undo history. */
  actionId?: string;
  /** Authored only by the server structural writer/admission boundary; retained with the event. */
  history?: SharedTextStructuralHistory;
  /** Updates apply only to the store lineage from which they originated. */
  restoreRevision?: string;
};
/** Ordered document events; a freeze marker carries no text update. */
export type SharedTextSyncEvent = SharedTextEvent & { kind: "sync" | "freeze" };
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
export type SharedTextSnapshot = SharedTextStoredState;
/** A disjoint edit in the original document's UTF-16 coordinates. */
export type SharedTextChange = {
  from: number;
  to: number;
  insert: string;
  /** Authorized identity fence: recreate a nonempty range even when its text is equal. */
  recreate?: true;
};

export type SharedTextActionReceipt = { actionId: string; update: Uint8Array };

export type SharedTextEditResult<Saved> =
  | { status: "notFound" }
  | { status: "unchanged"; text: string }
  | { status: "syncFailed"; error: unknown }
  | { status: "persistFailed"; cursor: string; error: unknown; receipt?: SharedTextActionReceipt }
  | { status: "edited"; text: string; cursor: string; saved: Saved; receipt?: SharedTextActionReceipt };

export type SharedTextStore<Saved, Context> = {
  load(docId: string, options: { signal?: AbortSignal }): Promise<SharedTextStoredState | null>;
  save(docId: string, input: SharedTextSaveInput, context: Context | undefined): Promise<Saved>;
};
