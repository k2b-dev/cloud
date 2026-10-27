import { expect, spyOn, test } from "bun:test";
import type { TopicPublish } from "@k2b/sync";
import * as Y from "yjs";
import { bindDocuments } from "./documents";
import { applySharedTextEvent, SHARED_TEXT_NAME, sharedTextNodeId, toBase64 } from "./events";
import type { SharedTextSaveInput, SharedTextStoredState, SharedTextSyncEvent } from "./types";

const fixture = () => {
  let stored: SharedTextStoredState | null = { state: null, cursor: null, restoreRevision: "revision", text: null };
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
    publish: async ({ data }: TopicPublish<SharedTextSyncEvent>) => {
      if (failures.publish) throw failures.publish;
      const cursor = `s6t.fixture.${events.length + 1}`;
      events.push({ cursor, data });
      return { cursor, eventId: cursor, messageId: cursor, streamSequence: events.length, duplicate: false };
    },
  };
  const documents = bindDocuments(
    {
      topic: () => handle,
      replay: async ({ docId, after, until, doc, signal }) => {
        docs.push(doc);
        replays.push({ after, until, signal });
        if (failures.replay === replays.length) throw new Error("replay failed");
        for (const event of events.slice(after ? Number(after.split(".").at(-1)) : 0, Number(until.split(".").at(-1))))
          applySharedTextEvent(doc, event, docId);
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
  expect(await f.documents.read("doc")).toEqual({ state: null, text: null, cursor: null });
  f.setStored(null);
  expect(await f.documents.read("doc")).toBeNull();
  f.setStored({ state: null, text: "fallback", cursor: null, restoreRevision: "r" });
  const receipt = await f.append("live");
  const current = await f.documents.read("doc");
  expect(current?.text).toContain("live");
  expect(current?.text).toContain("fallback");
  expect(current?.cursor).toBe(receipt.cursor);
  expect(current?.state).toBeInstanceOf(Uint8Array);
  f.setStored({ state: current!.state, text: "stored projection", cursor: receipt.cursor, restoreRevision: "r" });
  expect(await f.documents.read("doc")).toEqual({ state: current!.state, text: "stored projection", cursor: receipt.cursor });
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
    expect(f.events.at(-1)?.data).toMatchObject({ actor, originNodeId: sharedTextNodeId, originPeerId: null, kind: "sync" });
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

test("prepared range transactions preserve stored relative positions and replay idempotently", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  const f = fixture();
  let prepared: Uint8Array | undefined;
  let inserted: Uint8Array | undefined;
  try {
    await f.append("before target after");
    const result = await f.documents.edit("doc", { actor: { kind: "service_account", id: "reviewer" } }, (current) => {
      const doc = new Y.Doc();
      doc.clientID = 200;
      try {
        Y.applyUpdate(doc, current.state());
        const vector = Y.encodeStateVector(doc);
        const text = doc.getText(SHARED_TEXT_NAME);
        doc.transact(() => {
          text.delete(7, 6);
          text.insert(7, "replacement");
          doc.getMap("operations").set("accept-1", true);
        });
        inserted = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 7, 0));
        prepared = Y.encodeStateAsUpdate(doc, vector);
        return { update: prepared };
      } finally {
        doc.destroy();
      }
    });
    expect(result).toMatchObject({ status: "edited", text: "before replacement after" });
    expect(f.saves).toHaveLength(1);
    const replay = new Y.Doc();
    try {
      Y.applyUpdate(replay, f.saves[0]!.input.state);
      const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(inserted!), replay, false);
      expect(absolute?.index).toBe(7);
      expect(replay.getMap("operations").get("accept-1")).toBeTrue();
    } finally {
      replay.destroy();
    }
    const retry = await f.documents.edit("doc", { actor: null }, () => ({ update: prepared! }));
    expect(retry).toMatchObject({ status: "edited", text: "before replacement after" });
    expect(f.saves.at(-1)?.input.text).toBe("before replacement after");
  } finally {
    clock.mockRestore();
  }
});

test("server edits preserve unchanged identities and a concurrent middle insertion between distant changes", async () => {
  const f = fixture();
  const before = "First old paragraph\n\nMiddle stable 😀 paragraph\n\nThird old paragraph\n";
  await f.append(before);
  const current = await f.documents.read("doc");
  const browser = new Y.Doc();
  const saved = new Y.Doc();
  try {
    Y.applyUpdate(browser, current!.state!);
    const position = Y.createRelativePositionFromTypeIndex(browser.getText(SHARED_TEXT_NAME), before.indexOf("stable"));
    const vector = Y.encodeStateVector(browser);
    browser.getText(SHARED_TEXT_NAME).insert(before.indexOf("stable"), "client ");
    const next = before.replaceAll("old", "NEW WORDS");
    const expected = next.replace("stable", "client stable");
    expect(
      await f.documents.edit("doc", { actor: null }, ({ text }) => {
        expect(text).toBe(before);
        f.events.push({
          cursor: "s6t.fixture.2",
          data: {
            kind: "sync",
            payload: toBase64(Y.encodeStateAsUpdate(browser, vector)),
            originNodeId: "browser",
            originPeerId: "peer",
          },
        });
        return next;
      }),
    ).toMatchObject({ status: "edited", text: expected });
    Y.applyUpdate(saved, f.saves[0]!.input.state);
    const savedText = saved.getText(SHARED_TEXT_NAME);
    const resolved = Y.createAbsolutePositionFromRelativePosition(position, saved, false);
    expect(resolved?.type === savedText).toBe(true);
    expect(savedText.toString()).toBe(expected);
    expect(expected.slice(resolved!.index, resolved!.index + "stable 😀".length)).toBe("stable 😀");
  } finally {
    browser.destroy();
    saved.destroy();
  }
});
