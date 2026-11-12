export { captureTextAnchor, resolveTextAnchor } from "./anchors";
export { createTrustedTextAwareness, InvalidSharedTextAwarenessError } from "./awareness";
export { compareStreamCursor, maxStreamCursor, parseStreamCursor } from "./cursor";
export {
  applySharedTextEvent,
  fromBase64,
  isValidSharedTextUpdate,
  MalformedSharedTextEventError,
  SHARED_TEXT_NAME,
  sharedTextNodeId,
  toBase64,
} from "./events";
export { sharedText } from "./log";
export {
  createSharedTextRoom,
  createSharedTextRoomContext,
  isSharedTextStorageExhausted,
  type SharedTextRoomAccess,
  type SharedTextRoomAdapter,
  type SharedTextRoomContext,
  type SharedTextRoomMessages,
  type SharedTextRoomSnapshot,
  type SharedTextRoomSocket,
} from "./room";
export {
  createSharedTextRoomSchemas,
  SHARED_TEXT_ROOM_ERROR_CODE,
  SharedTextRestoreRevisionSchema,
  type SharedTextRoomProtocol,
} from "./room-protocol";
export type { SharedTextSnapshotBacklog, SharedTextSnapshotRepair, SharedTextSnapshotRequest, SharedTextSnapshotStore } from "./snapshots";
export { sharedTextSnapshotJobConfig } from "./snapshots";
export { planStructuralInverse, type SharedTextStructuralHistory, validateStructuralIngress } from "./structural-history";
export {
  captureTableAction,
  captureTableFocus,
  captureTableSource,
  planTableAction,
  prepareTableActionFocus,
  resolveTableFocus,
  type TableActionIntent,
  TableActionLimitError,
  TableActionRejectedError,
  type TableFocusWitness,
} from "./table-actions";
export * from "./types";
