import { expect, test } from "bun:test";
import { captureTableAction, SHARED_TEXT_NAME, toBase64 } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { decodeTableActionIntent, NoteTableActionRequestSchema } from "./table-actions";

test("transport decodes captured item anchors without ordinals or binary changes", () => {
  const doc = new Y.Doc();
  doc.clientID = 100;
  try {
    const text = doc.getText(SHARED_TEXT_NAME);
    text.insert(0, "| A | B |\n| --- | --- |\n| a | b |\n");
    const intent = captureTableAction(text, "alignRight", { tableFrom: 0, rowFrom: 0, columnFrom: 2, row: 0, column: 0 });
    if (!("column" in intent)) throw new Error("Expected column intent");
    const encoded = {
      action: intent.action,
      table: { headerBreak: toBase64(intent.table.headerBreak), separatorHyphen: toBase64(intent.table.separatorHyphen) },
      column: { hyphen: toBase64(intent.column.hyphen), left: toBase64(intent.column.left), right: toBase64(intent.column.right) },
    };
    const parsed = NoteTableActionRequestSchema.parse({
      restoreRevision: "0",
      actionId: "11111111-1111-4111-8111-111111111111",
      intent: encoded,
    });
    expect(decodeTableActionIntent(parsed.intent)).toEqual(intent);
  } finally {
    doc.destroy();
  }
});

test("transport rejects malformed, sentinel, noncanonical, oversized anchors and numeric targets", () => {
  const bytes = Y.encodeRelativePosition(new Y.RelativePosition(null, null, Y.createID(1, 1), 0));
  const anchor = toBase64(bytes);
  const request = {
    restoreRevision: "0",
    actionId: "11111111-1111-4111-8111-111111111111",
    intent: { action: "completeColumns", table: { headerBreak: anchor, separatorHyphen: anchor } },
  };
  for (const headerBreak of [
    "",
    "!!!!",
    anchor.slice(0, -1),
    toBase64(new Uint8Array([...bytes, 0])),
    "A".repeat(28),
    toBase64(Y.encodeRelativePosition(new Y.RelativePosition(null, "codemirror", null, 0))),
  ])
    expect(
      NoteTableActionRequestSchema.safeParse({ ...request, intent: { ...request.intent, table: { ...request.intent.table, headerBreak } } })
        .success,
    ).toBe(false);
  for (const intent of [
    { ...request.intent, row: 1 },
    { action: "deleteRow", table: request.intent.table, row: { kind: "body", beforeBreak: anchor, inside: anchor, insideKind: "text" } },
    { action: "deleteCol", table: request.intent.table, column: 1 },
    { action: "replace", table: request.intent.table },
  ])
    expect(NoteTableActionRequestSchema.safeParse({ ...request, intent }).success).toBe(false);
  for (const restoreRevision of ["", "abc", "-1", "01", "9223372036854775808"])
    expect(NoteTableActionRequestSchema.safeParse({ ...request, restoreRevision }).success).toBe(false);
  expect(NoteTableActionRequestSchema.safeParse({ ...request, actionId: "not-a-uuid" }).success).toBe(false);
});

test("the anchor bound accepts both maximum safe-integer Yjs item coordinates", () => {
  const anchor = toBase64(
    Y.encodeRelativePosition(new Y.RelativePosition(null, null, Y.createID(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), 0)),
  );
  expect(anchor).toHaveLength(24);
  expect(
    NoteTableActionRequestSchema.safeParse({
      restoreRevision: "9223372036854775807",
      actionId: "11111111-1111-4111-8111-111111111111",
      intent: { action: "deleteRow", table: { headerBreak: anchor, separatorHyphen: anchor }, row: { kind: "header" } },
    }).success,
  ).toBe(true);
});
