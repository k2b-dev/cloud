import { afterAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { beginMailboxHydration, finishMailboxHydration, publishPendingHydrationWork, requestMailboxHydration } from "./hydration-work";

const suite = suiteFor("database", "nats", "valkey");

suite("mail durable hydration wake", () => {
  const mailboxIds: string[] = [];
  const mailbox = async (): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Hydration work fixture') RETURNING id
    `;
    if (!row) throw new Error("Could not create hydration fixture mailbox");
    mailboxIds.push(row.id);
    return row.id;
  };
  afterAll(async () => {
    for (const id of mailboxIds) await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
  });

  test("requests merge while running, completion allocates one successor, and stale redelivery cannot retire it", async () => {
    const mailboxId = await mailbox();
    const first = await requestMailboxHydration(sql, mailboxId);
    expect(await beginMailboxHydration(first, "fixture")).toEqual({ retryBodies: false });
    for (let index = 0; index < 16; index += 1) {
      expect(await requestMailboxHydration(sql, mailboxId)).toEqual(first);
    }
    await finishMailboxHydration(first, false, "fixture");
    const [successor] = await sql<{ mailbox_id: string; job_id: string }[]>`
      SELECT mailbox_id, job_id FROM mail.hydration_work WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(successor?.job_id).toBeString();
    expect(successor?.job_id).not.toBe(first.job_id);
    expect(await beginMailboxHydration(first, "fixture")).toBeNull();
    await finishMailboxHydration(first, false, "fixture");
    expect(await beginMailboxHydration(successor!, "fixture")).toEqual({ retryBodies: false });
    await finishMailboxHydration(successor!, false, "fixture");
    const [idle] = await sql<{ job_id: string | null; requested_again_at: Date | null }[]>`
      SELECT job_id, requested_again_at FROM mail.hydration_work WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(idle).toEqual({ job_id: null, requested_again_at: null });
    const afterCompletion = await requestMailboxHydration(sql, mailboxId);
    expect(afterCompletion.job_id).not.toBe(successor!.job_id);
    await beginMailboxHydration(afterCompletion, "fixture");
    await finishMailboxHydration(afterCompletion, false, "fixture");
  });

  test("trailing fresh work does not retry a failed body; a due request keeps its retry intent across contention", async () => {
    const mailboxId = await mailbox();
    const first = await requestMailboxHydration(sql, mailboxId);
    expect(await beginMailboxHydration(first, "fixture")).toEqual({ retryBodies: false });
    await requestMailboxHydration(sql, mailboxId, true);
    // The generation resubmits after a busy provider lease, consuming the new retry request.
    expect(await beginMailboxHydration(first, "fixture")).toEqual({ retryBodies: true });
    expect(await beginMailboxHydration(first, "fixture")).toEqual({ retryBodies: true });
    await requestMailboxHydration(sql, mailboxId);
    await finishMailboxHydration(first, false, "fixture");
    const [next] = await sql<{ mailbox_id: string; job_id: string }[]>`
      SELECT mailbox_id, job_id FROM mail.hydration_work WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(await beginMailboxHydration(next!, "fixture")).toEqual({ retryBodies: false });
    await finishMailboxHydration(next!, false, "fixture");
  });

  test("an expired delivery cannot retire the generation now owned by its redelivery", async () => {
    const work = await requestMailboxHydration(sql, await mailbox());
    await beginMailboxHydration(work, "expired");
    await beginMailboxHydration(work, "redelivery");
    await requestMailboxHydration(sql, work.mailbox_id);
    await finishMailboxHydration(work, false, "expired");
    const [stillOwned] = await sql<{ job_id: string; delivery_id: string; requested: boolean }[]>`
      SELECT job_id, delivery_id, requested_again_at IS NOT NULL AS requested
      FROM mail.hydration_work WHERE mailbox_id = ${work.mailbox_id}::uuid
    `;
    expect(stillOwned).toEqual({ job_id: work.job_id, delivery_id: "redelivery", requested: true });
    await finishMailboxHydration(work, false, "redelivery");
    const [next] = await sql<{ mailbox_id: string; job_id: string }[]>`
      SELECT mailbox_id, job_id FROM mail.hydration_work WHERE mailbox_id = ${work.mailbox_id}::uuid
    `;
    expect(next?.job_id).not.toBe(work.job_id);
    await beginMailboxHydration(next!, "next");
    await finishMailboxHydration(next!, false, "next");
  });

  test("rolling back the domain transaction rolls back the wake", async () => {
    const mailboxId = await mailbox();
    await expect(
      sql.begin(async (tx) => {
        await requestMailboxHydration(tx, mailboxId);
        throw new Error("Fixture rollback");
      }),
    ).rejects.toThrow("Fixture rollback");
    const rows = await sql`SELECT mailbox_id FROM mail.hydration_work WHERE mailbox_id = ${mailboxId}::uuid`;
    expect(rows).toHaveLength(0);
  });

  test("stopping publication leaves the generation due for a later process", async () => {
    const work = await requestMailboxHydration(sql, await mailbox());
    const attempted: string[] = [];
    await publishPendingHydrationWork(
      async (next) => {
        attempted.push(next.job_id);
      },
      work.mailbox_id,
      () => true,
    );
    expect(attempted).toEqual([]);
    const [pending] = await sql<{ published_at: Date | null }[]>`
      SELECT published_at FROM mail.hydration_work WHERE mailbox_id = ${work.mailbox_id}::uuid
    `;
    expect(pending?.published_at).toBeNull();
    await publishPendingHydrationWork(async (next) => {
      attempted.push(next.job_id);
    }, work.mailbox_id);
    expect(attempted).toEqual([work.job_id]);
  });

  test("a failed publication stays due and does not block the next mailbox; retries reuse the same generation", async () => {
    const first = await requestMailboxHydration(sql, await mailbox());
    const second = await requestMailboxHydration(sql, await mailbox());
    const attempted: string[] = [];
    for (const request of [first, second]) {
      await publishPendingHydrationWork(async (work) => {
        attempted.push(work.job_id);
        if (work.job_id === first.job_id) throw new Error("Fixture broker failure");
      }, request.mailbox_id);
    }
    expect(attempted).toContain(first.job_id);
    expect(attempted).toContain(second.job_id);
    const retried: string[] = [];
    for (const request of [first, second]) {
      await publishPendingHydrationWork(async (work) => {
        retried.push(work.job_id);
      }, request.mailbox_id);
    }
    expect(retried).toEqual([first.job_id]);
  });
});
