import { expect, test } from "bun:test";

test("define lists the exact log and recovers retained updates with bounded forward progress", async () => {
  // Keep the process Sync mock local to this subprocess, including when this
  // file is run with the other shared-text unit files.
  const fixture = `
    import { expect, mock } from "bun:test";
    import { RetentionGapError } from "@k2b/sync";
    import * as Y from "yjs";
    let entries = [];
    const listings = [];
    let replay;
    const cursor = seq => "s6t.fixture." + seq;
    const topic = { cursorAt: cursor, replay: options => replay(options) };
    mock.module("../_internal/process-sync", () => ({ getProcessSync: () => ({
      topic: () => topic,
      listTopics: async function* (options) { listings.push(options); yield* entries; },
    }) }));
    const { sharedText } = await import("./log");
    const { toBase64, SHARED_TEXT_NAME } = await import("./events");
    const log = sharedText.define({ id: "test.text", retention: { maxAgeMs: 604800000, maxBytes: 1024 } });
    entries = [{ id: "test.text.child", firstSequence: 1 }, { id: "test.text", firstSequence: 7 }];
    expect(await log.firstSequence()).toBe(7);
    expect(listings).toEqual([{ idPrefix: "test.text" }]);
    entries = [{ id: "test.text.child", firstSequence: 1 }];
    expect(await log.firstSequence()).toBe(0);

    const source = new Y.Doc();
    source.clientID = 1;
    const recovered = new Y.Doc();
    const reloaded = new Y.Doc();
    try {
      source.getText(SHARED_TEXT_NAME).insert(0, "MISSING");
      const predecessor = Y.encodeStateAsUpdate(source);
      const vector = Y.encodeStateVector(source);
      source.getText(SHARED_TEXT_NAME).insert(7, " RETAINED");
      source.getText(SHARED_TEXT_NAME).delete(0, 7);
      const pending = Y.encodeStateAsUpdate(source, vector);
      const calls = [];
      replay = async function* (options) {
        calls.push(options);
        if (options.after === cursor(0)) throw new RetentionGapError(cursor(0), cursor(3), cursor(2));
        if (options.after === cursor(6)) return;
        yield { cursor: cursor(3), data: { kind: "sync", payload: "bad base64!" } };
        yield { cursor: cursor(4), data: { kind: "sync", payload: toBase64(pending) } };
        if (options.after === cursor(2)) throw new RetentionGapError(cursor(4), cursor(7), cursor(6));
      };
      const signal = new AbortController().signal;
      expect(await log.recover({ docId: "doc", after: null, until: cursor(8), doc: recovered, signal })).toEqual({ recoveredUpdates: 1, malformedUpdates: 1, historyGaps: 2 });
      expect(calls.map(call => call.after)).toEqual([cursor(0), cursor(2), cursor(6)]);
      expect(calls.every(call => call.until === cursor(8) && call.signal === signal)).toBe(true);
      expect(recovered.store.pendingStructs).not.toBeNull();
      Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(recovered));
      Y.applyUpdate(reloaded, predecessor);
      expect(reloaded.getText(SHARED_TEXT_NAME).toString()).toBe(" RETAINED");

      let count = 0;
      replay = async function* () { count++; throw new RetentionGapError(cursor(0), cursor(12), cursor(11)); };
      expect(await log.recover({ docId: "doc", after: cursor(0), until: cursor(8), doc: recovered })).toEqual({ recoveredUpdates: 0, malformedUpdates: 0, historyGaps: 1 });
      expect(count).toBe(1);
      for (const resumeAfter of [undefined, cursor(0)]) {
        const gap = new RetentionGapError(cursor(0), cursor(3), resumeAfter);
        replay = async function* () { throw gap; };
        await expect(log.recover({ docId: "doc", after: cursor(0), until: cursor(8), doc: recovered })).rejects.toBe(gap);
      }
      const failure = new Error("transport");
      replay = async function* () { throw failure; };
      await expect(log.recover({ docId: "doc", after: cursor(0), until: cursor(8), doc: recovered })).rejects.toBe(failure);
      const abort = new AbortController();
      abort.abort(new Error("cancelled"));
      await expect(log.recover({ docId: "doc", after: cursor(0), until: cursor(8), doc: recovered, signal: abort.signal })).rejects.toThrow("cancelled");
      const cancelledAtEnd = new AbortController();
      replay = async function* () { cancelledAtEnd.abort(new Error("at end")); };
      await expect(log.recover({ docId: "doc", after: cursor(0), until: cursor(8), doc: recovered, signal: cancelledAtEnd.signal })).rejects.toThrow("at end");
    } finally { source.destroy(); recovered.destroy(); reloaded.destroy(); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", fixture], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", timeout: 4000 });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, output: code === 0 ? "passed" : out + err }).toEqual({ code: 0, output: "passed" });
});
