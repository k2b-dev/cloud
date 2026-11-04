import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { requestMessageBody } from "./message-body-request";
import * as syncRuntime from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      ...user,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: "Mail",
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-body-request-${user.uid}`,
});

suite("Mail body requests of opened messages", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: Array<{ id: string; uid: string }> = [];
  let owner: MailRequestContext;
  let reader: MailRequestContext;
  let stranger: MailRequestContext;
  let clicker: MailRequestContext;
  let mailboxId = "";
  let folderId = "";
  let nextUid = 1;
  let enqueued: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    for (const role of ["owner", "reader", "stranger", "clicker"]) {
      const [user] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
        VALUES (${`body-${role}-${suffix}`}, 'local', 'user', ${`Body ${role}`}) RETURNING id, uid`;
      if (!user) throw new Error("Body request fixture user missing");
      users.push(user);
    }
    owner = contextFor(users[0]!);
    reader = contextFor(users[1]!);
    stranger = contextFor(users[2]!);
    clicker = contextFor(users[3]!);
    const mailbox = await createMailbox(owner, { name: `Body requests ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    for (const context of [reader, clicker]) {
      const grant = await grantMailboxAccess({ context: owner, mailboxId, principal: context.accessSubject, permission: "read" });
      if (!grant.ok) throw new Error(grant.error.message);
    }
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${suffix}, 'Inbox', 'inbox') RETURNING id`;
    folderId = folder!.id;
    spies.push(
      spyOn(syncRuntime, "enqueueMessageHydration").mockImplementation(async (messageId) => {
        enqueued.push(messageId);
      }),
    );
  });
  afterEach(() => {
    enqueued = [];
    setSystemTime();
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    await sql`DELETE FROM audit.events WHERE metadata->>'mailboxId' = ${mailboxId}`;
    for (const user of users) {
      await sql`DELETE FROM audit.events WHERE request_id = ${contextFor(user).requestId}`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });

  const message = async (
    options: { status?: string; attempt?: number; errorCode?: string | null; stale?: boolean; plainText?: string | null } = {},
  ) => {
    const uid = nextUid++;
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash,
         hydration_status, hydration_attempt, hydration_error_code, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<body-${uid}-${suffix}@example.test>`}, 'Opened', 'opened', now(), 1,
        ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, ${options.status ?? "envelope"}, ${options.attempt ?? 0},
        ${options.errorCode ?? null}, ${options.plainText ?? null})
      RETURNING id`;
    await sql`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, stale_at)
      VALUES (${folderId}::uuid, ${row!.id}::uuid, 1, ${uid}, ${options.stale ? new Date() : null})`;
    return row!.id;
  };
  const request = (messageId: string, context = owner, retry = false) => requestMessageBody({ context, mailboxId, messageId, retry });
  const hydration = async (messageId: string) => {
    const [row] = await sql<{ hydration_status: string; hydration_attempt: number; hydration_error_code: string | null }[]>`
      SELECT hydration_status, hydration_attempt, hydration_error_code FROM mail.message_contents WHERE id = ${messageId}::uuid
    `;
    return row;
  };

  test("a person without access to the message learns nothing and queues no job", async () => {
    const id = await message();
    const denied = await request(id, stranger);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect([403, 404]).toContain(denied.error.status);
    // Another mailbox's message is not found through this mailbox.
    const missing = await requestMessageBody({ context: owner, mailboxId, messageId: crypto.randomUUID(), retry: false });
    expect(missing).toMatchObject({ ok: false, error: { status: 404 } });
    expect(enqueued).toEqual([]);
  });

  test("a reader queues one job per message and window, and a reload continues the same wait", async () => {
    const start = new Date("2026-11-04T09:00:00.000Z");
    setSystemTime(start);
    const id = await message();
    expect(await request(id, reader)).toEqual({ ok: true, data: { state: "requested", waitedMs: 0 } });
    setSystemTime(new Date(start.getTime() + 20_000));
    // A reload, or the owner opening it too, joins the queued job and the wait so far.
    expect(await request(id, reader)).toEqual({ ok: true, data: { state: "requested", waitedMs: 20_000 } });
    expect(await request(id, owner)).toEqual({ ok: true, data: { state: "requested", waitedMs: 20_000 } });
    // An explicit retry starts the wait again; the job of the window stays the only one.
    expect(await request(id, reader, true)).toEqual({ ok: true, data: { state: "requested", waitedMs: 0 } });
    expect(enqueued).toEqual([id]);
  });

  test("a loaded body, a body no job can fetch, and a message too large to fetch queue nothing", async () => {
    const loaded = await message({ status: "complete", plainText: "Already here" });
    const stale = await message({ stale: true });
    const tooLarge = await message({ status: "failed", attempt: 5, errorCode: "MESSAGE_TOO_LARGE" });
    expect(await request(loaded)).toMatchObject({ ok: true, data: { state: "loaded" } });
    expect(await request(stale)).toMatchObject({ ok: true, data: { state: "unavailable" } });
    expect(await request(tooLarge, owner, true)).toMatchObject({ ok: true, data: { state: "unavailable" } });
    expect(await hydration(tooLarge)).toEqual({
      hydration_status: "failed",
      hydration_attempt: 5,
      hydration_error_code: "MESSAGE_TOO_LARGE",
    });
    expect(enqueued).toEqual([]);
  });

  test("a failed body is tried again from its first attempt, even right after an earlier request", async () => {
    const id = await message();
    expect(await request(id)).toMatchObject({ ok: true, data: { state: "requested" } });
    await sql`UPDATE mail.message_contents SET hydration_status = 'failed', hydration_attempt = 5, hydration_error_code = 'IMAP_TIMEOUT' WHERE id = ${id}::uuid`;
    expect(await request(id, reader, true)).toEqual({ ok: true, data: { state: "requested", waitedMs: 0 } });
    expect(await hydration(id)).toEqual({ hydration_status: "envelope", hydration_attempt: 0, hydration_error_code: null });
    expect(enqueued).toEqual([id, id]);
  });

  test("clicking through many messages puts at most twelve per minute, person and mailbox ahead of folder checks", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 14; index += 1) ids.push(await message());
    const states: string[] = [];
    for (const id of ids) {
      const result = await request(id, clicker);
      states.push(result.ok ? result.data.state : `error:${result.error.status}`);
    }
    expect(states).toEqual([...Array.from({ length: 12 }, () => "requested"), "limited", "limited"]);
    expect(enqueued).toEqual(ids.slice(0, 12));
    // The limit belongs to the person: another reader of the mailbox still asks with priority.
    expect(await request(ids[13]!, reader)).toMatchObject({ ok: true, data: { state: "requested" } });
    expect(enqueued).toEqual([...ids.slice(0, 12), ids[13]!]);
  });
});
