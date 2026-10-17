import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { buildCommandTargetIndex, migrate } from "../migrate";
import { undoMoveCopyQuery } from "./command-undo";
import { pendingMoveClaimQuery } from "./incoming-automation-order";
import { incomingAutomationSiblingQuery } from "./workflow-message-preconditions";

const suite = suiteFor("database", "nats");

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: Plan[];
};
type ExplainRow = { "QUERY PLAN": [{ Plan: Plan }] };

const planNodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)];

suite("per-message command lookup plans", () => {
  test("seeks the message target instead of scanning the mailbox command history", async () => {
    await migrate();
    expect(["built", "ready"]).toContain(await buildCommandTargetIndex());
    const [mailbox] = await sql<{ id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Command target plans') RETURNING id
    `;
    if (!mailbox) throw new Error("Missing command target mailbox");
    // Fixed dates keep the history and first-seen boundary independent of the day the test runs.
    const firstSeenAt = "2026-09-17T00:00:00.000Z";
    const commandId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    try {
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${mailbox.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active') RETURNING id
      `;
      if (!resource) throw new Error("Missing command target remote resource");
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name)
        VALUES (${newShortId()}, ${resource.id}::uuid, 'inbox', 'Inbox') RETURNING id
      `;
      if (!folder) throw new Error("Missing command target folder");
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id, mailbox_id, internal_date, content_hash)
        VALUES (${newShortId()}, ${mailbox.id}::uuid, ${firstSeenAt}::timestamptz, ${"b".repeat(64)}) RETURNING id
      `;
      if (!message) throw new Error("Missing command target message");
      const [ref] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, first_seen_at)
        VALUES (${folder.id}::uuid, ${message.id}::uuid, 1, 1, ${firstSeenAt}::timestamptz) RETURNING id
      `;
      if (!ref) throw new Error("Missing command target reference");
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${ref.id}::uuid, ${folder.id}::uuid, ${message.id}::uuid)
      `;
      await sql`
        INSERT INTO mail.commands (
          mailbox_id, kind, state, actor_kind, actor_id, correlation_id,
          idempotency_key, request_hash, target, payload, access_subject_kind, created_at, finished_at
        )
        SELECT ${mailbox.id}::uuid,
          CASE n % 3 WHEN 0 THEN 'sync_folder' WHEN 1 THEN 'change_message_state' ELSE 'move' END,
          'confirmed', 'workflow', ${workflowVersionId}::uuid, gen_random_uuid()::text,
          'history:' || n, repeat('c', 64),
          CASE WHEN n % 3 = 0 THEN '{}'::jsonb
            ELSE jsonb_build_object('remoteMessageRefId', gen_random_uuid()::text) END,
          '{}'::jsonb, 'system',
          ${firstSeenAt}::timestamptz + n * interval '30 days' / 6000,
          ${firstSeenAt}::timestamptz + n * interval '30 days' / 6000 + interval '1 second'
        FROM generate_series(1, 6000) AS history(n)
      `;
      await sql`
        INSERT INTO mail.commands (
          id, mailbox_id, kind, state, actor_kind, actor_id, correlation_id,
          idempotency_key, request_hash, target, payload, access_subject_kind, created_at
        ) VALUES (
          ${commandId}::uuid, ${mailbox.id}::uuid, 'change_message_state', 'queued', 'workflow',
          ${workflowVersionId}::uuid, ${runId}, 'subject', ${"d".repeat(64)},
          ${{ remoteMessageRefId: ref.id, expectedRemoteState: { flags: [], keywords: [] } }}::jsonb,
          '{}'::jsonb, 'system', ${firstSeenAt}::timestamptz
        )
      `;
      await sql`ANALYZE mail.commands`;
      await sql`ANALYZE mail.remote_message_refs`;
      await sql`ANALYZE mail.message_placements`;

      const queries = [
        incomingAutomationSiblingQuery(sql, [commandId]),
        pendingMoveClaimQuery(sql, { mailboxId: mailbox.id, refId: ref.id, firstSeenAt, runId }),
        undoMoveCopyQuery(sql, {
          mailboxId: mailbox.id,
          commandId,
          messageId: message.id,
          destinationFolderId: folder.id,
          createdAt: firstSeenAt,
        }),
      ];
      for (const query of queries) {
        const [explained] = await sql<ExplainRow[]>`EXPLAIN (FORMAT JSON) ${query}`;
        if (!explained) throw new Error("Missing command target query plan");
        const nodes = planNodes(explained["QUERY PLAN"][0].Plan);
        expect(nodes.some((node) => node["Index Name"] === "commands_message_target_idx")).toBe(true);
        expect(nodes.some((node) => node["Index Name"] === "commands_mailbox_idx")).toBe(false);
        expect(nodes.some((node) => node["Relation Name"] === "commands" && node["Node Type"] === "Seq Scan")).toBe(false);
      }
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
    }
  });
});
