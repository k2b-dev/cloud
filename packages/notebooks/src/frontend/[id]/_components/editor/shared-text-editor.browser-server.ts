/** Test-only server half: production planners and provenance, isolated per browser fixture. */
import * as Y from "yjs";
import { z } from "zod";
import {
  planStructuralInverse,
  prepareStructuralHistory,
  type SharedTextStructuralHistory,
} from "../../../../../../cloud/src/shared-text/structural-history";
import { planTableAction, prepareTableActionFocus } from "../../../../../../cloud/src/shared-text/table-actions";
import {
  decodeTableActionIntent,
  decodeTableFocus,
  encodeTableFocus,
  NOTE_TABLE_ACTION_MAX_LENGTH,
  NoteTableActionRequestSchema,
} from "../../../../lib/table-actions";

const Input = z.object({ session: z.uuid(), state: z.string(), request: NoteTableActionRequestSchema });

export const createBrowserTableServer = () => {
  const sessions = new Map<string, Map<string, SharedTextStructuralHistory>>();
  return {
    clear: () => sessions.clear(),
    async handle(request: Request) {
      const input = Input.parse(await request.json());
      let receipts = sessions.get(input.session);
      if (!receipts) {
        receipts = new Map();
        sessions.set(input.session, receipts);
      }
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Buffer.from(input.state, "base64"));
        const text = doc.getText("codemirror");
        const intent = decodeTableActionIntent(input.request.intent);
        const focusPlan =
          !("receiptCursor" in intent) && input.request.focus
            ? prepareTableActionFocus(text, intent, decodeTableFocus(input.request.focus), input.request.caret)
            : undefined;
        const original = "receiptCursor" in intent ? receipts.get(intent.receiptCursor) : undefined;
        if ("receiptCursor" in intent && !original) throw new Error("Unknown fixture receipt");
        const inverse = original ? planStructuralInverse(text, original) : undefined;
        const changes = (
          inverse?.changes ?? ("receiptCursor" in intent ? [] : planTableAction(text, intent, NOTE_TABLE_ACTION_MAX_LENGTH))
        ).toSorted((a, b) => a.from - b.from);
        const before = Y.encodeStateVector(doc);
        const finish = prepareStructuralHistory(text, changes);
        doc.transact(() => {
          for (const change of changes.toReversed()) {
            if (change.to > change.from) text.delete(change.from, change.to - change.from);
            if (change.insert) text.insert(change.from, change.insert);
          }
        });
        const record = finish();
        if ("receiptCursor" in intent) {
          record.inverseOf = intent.receiptCursor;
          record.retained = inverse?.retained ?? false;
        }
        const cursor = `s6t.browser.${receipts.size + 1}`;
        receipts.set(cursor, record);
        const focus = focusPlan?.(text);
        return Response.json({
          update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
          cursor,
          retained: record.retained ?? false,
          focus: focus ? encodeTableFocus(focus) : null,
        });
      } catch (error) {
        return Response.json(
          { message: error instanceof Error ? error.message : "Fixture action rejected", accepted: false },
          { status: 409 },
        );
      } finally {
        doc.destroy();
      }
    },
  };
};
