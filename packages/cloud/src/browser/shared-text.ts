/** Browser-safe identity helpers; no server log, storage, or process state. */
export { captureTextAnchor, resolveTextAnchor } from "../shared-text/anchors";
export { captureTableAction, type TableActionIntent, TableActionLimitError, TableActionRejectedError } from "../shared-text/table-actions";
export { createSharedTextActionHistory } from "./shared-text-history";
