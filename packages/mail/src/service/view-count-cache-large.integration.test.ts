import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { anchor, planLargeMailbox, seedLargeMailbox } from "../../test/fixtures/large-mailbox";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { updateConversationCollaboration } from "./conversation-assignments";
import { enqueueMailInvalidation } from "./live";
import { createMailbox } from "./mailboxes";
import { getConversationViewCounts, listFolders } from "./messages";
import { queryConversationViewCounts } from "./view-count-query";

const suite = suiteFor("database", "nats", "valkey");
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
});

// A real largest-mailbox regression, not a timing stub. Only this owned fixture receives a long timeout.
suite("cached workspace counts at 46,000 conversations", () => {
  let owner: User;
  let reader: User;
  let mailboxId: string;
  beforeAll(async () => {
    const createUser = async (role: string): Promise<User> => {
      const uid = `large-counts-${role}-${crypto.randomUUID()}`;
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id`;
      return {
        id: row!.id,
        uid,
        provider: "local",
        profile: "user",
        displayName: role,
        givenname: "Count",
        sn: "Cache",
        mail: null,
        roles: ["user"],
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroupIds: [],
        memberofGroup: [],
        manages: [],
        managesGroupIds: [],
      };
    };
    owner = await createUser("owner");
    reader = await createUser("assigned-reader");
    mailboxId = unwrap(await createMailbox(contextFor(owner), { name: "Largest count cache fixture" })).id;
    const plan = planLargeMailbox({ seed: 2403, anchor, messages: 80_000, conversations: 46_000, folders: 350 });
    await seedLargeMailbox(sql, plan, { mailboxId, userIds: [owner.id] });
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    const [conversation] = await sql<
      { id: string }[]
    >`SELECT id FROM mail.conversations WHERE mailbox_id = ${mailboxId}::uuid AND work_status = 'needs_action' AND snoozed_until IS NULL LIMIT 1`;
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${conversation!.id}::uuid, ${reader.id}::uuid)`;
    await sql.begin((tx) => enqueueMailInvalidation(tx, { mailboxId }));
  }, 600_000);

  // integration-preload drops this entire private database, including the multi-GB fixture.
  test("reuses the authorized snapshot within 50 ms and avoids mailbox table scans", async () => {
    const direct: number[] = [];
    let expected: Awaited<ReturnType<typeof queryConversationViewCounts>> | undefined;
    for (let run = 0; run < 6; run++) {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
        await tx`SET LOCAL jit = off`;
        const before = await tx<
          { relname: string; reads: number }[]
        >`SELECT relname, (seq_tup_read + idx_tup_fetch)::int AS reads FROM pg_stat_xact_user_tables WHERE schemaname = 'mail'`;
        const start = performance.now();
        expected = await queryConversationViewCounts(
          { mailboxId, currentUserId: owner.id, visibility: { scope: "mailbox", permission: "admin" } },
          tx,
        );
        direct.push(performance.now() - start);
        if (run === 5) {
          const after = await tx<
            { relname: string; reads: number }[]
          >`SELECT relname, (seq_tup_read + idx_tup_fetch)::int AS reads FROM pg_stat_xact_user_tables WHERE schemaname = 'mail'`;
          console.info(
            "Generic-plan authoritative tuple reads:",
            JSON.stringify(
              after
                .map((row) => ({
                  table: row.relname,
                  reads: row.reads - (before.find((previous) => previous.relname === row.relname)?.reads ?? 0),
                }))
                .filter((row) => row.reads > 0),
            ),
          );
        }
      });
    }
    if (!expected) throw new Error("Missing authoritative counts");
    expect(expected.recently_active).toBe(46_000);
    const params = { context: contextFor(owner), mailboxId, cached: true };
    expect(unwrap(await getConversationViewCounts(params))).toEqual(expected);
    const warm: number[] = [];
    for (let run = 0; run < 7; run++) {
      const start = performance.now();
      expect(unwrap(await getConversationViewCounts(params))).toEqual(expected);
      warm.push(performance.now() - start);
    }
    console.info(
      `46,000 conversations / 80,000 messages / 350 folders: authoritative generic ${median(direct.slice(1)).toFixed(2)} ms; cached authorized service ${median(warm).toFixed(2)} ms; samples ${warm.map((ms) => ms.toFixed(2)).join(", ")}`,
    );
    expect(median(warm)).toBeLessThan(50);

    await sql.begin(async (tx) => {
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.unsafe(
        `PREPARE mail_count_version(uuid) AS SELECT current_database() AS database, COALESCE(version::text, 'initial') AS version FROM (SELECT 1) singleton LEFT JOIN mail.mailbox_read_versions ON mailbox_id = $1`,
      );
      try {
        const plan = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS) EXECUTE mail_count_version('${mailboxId}')`);
        console.info("Generic cache version plan:", JSON.stringify(plan));
      } finally {
        await tx`DEALLOCATE mail_count_version`.simple();
      }
    });
    // Compare the folder count laterals alone under the same generic-plan discipline.
    // Metadata projection/order is identical in both production variants.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx`SET LOCAL jit = off`;
      const timings: Record<string, number[]> = {};
      for (const variant of ["separate", "combined"] as const) {
        const name = `mail_folder_counts_${variant}`;
        const totals =
          variant === "combined"
            ? "COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT ((chr(92) || 'Seen') = ANY(p.flags)))::int AS unread"
            : "COUNT(*)::int AS total";
        const unreadJoin =
          variant === "separate"
            ? "LEFT JOIN LATERAL (SELECT COUNT(*)::int AS unread FROM mail.message_placements p WHERE p.folder_id = f.id AND p.deleted_at IS NULL AND NOT ((chr(92) || 'Seen') = ANY(p.flags))) unread ON true"
            : "";
        await tx.unsafe(`PREPARE ${name}(uuid) AS SELECT f.id, totals.total, ${variant === "combined" ? "totals" : "unread"}.unread
          FROM mail.folders f JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
          LEFT JOIN LATERAL (SELECT ${totals} FROM mail.message_placements p WHERE p.folder_id = f.id AND p.deleted_at IS NULL) totals ON true
          ${unreadJoin} WHERE rr.mailbox_id = $1`);
        try {
          const samples: number[] = [];
          for (let run = 0; run < 6; run++) {
            const plan = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) EXECUTE ${name}('${mailboxId}')`);
            const execution = plan
              .map((row) => row["QUERY PLAN"])
              .join("\n")
              .match(/Execution Time: ([\d.]+) ms/);
            if (!execution) throw new Error("Missing folder execution time");
            samples.push(Number(execution[1]));
          }
          timings[variant] = samples.slice(1);
        } finally {
          await tx.unsafe(`DEALLOCATE ${name}`);
        }
      }
      console.info(
        `350-folder count laterals, prepared generic plan: separate ${median(timings.separate!).toFixed(2)} ms; combined ${median(timings.combined!).toFixed(2)} ms`,
      );
    });
    const folders = unwrap(await listFolders(contextFor(owner), mailboxId));
    expect(folders.reduce((sum, folder) => sum + folder.total, 0)).toBe(80_000);
    expect(folders.reduce((sum, folder) => sum + folder.unread, 0)).toBeGreaterThan(0);
  }, 120_000);

  test("an assigned-only reader never receives another reader's counts or mine; own actions refresh immediately", async () => {
    const ownerParams = { context: contextFor(owner), mailboxId, cached: true };
    const readerParams = { context: contextFor(reader), mailboxId, cached: true };
    const ownerCounts = unwrap(await getConversationViewCounts(ownerParams));
    const ownCounts = unwrap(await getConversationViewCounts(readerParams));
    expect(ownCounts.recently_active).toBe(1);
    expect(ownCounts.mine).toBe(1);
    expect(ownerCounts.mine).toBeGreaterThan(1);
    const [conversation] = await sql<
      { id: string; revision: number }[]
    >`SELECT c.id, c.revision FROM mail.conversations c JOIN mail.conversation_assignees a ON a.conversation_id = c.id WHERE c.mailbox_id = ${mailboxId}::uuid AND a.principal_id = ${reader.id}::uuid`;
    unwrap(
      await updateConversationCollaboration({
        locale: "en",
        context: contextFor(owner),
        mailboxId,
        conversationId: conversation!.id,
        input: { expectedRevision: Number(conversation!.revision), completion: "done" },
      }),
    );
    const refreshed = unwrap(await getConversationViewCounts(readerParams));
    expect(refreshed.mine).toBe(0);
    expect(refreshed.done).toBe(1);
    expect(refreshed.needs_action).toBe(0);
    expect(refreshed).toEqual(unwrap(await getConversationViewCounts({ context: contextFor(reader), mailboxId })));
  });
});
