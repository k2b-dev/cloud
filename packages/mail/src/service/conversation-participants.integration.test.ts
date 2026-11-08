import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listConversationParticipants, MAIL_ROW_PARTICIPANT_LIMIT } from "./conversation-participants";
import * as mailboxes from "./mailboxes";
import { loadMailboxListView, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: null,
});
const anchor = new Date("2026-10-01T12:00:00.000Z");

suite("Mail conversation participants", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let owner: User;
  let teammate: User;
  let reader: User;
  let agentId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let folderId = "";
  let identityId = "";
  let bindingId = "";
  let messageIndex = 0;
  const workflowIds: string[] = [];
  const conversations: Record<"crowd" | "team" | "automated" | "assigned" | "hidden" | "single", string> = {
    crowd: "",
    automated: "",
    team: "",
    assigned: "",
    hidden: "",
    single: "",
  };

  const createUser = async (role: string, displayName: string): Promise<User> => {
    const uid = `mail-participants-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${displayName}, false) RETURNING id`;
    userIds.push(row!.id);
    return {
      id: row!.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
  };

  const createConversation = async (subject: string, offsetMinutes: number): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'Customer', ${new Date(anchor.getTime() - offsetMinutes * 60_000)}, 'needs_action')
      RETURNING id`;
    return row!.id;
  };

  /** One message from `from`; with `sentBy`, Mail sent it for that actor through a command. */
  const addMessage = async (
    conversationId: string,
    from: { email: string; name?: string } | { email: string; name?: string }[] | null,
    sentBy?: { kind: "user" | "service_account" | "workflow"; id: string; state?: string },
  ) => {
    const index = messageIndex++;
    const date = new Date(anchor.getTime() + index * 60_000);
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${suffix}-${index}@example.test>`}, 'Fixture', 'fixture',
        ${date}, ${date}, 100, ${index.toString(16).padStart(64, "0")}, 'complete', 'Body') RETURNING id`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${message!.id}::uuid, ${index + 1}, 'headers')`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${index + 1}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid, ARRAY['\\Seen']::text[])`;
    for (const [position, address] of (Array.isArray(from) ? from : from ? [from] : []).entries())
      await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message!.id}::uuid, 'from', ${position}, ${address.name ?? null}, ${address.email}, ${address.email.toLowerCase()})`;
    if (!sentBy) return;
    const key = crypto.randomUUID();
    // Sent evidence is historical: no retired workflow command may be queued by this fixture.
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, state, actor_kind, actor_id, idempotency_key, request_hash, target, payload, access_subject_kind, access_subject_id, credential_scopes)
      VALUES (${mailboxId}::uuid, 'send', 'confirmed', ${sentBy.kind}, ${sentBy.id}::uuid, ${key}, ${"f".repeat(64)}, '{}', '{}',
        'user', ${owner.id}::uuid, ARRAY[]::text[]) RETURNING id`;
    const [draft] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, conversation_id, source_message_id, intent, sender_identity_id, author_kind, author_id,
        last_editor_kind, last_editor_id, subject, body_markdown, state, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${conversationId}::uuid, ${message!.id}::uuid, 'reply', ${identityId}::uuid,
        ${sentBy.kind}, ${sentBy.id}::uuid, ${sentBy.kind}, ${sentBy.id}::uuid, 'Reply', 'Body', 'sent', ${date}) RETURNING id`;
    await sql`INSERT INTO mail.outbox_submissions
      (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id,
        state, scheduled_at, requested_at, mime_date, draft_snapshot, message_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draft!.id}::uuid, ${command!.id}::uuid, ${identityId}::uuid, ${bindingId}::uuid,
        ${`<${key}@example.test>`}, ${sentBy.state ?? "sent"}, ${date}, ${date}, ${date},
        ${{ to: [], cc: [], bcc: [], subject: "Reply", body: "Body", renderedText: "Body" }}::jsonb, ${message!.id}::uuid)`;
  };

  beforeAll(async () => {
    owner = await createUser("owner", "Lea Brandt");
    teammate = await createUser("teammate", "Tom Keller");
    reader = await createUser("reader", "Rita Reader");
    const [agent] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`Reply agent ${suffix}`}, 'agent') RETURNING id`;
    agentId = agent!.id;
    mailboxId = unwrap(await mailboxes.createMailbox(contextFor(owner), { name: `Participants ${suffix}` })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}', '{}', ${"d".repeat(64)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    folderId = folder!.id;
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'team@example.test', 'Team') RETURNING id`;
    identityId = identity!.id;
    const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
      VALUES (${mailboxId}::uuid, 'Test', 'team@example.test', 'team@example.test', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 587, 'starttls', 'password', 'revoked') RETURNING id`;
    const [binding] = await sql<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
      VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, '{}') RETURNING id`;
    bindingId = binding!.id;

    // Twelve external senders, the first writing twice under another spelling of the same address.
    conversations.crowd = await createConversation("Crowd", 1);
    await addMessage(conversations.crowd, { email: "Sabine@Example.test", name: "Sabine J." });
    for (let i = 1; i < 12; i++) await addMessage(conversations.crowd, { email: `guest${i}@example.test`, name: `Guest ${i}` });
    await addMessage(conversations.crowd, { email: "sabine@example.test", name: "Sabine Jahn" });

    // An external question, replies by two team members and an agent through Mail, one imported reply from the team
    // address without a command, and a scheduled reply that has reached nobody yet.
    conversations.team = await createConversation("Team", 2);
    await addMessage(conversations.team, { email: "petra@example.test", name: "Petra Albers" });
    await addMessage(conversations.team, { email: "team@example.test", name: "Team" }, { kind: "user", id: owner.id });
    await addMessage(conversations.team, { email: "team@example.test", name: "Team" }, { kind: "user", id: teammate.id });
    await addMessage(conversations.team, { email: "team@example.test", name: "Team" }, { kind: "service_account", id: agentId });
    await addMessage(conversations.team, { email: "team@example.test", name: "Team" }, { kind: "user", id: owner.id });
    await addMessage(conversations.team, { email: "team@example.test", name: "Team desk" });
    await addMessage(conversations.team, { email: "team@example.test" }, { kind: "user", id: reader.id, state: "scheduled" });

    // Two versions of one workflow reply, and one message names two authors in From.
    const [workflow] = await sql<{ id: string }[]>`INSERT INTO workflows.workflow (app_id, scope_id, key, name, created_by_kind)
      VALUES ('mail', ${mailboxId}, ${`replies-${suffix}`}, 'Invoices', 'system') RETURNING id`;
    workflowIds.push(workflow!.id);
    const versions: string[] = [];
    for (const revision of [1, 2]) {
      const [version] = await sql<{ id: string }[]>`INSERT INTO workflows.version
        (workflow_id, revision, source, source_hash, plan, language_id, language_version, manifest_hash, created_by_kind)
        VALUES (${workflow!.id}::uuid, ${revision}, 'source', ${String(revision).repeat(64)}, '{}', 'test', 1, ${"b".repeat(64)}, 'system')
        RETURNING id`;
      versions.push(version!.id);
      await sql`INSERT INTO mail.workflow_source_names(version_id,workflow_id,name,active) VALUES(${version!.id}::uuid,${workflow!.id}::uuid,'Invoices',false)`;
    }
    conversations.automated = await createConversation("Automated", 6);
    await addMessage(conversations.automated, [
      { email: "karin@example.test", name: "Karin Lutz" },
      { email: "rolf@example.test", name: "Rolf Becker" },
    ]);
    await addMessage(conversations.automated, { email: "team@example.test" }, { kind: "workflow", id: versions[0]! });
    await addMessage(conversations.automated, { email: "team@example.test" }, { kind: "workflow", id: versions[1]! });

    // The reader is assigned only the first of these two.
    conversations.assigned = await createConversation("Assigned", 3);
    await addMessage(conversations.assigned, { email: "anna@example.test", name: "Anna Roth" });
    await addMessage(conversations.assigned, { email: "team@example.test" }, { kind: "user", id: teammate.id });
    conversations.hidden = await createConversation("Hidden", 4);
    await addMessage(conversations.hidden, { email: "secret@example.test", name: "Secret Sender" });
    await addMessage(conversations.hidden, { email: "team@example.test" }, { kind: "user", id: owner.id });
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
      VALUES (${conversations.assigned}::uuid, ${reader.id}::uuid, ${anchor})`;

    // Only the sender the row names wrote, twice.
    conversations.single = await createConversation("Single", 5);
    await addMessage(conversations.single, { email: "ute@example.test", name: "Ute Krämer" });
    await addMessage(conversations.single, { email: "ute@example.test", name: "Ute Krämer" });
  }, 30_000);

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (agentId) await sql`DELETE FROM auth.service_accounts WHERE id = ${agentId}::uuid`;
    for (const id of workflowIds) {
      await sql`DELETE FROM workflows.workflow WHERE id = ${id}::uuid`;
      await sql`DELETE FROM mail.workflow_source_names WHERE workflow_id = ${id}::uuid`;
    }
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("names at most ten per conversation, first to write first, and counts each address once", async () => {
    const result = unwrap(
      await listConversationParticipants({ context: contextFor(owner), mailboxId, conversationIds: [conversations.crowd] }),
    );
    const crowd = result.get(conversations.crowd)!;
    expect(crowd.count).toBe(12);
    expect(crowd.people).toHaveLength(MAIL_ROW_PARTICIPANT_LIMIT);
    // Two spellings of one address are one person, named as in their newest message.
    expect(crowd.people[0]).toEqual({ name: "Sabine Jahn" });
    expect(crowd.people.slice(1).map((person) => person.name)).toEqual(Array.from({ length: 9 }, (_, i) => `Guest ${i + 1}`));
  });

  test("names team members and agents by the command that sent their reply, and an imported reply by its address", async () => {
    const result = unwrap(
      await listConversationParticipants({ context: contextFor(owner), mailboxId, conversationIds: [conversations.team] }),
    );
    expect(result.get(conversations.team)).toEqual({
      count: 5,
      people: [
        { name: "Petra Albers" },
        { name: "Lea Brandt", kind: "user" },
        { name: "Tom Keller", kind: "user" },
        { name: `Reply agent ${suffix}`, kind: "service_account" },
        { name: "Team desk" },
      ],
    });
  });

  test("counts every author a message names and a workflow once across its versions", async () => {
    const result = unwrap(
      await listConversationParticipants({ context: contextFor(owner), mailboxId, conversationIds: [conversations.automated] }),
    );
    expect(result.get(conversations.automated)).toEqual({
      count: 3,
      people: [{ name: "Karin Lutz" }, { name: "Rolf Becker" }, { name: "Invoices", kind: "workflow" }],
    });
  });

  test("an assigned-only reader learns only the people of the conversations assigned to them", async () => {
    const result = unwrap(
      await listConversationParticipants({
        context: contextFor(reader),
        mailboxId,
        conversationIds: Object.values(conversations),
      }),
    );
    expect([...result.keys()]).toEqual([conversations.assigned]);
    expect(result.get(conversations.assigned)).toEqual({
      count: 2,
      people: [{ name: "Anna Roth" }, { name: "Tom Keller", kind: "user" }],
    });
    const names = [...result.values()].flatMap((entry) => entry.people.map((person) => person.name));
    expect(names).not.toContain("Secret Sender");
    expect(names).not.toContain("Lea Brandt");
  });

  test("the list carries participants only where more than the named sender wrote", async () => {
    const listFor = async (user: User) => {
      const resolved = await resolveWorkspaceRequest(new URL(`/app/mail/${mailboxShortId}`, "https://cloud.test"), mailboxId);
      return unwrap(await loadMailboxListView({ context: contextFor(user), mailboxId, ...resolved! }));
    };
    const view = await listFor(owner);
    const rows = new Map(view.listItems.map((item) => [item.conversationId, item]));
    expect(rows.get(conversations.crowd)?.participants).toHaveLength(MAIL_ROW_PARTICIPANT_LIMIT);
    expect(rows.get(conversations.crowd)?.participantCount).toBe(12);
    expect(rows.get(conversations.team)?.participants).toHaveLength(5);
    expect(rows.get(conversations.team)).not.toHaveProperty("participantCount");
    expect(rows.get(conversations.single)).not.toHaveProperty("participants");

    const readerView = await listFor(reader);
    expect(readerView.listItems.map((item) => item.conversationId)).toEqual([conversations.assigned]);
    expect(readerView.listItems[0]?.participants).toEqual([{ name: "Anna Roth" }, { name: "Tom Keller", kind: "user" }]);
  });
  test("frozen rule names survive later renames and definition deletion", async () => {
    const [workflow] = await sql<{ id: string }[]>`INSERT INTO workflows.workflow (app_id, scope_id, key, name, created_by_kind)
      VALUES ('mail', ${mailboxId}, ${`historical-${suffix}`}, 'Historical writer', 'system') RETURNING id`;
    workflowIds.push(workflow!.id);
    const [version] = await sql<{ id: string }[]>`INSERT INTO workflows.version
      (workflow_id, revision, source, source_hash, plan, language_id, language_version, manifest_hash, created_by_kind)
      VALUES (${workflow!.id}::uuid, 1, 'source', ${"a".repeat(64)}, '{}', 'test', 1, ${"b".repeat(64)}, 'system') RETURNING id`;
    await sql`INSERT INTO mail.workflow_source_names(version_id,workflow_id,name,active) VALUES(${version!.id}::uuid,${workflow!.id}::uuid,'Historical writer',false)`;
    const conversationId = await createConversation("Historical author", 7);
    await addMessage(conversationId, { email: "team@example.test" }, { kind: "workflow", id: version!.id });
    await sql`UPDATE workflows.workflow SET name = 'Renamed writer', active_version_id = ${version!.id}::uuid
      WHERE id = ${workflow!.id}::uuid`;
    const read = () => listConversationParticipants({ context: contextFor(owner), mailboxId, conversationIds: [conversationId] });
    expect(unwrap(await read()).get(conversationId)).toEqual({ people: [{ name: "Historical writer", kind: "workflow" }], count: 1 });
    await sql`DELETE FROM workflows.workflow WHERE id = ${workflow!.id}::uuid`;
    expect(unwrap(await read()).get(conversationId)).toEqual({ people: [{ name: "Historical writer", kind: "workflow" }], count: 1 });
    const [source] = await sql`SELECT workflow_id, name, active FROM mail.workflow_source_names WHERE version_id = ${version!.id}::uuid`;
    expect(source).toMatchObject({ workflow_id: workflow!.id, name: "Historical writer", active: false });
  });
});
