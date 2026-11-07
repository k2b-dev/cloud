import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { getMailboxAccess, requireMailboxAccess, withOneAccessRead } from "./access";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

suite("one access read for one view", () => {
  let userId = "";
  let mailboxId = "";
  let context: MailRequestContext;
  let accessIds: string[] = [];

  beforeAll(async () => {
    const uid = `mail-one-access-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Access reader', false)
      RETURNING id
    `;
    if (!row) throw new Error("User was not created");
    userId = row.id;
    const actor = {
      kind: "user",
      user: { id: userId, uid, provider: "local", profile: "user", displayName: "Access reader", roles: ["user"], memberofGroup: [] },
    } as unknown as MailRequestContext["actor"];
    context = { actor, accessSubject: { type: "user", userId }, requestId: "mail-one-access" };
    const mailbox = await createMailbox(context, { name: "One access read", description: "Disposable access fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("a view reads grants once, while every other context and every transaction reads them again", async () => {
    const view = withOneAccessRead(context);
    expect((await requireMailboxAccess(view, mailboxId, "read")).ok).toBe(true);

    const removed = await sql<
      { access_id: string }[]
    >`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid RETURNING access_id`;
    accessIds = removed.map((row) => row.access_id);

    // The running view keeps the answer it started with, as if all its parallel reads had run a moment earlier.
    expect((await requireMailboxAccess(view, mailboxId, "read")).ok).toBe(true);
    // The next request, the original context and a new view all see the removal.
    expect(await getMailboxAccess(context, mailboxId)).toBeNull();
    expect((await requireMailboxAccess(context, mailboxId, "read")).ok).toBe(false);
    expect((await requireMailboxAccess(withOneAccessRead(context), mailboxId, "read")).ok).toBe(false);
    // A check inside a transaction, as a change makes it, never uses the view's answer.
    const inTransaction = await sql.begin((tx) => requireMailboxAccess(view, mailboxId, "read", tx));
    expect(inTransaction.ok).toBe(false);
  });

  test("the view's context stays a separate object with the same identity", () => {
    const view = withOneAccessRead(context);
    expect(view).not.toBe(context);
    expect(view).toEqual(context);
  });
});
