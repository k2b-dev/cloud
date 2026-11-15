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
  /** A submission from the chat, as the chat tool records it; with an approval, it waits for an admin. */
  const submit = async (codeId: string, versionId: string, options: { approval?: boolean; conversationId?: string } = {}) => {
    const origin = {
      kind: "ai_chat",
      conversationId: options.conversationId ?? chatId,
      automaticAfterReview: true,
      cardAnchor: `tool-call-${versionId.slice(0, 8)}`,
    };
    submitted++;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding,origin,approval_id,created_at)
      VALUES(${versionId}::uuid,${codeId},'{}'::jsonb,${JSON.stringify(origin)}::text::jsonb,
        ${options.approval ? crypto.randomUUID() : null}::uuid,now() + make_interval(secs => ${submitted}))`;
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
    await sql`UPDATE code.codes SET state='paused',active_version_id=${onVersion}::uuid WHERE id=${on.id}`;
    const waiting = await mine("Angebote nachfassen");
    const first = await version(waiting.id, ids.author);
    await submit(waiting.id, first, { approval: true });
    await decide(first, "changes_requested");
    const second = await version(waiting.id, ids.author, first);
    await submit(waiting.id, second, { approval: true });
    const revising = await mine("Rechnungen sortieren");
    const asked = await version(revising.id, ids.author);
    await submit(revising.id, asked, { approval: true });
    await decide(asked, "changes_requested");
    await sql`INSERT INTO code.review_chat_work(version_id,code_id,conversation_id,user_id,state)
      VALUES(${asked}::uuid,${revising.id},${chatId}::uuid,${ids.author}::uuid,'running')`;
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
    expect(list.count).toBe(4);
    expect(list.items.map((item) => [item.title, item.state, item.attention])).toEqual([
      ["Rechnungen sortieren", "revising", false],
      ["Angebote nachfassen", "waiting", false],
      ["Wochenbericht", "paused", false],
      ["Lieferscheine ablegen", "ready", true],
    ]);
    expect(list.items[1]).toMatchObject({ versionId: second, number: 2, anchor: `tool-call-${second.slice(0, 8)}` });

    // A reader without the right sees nothing: another person asking for this chat gets an empty list.
    expect(await listChatCode({ conversationId: chatId }, ctx(ids.other))).toEqual({ count: 0, items: [] });
  });
});
