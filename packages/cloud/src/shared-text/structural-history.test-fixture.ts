import { expect } from "bun:test";
import type { MenuAction } from "@k2b/ui/text-editor";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { createSharedTextActionHistory } from "../browser/shared-text-history";
import { bindDocuments, createDoc } from "./documents";
import { applySharedTextEvent, fromBase64, SHARED_TEXT_NAME } from "./events";
import { captureTableAction, planTableAction } from "./table-actions";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

export const createStructuralFixture = (source = "| Header |\n| --- |\n| Original |") => {
  let stored: SharedTextStoredState = { text: source, state: null, cursor: null, restoreRevision: "0" };
  const events: { cursor: string; data: SharedTextSyncEvent }[] = [];
  const sequence = (value: string | null) => (value ? Number(value.split(".").at(-1)) : 0);
  const handle = {
    latestCursor: async () => events.at(-1)?.cursor ?? null,
    publish: async ({ expectedAfter, data }: { expectedAfter?: string | null; data: SharedTextSyncEvent }) => {
      if (expectedAfter !== undefined) expect(expectedAfter).toBe(events.at(-1)?.cursor ?? null);
      const cursor = `s6t.history.${events.length + 1}`;
      events.push({ cursor, data });
      return { cursor, eventId: cursor, messageId: cursor, streamSequence: events.length, duplicate: false };
    },
  };
  const log = {
    topic: () => handle,
    replay: async ({
      doc,
      after,
      until,
      docId,
      restoreRevision,
    }: {
      doc: Y.Doc;
      after: string | null;
      until: string;
      docId: string;
      restoreRevision?: string;
    }) => {
      for (const event of events.slice(sequence(after), sequence(until))) applySharedTextEvent(doc, event, docId, restoreRevision);
      return [];
    },
    async *events(_docId: string, after: string | null, until: string) {
      const selected =
        after === until ? events.slice(sequence(until) - 1, sequence(until)) : events.slice(sequence(after), sequence(until));
      if (!selected.length) throw new Error("Expired receipt");
      yield* selected;
    },
  };
  const store = {
    load: async () => stored,
    save: async (_id: string, input: SharedTextStoredState) => {
      stored = input;
    },
  };
  // Rebind/reload after every call: no server manager or process-local receipt
  // state participates in validation, Undo, Redo or closed-author delivery.
  const documents = () => bindDocuments(log, store);
  const replicas = [101, 202].map((clientID) => {
    const doc = createDoc(stored);
    doc.clientID = clientID;
    const text = doc.getText(SHARED_TEXT_NAME);
    const manager = new Y.UndoManager(text, { captureTimeout: 0 });
    let hints = 0;
    const history = createSharedTextActionHistory(doc, manager, undefined, () => hints++);
    return {
      doc,
      text,
      manager,
      history,
      hints: () => hints,
      actor: { kind: "user" as const, id: String(clientID) },
      cursor: null as string | null,
      recovery: [] as { update: Uint8Array; text: string; baseCursor: string | null }[],
    };
  });
  type Replica = (typeof replicas)[number];
  const deliver = (replica: Replica) => {
    for (const event of events.slice(sequence(replica.cursor))) {
      replica.history.apply(fromBase64(event.data.payload), event.data.actionId, event.cursor, event.data.history?.retained);
      replica.cursor = event.cursor;
    }
  };
  let serial = 0;
  for (const replica of replicas)
    replica.history.setInverseHandler(async (request) => {
      await documents().inverse("fixture", {
        actor: replica.actor,
        actionId: request.actionId,
        receiptCursor: request.receiptCursor,
        restoreRevision: "0",
        maxLength: 2_097_152,
      });
      deliver(replica);
    });
  const action = async (replica: Replica, name: MenuAction, column = 0, broadcast = true, row = 1) => {
    const table = T.findTables(replica.text.toString())[0]!;
    const intent = captureTableAction(replica.text, name, {
      tableFrom: table.from,
      row,
      column,
      rowFrom: T.gridLine(table, row)!.from,
      columnFrom: table.lines[0]!.cells[column]!.from,
    });
    const actionId = `action-${++serial}`;
    const pending = replica.history.begin(actionId);
    const result = await documents().change("fixture", { actor: replica.actor, actionId, maxLength: 2_097_152 }, (current) => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, current.state());
        return planTableAction(doc.getText(SHARED_TEXT_NAME), intent, 2_097_152);
      } finally {
        doc.destroy();
      }
    });
    expect(result.status).toBe("edited");
    for (const target of broadcast ? replicas : [replica]) deliver(target);
    await pending.applied;
    return events.at(-1)!;
  };
  const accept = async (replica: Replica, update = Y.encodeStateAsUpdate(replica.doc), baseCursor = replica.cursor) => {
    const result = await documents().accept("fixture", {
      actor: replica.actor,
      update,
      baseCursor,
      restoreRevision: "0",
      originNodeId: "fixture",
      originPeerId: null,
    });
    if (result.status === "accepted") for (const target of replicas) deliver(target);
    else replica.recovery.push({ update, baseCursor, text: replica.text.toString() });
    return result;
  };
  return {
    own: replicas[0]!,
    peer: replicas[1]!,
    replicas,
    action,
    accept,
    deliver,
    documents,
    events,
    stored: () => stored,
    canonical: async () => (await documents().read("fixture"))!,
    destroy() {
      for (const replica of replicas) {
        if (!replica.doc.isDestroyed) {
          replica.history.dispose();
          replica.manager.destroy();
          replica.doc.destroy();
        }
      }
    },
  };
};
