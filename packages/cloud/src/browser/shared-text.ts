/** Browser-safe identity helpers; no server log, storage, or process state. */
export { captureTextAnchor, resolveTextAnchor } from "../shared-text/anchors";
export {
  captureTableAction,
  captureTableFocus,
  captureTableSource,
  prepareTableActionFocus,
  resolveTableFocus,
  type TableActionIntent,
  TableActionLimitError,
  TableActionRejectedError,
  type TableFocusWitness,
} from "../shared-text/table-actions";
export * from "./shared-text-document";
export { createSharedTextActionHistory, type SharedTextInverseRequest } from "./shared-text-history";
export { applyToYText, changesBetween, rebaseOnto } from "./shared-text-lazy";
export * from "./shared-text-offline";
export { openAuthorizedSharedTextOffline } from "./shared-text-offline-authorized";
export * from "./shared-text-provider";
export * from "./shared-text-table-contract";
