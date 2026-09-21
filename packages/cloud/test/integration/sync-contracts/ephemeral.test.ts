import { afterAll, beforeAll, expect, test } from "bun:test";
import type { EphemeralEvent } from "@k2b/sync";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync, until } from "./harness";

const suite = natsSuite();

suite("ephemeral contract", () => {
  let fixture: Awaited<ReturnType<typeof openSync>>;

  beforeAll(async () => {
    fixture = await openSync("ephemeral");
  });
  afterAll(async () => {
    await fixture?.close();
  });

  test("an entry expires after its TTL and watch observes the upsert and the expiry", async () => {
    const presence = fixture.sync.ephemeral<{ node: string }>({ id: "contract", ttlMs: 1_000 });
    await presence.ready();
    const events: EphemeralEvent<{ node: string }>[] = [];
    const abort = new AbortController();
    const watching = (async () => {
      for await (const event of presence.watch({ signal: abort.signal })) events.push(event);
    })().catch(() => undefined);
    try {
      const entry = await presence.upsert({ key: "worker-1", value: { node: "a" } });
      expect(entry.expiresAt).toBeInstanceOf(Date);
      expect((await presence.snapshot()).entries.map((item) => item.key)).toEqual(["worker-1"]);
      await until(() => events.some((event) => event.type === "expire" && event.key === "worker-1"), 5_000, "the expiry event");
      expect((await presence.snapshot()).entries).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(["upsert", "expire"]);
    } finally {
      abort.abort();
      await watching;
    }
  });
});
