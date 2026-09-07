import { expect, test } from "bun:test";

test("explicit batch retries retain a wakeup while the previous worker is completing", async () => {
  // Isolate module mocks from other notification tests; no database or provider
  // is used. The previous worker has already sampled remaining=0 but still
  // owns its coalescing claim until its handler returns.
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const batchId = "00000000-0000-4000-8000-000000000001";
    const userId = "00000000-0000-4000-8000-000000000002";
    const row = {
      id: batchId, subject: "Retry", body_markdown: "Body", body_html: "Body",
      selection: {}, selection_hash: "hash", status: "completed_with_errors",
      created_at: new Date(), completed_at: new Date(),
    };
    let recipientStatus = "error";
    const queued = [];
    const claims = new Set([batchId]);
    const sql = async (parts) => {
      const query = parts.join("?");
      if (query.includes("SET status = 'pending'")) {
        assert.equal(recipientStatus, "error");
        recipientStatus = "pending";
        return [{ user_id: userId }];
      }
      if (query.includes("SELECT * FROM notifications.batches")) return [row];
      if (query.includes("UPDATE notifications.batches")) return [row];
      throw new Error("Unexpected SQL: " + query);
    };
    // Bun's native sql export cannot be replaced with mock.module("bun").
    // Redirect only this module's SQL import to the in-memory fixture.
    globalThis.batchRetrySql = sql;
    Bun.plugin({
      name: "notification-batch-sql-fixture",
      setup(build) {
        build.onLoad({ filter: /[\\/]notifications[\\/]batches\\.ts$/ }, async ({ path }) => ({
          contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.batchRetrySql;'),
          loader: "ts",
        }));
      },
    });
    mock.module(${JSON.stringify(new URL("../../_internal/process-sync.ts", import.meta.url).pathname)}, () => ({
      lazySync: () => () => ({
        submit: async (input) => {
          assert.ok(new TextEncoder().encode(input.key).length <= 96, "Sync job keys are limited to 96 bytes");
          if (input.coalesce && claims.has(input.key)) return { jobId: "completing", duplicate: true };
          queued.push(input);
          return { jobId: "retry-" + queued.length, duplicate: false };
        },
      }),
    }));
    mock.module(${JSON.stringify(new URL("../logging/index.ts", import.meta.url).pathname)}, () => ({ logger: () => ({}), trace: {} }));
    mock.module(${JSON.stringify(new URL("../../shared/markdown.ts", import.meta.url).pathname)}, () => ({ markdown: {} }));
    mock.module(${JSON.stringify(new URL("../postgres.ts", import.meta.url).pathname)}, () => ({
      parsePgJsonValue: value => value, toPgTextArray: value => value, toPgUuidArray: value => value,
    }));
    mock.module(${JSON.stringify(new URL("./email.ts", import.meta.url).pathname)}, () => ({
      sendEmail: () => { throw new Error("Provider must not be called"); },
    }));
    mock.module(${JSON.stringify(new URL("../sync-ops.ts", import.meta.url).pathname)}, () => ({ syncOps: {} }));
    const { retryFailed, retryRecipient } = await import(${JSON.stringify(new URL("./batches.ts", import.meta.url).pathname)});
    for (const retry of [() => retryFailed({ id: batchId }), () => retryRecipient({ id: batchId, userId })]) {
      recipientStatus = "error";
      claims.add(batchId);
      queued.length = 0;
      const result = await retry();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(recipientStatus, "pending");
      // Completion of the older handler cannot enqueue anything: its earlier
      // pending-count snapshot was zero. Only the explicit retry can wake work.
      claims.delete(batchId);
      assert.equal(queued.length, 1, "retry wakeup was swallowed by the completing worker");
      assert.deepEqual(queued[0].input, { batchId });
      assert.notEqual(queued[0].key, batchId);
      assert.equal(result.data.jobId, "retry-1");
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
