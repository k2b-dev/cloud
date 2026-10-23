import { expect, spyOn, test } from "bun:test";
import { ConflictError, type TopicPublish } from "@k2b/sync";
import * as Y from "yjs";
import { createStructuralFixture } from "../../../../scripts/fixtures/shared-text-history";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";
import { bindDocuments, createDoc } from "./documents";
import { applySharedTextEvent, SHARED_TEXT_NAME, sharedTextNodeId, toBase64 } from "./events";
import type { SharedTextSaveInput, SharedTextStoredState, SharedTextSyncEvent } from "./types";

const fixture = () => {
  let stored: SharedTextStoredState | null = { state: null, cursor: null, restoreRevision: "revision", text: null };
  const publications: TopicPublish<SharedTextSyncEvent>[] = [];
  const events: { cursor: string; data: SharedTextSyncEvent }[] = [];
  const saves: { docId: string; input: SharedTextSaveInput; context: string | undefined }[] = [];
  const docs: Y.Doc[] = [];
  const replays: { after: string | null; until: string; signal?: AbortSignal }[] = [];
  const failures: { load?: unknown; latest?: unknown; publish?: unknown; replay?: number; save?: unknown } = {};
  const handle = {
    latestCursor: async () => {
      if (failures.latest) throw failures.latest;
      return events.at(-1)?.cursor ?? null;
    },
    publish: async (input: TopicPublish<SharedTextSyncEvent>) => {
      publications.push(input);
      const { data } = input;
      if (Object.hasOwn(input, "expectedAfter") && input.expectedAfter !== (events.at(-1)?.cursor ?? null))
        throw new ConflictError("head changed");
      if (failures.publish) throw failures.publish;
      const cursor = `s6t.fixture.${events.length + 1}`;
      events.push({ cursor, data });
      return { cursor, eventId: cursor, messageId: cursor, streamSequence: events.length, duplicate: false };
    },
  };
  const documents = bindDocuments(
    {
      topic: () => handle,
      replay: async ({ docId, after, until, doc, restoreRevision, signal }) => {
        docs.push(doc);
        replays.push({ after, until, signal });
        if (failures.replay === replays.length) throw new Error("replay failed");
        for (const event of events.slice(after ? Number(after.split(".").at(-1)) : 0, Number(until.split(".").at(-1))))
          applySharedTextEvent(doc, event, docId, restoreRevision);
        return [];
      },
    },
    {
      load: async () => {
        if (failures.load) throw failures.load;
        return stored;
      },
      save: async (docId, input, context: string | undefined) => {
        if (failures.save) throw failures.save;
        saves.push({ docId, input, context });
        return { ok: false, error: "overtaken" };
      },
    },
  );
  const append = async (text: string) => {
    const doc = new Y.Doc();
    try {
      doc.getText(SHARED_TEXT_NAME).insert(0, text);
      return await handle.publish({
        data: { kind: "sync", payload: toBase64(Y.encodeStateAsUpdate(doc)), originNodeId: "foreign", originPeerId: null },
      });
    } finally {
      doc.destroy();
    }
  };
  return {
    documents,
    publications,
    events,
    saves,
    failures,
    docs,
    replays,
    append,
    setStored: (value: SharedTextStoredState | null) => {
      stored = value;
    },
  };
};

test("read preserves nullable snapshots and replays only newer log events", async () => {
  const f = fixture();
  expect(await f.documents.read("doc")).toEqual({ state: null, text: null, cursor: null, restoreRevision: "revision" });
  f.setStored(null);
  expect(await f.documents.read("doc")).toBeNull();
  f.setStored({ state: null, text: "fallback", cursor: null, restoreRevision: "r" });
  const receipt = await f.append("live");
  const current = await f.documents.read("doc");
  expect(current?.text).toContain("live");
  expect(current?.text).toContain("fallback");
  expect(current?.cursor).toBe(receipt.cursor);
  expect(current?.restoreRevision).toBe("r");
  expect(current?.state).toBeInstanceOf(Uint8Array);
  f.setStored({ state: current!.state, text: "stored projection", cursor: receipt.cursor, restoreRevision: "r" });
  expect(await f.documents.read("doc")).toEqual({
    state: current!.state,
    text: "stored projection",
    cursor: receipt.cursor,
    restoreRevision: "r",
  });
  expect(f.replays).toHaveLength(1);
});

test("read propagates replay errors and destroys the replay document", async () => {
  const f = fixture();
  await f.append("current");
  f.failures.replay = 1;
  await expect(f.documents.read("doc")).rejects.toThrow("replay failed");
  expect(f.docs).toHaveLength(1);
  expect(f.docs[0]?.isDestroyed).toBe(true);
});

test("edit reads the log end and persists a replay to its published cursor with actor and context", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  const f = fixture();
  const actor = { kind: "service_account" as const, id: "agent" };
  const signal = new AbortController().signal;
  try {
    await f.append("foreign");
    const result = await f.documents.edit("doc", { actor, context: "context", signal }, async (current) => {
      expect(current.text).toBe("foreign");
      const copy = new Y.Doc();
      try {
        Y.applyUpdate(copy, current.state());
        expect(copy.getText(SHARED_TEXT_NAME).toString()).toBe("foreign");
      } finally {
        copy.destroy();
      }
      // Accepted after the first replay, this update must appear in the saved doc too.
      await f.append("during callback");
      return `${current.text}!`;
    });
    expect(result).toMatchObject({ status: "edited", saved: { ok: false, error: "overtaken" } });
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]).toMatchObject({
      docId: "doc",
      context: "context",
      input: {
        actor,
        restoreRevision: "revision",
        requestedAt: 1_790_000_000_000,
        contributors: [{ ...actor, lastContributedAt: new Date(1_790_000_000_000) }],
      },
    });
    expect(f.saves[0]!.input.text).toContain("foreign!");
    expect(f.saves[0]!.input.text).toContain("during callback");
    expect(f.events.at(-1)?.data).toMatchObject({
      actor,
      restoreRevision: "revision",
      originNodeId: sharedTextNodeId,
      originPeerId: null,
      kind: "sync",
    });
    expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
    expect(f.replays).toEqual([
      { after: null, until: "s6t.fixture.1", signal },
      { after: null, until: "s6t.fixture.3", signal },
    ]);
  } finally {
    clock.mockRestore();
  }
});

test("unchanged edits never publish or save, and callbacks throw unchanged", async () => {
  const f = fixture();
  await f.append("current");
  expect(await f.documents.edit("doc", { actor: null }, ({ text }) => text)).toEqual({ status: "unchanged", text: "current" });
  const error = new Error("callback");
  await expect(
    f.documents.edit("doc", { actor: null }, () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(f.events).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
});

test("edit distinguishes missing documents, replay failures and persistence failures", async () => {
  const f = fixture();
  f.setStored(null);
  expect(await f.documents.edit("missing", { actor: null }, () => "next")).toEqual({ status: "notFound" });
  f.setStored({ state: null, text: null, cursor: null, restoreRevision: "r" });
  await f.append("current");
  f.failures.replay = 1;
  expect(await f.documents.edit("doc", { actor: null }, () => "next")).toMatchObject({ status: "syncFailed", error: expect.any(Error) });
  expect(f.events).toHaveLength(1);
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
  f.failures.replay = 3;
  expect(await f.documents.edit("doc", { actor: null }, () => "next")).toMatchObject({ status: "persistFailed", cursor: "s6t.fixture.2" });
  expect(f.saves).toHaveLength(0);
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
  f.failures.replay = undefined;
  f.failures.save = new Error("save failed");
  expect(await f.documents.edit("doc", { actor: null }, () => "another")).toMatchObject({
    status: "persistFailed",
    error: f.failures.save,
  });
});

for (const step of ["load", "latest", "publish"] as const) {
  test(`edit propagates ${step} errors without saving`, async () => {
    const f = fixture();
    const error = new Error(step);
    f.failures[step] = error;
    await expect(f.documents.edit("doc", { actor: null }, () => "next")).rejects.toBe(error);
    expect(f.saves).toHaveLength(0);
  });
}

test("edit cancelled during the callback publishes and saves nothing", async () => {
  const f = fixture();
  await f.append("current");
  const abort = new AbortController();
  await expect(
    f.documents.edit("doc", { actor: null, signal: abort.signal }, ({ text }) => {
      abort.abort(new Error("cancelled"));
      return `${text}!`;
    }),
  ).rejects.toThrow("cancelled");
  expect(f.events).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
});

test("edit cancelled during replay throws instead of reporting a sync failure and never runs the callback", async () => {
  const f = fixture();
  await f.append("current");
  const abort = new AbortController();
  f.failures.replay = 1;
  let called = false;
  const edit = f.documents.edit("doc", { actor: null, signal: abort.signal }, ({ text }) => {
    called = true;
    return `${text}!`;
  });
  abort.abort(new Error("cancelled"));
  await expect(edit).rejects.toThrow("cancelled");
  expect(called).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
});

test("an edit of fallback text without a snapshot keeps the edit in the saved state", async () => {
  const f = fixture();
  f.setStored({ state: null, text: "hello", cursor: null, restoreRevision: "r" });
  const result = await f.documents.edit("doc", { actor: null }, ({ text }) => `${text}!`);
  expect(result).toMatchObject({ status: "edited", text: "hello!" });
  expect(f.saves[0]?.input.text).toBe("hello!");
  const saved = new Y.Doc();
  try {
    Y.applyUpdate(saved, f.saves[0]!.input.state);
    expect(saved.getText(SHARED_TEXT_NAME).toString()).toBe("hello!");
    expect(saved.store.pendingStructs).toBeNull();
  } finally {
    saved.destroy();
  }
  // A later read from the same fallback replays the published edit, too.
  expect((await f.documents.read("doc"))?.text).toBe("hello!");
});

test("change preserves the identities between disjoint edits and conditions an empty tenant head", async () => {
  const f = fixture();
  const stored = { state: null, cursor: null, restoreRevision: "r", text: "first middle last" };
  f.setStored(stored);
  const before = createDoc(stored);
  const after = new Y.Doc();
  try {
    const anchor = Y.createRelativePositionFromTypeIndex(before.getText(SHARED_TEXT_NAME), 8);
    const result = await f.documents.change("doc", { actor: null, maxLength: 100 }, ({ text }) => [
      { from: text.length, to: text.length, insert: "]" },
      { from: 0, to: 0, insert: "[" },
    ]);
    expect(result).toMatchObject({ status: "edited", text: "[first middle last]" });
    expect(f.publications[0]?.expectedAfter).toBeNull();
    Y.applyUpdate(after, f.saves[0]!.input.state);
    const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, after, false)!;
    expect(resolved.index).toBe(9);
    expect(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(after.getText(SHARED_TEXT_NAME), resolved.index))).toEqual(
      Y.encodeRelativePosition(anchor),
    );
    expect(after.store.pendingStructs).toBeNull();
  } finally {
    before.destroy();
    after.destroy();
  }
});

test("change rejects a moved tenant head without publishing or saving its speculative edits", async () => {
  const f = fixture();
  await f.append("base");
  await expect(
    f.documents.change("doc", { actor: null, maxLength: 100 }, async ({ text }) => {
      await f.append("peer");
      return [{ from: text.length, to: text.length, insert: "mine" }];
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(f.events).toHaveLength(2);
  expect(f.saves).toHaveLength(0);
  expect(f.publications.at(-1)?.expectedAfter).toBe("s6t.fixture.1");
  expect(f.docs.every((doc) => doc.isDestroyed)).toBe(true);
  expect((await f.documents.read("doc"))?.text).not.toContain("mine");
});

test("change skips identical edits and rejects invalid ranges, Unicode splits and size before publication", async () => {
  const f = fixture();
  f.setStored({ state: null, cursor: null, restoreRevision: "r", text: "a😀b" });
  expect(await f.documents.change("doc", { actor: null, maxLength: 4 }, () => [{ from: 0, to: 1, insert: "a" }])).toEqual({
    status: "unchanged",
    text: "a😀b",
  });
  const invalid = [
    [{ from: -1, to: 0, insert: "" }],
    [{ from: 1, to: 0, insert: "" }],
    [{ from: 0, to: 5, insert: "" }],
    [{ from: 0.5, to: 1, insert: "" }],
    [
      { from: 0, to: 3, insert: "" },
      { from: 1, to: 4, insert: "" },
    ],
    [
      { from: 0, to: 0, insert: "x" },
      { from: 0, to: 0, insert: "y" },
    ],
    [{ from: 1, to: 2, insert: "" }],
    [{ from: 0, to: 0, insert: "\ud800" }],
    [{ from: 0, to: 0, insert: "too long" }],
  ];
  for (const changes of invalid)
    await expect(f.documents.change("doc", { actor: null, maxLength: 4 }, () => changes)).rejects.toBeInstanceOf(RangeError);
  expect(f.publications).toHaveLength(0);
  expect(f.saves).toHaveLength(0);
});

test("change refuses unresolved causal dependencies before invoking the planner", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 77;
  const partial = new Y.Doc();
  try {
    const text = source.getText(SHARED_TEXT_NAME);
    text.insert(0, "a");
    const vector = Y.encodeStateVector(source);
    text.insert(1, "b");
    Y.applyUpdate(partial, Y.encodeStateAsUpdate(source, vector));
    expect(partial.store.pendingStructs).not.toBeNull();
    f.setStored({ state: Y.encodeStateAsUpdate(partial), text: "", cursor: null, restoreRevision: "r" });
    let planned = false;
    const result = await f.documents.change("doc", { actor: null, maxLength: 100 }, () => {
      planned = true;
      return [{ from: 0, to: 0, insert: "new" }];
    });
    expect(result).toMatchObject({ status: "syncFailed", error: expect.any(Error) });
    expect(planned).toBe(false);
    expect(f.publications).toHaveLength(0);
  } finally {
    partial.destroy();
    source.destroy();
  }
});

test("change preserves cancellation, unknown publication errors and accepted-write persistence failure", async () => {
  const f = fixture();
  const signal = new AbortController();
  await expect(
    f.documents.change("doc", { actor: null, maxLength: 20, signal: signal.signal }, () => {
      signal.abort(new Error("cancelled"));
      return [{ from: 0, to: 0, insert: "hello" }];
    }),
  ).rejects.toThrow("cancelled");
  expect(f.publications).toHaveLength(0);
  const unknown = new Error("publication outcome unknown");
  f.failures.publish = unknown;
  await expect(f.documents.change("doc", { actor: null, maxLength: 20 }, () => [{ from: 0, to: 0, insert: "hello" }])).rejects.toBe(
    unknown,
  );
  expect(f.saves).toHaveLength(0);
  f.failures.publish = undefined;
  f.failures.save = new Error("save failed");
  expect(await f.documents.change("doc", { actor: null, maxLength: 20 }, () => [{ from: 0, to: 0, insert: "hello" }])).toMatchObject({
    status: "persistFailed",
    cursor: "s6t.fixture.1",
  });
  expect(f.events).toHaveLength(1);
});

test("change returns and publishes the same action receipt before persistence, with the loaded restore revision", async () => {
  for (const failure of [false, true]) {
    const f = fixture();
    f.setStored({ state: null, cursor: null, restoreRevision: "17", text: "body" });
    if (failure) f.failures.save = new Error("store unavailable");
    const result = await f.documents.change(
      "doc",
      { actor: { kind: "user", id: "writer" }, actionId: "action-17", maxLength: 100 },
      (current) => {
        expect(current.restoreRevision).toBe("17");
        return [{ from: 4, to: 4, insert: "!" }];
      },
    );
    expect(result.status).toBe(failure ? "persistFailed" : "edited");
    if (result.status !== "edited" && result.status !== "persistFailed") throw new Error("Missing action result");
    expect(result.receipt?.actionId).toBe("action-17");
    expect(f.publications[0]!.data.actionId).toBe("action-17");
    expect(Buffer.from(result.receipt!.update).toString("base64")).toBe(f.publications[0]!.data.payload);
    const peer = createDoc({ state: null, text: "body", cursor: null, restoreRevision: "17" });
    try {
      Y.applyUpdate(peer, result.receipt!.update);
      expect(peer.getText(SHARED_TEXT_NAME).toString()).toBe("body!");
    } finally {
      peer.destroy();
    }
  }
});

test("ordinary text edits keep their originating revision when a snapshot is restored during planning", async () => {
  const f = fixture();
  const old = new Y.Doc();
  old.clientID = 101;
  old.getText(SHARED_TEXT_NAME).insert(0, "TOKEN");
  const historical = Y.encodeStateAsUpdate(old);
  old.getText(SHARED_TEXT_NAME).delete(0, 5);
  f.setStored({ state: Y.encodeStateAsUpdate(old), text: "", cursor: null, restoreRevision: "0" });
  try {
    await f.documents.edit("doc", { actor: null }, () => {
      f.setStored({ state: historical, text: "TOKEN", cursor: null, restoreRevision: "1" });
      return "OLD EDIT";
    });
    expect(f.events.at(-1)?.data.restoreRevision).toBe("0");
    const current = await f.documents.read("doc");
    expect(current?.text).toBe("TOKEN");
    expect(current?.restoreRevision).toBe("1");
    const replacement = new Y.Doc();
    try {
      Y.applyUpdate(replacement, current!.state!);
      expect(replacement.store.pendingDs).toBeNull();
      expect(replacement.store.pendingStructs).toBeNull();
    } finally {
      replacement.destroy();
    }
  } finally {
    old.destroy();
  }
});

test("ordinary ingress accepts an idle shared-topic snapshot watermark and replays only its new tenant event", async () => {
  const initial = new Y.Doc();
  initial.clientID = 17;
  initial.getText(SHARED_TEXT_NAME).insert(0, "base");
  const stored: SharedTextStoredState = {
    state: Y.encodeStateAsUpdate(initial),
    text: "base",
    cursor: "s6t.fixture.9",
    restoreRevision: "0",
  };
  const client = createDoc(stored);
  const before = Y.encodeStateVector(client);
  client.getText(SHARED_TEXT_NAME).insert(4, " input");
  const events: { cursor: string; data: SharedTextSyncEvent }[] = [];
  const documents = bindDocuments(
    {
      topic: () => ({
        latestCursor: async () => events.at(-1)?.cursor ?? null,
        publish: async (input) => {
          expect(input.expectedAfter).toBeNull(); // Snapshot covers other tenants' events.
          const cursor = "s6t.fixture.10";
          events.push({ cursor, data: input.data });
          return { cursor, eventId: "event", messageId: "message", streamSequence: 10, duplicate: false };
        },
      }),
      events: async function* () {
        yield* events;
      },
      replay: async ({ doc }) => {
        for (const event of events) applySharedTextEvent(doc, event, "idle", "0");
        return [];
      },
    },
    { load: async () => stored, save: async () => {} },
  );
  try {
    expect(
      await documents.accept("idle", {
        actor: { kind: "user", id: "author" },
        update: Y.encodeStateAsUpdate(client, before),
        baseCursor: stored.cursor,
        restoreRevision: "0",
        originNodeId: "node",
        originPeerId: "peer",
      }),
    ).toEqual({ status: "accepted", cursor: "s6t.fixture.10" });
    const snapshot = (await documents.read("idle"))!;
    const reloaded = createDoc(snapshot);
    try {
      expect(reloaded.getText(SHARED_TEXT_NAME).toString()).toBe("base input");
    } finally {
      reloaded.destroy();
    }
  } finally {
    initial.destroy();
    client.destroy();
  }
});

test("only an explicit authorized recreation changes equal-text range identities", async () => {
  const f = fixture();
  f.setStored({ text: "abc", state: null, cursor: null, restoreRevision: "revision" });
  const initial = createDoc((await f.documents.read("doc"))!);
  const anchor = captureTextAnchor(initial.getText(SHARED_TEXT_NAME), 1);
  initial.destroy();
  const options = { actor: null, maxLength: 3, actionId: "identity-fence" };
  expect((await f.documents.change("doc", options, () => [{ from: 1, to: 2, insert: "b" }])).status).toBe("unchanged");
  expect(f.events).toHaveLength(0);
  expect((await f.documents.change("doc", options, () => [{ from: 1, to: 2, insert: "b", recreate: true }])).status).toBe("edited");
  const current = createDoc((await f.documents.read("doc"))!);
  try {
    expect(current.getText(SHARED_TEXT_NAME).toString()).toBe("abc");
    expect(resolveTextAnchor(current.getText(SHARED_TEXT_NAME), anchor)).toBeNull();
    expect(f.events[0]!.data.history!.patches[0]!.recreate).toBe(true);
  } finally {
    current.destroy();
  }
  await expect(f.documents.change("doc", options, () => [{ from: 0, to: 0, insert: "", recreate: true }])).rejects.toBeInstanceOf(
    RangeError,
  );
  expect(f.events).toHaveLength(1);
});

test("admission validates the merged text limit before confirming individually legal concurrent input", async () => {
  const f = createStructuralFixture("base");
  try {
    const baseCursor = f.peer.cursor;
    const ownVector = Y.encodeStateVector(f.own.doc),
      peerVector = Y.encodeStateVector(f.peer.doc);
    f.own.text.insert(0, "AA");
    f.peer.text.insert(4, "BB");
    expect(f.own.text.length).toBe(6);
    expect(f.peer.text.length).toBe(6);
    const own = Y.encodeStateAsUpdate(f.own.doc, ownVector),
      peer = Y.encodeStateAsUpdate(f.peer.doc, peerVector);
    const options = { actor: f.own.actor, baseCursor, restoreRevision: "0", originNodeId: "fixture", originPeerId: "peer", maxLength: 6 };
    expect((await f.documents().accept("fixture", { ...options, update: own })).status).toBe("accepted");
    const count = f.events.length,
      before = (await f.canonical()).text;
    expect((await f.documents().accept("fixture", { ...options, actor: f.peer.actor, update: peer })).status).toBe("recoveryRequired");
    expect(f.events).toHaveLength(count);
    expect((await f.canonical()).text).toBe(before);
    expect(f.peer.text.toString()).toBe("baseBB");
    // The actual transport envelope/source remains available to the provider.
    const probe = createDoc(f.stored());
    try {
      Y.applyUpdate(probe, peer);
      expect(probe.getText(SHARED_TEXT_NAME).toString()).toContain("BB");
    } finally {
      probe.destroy();
    }
    for (const maxLength of [-1, 0.5, Number.NaN])
      await expect(f.documents().accept("fixture", { ...options, update: peer, maxLength })).rejects.toThrow(RangeError);
  } finally {
    f.destroy();
  }
});
