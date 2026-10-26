import { expect, test } from "bun:test";
import { StoreFullError } from "@k2b/sync";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync, until } from "../../../test/integration/sync-contracts/harness";

natsSuite()("workflow AI delivery admission", () => {
  test("rejects excess coalesced work and preserves accepted work", async () => {
    const fixture = await openSync("workflow-ai-full");
    const job = fixture.sync.job<string>({
      id: "ai-reject", whenFull: "reject",
      retention: { maxMessages: 1, maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    });
    try {
      await job.submit({ key: "first", input: "first", coalesce: true });
      await expect(job.submit({ key: "second", input: "second", coalesce: true })).rejects.toBeInstanceOf(StoreFullError);
      const received: string[] = [];
      const worker = await job.process({}, async ({ input }) => { received.push(input); });
      try {
        await until(() => received.length === 1);
        expect(received).toEqual(["first"]);
      } finally { worker.stop(); await worker.drain(); }
    } finally { await fixture.close(); }
  });
});
