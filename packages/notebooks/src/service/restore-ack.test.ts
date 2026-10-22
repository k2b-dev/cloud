import { expect, mock, test } from "bun:test";
import { applySharedTextEvent, compareStreamCursor, type SharedTextSyncEvent, toBase64 } from "@k2b/cloud/shared-text";
import * as Y from "yjs";

// SQL and module fixtures stay in a subprocess, outside other suites' graphs.
if (process.env.NOTEBOOKS_RESTORE_ACK_CHILD !== "1") {
  test("restore and receipts validate and replay under the same row lock", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_RESTORE_ACK_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  const fixedDate = new Date("2026-01-01T00:00:00Z");
  const encode = (text: string) => {
    const doc = new Y.Doc();
    doc.clientID = 100;
    doc.getText("codemirror").insert(0, text);
    try {
      return Buffer.from(Y.encodeStateAsUpdate(doc));
    } finally {
      doc.destroy();
    }
  };
  const empty = () => ({
    id: "note",
    short_id: "abcdef",
    notebook_id: "book",
    parent_id: null,
    title: "",
    position: 1,
    yjs_snapshot: encode(""),
    yjs_stream_cursor: "s6t.fixture.0",
    yjs_restore_revision: "0",
    yjs_history_incomplete: false,
    content_md: "",
    locked_at: null as Date | null,
    created_by: null,
    created_at: fixedDate,
    updated_at: fixedDate,
  });
  let row: ReturnType<typeof empty> | null = empty();
  let events: Array<{ cursor: string; data: SharedTextSyncEvent }> = [];
  let writes = 0;
  let versions = 0;
  let locked = false;
  let lockKind: "shared" | "exclusive" | null = null;
  let underLock: (() => void) | null = null;
  const reset = () => {
    row = empty();
    events = [];
    writes = 0;
    versions = 0;
    underLock = null;
  };
  const fixtureSql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("FOR UPDATE") || query.includes("FOR SHARE")) {
      expect(locked).toBe(true);
      lockKind = query.includes("FOR UPDATE") ? "exclusive" : "shared";
      underLock?.();
      if (!row) return [];
      return query.includes("AS revision") ? [{ revision: row.yjs_restore_revision }] : [{ ...row }];
    }
    if (query.includes("UPDATE notebooks.notes")) {
      expect(lockKind).toBe("exclusive");
      writes++;
      if (!row || !(values[0] instanceof Uint8Array)) throw new Error("Missing replacement");
      row.yjs_snapshot = Buffer.from(values[0]);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.yjs_snapshot);
        row.content_md = doc.getText("codemirror").toString();
      } finally {
        doc.destroy();
      }
      row.yjs_restore_revision = String(BigInt(row.yjs_restore_revision) + 1n);
      return Object.assign([], { count: 1 });
    }
    if (query.includes("INSERT INTO notebooks.note_versions")) {
      versions++;
      return [{ id: "version" }];
    }
    if (query.includes("FROM notebooks.notes")) {
      expect(locked).toBe(false); // No second pool connection/anchor under lock.
      return row ? [{ ...row }] : [];
    }
    throw new Error("Unexpected SQL: " + query);
  };
  Object.assign(fixtureSql, {
    begin: async (callback: (tx: typeof fixtureSql) => Promise<unknown>) => {
      expect(locked).toBe(false);
      locked = true;
      try {
        return await callback(fixtureSql);
      } finally {
        locked = false;
        lockKind = null;
      }
    },
  });
  Object.assign(globalThis, { restoreAckSql: fixtureSql });
  // Bun's native sql export cannot be mocked. Redirect only notes.ts's import;
  // all service code, including transaction/replay ordering, executes unchanged.
  Bun.plugin({
    name: "restore-ack-sql",
    setup(build) {
      build.onLoad({ filter: /[\/]notebooks[\/]src[\/]service[\/]notes\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace(
          'import { sql, type TransactionSQL } from "bun";',
          "const sql = globalThis.restoreAckSql;",
        ),
        loader: "ts",
      }));
    },
  });
  mock.module("@k2b/cloud", () => ({ lazySync: () => () => ({}) }));
  mock.module("@k2b/cloud/server", () => ({ REQUEST_IDLE_TIMEOUT_MAX_SECONDS: 240 }));
  mock.module("@k2b/cloud/services", () => ({
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    get: async () => ({}),
    toPgTextArray: (value: unknown) => value,
    toPgUuidArray: (value: unknown) => value,
    trace: {},
  }));
  mock.module("./access", () => ({ buildNotebookVisibleAccessCondition() {}, mayReadAcrossNotebooks() {} }));
  mock.module("./activity", () => ({ record: async () => {} }));
  mock.module("./note-refs", () => ({ reindexNoteRefsSafe: async () => {} }));
  mock.module("./workspace-events", () => ({ invalidated() {}, noteCreated() {}, noteDeleted() {}, noteUpdated: async () => {} }));
  const topic = {
    head: async () => {
      expect(lockKind).toBe("exclusive");
      return "s6t.fixture.9";
    },
    latestCursor: async () => {
      expect(lockKind).toBe("exclusive");
      return events.at(-1)?.cursor ?? null;
    },
    cursorSequence: (cursor: string) => Number(cursor.split(".").at(-1)),
  };
  mock.module("./yjs-sync", () => ({
    applyYjsTopicEvent: applySharedTextEvent,
    compareStreamCursor,
    createYjsTopic: () => topic,
    isSharedCursor: (cursor: string) => cursor?.startsWith("s6t."),
    legacyYjsTopicInfo: async () => null,
    parseStreamCursor: () => null,
    toBase64,
    notebooksTextLog: {
      withStore: () => ({}),
      replay: async (input: { doc: Y.Doc; restoreRevision: string; signal: AbortSignal }) => {
        expect(lockKind).toBe("exclusive");
        expect(input.restoreRevision).toBe(row?.yjs_restore_revision);
        expect(input.signal).toBeInstanceOf(AbortSignal);
        for (const event of events) applySharedTextEvent(input.doc, event, "note", input.restoreRevision);
      },
    },
  }));
  const notes = await import("./notes");
  const restore = (signal?: AbortSignal) =>
    notes.restoreFromSnapshot({ noteId: "note", yjsSnapshot: toBase64(encode("TOKEN")), createdBy: null, signal });

  test("no writes yet restores; stale delivery is blocked and matching delivery holds SHARE through send", async () => {
    reset();
    expect((await restore()).ok).toBe(true);
    expect(row?.content_md).toBe("TOKEN");
    expect(row?.yjs_restore_revision).toBe("1");
    expect(versions).toBe(1);
    let sent = 0;
    expect(
      await notes.deliverAtRestoreRevision({
        noteId: "note",
        restoreRevision: "0",
        deliver: () => {
          sent++;
        },
      }),
    ).toBe("stale");
    expect(sent).toBe(0);
    expect(
      await notes.deliverAtRestoreRevision({
        noteId: "note",
        restoreRevision: "1",
        deliver: () => {
          expect(lockKind).toBe("shared");
          sent++;
        },
      }),
    ).toBe("delivered");
    expect(sent).toBe(1);
  });
  for (const text of ["ACKNOWLEDGED", " \n"])
    test(`acknowledged live ${JSON.stringify(text)} absent in stored Markdown blocks restore`, async () => {
      reset();
      events.push({
        cursor: "s6t.fixture.1",
        data: { kind: "sync", payload: toBase64(encode(text)), restoreRevision: "0", originNodeId: "peer", originPeerId: "peer" },
      });
      expect(await notes.deliverAtRestoreRevision({ noteId: "note", restoreRevision: "0", deliver: () => undefined })).toBe("delivered");
      expect(row?.content_md).toBe("");
      expect(await restore()).toMatchObject({ ok: false, status: 400 });
      expect(writes).toBe(0);
      expect(versions).toBe(0);
    });
  for (const status of [404, 403, 409])
    test(`restore revalidates ${status} under its exclusive lock`, async () => {
      reset();
      underLock = () => {
        if (status === 404) row = null;
        else if (row && status === 403) row.locked_at = fixedDate;
        else if (row) row.yjs_restore_revision = "1";
      };
      expect(await restore()).toMatchObject({ ok: false, status });
      expect(writes).toBe(0);
      expect(versions).toBe(0);
    });
  test("an undecodable stored base remains a nonempty-target rejection", async () => {
    reset();
    if (!row) throw new Error("Missing fixture");
    row.yjs_snapshot = Buffer.from([255]);
    expect(await restore()).toMatchObject({ ok: false, status: 400 });
    expect(writes).toBe(0);
  });

  test("cancelled restoration never writes", async () => {
    reset();
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(restore(cancelled.signal)).rejects.toThrow("cancelled");
    expect(writes).toBe(0);
  });
}
