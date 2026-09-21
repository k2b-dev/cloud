import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { listRelatedConversations } from "./conversation-context";
import { createMailbox } from "./mailboxes";
import { normalizeMailSubject } from "./message-threading";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `related-mail-${user.uid}`,
});

suite("related Mail conversations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let owner: { id: string; uid: string };
  let mailboxId = "";
  let currentConversationId = "";
  let createConversation: (uid: number, subject: string, participant: string, minutesAgo: number) => Promise<string>;

  beforeAll(async () => {
    await migrate();
    const [createdOwner] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`related-mail-${suffix}`}, 'local', 'user', 'Related Mail', false)
      RETURNING id, uid
    `;
    if (!createdOwner) throw new Error("Failed to create Related Mail test user");
    owner = createdOwner;
    const mailbox = await createMailbox(contextFor(owner), { name: `Related Mail ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${suffix.padEnd(64, "0")}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`related-${suffix}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;

    createConversation = async (uid: number, subject: string, participant: string, minutesAgo: number) => {
      const date = new Date(Date.now() - minutesAgo * 60_000);
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (
          short_id, mailbox_id, message_id, subject, normalized_subject, internal_date,
          size_bytes, content_hash, hydration_status, plain_text
        ) VALUES (
          ${newShortId()}, ${mailboxId}::uuid, ${`<related-${uid}-${suffix}@example.test>`}, ${subject},
          ${normalizeMailSubject(subject)}, ${date}, 128, ${uid.toString(16).padStart(64, "0")}, 'complete', ${`Preview ${uid}`}
        ) RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message!.id}::uuid, 'from', 0, ${participant}, ${participant}, ${participant})
      `;
      const [remoteRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, ${uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${remoteRef!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid)
      `;
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, ${participant}, ${date})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, ${date.getTime()}, 'headers')
      `;
      return conversation!.id;
    };

    currentConversationId = await createConversation(101, "Re: Project Alpha", "ada@example.test", 1);
    await createConversation(102, "Project Alpha", "ada@example.test", 5);
    await createConversation(103, "Different subject", "ada@example.test", 2);
    await createConversation(104, "Fwd: Project Alpha", "bob@example.test", 3);
    await createConversation(105, "Unrelated", "bob@example.test", 0);
  });

  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("ranks shared participants before normalized subjects and explains every result", async () => {
    const result = await listRelatedConversations({
      context: contextFor(owner),
      mailboxId,
      conversationId: currentConversationId,
      limit: 10,
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0]?.reasons.map((reason) => reason.kind)).toEqual(["participant", "subject"]);
    expect(result.data[1]?.reasons).toEqual([{ kind: "participant", value: "ada@example.test" }]);
    expect(result.data[2]?.reasons).toEqual([{ kind: "subject", value: "Re: Project Alpha" }]);
    expect(result.data.some((item) => item.id === currentConversationId)).toBeFalse();
  });

  test("rejects a caller without mailbox read access", async () => {
    const result = await listRelatedConversations({
      context: contextFor({ id: crypto.randomUUID(), uid: `related-outsider-${suffix}` }),
      mailboxId,
      conversationId: currentConversationId,
      limit: 5,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error.status).toBe(403);
  });

  test("keeps a common-participant mailbox bounded to the requested newest window", async () => {
    const commonParticipant = "common@example.test";
    const sourceId = await createConversation(200, "Common participant source", commonParticipant, 0);
    for (let index = 0; index < 64; index += 1) {
      await createConversation(201 + index, `Common participant ${index}`, commonParticipant, index + 1);
    }

    const result = await listRelatedConversations({
      context: contextFor(owner),
      mailboxId,
      conversationId: sourceId,
      limit: 3,
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data.map((item) => item.subject)).toEqual(["Common participant 0", "Common participant 1", "Common participant 2"]);
    expect(result.data.every((item) => item.reasons[0]?.value === commonParticipant)).toBeTrue();
  });
});
