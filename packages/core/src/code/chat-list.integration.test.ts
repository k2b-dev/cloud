import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { migrateApprovals } from "@k2b/cloud/services/approvals";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateSettings } from "../migrate/core/settings";
import * as access from "./access";
import { listChatCode } from "./chat-list";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { createCode, createCodeVersion } from "./store";

const ids = {
  author: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
};
const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const person = (id: string): User => ({
  id,
  uid: id,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const ctx = (id: string): access.CodeContext => ({
  authority: {
    actor: { kind: "user", user: person(id) },
    accessSubject: { type: "user", userId: id },
    credentialKind: "session",
    scopes: [],
  },
  locale: "de",
});

// Integration runs only with explicit CLOUD_TEST_DATABASE_URL in CI.
databaseSuite()("Core lists the Code a chat submitted, for its owner only", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const spies: Array<{ mockRestore(): void }> = [];
  let submitted = 0;
  const version = async (codeId: string, author: string, baseVersionId: string | null = null) =>
    (
      await createCodeVersion(
        { codeId, sourceFiles: { "code.ts": "export {};" }, bundle: "export {};", manifest: {}, baseVersionId },
        ctx(author),
      )
    ).id;
  /** An admin's approval request for a version, open, expired, or closed when a newer version replaced it. */
  const approval = async (status: "pending" | "expired" | "cancelled", expiresInSeconds = 3600) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO approvals.requests(app_id,action,kind,requester_kind,requester_ref,
        requester_app_id,approver_role,assurance,sentence,args_digest,review_digest,status,expires_at)
      VALUES('core','code.version.submit','code_version','code_version',${crypto.randomUUID()},'core','admin','confirm',
        'Version freigeben','args','review',${status},now() + make_interval(secs => ${expiresInSeconds}))
      RETURNING id`;
    return row!.id;
  };
  /** A submission from the chat, as the chat tool records it; with an approval, it waits for an admin. */
  const submit = async (codeId: string, versionId: string, options: { approval?: string; conversationId?: string } = {}) => {
    const origin = {
      kind: "ai_chat",
      conversationId: options.conversationId ?? chatId,
      automaticAfterReview: true,
      cardAnchor: `tool-call-${versionId.slice(0, 8)}`,
    };
    submitted++;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding,origin,approval_id,created_at)
      VALUES(${versionId}::uuid,${codeId},'{}'::jsonb,${JSON.stringify(origin)}::text::jsonb,
        ${options.approval ?? null}::uuid,now() + make_interval(secs => ${submitted}))`;
  };
  const decide = (versionId: string, outcome: "approved" | "changes_requested" | "rejected") =>
    sql`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_via,auth_epoch,outcome)
      VALUES(${versionId}::uuid,'{}'::jsonb,${outcome === "approved"},false,'test',1,${outcome})`;

  beforeAll(async () => {
    database = await useFreshDatabase("core_code_chat_list");
    await migrateAuth();
    await migrateAppApproval();
    await migrateSettings();
    await migrateAudit();
    await migrateCode();
    await migratePolicy();
    await migrateApprovals();
    await migrateVersions();
    await migrateActivation();
    await sql`CREATE SCHEMA IF NOT EXISTS ai`;
    await sql`CREATE TABLE IF NOT EXISTS ai.conversations(id UUID PRIMARY KEY, created_by_user_id UUID NOT NULL)`;
    // Records the live updates Core sends, in place of AI's own outbox.
    await sql`CREATE TABLE IF NOT EXISTS ai.live_sent(user_id UUID, domains TEXT[])`;
    await sql`CREATE OR REPLACE FUNCTION ai.enqueue_live_for_user(change UUID, person UUID, chat TEXT, project TEXT, domains TEXT[])
      RETURNS void AS $$ INSERT INTO ai.live_sent VALUES(person, domains) $$ LANGUAGE sql`.simple();
    for (const [name, id] of Object.entries(ids))
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${name},'local','user')`;
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${chatId}::uuid,${ids.author}::uuid)`;
    spies.push(
      spyOn(codeSettings, "get").mockImplementation(async (key) => {
        const definition = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
        if (!definition) throw new Error(`Unexpected setting ${key}`);
        return definition.default;
      }),
      spyOn(access, "readCodeOwner").mockImplementation(async (owner, context) =>
        owner.kind === "person" &&
        context.authority.accessSubject.type === "user" &&
        owner.userId === context.authority.accessSubject.userId
          ? { title: "Person", admin: true }
          : null,
      ),
    );
  }, 120_000);
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await database?.drop();
  });

  test("each Code with the state of its newest version from the chat and its card; a stranger's Code and chat stay hidden", async () => {
    const mine = (title: string) => createCode({ owner: { kind: "person", userId: ids.author }, title }, ctx(ids.author));
    const ready = await mine("Lieferscheine ablegen");
    await submit(ready.id, await version(ready.id, ids.author));
    const on = await mine("Wochenbericht");
    const onVersion = await version(on.id, ids.author);
    await submit(on.id, onVersion);
    await sql`UPDATE code.codes SET active_version_id=${onVersion}::uuid WHERE id=${on.id}`;
    await sql`DELETE FROM ai.live_sent`;
    // Pausing tells the chat's person, so the box's state word follows.
    await sql`UPDATE code.codes SET state='paused' WHERE id=${on.id}`;
    const sent = await sql<{ userId: string; domains: string[] }[]>`SELECT user_id::text AS "userId", domains FROM ai.live_sent`;
    expect([...sent]).toEqual([{ userId: ids.author, domains: ["code-versions"] }]);
    const waiting = await mine("Angebote nachfassen");
    const first = await version(waiting.id, ids.author);
    await submit(waiting.id, first, { approval: await approval("pending") });
    await decide(first, "changes_requested");
    const second = await version(waiting.id, ids.author, first);
    await submit(waiting.id, second, { approval: await approval("pending") });
    const revising = await mine("Rechnungen sortieren");
    const asked = await version(revising.id, ids.author);
    await submit(revising.id, asked, { approval: await approval("pending") });
    await decide(asked, "changes_requested");
    await sql`INSERT INTO code.review_chat_work(version_id,code_id,conversation_id,user_id,state)
      VALUES(${asked}::uuid,${revising.id},${chatId}::uuid,${ids.author}::uuid,'running')`;
    // Its approval ran out: the person can ask again.
    const lapsed = await mine("Abgelaufen");
    await submit(lapsed.id, await version(lapsed.id, ids.author), { approval: await approval("pending", -60) });
    // A newer version from another chat closed this one's request without a decision: nothing waits here any more.
    const replaced = await mine("Ersetzt");
    const older = await version(replaced.id, ids.author);
    await submit(replaced.id, older, { approval: await approval("cancelled") });
    await submit(replaced.id, await version(replaced.id, ids.author, older), {
      approval: await approval("pending"),
      conversationId: crypto.randomUUID(),
    });
    // Withdrawn and from another chat: not this chat's automations.
    const withdrawn = await mine("Zurückgezogen");
    const gone = await version(withdrawn.id, ids.author);
    await submit(withdrawn.id, gone);
    await sql`INSERT INTO code.version_withdrawals(version_id) VALUES(${gone}::uuid)`;
    const elsewhere = await mine("Anderer Chat");
    await submit(elsewhere.id, await version(elsewhere.id, ids.author), { conversationId: crypto.randomUUID() });
    // Someone else's Code submitted from this chat, which its author may not read.
    const foreign = await createCode({ owner: { kind: "person", userId: ids.other }, title: "Fremd" }, ctx(ids.other));
    await submit(foreign.id, await version(foreign.id, ids.other));

    const list = await listChatCode({ conversationId: chatId }, ctx(ids.author));
    expect(list.count).toBe(5);
    expect(list.items.map((item) => [item.title, item.state, item.attention])).toEqual([
      ["Abgelaufen", "waiting", true],
      ["Rechnungen sortieren", "revising", false],
      ["Angebote nachfassen", "waiting", false],
      ["Wochenbericht", "paused", false],
      ["Lieferscheine ablegen", "ready", true],
    ]);
    expect(list.items[2]).toMatchObject({ versionId: second, number: 2, anchor: `code-version-${second}` });

    // A reader without the right sees nothing: another person asking for this chat gets an empty list.
    expect(await listChatCode({ conversationId: chatId }, ctx(ids.other))).toEqual({ count: 0, items: [] });
  });
});
