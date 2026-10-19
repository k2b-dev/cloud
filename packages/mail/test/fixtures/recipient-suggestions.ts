import type { User } from "@k2b/cloud/contracts";
import { sql } from "bun";
import type { MailRequestContext } from "../../src/service/auth";
import { createMailbox } from "../../src/service/mailboxes";

export const recipientSuggestionNow = new Date("2026-10-19T12:00:00.000Z");

export const recipientContext = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: "recipient-suggestions-test",
});

export const createRecipientMailboxFixture = async () => {
  const uid = `recipient-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${uid}, 'local', 'user', 'Recipient Test', false) RETURNING id`;
  if (!row) throw new Error("Could not create recipient test user");
  const user: User = {
    id: row.id,
    uid,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Recipient",
    sn: "Test",
    displayName: "Recipient Test",
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
  const context = recipientContext(user);
  const mailbox = await createMailbox(context, { name: "Recipient suggestions fixture" });
  if (!mailbox.ok) throw new Error(mailbox.error.message);
  const mailboxId = mailbox.data.id;
  const cleanup = async () => {
    const grants = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  };
  return { mailboxId, user, context, cleanup };
};
