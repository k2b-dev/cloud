import type { PublicField as Field } from "../../../api/public-dto";
import type { CardSize } from "./query-url";

/**
 * The records page has two islands: the head's search and actions (in the workspace head, K6) and the records view
 * below it, which owns the query, the selection, and the dialogs. They talk through window events scoped to the table,
 * so neither imports the other's state and each hydrates on its own. The view keeps the last status on `globalThis`,
 * so a head that hydrates later starts from the view's current state.
 */
/** `?new=1` on a table page opens its create flow; the head's main action links there and the records view takes it over. */
export const NEW_RECORD_PARAM = "new";

export type RecordsHeadStatus = {
  /** Records are loading or reconciling; the search icon turns into a spinner. */
  busy: boolean;
  search: { q: string; fieldIds: string[] };
  searchableFields: Field[];
  /** Chosen records for bulk workflows. */
  selectedCount: number;
  /** A bulk workflow is being prepared. */
  queueing: boolean;
  /** A live reconciliation failed and waits for a person; `running` while the refresh loads. */
  refresh: { needed: boolean; running: boolean };
  /** The card size while the records show as cards; `null` in every other display. */
  cardSize: CardSize | null;
  /** The current query can be saved as a view; `saving` while it is. `null` when there is nothing to save. */
  saveView: { saving: boolean } | null;
};

export type RecordsHeadCommand =
  | { kind: "search"; q: string; fieldIds: string[] }
  | { kind: "metadata" }
  | { kind: "export" }
  | { kind: "audit" }
  | { kind: "workflow"; launcherId: string }
  | { kind: "refresh" }
  | { kind: "cardSize"; size: CardSize }
  | { kind: "saveView" };

const COMMAND = "grids:records-head-command";
const STATUS = "grids:records-head-status";
type Detail<T> = { tableId: string; value: T };
const lastStatus = (): Map<string, RecordsHeadStatus> => {
  const scope = globalThis as { __gridsRecordsHeadStatus?: Map<string, RecordsHeadStatus> };
  scope.__gridsRecordsHeadStatus ??= new Map();
  return scope.__gridsRecordsHeadStatus;
};

const listen = <T>(name: string, tableId: string, handler: (value: T) => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Detail<T>>).detail;
    if (detail?.tableId === tableId) handler(detail.value);
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
};

const send = <T>(name: string, tableId: string, value: T) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Detail<T>>(name, { detail: { tableId, value } }));
};

/** The head asks the records view to search or to open one of its dialogs. */
export const sendRecordsHeadCommand = (tableId: string, command: RecordsHeadCommand) => send(COMMAND, tableId, command);
export const onRecordsHeadCommand = (tableId: string, handler: (command: RecordsHeadCommand) => void) => listen(COMMAND, tableId, handler);

/** The records view tells the head what it shows. */
export const publishRecordsHeadStatus = (tableId: string, status: RecordsHeadStatus) => {
  lastStatus().set(tableId, status);
  send(STATUS, tableId, status);
};
/** The view leaves (another page, a new view of the same table): a head that hydrates next starts from its own props. */
export const forgetRecordsHeadStatus = (tableId: string) => {
  lastStatus().delete(tableId);
};
export const onRecordsHeadStatus = (tableId: string, handler: (status: RecordsHeadStatus) => void) => {
  const known = lastStatus().get(tableId);
  if (known) handler(known);
  return listen(STATUS, tableId, handler);
};
