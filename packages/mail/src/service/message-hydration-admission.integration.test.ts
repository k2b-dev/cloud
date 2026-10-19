import { afterAll, beforeAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { hydrateMessageFromSource } from "./message-hydration";
import { MAIL_PROCESSING_MEMORY_BUDGET_BYTES, processingMemoryState, withProcessingMemory } from "./processing-memory-budget";

const suite = suiteFor("database", "nats", "valkey");

const within = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for hydration admission failure")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

suite("Mail hydration memory admission", () => {
  const mailboxId = crypto.randomUUID();

  beforeAll(async () => {
    await migrate();
    await sql`
      INSERT INTO mail.mailboxes (id, short_id, name)
      VALUES (${mailboxId}::uuid, ${newShortId()}, 'Hydration admission tests')
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
  });

  test("a source error while queued releases the waiter and claim with the original retryable error", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, '<admission@example.test>',
        ${new Date("2026-01-01T00:00:00Z")}, 256, ${"a".repeat(64)}, 'headers'
      ) RETURNING id
    `;
    if (!message) throw new Error("Failed to create hydration test message");

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withProcessingMemory({ weightBytes: MAIL_PROCESSING_MEMORY_BUDGET_BYTES, label: "admission test" }, async () => {
      started.resolve();
      await release.promise;
    });
    const source = new PassThrough();
    // Let the regression reach the bounded rejection assertion even if hydration loses the event.
    const observeError = (): void => {};
    source.on("error", observeError);
    const cancelled = new AbortController();
    let hydration: ReturnType<typeof hydrateMessageFromSource> | undefined;
    let settled: Promise<unknown> | undefined;
    let waiting = true;
    try {
      await within(started.promise);
      hydration = hydrateMessageFromSource({ messageId: message.id, source, signal: cancelled.signal });
      settled = hydration.catch(() => undefined);
      try {
        await within(
          (async () => {
            while (waiting && processingMemoryState().waiting === 0) await Bun.sleep(1);
          })(),
        );
      } finally {
        waiting = false;
      }
      expect(processingMemoryState()).toMatchObject({
        inFlightBytes: MAIL_PROCESSING_MEMORY_BUDGET_BYTES,
        inFlightCount: 1,
        waiting: 1,
      });

      const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      // ImapFlow forwards this event without destroying or ending the download stream.
      source.emit("error", error);
      await expect(within(hydration)).rejects.toBe(error);
      expect(source.destroyed).toBe(true);
      expect(source.listeners("error")).toEqual([observeError]);
      expect(processingMemoryState()).toMatchObject({
        inFlightBytes: MAIL_PROCESSING_MEMORY_BUDGET_BYTES,
        inFlightCount: 1,
        waiting: 0,
      });
      const [state] = await sql`
        SELECT hydration_status, hydration_attempt, hydration_error_code, hydration_claim_id, hydration_claimed_at, source_blob_id
        FROM mail.message_contents WHERE id = ${message.id}::uuid
      `;
      expect(state).toEqual({
        hydration_status: "failed",
        hydration_attempt: 1,
        hydration_error_code: "ECONNRESET",
        hydration_claim_id: null,
        hydration_claimed_at: null,
        source_blob_id: null,
      });
    } finally {
      waiting = false;
      cancelled.abort();
      source.destroy();
      release.resolve();
      await held;
      if (settled) await within(settled);
      source.off("error", observeError);
    }
    expect(processingMemoryState()).toMatchObject({ inFlightBytes: 0, inFlightCount: 0, waiting: 0 });
  }, 20_000);
});
