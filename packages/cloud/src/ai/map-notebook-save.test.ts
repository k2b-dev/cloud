import { describe, expect, test } from "bun:test";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { GeoRouteSchema } from "../contracts/geo-route";
import { type MapNotebookSaveCheckpoint, type MapNotebookSaveOptions, saveMapNotebook } from "./map-notebook-save";

const contentHash = (content: string) => `sha256:${new Bun.CryptoHasher("sha256").update(content).digest("hex")}`;
const route = () => {
  const provenance = {
    provider: "geoapify",
    computedAt: "2026-10-22T00:00:00Z",
    attribution: { text: "Geoapify · OpenStreetMap", links: ["https://www.geoapify.com/", "https://www.openstreetmap.org/copyright"] },
  };
  const shared = {
    polyline6: "\\\\".repeat(40_000),
    distanceMeters: 100,
    durationSeconds: 60,
    simplificationToleranceMeters: 0,
    provenance,
  };
  const document = GeoRouteSchema.parse({
    ...shared,
    inputHash: "a".repeat(64),
    options: { mode: "car" },
    stops: Array.from({ length: 4 }, (_, index) => ({ id: String(index), point: { lat: index, lon: index }, label: "東京😀" })),
    legs: Array.from({ length: 3 }, (_, index) => ({ ...shared, fromStopId: String(index), toStopId: String(index + 1), options: {} })),
  });
  return `# Trip 😀\n\n:::geo\n${JSON.stringify({ version: 1, pins: [], route: document })}\n:::\n\n:::geo\n{"version":1,"pins":[]}\n:::\n`;
};
const hasSplitSurrogate = (text: string) => /[\uD800-\uDBFF]$/.test(text) || /^[\uDC00-\uDFFF]/.test(text);

function fixture(content: string) {
  let stored = "";
  let checkpoint: MapNotebookSaveCheckpoint | undefined;
  let creates = 0;
  let edits = 0;
  let reads = 0;
  let lostCreate = false;
  let lostAppend = false;
  let skipAppend = false;
  let failRead = false;
  let abortAfterCreate: AbortController | undefined;
  let beforeAppend: (() => void) | undefined;
  const attempts: string[] = [];
  const snapshots: MapNotebookSaveCheckpoint[] = [];
  const options: MapNotebookSaveOptions = {
    content,
    notebookId: "book01",
    sourceKey: "map-123:revision-7",
    onCheckpoint: (next) => {
      checkpoint = structuredClone(next);
      snapshots.push(checkpoint);
    },
    client: {
      fetch: async (url, init) => {
        expect(new TextEncoder().encode(String(init?.body)).byteLength).toBeLessThanOrEqual(CAPABILITY_MAX_REQUEST_BYTES);
        const input = JSON.parse(String(init?.body)).input;
        const key = new Headers(init?.headers).get("idempotency-key");
        if (String(url).endsWith("note.create")) {
          expect(checkpoint?.pending?.kind).toBe("create");
          expect(key).toBe(checkpoint?.pending?.key ?? "");
          expect(input.content.length).toBeLessThanOrEqual(200_000);
          expect(hasSplitSurrogate(input.content)).toBeFalse();
          creates++;
          stored = input.content;
          if (lostCreate) throw new Error("response lost after commit");
          abortAfterCreate?.abort();
          return Response.json({ data: { id: "note01", notebookId: "book01" } });
        }
        if (String(url).endsWith("note.read")) {
          reads++;
          expect(input).toEqual({ id: "note01", contentLimit: 1 });
          expect(key).toBeNull();
          if (failRead) throw new Error("read unavailable");
          return Response.json({ data: { id: "note01", notebookId: "book01", contentHash: contentHash(stored) } });
        }
        expect(String(url)).toEndWith("note.edit");
        expect(key).toBeNull(); // This Action rejects platform idempotency keys.
        expect(checkpoint?.pending?.kind).toBe("append");
        attempts.push(checkpoint!.pending!.key);
        expect(input.blockLimit).toBe(0);
        expect(input.operations.length).toBeGreaterThan(0);
        expect(input.operations.length).toBeLessThanOrEqual(20);
        beforeAppend?.();
        if (input.ifContentHash !== contentHash(stored)) {
          return Response.json({ code: "CONFLICT", message: "Changed" }, { status: 409 });
        }
        const beforeHash = contentHash(stored);
        edits++;
        for (const op of input.operations) {
          expect(op.kind).toBe("append");
          expect(op.separator).toBe("none");
          expect(op.content.length).toBeLessThanOrEqual(10_000);
          expect(hasSplitSurrogate(op.content)).toBeFalse();
          if (!skipAppend) stored += op.content;
        }
        if (lostAppend) {
          lostAppend = false;
          throw new Error("append answer lost");
        }
        return Response.json({ data: { beforeHash, afterHash: contentHash(stored) } });
      },
    },
  };
  return {
    options,
    snapshots,
    attempts,
    get stored() {
      return stored;
    },
    set stored(value) {
      stored = value;
    },
    get checkpoint() {
      return checkpoint;
    },
    get creates() {
      return creates;
    },
    get edits() {
      return edits;
    },
    get reads() {
      return reads;
    },
    loseCreate() {
      lostCreate = true;
    },
    loseAppend(apply = true) {
      lostAppend = true;
      skipAppend = !apply;
    },
    allowAppend() {
      skipAppend = false;
    },
    failRead() {
      failRead = true;
    },
    abortCreate(controller: AbortController) {
      abortAfterCreate = controller;
    },
    beforeAppend(callback: () => void) {
      beforeAppend = callback;
    },
    resume() {
      return saveMapNotebook({ ...options, checkpoint });
    },
  };
}

describe("map Notebook saving over the public capability client", () => {
  test("small exact Markdown uses one create and verifies its full hash", async () => {
    const f = fixture("# Map\n\n東京😀\n");
    expect((await saveMapNotebook(f.options)).status).toBe("saved");
    expect(f.creates).toBe(1);
    expect(f.edits).toBe(0);
    expect(f.reads).toBe(1);
    expect(f.stored).toBe(f.options.content);
    expect((await f.resume()).status).toBe("saved");
    expect(f.creates).toBe(1);
  });
  test("route JSON over 200k and 256KiB round-trips with bounded batches and multiple documents", async () => {
    const f = fixture(route());
    expect(f.options.content.length).toBeGreaterThan(200_000);
    expect(new TextEncoder().encode(JSON.stringify({ input: { content: f.options.content } })).length).toBeGreaterThan(
      CAPABILITY_MAX_REQUEST_BYTES,
    );
    expect((await saveMapNotebook(f.options)).status).toBe("saved");
    expect(f.edits).toBeGreaterThan(2);
    expect(f.stored).toBe(f.options.content);
    expect(contentHash(f.stored)).toBe(contentHash(f.options.content));
    expect(JSON.stringify(f.snapshots.at(-1)).length).toBeLessThan(1000);
  });
  test("under-200k escaped source still splits to fit serialized request bytes", async () => {
    const f = fixture(`# Map\n${"\\".repeat(180_000)}`);
    expect((await saveMapNotebook(f.options)).status).toBe("saved");
    expect(f.edits).toBeGreaterThan(0);
    expect(f.stored).toBe(f.options.content);
  });
  test("create and append boundaries never split UTF-16 pairs", async () => {
    const f = fixture(`# Map\n${"😀東\\".repeat(100_000)}`);
    expect((await saveMapNotebook(f.options)).status).toBe("saved");
    expect(f.stored).toBe(f.options.content);
  });
  test("lost applied append is read and advanced without repeating it", async () => {
    const f = fixture(route());
    f.loseAppend();
    const first = await saveMapNotebook(f.options);
    expect(first.status).toBe("unknown");
    const applied = f.stored.length;
    expect(first.checkpoint?.pending?.end).toBe(applied);
    expect((await f.resume()).status).toBe("saved");
    expect(new Set(f.attempts).size).toBe(f.attempts.length);
    expect(f.stored).toBe(f.options.content);
    expect(f.creates).toBe(1);
  });
  test("an old hash after an uncertain append never proves no effect or triggers redispatch", async () => {
    const f = fixture(route());
    f.loseAppend(false);
    expect((await saveMapNotebook(f.options)).status).toBe("unknown");
    const pending = f.checkpoint!.pending!;
    const edits = f.edits;
    expect(await f.resume()).toMatchObject({ status: "unknown", code: "append_outcome_unknown", noteId: "note01" });
    expect(f.edits).toBe(edits);
    expect(f.checkpoint?.pending?.key).toBe(pending.key);
    // The delayed original can still publish after that query. Reconcile its after-hash next time.
    f.stored = f.options.content.slice(0, pending.end);
    f.allowAppend();
    expect((await f.resume()).status).toBe("saved");
    expect(f.attempts.filter((key) => key === pending.key)).toHaveLength(1);
    expect(f.stored).toBe(f.options.content);
  });
  test("external edits produce an accessible conflict and no overwrite", async () => {
    const f = fixture(route());
    f.loseAppend();
    await saveMapNotebook(f.options);
    f.stored += "\nExternal edit";
    const edits = f.edits;
    expect(await f.resume()).toMatchObject({
      status: "conflict",
      code: "content_changed",
      noteId: "note01",
      noteHref: "/open/notebooks.note/~note01",
    });
    expect(f.edits).toBe(edits);
  });
  test("external edits racing a batch fail the hash guard without overwriting them", async () => {
    const f = fixture(route());
    f.beforeAppend(() => {
      f.stored += "\nSomeone else's change";
    });
    expect((await saveMapNotebook(f.options)).status).toBe("conflict");
    expect(f.stored).toEndWith("Someone else's change");
  });
  test("unknown create never creates again, regardless of elapsed claim retention", async () => {
    const f = fixture(route());
    f.loseCreate();
    expect((await saveMapNotebook(f.options)).status).toBe("unknown");
    const persisted = JSON.parse(JSON.stringify(f.checkpoint));
    expect(await saveMapNotebook({ ...f.options, checkpoint: persisted })).toMatchObject({
      status: "unknown",
      code: "create_outcome_unknown",
      notebookHref: "/open/notebooks.notebook/~book01",
    });
    expect(f.creates).toBe(1);
    expect(f.edits).toBe(0);
  });
  test("cancellation retains a known note and explicit resume completes it", async () => {
    const controller = new AbortController();
    const f = fixture(route());
    f.abortCreate(controller);
    const first = await saveMapNotebook({ ...f.options, signal: controller.signal });
    expect(first).toMatchObject({ status: "cancelled", noteId: "note01" });
    expect(f.edits).toBe(0);
    expect((await f.resume()).status).toBe("saved");
    expect(f.creates).toBe(1);
  });
  test("failed checkpoint persistence prevents dispatch", async () => {
    const f = fixture(route());
    const outcome = await saveMapNotebook({
      ...f.options,
      onCheckpoint: () => {
        throw new Error("Storage full");
      },
    });
    expect(outcome).toMatchObject({ status: "error", message: "Storage full" });
    expect(f.creates).toBe(0);
    expect(outcome.checkpoint?.pending).toBeUndefined();
    expect((await saveMapNotebook({ ...f.options, checkpoint: outcome.checkpoint })).status).toBe("saved");
    expect(f.creates).toBe(1);
  });
  test("unavailable reconciliation returns unknown and never dispatches an append", async () => {
    const f = fixture(route());
    f.loseAppend();
    await saveMapNotebook(f.options);
    f.failRead();
    const edits = f.edits;
    expect((await f.resume()).status).toBe("unknown");
    expect(f.edits).toBe(edits);
  });
  test("changed export or revision never resumes an older checkpoint", async () => {
    const f = fixture(route());
    f.loseAppend();
    await saveMapNotebook(f.options);
    for (const change of [{ content: f.options.content + "\n" }, { sourceKey: "different-revision" }, { notebookId: "book02" }]) {
      expect((await saveMapNotebook({ ...f.options, ...change, checkpoint: f.checkpoint })).status).toBe("conflict");
    }
  });
  test("invalid title fails before creating a note with altered content", async () => {
    const f = fixture("No existing heading");
    expect((await saveMapNotebook(f.options)).status).toBe("error");
    expect(f.creates).toBe(0);
  });
  test("a definitive create rejection is visible and an explicit retry uses a new key", async () => {
    const f = fixture("# Map\nbody");
    const fetch = f.options.client!.fetch!;
    const keys: (string | null)[] = [];
    f.options.client = {
      fetch: async (url, init) => {
        if (String(url).endsWith("note.create")) {
          keys.push(new Headers(init?.headers).get("idempotency-key"));
          if (keys.length === 1) return Response.json({ code: "FORBIDDEN", message: "Permission denied" }, { status: 403 });
        }
        return fetch(url, init);
      },
    };
    expect(await saveMapNotebook(f.options)).toMatchObject({ status: "error", code: "FORBIDDEN" });
    expect(f.checkpoint?.pending).toBeUndefined();
    expect(f.creates).toBe(0);
    expect((await f.resume()).status).toBe("saved");
    expect(keys[0]).not.toBe(keys[1]);
  });
  test("a proven rejected append retries only on explicit resume, with a new attempt and hash", async () => {
    const f = fixture(route());
    const fetch = f.options.client!.fetch!;
    const attempts: string[] = [];
    f.options.client = {
      fetch: async (url, init) => {
        if (String(url).endsWith("note.edit")) {
          attempts.push(f.checkpoint!.pending!.key);
          if (attempts.length === 1) return Response.json({ code: "FORBIDDEN", message: "Approval required" }, { status: 403 });
        }
        return fetch(url, init);
      },
    };
    expect(await saveMapNotebook(f.options)).toMatchObject({ status: "error", code: "FORBIDDEN", noteId: "note01" });
    expect(f.checkpoint?.pending).toBeUndefined();
    expect(f.edits).toBe(0);
    expect((await f.resume()).status).toBe("saved");
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(f.stored).toBe(f.options.content);
  });
  test("cancelling in the pre-dispatch callback leaves a known unsent checkpoint", async () => {
    const f = fixture("# Map\nbody");
    const controller = new AbortController();
    const remember = f.options.onCheckpoint;
    const outcome = await saveMapNotebook({
      ...f.options,
      signal: controller.signal,
      onCheckpoint: async (next) => {
        await remember(next);
        controller.abort();
      },
    });
    expect(outcome.status).toBe("cancelled");
    expect(outcome.checkpoint?.pending).toBeUndefined();
    expect(f.creates).toBe(0);
    expect((await f.resume()).status).toBe("saved");
  });
});
