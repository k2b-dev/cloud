import { expect, setSystemTime } from "bun:test";
import { getProcessSync } from "@k2b/cloud";
import { sharedText } from "@k2b/cloud/shared-text";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectTestNats, testFor } from "../../../../scripts/fixtures/test-infra";
import { mailDraftDocumentLog } from "./draft-document-log";

const NOW = new Date("2026-11-13T12:00:00Z");
testFor("database", "nats")("Mail prepares a larger lifecycle budget without losing fences or shrinking operator limits", async () => {
  setSystemTime(NOW);
  const connection = await connectTestNats();
  const manager = await jetstreamManager(connection);
  try {
    const previous = sharedText.define({ ...mailDraftDocumentLog.topicConfig, lifecycle: { maxBytes: 16 * 1024 * 1024 } });
    await previous.ready();
    const namespace = (await getProcessSync().resources()).find((resource) => resource.id === mailDraftDocumentLog.id)?.namespace;
    expect(namespace).toBeDefined();
    const streams = [];
    for await (const stream of manager.streams.list())
      if (
        stream.config.metadata?.["cloud.shared-text.lifecycle"] === mailDraftDocumentLog.id &&
        stream.config.metadata?.["sync.namespace"] === namespace
      )
        streams.push(stream);
    expect(streams).toHaveLength(1);
    const name = streams[0]!.config.name;
    expect((await manager.streams.info(name)).config.max_bytes).toBe(16 * 1024 * 1024);
    // Use three-digit lifecycle CAS revisions, as in an already used stream.
    let warmup = await previous.lifecycle!.put("warmup", null, { state: "open" });
    for (let index = 1; index < 100; index++) warmup = await previous.lifecycle!.put("warmup", warmup, { state: "open" });
    const before = await manager.streams.info(name);
    const topic = mailDraftDocumentLog.topic();
    const value = {
      state: "closed",
      freezeCursor: topic.cursorAt(1_234_567),
      closeCursor: topic.cursorAt(1_234_568),
      restoreRevision: "1",
    } as const;
    for (let index = 0; index < 100; index++) {
      const frozen = await previous.lifecycle!.put(`closed-${index}`, null, {
        state: "frozen",
        freezeCursor: value.freezeCursor,
        restoreRevision: "1",
        expiresAt: NOW.getTime() + 60_000,
      });
      await previous.lifecycle!.put(`closed-${index}`, frozen, value);
    }
    const sample = await manager.streams.info(name);
    const bytesPerEntry = (sample.state.bytes - before.state.bytes) / 100;
    console.info("Mail lifecycle sizing sample", { entries: 100, jsonBytes: JSON.stringify(value).length, bytesPerEntry });
    // Planning budget: 1,000 sends/day for three years, below the warning threshold.
    expect(bytesPerEntry * 1_000 * 365 * 3).toBeLessThan(512 * 1024 * 1024 * 0.8);

    await mailDraftDocumentLog.ready();
    const expanded = await manager.streams.info(name);
    expect(expanded.config.max_bytes).toBe(512 * 1024 * 1024);
    expect(expanded.state.bytes).toBe(sample.state.bytes);
    expect(expanded.state.messages).toBe(101);
    expect(await mailDraftDocumentLog.lifecycle!.get("closed-0")).toMatchObject({ value });

    await manager.streams.update(name, { max_bytes: 768 * 1024 * 1024 });
    await sharedText.define({ ...mailDraftDocumentLog.topicConfig, lifecycle: { maxBytes: 512 * 1024 * 1024 } }).ready();
    await sharedText.define({ ...mailDraftDocumentLog.topicConfig, lifecycle: { maxBytes: 16 * 1024 * 1024 } }).ready();
    expect((await manager.streams.info(name)).config.max_bytes).toBe(768 * 1024 * 1024);
    expect(await previous.lifecycle!.get("closed-0")).toMatchObject({ value });
  } finally {
    await connection.drain();
    setSystemTime();
  }
});
