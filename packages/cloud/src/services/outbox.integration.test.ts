import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { createPgOutbox } from "./outbox";

const TABLE = "ai.live_invalidation_outbox";

const canUseOutboxTable = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ outbox: string | null }[]>`SELECT to_regclass(${TABLE})::text AS outbox`;
    return Boolean(row?.outbox);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseOutboxTable()) ? describe : describe.skip;

type Row = { id: string; audience_user_id: string; attempts: number };

const enqueue = async (audienceUserId: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ai.live_invalidation_outbox (change_id, audience_user_id, domains)
    VALUES (gen_random_uuid(), ${audienceUserId}::uuid, ARRAY['conversation-list']::text[])
    RETURNING id::text
  `;
  return row!.id;
};

const mine = (rows: Row[], audienceUserId: string): Row[] => rows.filter((row) => row.audience_user_id === audienceUserId);

suite("services.outbox", () => {
  test("retries failed deliveries with backoff and blocks later rows of an ordered key", async () => {
    const audienceUserId = crypto.randomUUID();
    const published: string[] = [];
    const outbox = createPgOutbox<Row>({
      table: TABLE,
      name: "test:outbox",
      publish: async (row) => {
        published.push(row.id);
      },
      reconcileIntervalMs: 60_000,
      orderBy: "audience_user_id",
      maxAttempts: 2,
    });
    try {
      const first = await enqueue(audienceUserId);
      const second = await enqueue(audienceUserId);

      const claimed = mine(await outbox.claim(), audienceUserId);
      expect(claimed.map((row) => row.id)).toEqual([first]);
      await outbox.dispatch(claimed[0]!, async () => {
        throw new Error("topic unavailable");
      });
      const [failed] = await sql<{ attempts: number; delivered_at: Date | null; dead_at: Date | null; last_error: string | null }[]>`
        SELECT attempts, delivered_at, dead_at, last_error FROM ai.live_invalidation_outbox WHERE id = ${first}::uuid
      `;
      expect(failed).toMatchObject({ attempts: 1, delivered_at: null, dead_at: null, last_error: "topic unavailable" });
      expect(mine(await outbox.claim(), audienceUserId)).toEqual([]);

      await sql`UPDATE ai.live_invalidation_outbox SET next_attempt_at = now() WHERE id = ${first}::uuid`;
      expect(await outbox.reconcile()).toBeGreaterThanOrEqual(2);
      expect(published).toEqual([first, second]);
      const [pending] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM ai.live_invalidation_outbox
        WHERE audience_user_id = ${audienceUserId}::uuid AND delivered_at IS NULL
      `;
      expect(pending?.count).toBe(0);
    } finally {
      await sql`DELETE FROM ai.live_invalidation_outbox WHERE audience_user_id = ${audienceUserId}::uuid`;
    }
  });

  test("marks a row dead after maxAttempts and stops claiming it", async () => {
    const audienceUserId = crypto.randomUUID();
    const outbox = createPgOutbox<Row>({
      table: TABLE,
      name: "test:outbox",
      publish: async () => {
        throw new Error("always failing");
      },
      reconcileIntervalMs: 60_000,
      maxAttempts: 1,
    });
    try {
      const id = await enqueue(audienceUserId);
      const [row] = mine(await outbox.claim(), audienceUserId);
      expect(row?.id).toBe(id);
      await outbox.dispatch(row!);
      const [dead] = await sql<{ attempts: number; dead_at: Date | null }[]>`
        SELECT attempts, dead_at FROM ai.live_invalidation_outbox WHERE id = ${id}::uuid
      `;
      expect(dead?.attempts).toBe(1);
      expect(dead?.dead_at).not.toBeNull();
      await sql`UPDATE ai.live_invalidation_outbox SET next_attempt_at = now() WHERE id = ${id}::uuid`;
      expect(mine(await outbox.claim(), audienceUserId)).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.live_invalidation_outbox WHERE audience_user_id = ${audienceUserId}::uuid`;
    }
  });

  test("claims unordered rows in one batch without dead-letter columns", async () => {
    const audienceUserId = crypto.randomUUID();
    const outbox = createPgOutbox<Row>({
      table: TABLE,
      name: "test:outbox",
      publish: async () => {},
      reconcileIntervalMs: 60_000,
    });
    try {
      const ids = [await enqueue(audienceUserId), await enqueue(audienceUserId)];
      expect(
        mine(await outbox.claim(), audienceUserId)
          .map((row) => row.id)
          .sort(),
      ).toEqual([...ids].sort());
    } finally {
      await sql`DELETE FROM ai.live_invalidation_outbox WHERE audience_user_id = ${audienceUserId}::uuid`;
    }
  });

  test("rejects unsafe identifiers", () => {
    expect(() =>
      createPgOutbox<Row>({ table: "ai.outbox; DROP TABLE x", name: "t", publish: async () => {}, reconcileIntervalMs: 1 }),
    ).toThrow(/Invalid outbox table/);
  });
});
