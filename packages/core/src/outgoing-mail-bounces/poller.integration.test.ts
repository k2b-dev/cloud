import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { MailStatus } from "@k2b/cloud/contracts";
import * as logging from "@k2b/cloud/services/logging";
import { applyOutgoingMailBounce, outgoingMailMessages } from "@k2b/cloud/services/outgoing-mail/messages";
import { listImapMailProfiles, saveImapMailCheck } from "@k2b/cloud/services/outgoing-mail/store";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate/core/outgoing-mail";
import { headers, report, status, structure } from "./fixtures";
import { type BounceMailbox, pollProfileBounces } from "./poller";

databaseSuite()("delivery report database effects", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  const profileId = crypto.randomUUID();
  beforeAll(async () => {
    fresh = await useFreshDatabase("outgoing_mail_bounces");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.simple();
    await migrate();
    await sql`INSERT INTO outgoing_mail.profiles(id, key, name, from_address, smtp_host, smtp_port, smtp_secure,
      imap_host, imap_port, imap_secure, imap_user, imap_folder)
      VALUES (${profileId}::uuid, 'sender', 'Sender', 'sender@example.org', 'smtp.example.org', 587, false,
        'imap.example.org', 993, true, 'sender', 'INBOX')`;
  });
  beforeEach(async () => {
    await sql`DELETE FROM outgoing_mail.messages`;
    await sql`UPDATE outgoing_mail.profiles SET imap_uid_validity = NULL, imap_last_uid = NULL, imap_checked_at = NULL, imap_error = NULL, from_address = 'sender@example.org'`;
  });
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  const insert = async (state: MailStatus) => {
    const id = report.id;
    await sql`INSERT INTO outgoing_mail.messages(id, app_id, profile_id, profile_key, lane, to_addresses, recipient_count, subject,
      message_id_header, status, deadline_at) VALUES (${id}::uuid, 'inventory', ${profileId}::uuid, 'sender', 'immediate',
      ARRAY['first@example.org', 'second@example.org'], 2, 'Hello', ${report.messageId}, ${state}, now() + interval '24 hours')`;
    return id;
  };
  const mailbox = (): BounceMailbox => ({
    open: async () => ({ uidValidity: "42" }),
    listUids: async () => ({ uids: [1], through: 1 }),
    bodyStructure: async () => structure,
    fetchPart: async (_uid, part) => Buffer.from(part === "2" ? status : headers),
    close: () => {},
  });
  test("sent becomes bounced, stores failures, appears in app/admin lists, and duplicate reports preserve the first bounce time", async () => {
    const id = await insert("sent");
    const [profile] = await listImapMailProfiles();
    await pollProfileBounces(profile!, mailbox, new AbortController().signal);
    const first = await sql<
      Record<string, unknown>[]
    >`SELECT status, failures, bounced_at FROM outgoing_mail.messages WHERE id = ${id}::uuid`;
    expect(first[0]?.status).toBe("bounced");
    expect(first[0]?.failures).toEqual(report.failures.map((item) => ({ ...item, at: expect.any(String) })));
    await Promise.all([
      applyOutgoingMailBounce(profileId, report.id, report.messageId, report.failures),
      applyOutgoingMailBounce(profileId, report.id, report.messageId, report.failures),
    ]);
    expect(
      await sql<Record<string, unknown>[]>`SELECT status, failures, bounced_at FROM outgoing_mail.messages WHERE id = ${id}::uuid`,
    ).toEqual(first);
    for (const metadata of [false, true]) {
      const page = await outgoingMailMessages.list({ app: "inventory", status: ["bounced"] }, {}, metadata);
      expect(page.items[0]).toMatchObject({ id, status: "bounced", failures: first[0]?.failures });
    }
    expect(
      await sql<
        Record<string, unknown>[]
      >`SELECT imap_uid_validity::text AS validity, imap_last_uid::int AS uid, imap_error, imap_checked_at IS NOT NULL AS checked FROM outgoing_mail.profiles`,
    ).toEqual([{ validity: "42", uid: 1, imap_error: null, checked: true }]);
  });
  test.each(["queued", "sending", "failed", "cancelled"] satisfies MailStatus[])("%s mail is unchanged", async (state) => {
    const id = await insert(state);
    await applyOutgoingMailBounce(profileId, report.id, report.messageId, report.failures);
    expect(
      await sql<Record<string, unknown>[]>`SELECT status, failures, bounced_at FROM outgoing_mail.messages WHERE id = ${id}::uuid`,
    ).toEqual([{ status: state, failures: [], bounced_at: null }]);
  });
  test("other profiles, missing records and mismatched IDs are skipped; failures are bounded", async () => {
    const id = await insert("sent");
    await applyOutgoingMailBounce(crypto.randomUUID(), report.id, report.messageId, report.failures);
    await applyOutgoingMailBounce(profileId, crypto.randomUUID(), report.messageId, report.failures);
    await applyOutgoingMailBounce(profileId, report.id, "<missing@example.org>", report.failures);
    expect((await sql<Record<string, unknown>[]>`SELECT status FROM outgoing_mail.messages`)[0]?.status).toBe("sent");
    await applyOutgoingMailBounce(
      profileId,
      report.id,
      report.messageId,
      Array.from({ length: 110 }, (_, i) => ({ recipient: "first@example.org", reason: `5.1.1 Unknown ${i}` })),
    );
    expect((await outgoingMailMessages.metadata(id))?.failures).toHaveLength(100);
    await sql`DELETE FROM outgoing_mail.messages`;
    await expect(applyOutgoingMailBounce(profileId, report.id, report.messageId, report.failures)).resolves.toBeUndefined();
  });
  test("poll errors preserve the cursor and record a credential-free check status", async () => {
    const [profile] = await listImapMailProfiles();
    await saveImapMailCheck(profile!, { uidValidity: "42", lastUid: 10 });
    const [current] = await listImapMailProfiles();
    const logger = spyOn(logging, "logger").mockReturnValue({ error: () => {}, warn: () => {}, debug: () => {}, info: () => {} });
    try {
      await pollProfileBounces(
        current!,
        () => ({
          ...mailbox(),
          open: async () => {
            throw new Error("password=must-not-escape");
          },
        }),
        new AbortController().signal,
      );
      expect(
        await sql<
          Record<string, unknown>[]
        >`SELECT imap_uid_validity::text AS validity, imap_last_uid::int AS uid, imap_error, imap_checked_at IS NOT NULL AS checked FROM outgoing_mail.profiles`,
      ).toEqual([{ validity: "42", uid: 10, imap_error: "open_failed", checked: true }]);
    } finally {
      logger.mockRestore();
    }
  });
  test.each([
    { name: "foreign recipient", final: "foreign@example.org", original: undefined, expected: [] },
    { name: "mixed report", final: "first@example.org", original: undefined, expected: ["first@example.org"] },
    { name: "Original-Recipient", final: "forwarded@example.net", original: "second@example.org", expected: ["second@example.org"] },
    { name: "case-insensitive recipient", final: "FIRST@EXAMPLE.ORG", original: undefined, expected: ["first@example.org"] },
  ])("$name only stores the message's actual recipients", async ({ final, original, expected }) => {
    const id = await insert("sent");
    const [profile] = await listImapMailProfiles();
    const deliveryStatus = `Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; <${final}>\r\n${original ? `Original-Recipient: rfc822; <${original}>\r\n` : ""}Action: failed\r\nStatus: 5.1.1\r\n\r\nFinal-Recipient: rfc822; foreign@example.org\r\nAction: failed\r\nStatus: 5.2.2\r\n`;
    await pollProfileBounces(
      profile!,
      () => ({ ...mailbox(), fetchPart: async (_uid, part) => Buffer.from(part === "2" ? deliveryStatus : headers) }),
      new AbortController().signal,
    );
    const record = await outgoingMailMessages.metadata(id);
    expect(record?.status).toBe(expected.length ? "bounced" : "sent");
    expect(record?.failures.map((failure) => failure.recipient)).toEqual([...expected]);
  });
  test("matches the stored Message-ID across UUID/domain case and later sender-domain changes", async () => {
    const id = await insert("sent");
    await sql`UPDATE outgoing_mail.messages SET message_id_header = ${`<${id}@Old.Example>`} WHERE id = ${id}::uuid`;
    await sql`UPDATE outgoing_mail.profiles SET from_address = 'sender@new.example' WHERE id = ${profileId}::uuid`;
    const [profile] = await listImapMailProfiles();
    const reported = headers.replace(report.messageId, `<${id.toUpperCase()}@old.example>`);
    await pollProfileBounces(
      profile!,
      () => ({ ...mailbox(), fetchPart: async (_uid, part) => Buffer.from(part === "2" ? status : reported) }),
      new AbortController().signal,
    );
    expect((await outgoingMailMessages.metadata(id))?.status).toBe("bounced");
  });
});
