import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createWorkflowInputSchema, workflowTryResultSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { createLocalTag } from "../service/local-tags";
import { createMailbox } from "../service/mailboxes";
import { extractMessageProtocolFacts } from "../service/message-protocol";
import { createWorkflow } from "../service/workflow-definition-service";
import app from ".";

const suite = suiteFor("database", "nats", "valkey");
const header = `inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "\${{ trigger.message }}"
      conversation: "\${{ trigger.conversation }}"
steps:
`;
const example =
  header +
  `  - if:
      all:
        - not: { equals: ["\${{ inputs.message.isBulk }}", true] }
        - any:
            - greaterThan: ["\${{ inputs.message.textLength }}", 150]
            - greaterThan: ["\${{ inputs.conversation.messageCount }}", 3]
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: Long }
`;

suite("Mail no-AI workflow dry run HTTP boundary", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const sessions = new Map<string, User>();
  const userIds: string[] = [];
  let owner: User;
  let reader: User;
  let assigned: User;
  let outsider: User;
  let context: MailRequestContext;
  let mailboxId = "";
  let mailboxShortId = "";
  let workflowId = "";
  let verify: { mockRestore(): void } | undefined;
  const user = async (name: string): Promise<User> => {
    const [row] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`${name}-${suffix}`}, 'local', 'user', ${name}, false) RETURNING id, uid
    `;
    if (!row) throw new Error("User fixture missing");
    userIds.push(row.id);
    const value: User = {
      ...row,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: name,
      sn: "Test",
      displayName: name,
      mail: `${row.uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    sessions.set(name, value);
    return value;
  };
  const call = (input: unknown, token = "owner") =>
    app.request(`/mailboxes/${mailboxShortId}/workflows/try`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify(input),
    });
  const batch = async (input: unknown, token = "owner") => {
    const response = await call(input, token);
    if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
    return workflowTryResultSchema.parse(await response.json());
  };
  beforeAll(async () => {
    setSystemTime(new Date("2026-10-22T00:00:00Z"));
    await migrate();
    owner = await user("owner");
    reader = await user("reader");
    assigned = await user("assigned");
    outsider = await user("outsider");
    sessions.set("owner-read", owner);
    verify = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token) => {
      const user = sessions.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: token === "owner-read" ? ["read"] : [] } : null;
    });
    context = { actor: { kind: "user", user: owner }, accessSubject: { type: "user", userId: owner.id }, requestId: `try-${suffix}` };
    mailboxId = unwrap(await createMailbox(context, { name: `Workflow try ${suffix}` })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    unwrap(await grantMailboxAccess({ context, mailboxId, principal: { type: "user", userId: reader.id }, permission: "read" }));
    unwrap(
      await grantMailboxAccess({
        context,
        mailboxId,
        principal: { type: "user", userId: assigned.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    unwrap(await createLocalTag({ context, mailboxId, input: { name: "Long", color: "blue" } }));
    workflowId = unwrap(
      await createWorkflow({ context, mailboxId, input: createWorkflowInputSchema.parse({ name: "Long messages", source: example }) }),
    ).id;
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${suffix.padEnd(64, "0")}, 'active') RETURNING id`;
    const [folder] = await sql<
      { id: string }[]
    >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${suffix}, 'Inbox', 'inbox', 'current') RETURNING id`;
    for (const [index, length, bulk] of [
      [0, 642, false],
      [1, 800, true],
      [2, 20, false],
    ] as const) {
      const date = new Date(`2026-10-20T12:0${2 - index}:00.000Z`);
      const [conversation] = await sql<
        { id: string }[]
      >`INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${`Message ${index}`}, 'Mara', ${date}) RETURNING id`;
      if (index === 0)
        await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${conversation!.id}::uuid, ${assigned.id}::uuid)`;
      const protocol = extractMessageProtocolFacts((name) => (bulk && name === "list-id" ? "Updates <updates.example.test>" : null));
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, plain_text, sanitized_html, protocol_facts
      ) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<try-${suffix}-${index}@example.test>`}, ${`Message ${index}`}, ${date}, 1000,
        ${`${suffix}${index}`.padEnd(64, "0")}, 'complete', ${"a".repeat(length)}, '', ${protocol}::jsonb) RETURNING id`;
      await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message!.id}::uuid, 'from', 0, 'Mara', 'mara@example.test', 'mara@example.test')`;
      const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, ${index + 1}) RETURNING id`;
      await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
        VALUES (${ref!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[])`;
      await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${index}, 'headers')`;
    }
  });
  afterAll(async () => {
    setSystemTime();
    verify?.mockRestore();
    if (mailboxId) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
        UNION ALL SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
    await sql`DELETE FROM audit.events WHERE request_id = ${context?.requestId}`;
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });
  const state = async () => {
    const tables = await sql<{ schemaname: string; tablename: string }[]>`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname IN ('mail', 'ai', 'workflows') ORDER BY schemaname, tablename`;
    const rows = [];
    for (const table of tables) {
      const [data] = await sql<
        { data: string }[]
      >`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text), '[]'::jsonb)::text AS data
        FROM ${sql(table.schemaname)}.${sql(table.tablename)} row`;
      rows.push([`${table.schemaname}.${table.tablename}`, data!.data]);
    }
    return rows;
  };
  test("reports facts, newest-first outcomes, and identical totals across batches", async () => {
    const before = await state();
    const whole = await batch({ source: example, last: 50, batch: 25 });
    expect(whole.window).toEqual({ last: 50, total: 3 });
    expect(whole.items.map((item) => item.outcome)).toEqual(["match", "skipped", "none"]);
    expect(whole.items[0]!.facts).toEqual([
      { path: "message.isBulk", value: false },
      { path: "message.textLength", value: 642 },
      { path: "conversation.messageCount", value: 1 },
    ]);
    const first = await batch({ workflowId, batch: 1 }, "reader");
    const second = await batch({ workflowId, batch: 1, cursor: first.cursor }, "reader");
    const third = await batch({ workflowId, batch: 1, cursor: second.cursor }, "reader");
    expect([first.checked, second.checked, third.checked]).toEqual([1, 2, 3]);
    expect(third.cursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items]).toEqual(whole.items);
    expect(await state()).toEqual(before);
  });
  test("plans AI and dependent branches without any database writes or AI billing", async () => {
    const before = await state();
    const result = await batch({
      source:
        header +
        `  - aiClassify:
      input: "\${{ inputs.message.subject }}"
      prompt: Classify
      choices: [Complaint, Other]
      saveAs: category
  - if:
      equals: ["\${{ category }}", Complaint]
    then:
      - aiGenerateText: { prompt: Reply, saveAs: reply }
`,
    });
    expect(result.aiCalls).toEqual({ min: 3, max: 6 });
    expect(result.items.every((item) => item.stoppedAtAi && item.aiCalls.min === 1 && item.aiCalls.max === 2)).toBe(true);
    expect(result.preflight).toEqual({ targets: [], sends: false, writesDrafts: false, aiSteps: 2 });
    expect(await state()).toEqual(before);
  });
  test("reports missing and inaccessible static targets, even before conditions match", async () => {
    const result = await batch({
      source:
        header +
        `  - if: { equals: ["\${{ inputs.message.subject }}", Never] }
    then:
      - assignConversation: { conversation: inputs.conversation, user: "${outsider.id}" }
  - assignConversation: { conversation: inputs.conversation, user: MissingUser }
`,
    });
    expect(result.preflight.targets).toEqual([
      { kind: "user", value: outsider.id, ok: false, problem: "target_no_access" },
      { kind: "user", value: "MissingUser", ok: false, problem: "target_missing" },
    ]);
    expect(result.items[0]!.problems).toContainEqual({
      code: "target_missing",
      path: ["steps", 1, "assignConversation", "user"],
      target: "MissingUser",
    });
    const noAccess = await batch({
      source: header + `  - assignConversation: { conversation: inputs.conversation, user: "${outsider.id}" }`,
    });
    expect(noAccess.items.every((item) => item.problems[0]?.code === "target_no_access")).toBe(true);
  });
  test("omits a message whose placement becomes unavailable between batches", async () => {
    const first = await batch({ source: example, batch: 1 });
    const cursor = JSON.parse(Buffer.from(first.cursor!, "base64url").toString());
    const id: string = cursor.ids[1];
    await sql`UPDATE mail.remote_message_refs SET stale_at = '2026-10-21T00:00:00Z' WHERE id = ${id}::uuid`;
    try {
      const next = await batch({ source: example, batch: 1, cursor: first.cursor });
      expect(next.checked).toBe(2);
      expect(next.items).toEqual([]);
    } finally {
      await sql`UPDATE mail.remote_message_refs SET stale_at = NULL WHERE id = ${id}::uuid`;
    }
  });
  test("treats inactive users and folders outside this mailbox as unavailable", async () => {
    const other = unwrap(await createMailbox(context, { name: `Other ${suffix}` }));
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${other.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${`${suffix}other`.padEnd(64, "0")}, 'active') RETURNING id`;
    const folder = newShortId();
    await sql`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${folder}, ${resource!.id}::uuid, ${suffix}, 'Other folder', 'other', 'current')`;
    await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${outsider.id}::uuid`;
    try {
      const result = await batch({
        source:
          header +
          `  - assignConversation: { conversation: inputs.conversation, user: "${outsider.id}" }
  - moveMessage: { message: inputs.message, folder: "${folder}" }
`,
      });
      expect(result.preflight.targets).toEqual([
        { kind: "user", value: outsider.id, ok: false, problem: "target_missing" },
        { kind: "folder", value: folder, ok: false, problem: "target_missing" },
      ]);
    } finally {
      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${outsider.id}::uuid`;
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${other.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${other.id}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
  });
  test("preserves saved-workflow read permission and rejects unsaved source for readers", async () => {
    expect((await call({ workflowId }, "reader")).status).toBe(200);
    expect((await call({ workflowId }, "owner-read")).status).toBe(200);
    expect((await call({ source: example }, "owner-read")).status).toBe(403);
    expect((await call({ source: example }, "reader")).status).toBe(403);
    expect((await call({ workflowId }, "assigned")).status).toBe(403);
    expect((await call({ workflowId }, "outsider")).status).toBe(403);
    expect((await call({ workflowId: crypto.randomUUID() })).status).toBe(404);
  });
  test("returns validation diagnostics and refuses malformed or cross-source cursors", async () => {
    const invalid = await call({ source: "steps: [" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ valid: false, diagnostics: expect.any(Array) });
    expect((await call({ source: example, workflowId })).status).toBe(400);
    const first = await batch({ source: example, batch: 1 });
    expect((await call({ source: example, last: 10, cursor: first.cursor })).status).toBe(400);
    expect((await call({ source: example, cursor: "broken" })).status).toBe(400);
    const cursor = JSON.parse(Buffer.from(first.cursor!, "base64url").toString());
    const duplicate = Buffer.from(JSON.stringify({ ...cursor, ids: [cursor.ids[0], cursor.ids[0]] })).toString("base64url");
    expect((await call({ source: example, cursor: duplicate })).status).toBe(400);
  });
});
