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
export { createSharedTextActionHistory, type SharedTextInverseRequest } from "./shared-text-history";
