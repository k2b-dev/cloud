/**
 * F3 A table structure for the Mail editor: typing and appending a row stay
 * local; every other table action runs on the server against fixed character
 * anchors. The live stream is the only path that applies the result.
 */
import {
  captureTableAction,
  captureTableFocus,
  captureTableSource,
  decodeTableFocus,
  type EncodedTableActionIntent,
  type EncodedTableFocus,
  encodeTableFocus,
  resolveTableFocus,
  type SharedTextInverseRequest,
  type TableActionIntent,
  type TableFocusWitness,
  TextTableFocusSchema,
} from "@k2b/cloud/browser/shared-text";
import { encoding } from "@k2b/stdlib";
import type { MenuAction, TableFocusTarget, TableHost, TableTarget } from "@k2b/ui/text-editor";
import type * as Y from "yjs";

type MailTableActionRequest = {
  generation: string;
  actionId: string;
  intent: EncodedTableActionIntent;
  focus?: EncodedTableFocus;
  caret?: { row: number; column: number };
};

/** Same UTF-16 limit as the public shared table contract. */
export const MAIL_EDITOR_MAX_LENGTH = 2_097_152;

type PendingAction = { applied: Promise<void>; cancel: (reason: unknown) => void };
export type TableStructureProvider = {
  canStructure: () => boolean;
  generation: () => string | null;
  beginAction: (actionId: string) => PendingAction;
  setInverseHandler: (handler: (request: SharedTextInverseRequest) => Promise<void>) => void;
};
/** The parts of the typed API response the outcome depends on. */
export type TableActionResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
/** A table action whose publication the server could not confirm or deny. */
export type UnknownTableAction = { message: string | null; stopWaiting: () => void };

const encodeIntent = (intent: TableActionIntent): EncodedTableActionIntent => {
  const base64 = encoding.toBase64;
  const table = { headerBreak: base64(intent.table.headerBreak), separatorHyphen: base64(intent.table.separatorHyphen) };
  if ("source" in intent) return { action: intent.action, table, expected: intent.expected, source: intent.source };
  if (!("row" in intent) && !("column" in intent)) return { action: intent.action, table };
  const encodeRow = (row: Extract<TableActionIntent, { row: unknown }>["row"]) =>
    row.kind === "header"
      ? row
      : { kind: "body" as const, beforeBreak: base64(row.beforeBreak), inside: base64(row.inside), insideKind: row.insideKind };
  const encodeColumn = (column: Extract<TableActionIntent, { column: unknown }>["column"]) => ({
    hyphen: base64(column.hyphen),
    left: base64(column.left),
    right: base64(column.right),
  });
  if ("row" in intent) {
    const row = encodeRow(intent.row);
    return "neighbor" in intent
      ? { action: intent.action, table, row, neighbor: encodeRow(intent.neighbor) }
      : { action: intent.action, table, row };
  }
  const column = encodeColumn(intent.column);
  return "neighbor" in intent
    ? { action: intent.action, table, column, neighbor: encodeColumn(intent.neighbor) }
    : { action: intent.action, table, column };
};

const readFocus = (value: unknown): TableFocusWitness | null => {
  const parsed = TextTableFocusSchema.safeParse(value);
  return parsed.success ? decodeTableFocus(parsed.data) : null;
};

type Outcome =
  | { kind: "applied"; focus: TableFocusWitness | null }
  | { kind: "unchanged" }
  | { kind: "accepted"; message: string | null; focus: TableFocusWitness | null }
  | { kind: "rejected"; message: string | null }
  | { kind: "unknown"; message: string | null };

/** Reads the documented responses; anything else with a 5xx status may have been published. */
const outcomeOf = async (response: TableActionResponse): Promise<Outcome> => {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An unreadable body only loses the message; the status still decides.
  }
  const record = body && typeof body === "object" ? Object.fromEntries(Object.entries(body)) : {};
  const message = typeof record.message === "string" && record.message ? record.message : null;
  // An HTTP 200 can describe an UNKNOWN publication. Never treat changed:false as proof of rejection.
  if (record.accepted === null) return { kind: "unknown", message };
  if (response.ok && record.accepted === false && record.changed === false) return { kind: "unchanged" };
  if (record.accepted === true) return { kind: "accepted", message, focus: readFocus(record.focus) };
  if (record.accepted === false) return { kind: "rejected", message };
  if (response.ok && record.changed === true) return { kind: "applied", focus: readFocus(record.focus) };
  // Validation, access and routing failures happen before the action runs.
  return response.status < 500 ? { kind: "rejected", message } : { kind: "unknown", message };
};

export const createMailDraftTableStructure = (options: {
  ytext: Y.Text;
  provider: TableStructureProvider;
  /** Makes `available` reactive for the menu, e.g. a signal bumped on provider changes. */
  track?: () => unknown;
  post: (request: MailTableActionRequest) => Promise<TableActionResponse>;
  /** Shows a server message, or `fallback` when it sent none. */
  notify: (message: string) => void;
  fallback: () => string;
  onUnknown: (action: UnknownTableAction | null) => void;
}): NonNullable<TableHost["structure"]> & {
  replaceSource: (
    target: TableTarget,
    expected: string,
    source: string,
    caret?: { row: number; column: number },
  ) => Promise<TableFocusTarget | void>;
} => {
  options.provider.setInverseHandler(async (request) => {
    const generation = options.provider.generation();
    if (generation === null) throw new Error("Table structure is unavailable");
    let outcome: Outcome;
    try {
      outcome = await outcomeOf(
        await options.post({
          generation,
          actionId: request.actionId,
          intent: { action: request.action, receiptCursor: request.receiptCursor },
        }),
      );
    } catch {
      outcome = { kind: "unknown", message: null };
    }
    if (outcome.kind === "rejected" || outcome.kind === "unchanged") {
      const message = "message" in outcome ? outcome.message : null;
      options.notify(message ?? options.fallback());
      throw new Error(message ?? "The structural history target is unavailable");
    }
    if (outcome.kind === "unknown") {
      options.onUnknown({ message: outcome.message, stopWaiting: () => request.cancel(new Error("Stopped waiting for the table action")) });
      await request.applied.finally(() => options.onUnknown(null));
    } else if (outcome.kind === "accepted" && outcome.message) options.notify(outcome.message);
  });
  const perform = (
    intent: EncodedTableActionIntent,
    target: TableTarget,
    preserveDraft = false,
    caret?: { row: number; column: number },
  ) => {
    let focus: EncodedTableFocus | undefined;
    try {
      focus = encodeTableFocus(captureTableFocus(options.ytext, target));
    } catch {
      /* Extra cells may not yet have a separator identity. */
    }
    const generation = options.provider.generation();
    if (!options.provider.canStructure() || generation === null) throw new Error("Table structure is unavailable");

    const actionId = crypto.randomUUID();
    const pending = options.provider.beginAction(actionId);
    const settle = async () => {
      let outcome: Outcome;
      try {
        outcome = await outcomeOf(await options.post({ generation, actionId, intent, focus, caret }));
      } catch {
        outcome = { kind: "unknown", message: null };
      }
      switch (outcome.kind) {
        case "unchanged":
          pending.cancel(new Error("The table action changed nothing"));
          return;
        case "rejected":
          pending.cancel(new Error(outcome.message ?? "Rejected table action"));
          options.notify(outcome.message ?? options.fallback());
          if (preserveDraft) throw new Error(outcome.message ?? "Rejected table source");
          return;
        case "accepted":
          // Published although saving failed: the stream still brings the change.
          if (outcome.message) options.notify(outcome.message);
          break;
        case "unknown": {
          // Never resubmit: the first request may still arrive on the stream.
          const unknown: UnknownTableAction = {
            message: outcome.message,
            stopWaiting: () => pending.cancel(new Error("Stopped waiting for the table action")),
          };
          options.onUnknown(unknown);
          try {
            if (preserveDraft) await pending.applied;
            else await pending.applied.catch(() => {});
          } finally {
            options.onUnknown(null);
          }
          return;
        }
      }
      // A closed or terminated connection reports itself; the editor keeps the text.
      if (preserveDraft) await pending.applied;
      else {
        try {
          await pending.applied;
        } catch {
          return;
        }
      }
      if ((outcome.kind === "applied" || outcome.kind === "accepted") && outcome.focus) {
        const witness = outcome.focus;
        return () => resolveTableFocus(options.ytext, witness);
      }
    };
    return settle();
  };
  return {
    available: () => {
      options.track?.();
      return options.provider.canStructure();
    },
    perform: (action: MenuAction, target: TableTarget) => perform(encodeIntent(captureTableAction(options.ytext, action, target)), target),
    replaceSource: (target, expected, source, caret) =>
      perform(encodeIntent(captureTableSource(options.ytext, target, expected, source)), target, true, caret),
  };
};
