import { expect, spyOn } from "bun:test";
import { ConflictError, createSync } from "@k2b/sync";
import * as Y from "yjs";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import {
  SHARED_TEXT_NAME,
  type SharedTextActor,
  type SharedTextSaveInput,
  type SharedTextStoredState,
  sharedText,
  sharedTextNodeId,
  toBase64,
} from "./index";

const withLog = async (run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) => {
  const f = await setup();
  try {
    await f.sync.ready();
    await run(f);
  } finally {
    f.source.destroy();
    try {
      await f.log.topic().destroy();
      await f.sync.drain();
    } finally {
      unbindProcessSync();
      await f.connection.close();
    }
  }
};

const setup = async () => {
  const connection = await connectTestNats();
  const sync = createSync({ connection, namespace: testSyncNamespace("shared-text"), application: "test", defaults: { replicas: 1 } });
  bindProcessSync(sync);
  const log = sharedText.define({
    id: `test:shared-text:${crypto.randomUUID()}`,
    retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 * 1024 },
    deadLetterRetention: { maxBytes: 64 * 1024 },
    maxPayloadBytes: 4096,
  });
  const docId = crypto.randomUUID();
  let stored: SharedTextStoredState = { state: null, text: null, cursor: null, restoreRevision: "0" };
  let overtaken = false;
  const saves: SharedTextSaveInput[] = [];
  const documents = log.withStore({
    load: async () => stored,
    save: async (_id, input) => {
      saves.push(input);
      if (overtaken) return { status: "overtaken" as const };
      stored = { state: input.state, text: input.text, cursor: input.cursor, restoreRevision: input.restoreRevision };
      return { status: "saved" as const };
    },
  });
  const source = new Y.Doc();
  const append = async (text: string, actor?: SharedTextActor) => {
    const vector = Y.encodeStateVector(source);
    source.getText(SHARED_TEXT_NAME).insert(source.getText(SHARED_TEXT_NAME).length, text);
    // The wire shape predates shared-text, including retained events without actor.
    return log.topic().publish({
      tenantId: docId,
      data: {
        kind: "sync",
        payload: toBase64(Y.encodeStateAsUpdate(source, vector)),
        originNodeId: "old-node",
        originPeerId: null,
        ...(actor ? { actor } : {}),
      },
    });
  };
  return {
    connection,
    sync,
    log,
    docId,
    documents,
    saves,
    source,
    append,
    setWatermark: (cursor: string) => {
      stored = { ...stored, cursor };
    },
    setOvertaken: () => {
      overtaken = true;
    },
  };
};

testFor("nats")("old wire events replay identically through read and edit and credit only known actors", async () => {
  await withLog(async ({ documents, log, docId, saves, append }) => {
    const actor = { kind: "user" as const, id: "old-user" };
    await append("without actor ");
    const last = await append("with actor", actor);
    const read = await documents.read(docId);
    expect(read?.text).toBe("without actor with actor");
    const raw = await Array.fromAsync(log.topic().replay({ tenantId: docId, after: log.topic().cursorAt(0), until: last.cursor }));
    expect(raw[0]?.data.actor).toBeUndefined();
    const result = await documents.edit(docId, { actor: null }, (current) => {
      expect(current.text).toBe("without actor with actor");
      expect(current.contributors).toEqual([{ ...actor, lastContributedAt: raw[1]!.publishedAt }]);
      return `${current.text}!`;
    });
    expect(result).toMatchObject({ status: "edited", text: "without actor with actor!" });
    expect(saves[0]?.contributors).toEqual([{ ...actor, lastContributedAt: raw[1]!.publishedAt }]);
  });
});

testFor("nats")("service-account edits publish their actor and save contributors at requestedAt", async () => {
  await withLog(async ({ documents, log, docId, saves }) => {
    const clock = spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
    const actor = { kind: "service_account" as const, id: "agent" };
    try {
      const result = await documents.edit(docId, { actor }, () => "agent text");
      expect(result.status).toBe("edited");
      if (result.status !== "edited") throw new Error(`Unexpected edit status: ${result.status}`);
      const events = await Array.fromAsync(log.topic().replay({ tenantId: docId, after: log.topic().cursorAt(0), until: result.cursor }));
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({ kind: "sync", actor, originNodeId: sharedTextNodeId, originPeerId: null });
      expect(saves[0]?.requestedAt).toBe(1_790_000_000_000);
      expect(saves[0]?.contributors).toEqual([{ ...actor, lastContributedAt: new Date(1_790_000_000_000) }]);
    } finally {
      clock.mockRestore();
    }
  });
});

testFor("nats")("read includes updates newer than the stored snapshot without saving", async () => {
  await withLog(async ({ documents, docId, saves, append }) => {
    const last = await append("unsnapshotted");
    const current = await documents.read(docId);
    expect(current).toMatchObject({ text: "unsnapshotted", cursor: last.cursor, state: expect.any(Uint8Array) });
    expect(saves).toHaveLength(0);
  });
});

testFor("nats")("edit diffs against the replayed state and keeps a foreign insertion", async () => {
  await withLog(async ({ documents, log, docId }) => {
    await documents.edit(docId, { actor: null }, () => "base");
    const initial = await documents.read(docId);
    const browser = new Y.Doc();
    try {
      Y.applyUpdate(browser, initial!.state!);
      const vector = Y.encodeStateVector(browser);
      browser.getText(SHARED_TEXT_NAME).insert(0, "foreign ");
      await log.topic().publish({
        tenantId: docId,
        data: {
          kind: "sync",
          payload: toBase64(Y.encodeStateAsUpdate(browser, vector)),
          originNodeId: "browser",
          originPeerId: "peer",
        },
      });
      const result = await documents.edit(docId, { actor: null }, ({ text }) => {
        expect(text).toBe("foreign base");
        return `${text}!`;
      });
      expect(result).toMatchObject({ status: "edited", text: "foreign base!" });
      expect((await documents.read(docId))?.text).toBe("foreign base!");
    } finally {
      browser.destroy();
    }
  });
});

testFor("nats")("an overtaken save result passes through without another save", async () => {
  await withLog(async ({ documents, docId, saves, setOvertaken }) => {
    setOvertaken();
    const result = await documents.edit(docId, { actor: null }, () => "accepted update");
    expect(result).toMatchObject({ status: "edited", saved: { status: "overtaken" } });
    expect(saves).toHaveLength(1);
    expect((await documents.read(docId))?.text).toBe("accepted update");
    expect(saves).toHaveLength(1);
  });
});

testFor("nats")("disjoint changes preserve interior Yjs identities through the real log", async () => {
  await withLog(async ({ documents, docId }) => {
    await documents.change(docId, { actor: null, maxLength: 100 }, () => [{ from: 0, to: 0, insert: "first middle last" }]);
    const before = new Y.Doc();
    const after = new Y.Doc();
    try {
      Y.applyUpdate(before, (await documents.read(docId))!.state!);
      const anchor = Y.createRelativePositionFromTypeIndex(before.getText(SHARED_TEXT_NAME), 8);
      const result = await documents.change(docId, { actor: null, maxLength: 100 }, ({ text }) => [
        { from: 0, to: 0, insert: "[" },
        { from: text.length, to: text.length, insert: "]" },
      ]);
      expect(result).toMatchObject({ status: "edited", text: "[first middle last]" });
      Y.applyUpdate(after, (await documents.read(docId))!.state!);
      const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, after, false)!;
      expect(resolved.index).toBe(9);
      expect(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(after.getText(SHARED_TEXT_NAME), resolved.index))).toEqual(
        Y.encodeRelativePosition(anchor),
      );
    } finally {
      before.destroy();
      after.destroy();
    }
  });
});

for (const empty of [false, true]) {
  testFor("nats")(
    `a competing update rejects a structural transaction from ${empty ? "an empty" : "an existing"} tenant head`,
    async () => {
      await withLog(async ({ documents, docId, append, saves, log }) => {
        if (!empty) await append("base");
        await expect(
          documents.change(docId, { actor: null, maxLength: 100 }, async ({ text }) => {
            await append("peer");
            return [{ from: text.length, to: text.length, insert: "must not publish" }];
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(saves).toHaveLength(0);
        expect((await documents.read(docId))?.text).toBe(empty ? "peer" : "basepeer");
        const events = await Array.fromAsync(
          log
            .topic()
            .replay({ tenantId: docId, after: log.topic().cursorAt(0), until: (await log.topic().latestCursor({ tenantId: docId }))! }),
        );
        expect(events).toHaveLength(empty ? 1 : 2);
      });
    },
  );
}

testFor("nats")("other tenants and a newer stored stream watermark do not conflict with this document", async () => {
  await withLog(async ({ documents, docId, log, source, setWatermark }) => {
    await documents.edit(docId, { actor: null }, () => "base");
    const other = await log.topic().publish({
      tenantId: "another-document",
      data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(source)), originNodeId: "other", originPeerId: null },
    });
    setWatermark(other.cursor);
    expect(
      await documents.change(docId, { actor: null, maxLength: 100 }, ({ text }) => [{ from: text.length, to: text.length, insert: "!" }]),
    ).toMatchObject({ status: "edited", text: "base!" });
  });
});
