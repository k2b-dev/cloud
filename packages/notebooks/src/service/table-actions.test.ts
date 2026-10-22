import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  captureTableAction,
  captureTextAnchor,
  resolveTextAnchor,
  SHARED_TEXT_NAME,
  type SharedTextEditResult,
  type TableActionIntent,
} from "@k2b/cloud/shared-text";
import { deleteRow, findTables, gridLine } from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import type { Note } from "./notes";

// Isolate module spies; no Sync connection, database, or service is started.
if (process.env.NOTEBOOKS_TABLE_ACTION_SERVICE_TEST !== "1") {
  test("Notebooks table action service guards and planner", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_TABLE_ACTION_SERVICE_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  const { notebooksTextLog } = await import("./yjs-sync");
  const binding = spyOn(notebooksTextLog, "withStore");
  const notes = await import("./notes");
  const bound = binding.mock.results[0];
  if (!bound || bound.type !== "return") throw new Error("Missing document binding");
  const change = spyOn(bound.value, "change");
  const get = spyOn(notes, "get");
  const stored = spyOn(notes, "getYjsStateWithCursor");
  const noteId = "11111111-1111-4111-8111-111111111111";
  const notebookId = "22222222-2222-4222-8222-222222222222";
  const actor = { kind: "service_account" as const, id: "33333333-3333-4333-8333-333333333333" };
  const note: Note = {
    id: noteId,
    notebookId,
    shortId: "note01",
    parentId: null,
    title: "A",
    position: 0,
    hasChildren: false,
    yjsSnapshotAt: null,
    historyIncomplete: false,
    contentMd: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lockedAt: null,
  };
  let doc: Y.Doc;
  let intent: TableActionIntent;
  const input = () => ({
    notebookId,
    noteId,
    permission: "write" as const,
    intent,
    restoreRevision: "0",
    actionId: "44444444-4444-4444-8444-444444444444",
    createdBy: null,
    actor,
  });
  beforeEach(() => {
    doc = new Y.Doc();
    doc.clientID = 100;
    const text = doc.getText(SHARED_TEXT_NAME);
    text.insert(0, "| A | B |\n| --- | --- |\n| a | b |\n");
    intent = captureTableAction(text, "colRight", { tableFrom: 0, rowFrom: 0, columnFrom: 2, row: 0, column: 0 });
    get.mockReset().mockResolvedValue(note);
    stored
      .mockReset()
      .mockResolvedValue({ yjsState: null, streamCursor: null, restoreRevision: "0", contentMd: null, historyIncomplete: false });
    change.mockReset().mockImplementation(async (_id, _options, plan) => {
      const edits = await plan({ text: text.toString(), restoreRevision: "0", state: () => Y.encodeStateAsUpdate(doc), contributors: [] });
      expect(edits.length).toBeGreaterThan(1); // Preserve separated rows instead of replacing the whole table.
      return { status: "unchanged", text: text.toString() };
    });
  });
  afterEach(() => doc.destroy());
  afterAll(() => {
    for (const spy of [change, get, stored, binding]) spy.mockRestore();
  });

  test("denies readers before loading or changing text", async () => {
    expect(await notes.tableAction({ ...input(), permission: "read" })).toMatchObject({ ok: false, status: 403, accepted: false });
    expect(get).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });
  test("rejects another notebook, locked notes, and incomplete history before planning", async () => {
    for (const [value, code] of [
      [{ ...note, notebookId: "other" }, "table_action_note_not_found"],
      [{ ...note, lockedAt: note.updatedAt }, "table_action_locked"],
      [{ ...note, historyIncomplete: true }, "table_action_history_incomplete"],
    ] as const) {
      get.mockResolvedValue(value);
      expect(await notes.tableAction(input())).toMatchObject({ ok: false, code, accepted: false });
    }
    expect(change).not.toHaveBeenCalled();
  });
  test("passes actor, audit context, limit, cancellation and action identity through the existing writer", async () => {
    const signal = new AbortController().signal;
    expect(await notes.tableAction({ ...input(), signal })).toEqual({ ok: true, data: { changed: false, cursor: null, receipt: null } });
    expect(change).toHaveBeenCalledWith(
      noteId,
      { actor, context: { createdBy: null }, signal, maxLength: 2_097_152, actionId: input().actionId },
      expect.any(Function),
    );
  });
  test("rechecks history and lock after replay", async () => {
    for (const updated of [
      { ...note, lockedAt: note.updatedAt },
      { ...note, historyIncomplete: true },
      { ...note, notebookId: "other" },
    ]) {
      get.mockReset().mockResolvedValueOnce(note).mockResolvedValue(updated);
      expect(await notes.tableAction(input())).toMatchObject({ ok: false, accepted: false });
    }
    get.mockReset().mockResolvedValue(note);
    stored.mockResolvedValue({ yjsState: null, streamCursor: null, restoreRevision: "0", contentMd: null, historyIncomplete: true });
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_action_history_incomplete", accepted: false });
  });
  test("rejects a restore revision mismatch inside the planner", async () => {
    expect(await notes.tableAction({ ...input(), restoreRevision: "1" })).toMatchObject({
      ok: false,
      code: "table_action_restore_conflict",
      status: 409,
      accepted: false,
    });
    stored.mockResolvedValue({ yjsState: null, streamCursor: null, restoreRevision: "1", contentMd: null, historyIncomplete: false });
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_action_restore_conflict", accepted: false });
  });
  test("rejects deleted target characters before producing edits", async () => {
    const text = doc.getText(SHARED_TEXT_NAME);
    text.delete(text.toString().indexOf("\n"), 1);
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_target_rejected", status: 409, accepted: false });
  });
  test("a deleted body row cannot redirect a delayed action to its neighbour", async () => {
    const text = doc.getText(SHARED_TEXT_NAME);
    text.insert(text.length, "| second | row |\n");
    const table = findTables(text.toString())[0]!;
    intent = captureTableAction(text, "deleteRow", {
      tableFrom: table.from,
      rowFrom: gridLine(table, 1)!.from,
      columnFrom: table.lines[0]!.cells[0]!.from,
      row: 1,
      column: 0,
    });
    for (const edit of deleteRow(table, 1).sort((a, b) => b.from - a.from)) {
      if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
      if (edit.insert) text.insert(edit.from, edit.insert);
    }
    const before = text.toString();
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_target_rejected", status: 409, accepted: false });
    expect(text.toString()).toBe(before);
  });
  test("accepts header text edits and unrelated shifts with surviving anchors", async () => {
    const text = doc.getText(SHARED_TEXT_NAME);
    text.delete(2, 1);
    text.insert(2, "Renamed");
    text.insert(0, "Unrelated prose\n\n");
    expect(await notes.tableAction(input())).toMatchObject({ ok: true });
  });
  test("preserves untouched cell identities between the service's disjoint changes", async () => {
    const text = doc.getText(SHARED_TEXT_NAME);
    const anchor = captureTextAnchor(text, text.toString().indexOf("b |"));
    change.mockImplementation(async (_id, options, plan) => {
      const edits = await plan({ text: text.toString(), restoreRevision: "0", state: () => Y.encodeStateAsUpdate(doc), contributors: [] });
      const server = new Y.Doc();
      try {
        Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
        const ytext = server.getText(SHARED_TEXT_NAME);
        for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
          if (edit.to > edit.from) ytext.delete(edit.from, edit.to - edit.from);
          if (edit.insert) ytext.insert(edit.from, edit.insert);
        }
        const at = resolveTextAnchor(ytext, anchor);
        expect(at).not.toBeNull();
        expect(ytext.toString()[at!]).toBe("b");
        expect(findTables(ytext.toString())[0]!.lines[0]!.cells.map((cell) => cell.text)).toEqual(["A", "", "B"]);
        expect(options.actor).toEqual(actor);
        return {
          status: "edited",
          text: ytext.toString(),
          cursor: "cursor",
          saved: { ok: true, data: { versionId: null } },
          receipt: { actionId: input().actionId, update: Y.encodeStateAsUpdate(server) },
        };
      } finally {
        server.destroy();
      }
    });
    expect(await notes.tableAction(input())).toMatchObject({
      ok: true,
      data: { changed: true, cursor: "cursor", receipt: { actionId: input().actionId } },
    });
  });
  test("rejects content above the approved UTF-16 limit without modifying the source", async () => {
    const text = doc.getText(SHARED_TEXT_NAME);
    text.insert(text.length, "\n" + "x".repeat(2_097_152 - text.length - 1));
    const before = text.toString();
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_action_too_large", status: 413, accepted: false });
    expect(text.toString()).toBe(before);
    // Alignment changes additionally exercise the adapter's resulting-length guard.
    intent = captureTableAction(text, "alignRight", { tableFrom: 0, rowFrom: 0, columnFrom: 2, row: 0, column: 0 });
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, code: "table_action_too_large", status: 413, accepted: false });
    expect(text.toString()).toBe(before);
  });
  test("cancellation before planning preserves text and skips the writer", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(notes.tableAction({ ...input(), signal: controller.signal })).rejects.toThrow("cancelled");
    expect(change).not.toHaveBeenCalled();
  });
  test("returns accepted receipts for persistence exceptions and rejected saves", async () => {
    const receipt = { actionId: input().actionId, update: new Uint8Array([1, 2, 3]) };
    for (const outcome of [
      { status: "persistFailed", cursor: "cursor", error: new Error("save unavailable"), receipt },
      { status: "edited", text: "", cursor: "cursor", saved: { ok: false, error: "Cannot modify locked note", status: 403 }, receipt },
    ] satisfies SharedTextEditResult<unknown>[]) {
      change.mockResolvedValue(outcome);
      expect(await notes.tableAction(input())).toMatchObject({
        ok: false,
        code: "table_action_persist_failed",
        accepted: true,
        cursor: "cursor",
        receipt: { actionId: input().actionId, update: "AQID" },
      });
    }
  });
  test("does not retry a conflict or an ambiguous publication", async () => {
    const { ConflictError } = await import("@k2b/sync");
    change.mockRejectedValue(new ConflictError("head changed"));
    expect(await notes.tableAction(input())).toMatchObject({ ok: false, status: 409, accepted: false, code: "table_action_conflict" });
    expect(change).toHaveBeenCalledTimes(1);
    change.mockReset().mockRejectedValue(new Error("ack lost"));
    expect(await notes.tableAction(input())).toMatchObject({
      ok: false,
      status: 500,
      accepted: null,
      code: "table_action_outcome_unknown",
    });
    expect(change).toHaveBeenCalledTimes(1);
  });
}
