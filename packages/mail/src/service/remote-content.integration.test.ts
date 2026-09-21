import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import {
  createRemoteContentRule,
  deleteRemoteContentRule,
  listRemoteContentRules,
  loadRemoteImage,
  resolveMessagesRemoteContent,
} from "./remote-content";

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
      mail: `${user.uid}@example.com`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-remote-content-${user.uid}`,
});

suite("mail remote content rules", () => {
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let ownerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let outsiderContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const suffix = crypto.randomUUID().slice(0, 8);
    const createUser = async (role: string) => {
      const uid = `mail-remote-content-${role}-${suffix}`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${uid}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create ${role} user`);
      userIds.push(row.id);
      return { id: row.id, uid };
    };
    const owner = await createUser("owner");
    const reader = await createUser("reader");
    const outsider = await createUser("outsider");
    ownerContext = contextFor(owner);
    readerContext = contextFor(reader);
    outsiderContext = contextFor(outsider);

    const mailbox = await createMailbox(ownerContext, { name: `Remote content ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const access = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!access.ok) throw new Error(access.error.message);
    accessIds.push(access.data.id);
  });

  afterAll(async () => {
    if (mailboxId) {
      const mailboxAccess = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      accessIds.push(...mailboxAccess.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(accessIds)]}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("scopes rules to the current principal while allowing read collaborators", async () => {
    const created = await createRemoteContentRule({
      context: readerContext,
      mailboxId,
      input: { scope: "sender", value: " Sender@Example.com " },
    });
    expect(created.ok).toBeTrue();
    if (!created.ok) return;
    expect(created.data.value).toBe("sender@example.com");

    const repeated = await createRemoteContentRule({
      context: readerContext,
      mailboxId,
      input: { scope: "sender", value: "sender@example.com" },
    });
    expect(repeated.ok && repeated.data.id).toBe(created.data.id);

    const readerRules = await listRemoteContentRules(readerContext, mailboxId);
    const ownerRules = await listRemoteContentRules(ownerContext, mailboxId);
    const outsiderRules = await listRemoteContentRules(outsiderContext, mailboxId);
    expect(readerRules.ok && readerRules.data.map((rule) => rule.id)).toEqual([created.data.id]);
    expect(ownerRules.ok && ownerRules.data).toEqual([]);
    expect(outsiderRules.ok).toBeFalse();

    const message = { id: crypto.randomUUID(), from: [{ address: "sender@example.com" }] };
    const readerMetadata = await resolveMessagesRemoteContent({ context: readerContext, mailboxId, messages: [message] });
    const ownerMetadata = await resolveMessagesRemoteContent({ context: ownerContext, mailboxId, messages: [message] });
    expect(readerMetadata.ok && readerMetadata.data.get(message.id)?.allowedByRule).toBeTrue();
    expect(ownerMetadata.ok && ownerMetadata.data.get(message.id)?.allowedByRule).toBeFalse();

    expect((await deleteRemoteContentRule({ context: ownerContext, mailboxId, ruleId: created.data.id })).ok).toBeFalse();
    expect((await deleteRemoteContentRule({ context: readerContext, mailboxId, ruleId: created.data.id })).ok).toBeTrue();

    const readerAccessId = accessIds[0];
    if (!readerAccessId) throw new Error("Reader access id is missing");
    expect((await revokeMailboxAccess({ context: ownerContext, mailboxId, accessId: readerAccessId })).ok).toBeTrue();
    expect((await listRemoteContentRules(readerContext, mailboxId)).ok).toBeFalse();
  });

  test("checks mailbox access before resolving a remote image and blocks private targets", async () => {
    const messageId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    await sql`
      INSERT INTO mail.message_contents (short_id,
        id, mailbox_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${messageId}::uuid, ${mailboxId}::uuid, 'Remote image', 'remote image', now(), 1,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete'
      )
    `;
    await sql`
      INSERT INTO mail.message_remote_images (id, message_id, position, source_url, source_host)
      VALUES (${imageId}::uuid, ${messageId}::uuid, 0, 'http://127.0.0.1/tracker.png', '127.0.0.1')
    `;

    const outsider = await loadRemoteImage({ context: outsiderContext, mailboxId, messageId, imageId });
    const owner = await loadRemoteImage({ context: ownerContext, mailboxId, messageId, imageId });
    expect(outsider.ok).toBeFalse();
    expect(owner.ok).toBeFalse();
    expect(!owner.ok && owner.error.message).not.toContain("127.0.0.1");
  });
});
