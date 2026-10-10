import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens, serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailConversationPreview } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "../service/auth";
import { writeConversationAssignees } from "../service/collaboration";
import { MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH, MAIL_CONVERSATION_PREVIEW_NAME_MAX_LENGTH } from "../service/conversation-preview";
import { createMailbox } from "../service/mailboxes";
import app from ".";

// The production API stack includes the Valkey-backed rate limit, so these requests need all three services.
const suite = suiteFor("database", "nats", "valkey");

const userFor = (row: { id: string; uid: string }): User => ({
  id: row.id,
  uid: row.uid,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: row.uid,
  sn: "Test",
  displayName: row.uid,
  mail: `${row.uid}@example.test`,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});

suite("Mail conversation quick look", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const sessions = new Map<string, User>();
  const userIds: string[] = [];
  const accountIds: string[] = [];
  const blobIds: string[] = [];
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let folderId = "";
  let uid = 0;

  const insertUser = async (name: string, displayName: string) => {
    const [row] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`${name}-${suffix}`}, 'local', 'user', ${displayName}, false)
      RETURNING id, uid
    `;
    if (!row) throw new Error("Failed to create a test user");
    userIds.push(row.id);
    const user = userFor(row);
    sessions.set(`${name}-session`, user);
    return user;
  };

  const call = (token: string, path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueCallerAddress() } });
  const preview = (token: string, conversationShortId: string) =>
    call(token, `/mailboxes/${mailboxShortId}/conversations/${conversationShortId}/preview`);

  const insertMessage = async (params: {
    conversationId: string;
    minutesAgo: number;
    from: { name: string; email: string };
    plainText?: string | null;
    html?: string | null;
    hydrationStatus?: "headers" | "failed" | "complete";
    attachments?: string[];
  }) => {
    uid += 1;
    const date = new Date(Date.now() - params.minutesAgo * 60_000);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status, plain_text, sanitized_html
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${`<preview-${uid}-${suffix}@example.test>`}, 'Offer', ${date}, 128,
        ${`${suffix}${uid.toString(16)}`.padEnd(64, "0")}, ${params.hydrationStatus ?? "complete"}, ${params.plainText ?? null}, ${params.html ?? null}
      ) RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, ${params.from.name}, ${params.from.email}, ${params.from.email})
    `;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${uid})
      RETURNING id
    `;
    // Unread: no \\Seen flag, so a read marking would be visible.
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${remoteRef!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid, ARRAY[]::text[])
    `;
    for (const [index, filename] of (params.attachments ?? []).entries()) {
      const [blob] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_count, complete, completed_at)
        VALUES (${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 1024, 1, true, now())
        RETURNING id
      `;
      blobIds.push(blob!.id);
      const [part] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_parts (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
        VALUES (${message!.id}::uuid, ${String(index + 2)}, 'application/pdf', 'attachment', ${filename}, 1024, ${blob!.id}::uuid, 'complete')
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
        VALUES (${newShortId()}, ${message!.id}::uuid, ${part!.id}::uuid, ${filename}, 'application/pdf', 'attachment', 1024, ${blob!.id}::uuid)
      `;
    }
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${params.conversationId}::uuid, ${message!.id}::uuid, ${date.getTime()}, 'headers')
    `;
  };

  const insertConversation = async (params: { summary?: string | null; assigneeUserIds?: string[] } = {}) => {
    const [conversation] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, summary)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Offer', 'Mara Beispiel', now(), ${params.summary ?? null})
      RETURNING id, short_id
    `;
    await sql.begin((tx) =>
      writeConversationAssignees(tx, { mailboxId, conversationId: conversation!.id, userIds: params.assigneeUserIds ?? [] }),
    );
    return { id: conversation!.id, shortId: conversation!.short_id };
  };

  /** Everything a read marking or another side effect would change. */
  const observableState = async (conversationId: string) => {
    const [state] = await sql<{ revision: string; updated_at: Date; flags: string[]; activity: number; hydration: string[] }[]>`
      SELECT
        c.revision,
        c.updated_at,
        ARRAY(
          SELECT array_to_string(mp.flags, ',') FROM mail.conversation_messages cm
          JOIN mail.message_placements mp ON mp.message_id = cm.message_id
          WHERE cm.conversation_id = c.id ORDER BY mp.message_id
        ) AS flags,
        (SELECT COUNT(*)::int FROM mail.activity_events event WHERE event.conversation_id = c.id) AS activity,
        ARRAY(
          SELECT mc.hydration_status FROM mail.conversation_messages cm
          JOIN mail.message_contents mc ON mc.id = cm.message_id
          WHERE cm.conversation_id = c.id ORDER BY mc.id
        ) AS hydration
      FROM mail.conversations c WHERE c.id = ${conversationId}::uuid
    `;
    const [commands] = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid`;
    return { ...state, commands: commands?.count ?? 0 };
  };

  let owner: User;
  let assignee: User;
  let main: { id: string; shortId: string };

  beforeAll(async () => {
    await migrate();
    owner = await insertUser("preview-owner", "Owner");
    assignee = await insertUser("preview-assignee", "Jonas Muster");
    await insertUser("preview-outsider", "Outsider");
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = sessions.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
    });

    const ownerContext: MailRequestContext = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId: owner.id },
      requestId: `mail-preview-${suffix}`,
    };
    const mailbox = await createMailbox(ownerContext, { name: `Quick look ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = row!.short_id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${suffix.padEnd(64, "0")}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`preview-${suffix}`}, 'Inbox', 'inbox', 'current')
      RETURNING id
    `;
    folderId = folder!.id;

    main = await insertConversation({ assigneeUserIds: [assignee.id] });
    await insertMessage({
      conversationId: main.id,
      minutesAgo: 30,
      from: { name: "Jonas Muster", email: "jonas@example.test" },
      plainText: "Could you send version 3?",
      attachments: ["Offer_v2.pdf"],
    });
    await insertMessage({
      conversationId: main.id,
      minutesAgo: 5,
      from: { name: "Mara Beispiel", email: "mara@example.test" },
      plainText: "Hello Jonas,\n\nhere is version 3.\n\nMara\n\nOn Monday Jonas wrote:\n> Could you send version 3?",
      attachments: ["Offer_v3.pdf", "Stage_plot.png"],
    });
  });

  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    if (blobIds.length) await sql`DELETE FROM mail.message_part_blobs WHERE id IN ${sql(blobIds)}`;
    for (const id of accountIds) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
      await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    if (userIds.length) await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
  });

  test("returns the newest message without quoted history and the conversation's facts", async () => {
    const response = await preview("preview-owner-session", main.shortId);
    expect(response.status).toBe(200);
    expect((await response.json()) as MailConversationPreview).toEqual({
      conversationId: main.shortId,
      summary: null,
      latestMessage: {
        from: { name: "Mara Beispiel", address: "mara@example.test" },
        excerpt: "Hello Jonas,\n\nhere is version 3.\n\nMara",
        body: "synced",
      },
      // The newest message's first attachment; the count covers the whole conversation.
      attachments: { count: 3, firstName: "Offer_v3.pdf" },
      earlierMessageCount: 1,
      assigneeName: "Jonas Muster",
    });
  });

  test("shows a stored summary as plain text and bounds the excerpt", async () => {
    const conversation = await insertConversation({ summary: "**Version 3** is ready.\n\n- Reply by Friday" });
    await insertMessage({
      conversationId: conversation.id,
      minutesAgo: 1,
      from: { name: "Paul Probe", email: "paul@example.test" },
      plainText: "word ".repeat(10_000),
    });
    const response = await preview("preview-owner-session", conversation.shortId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as MailConversationPreview;
    expect(body.summary).toBe("Version 3 is ready. • Reply by Friday");
    expect(body.latestMessage?.excerpt?.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_EXCERPT_MAX_LENGTH);
    expect(body.latestMessage?.excerpt?.endsWith("…")).toBeTrue();
    expect(body).toMatchObject({ attachments: { count: 0, firstName: null }, earlierMessageCount: 0, assigneeName: null });
  });

  test("falls back to the HTML body as text without remote content", async () => {
    const conversation = await insertConversation();
    await insertMessage({
      conversationId: conversation.id,
      minutesAgo: 1,
      from: { name: "Lea Lorem", email: "lea@example.test" },
      html: '<p>Thanks for <a href="https://tracker.example.test/c">confirming</a>!</p><img src="https://images.example.test/p.png" alt="tracking">',
    });
    const body = (await (await preview("preview-owner-session", conversation.shortId)).json()) as MailConversationPreview;
    expect(body.latestMessage?.excerpt).toBe("Thanks for confirming!");
  });

  test("tells a body that is still syncing or failed apart from a message without text", async () => {
    const stateOf = async (hydrationStatus: "headers" | "failed" | "complete") => {
      const conversation = await insertConversation();
      await insertMessage({
        conversationId: conversation.id,
        minutesAgo: 1,
        from: { name: "Lea Lorem", email: "lea@example.test" },
        hydrationStatus,
      });
      const body = (await (await preview("preview-owner-session", conversation.shortId)).json()) as MailConversationPreview;
      return body.latestMessage && { excerpt: body.latestMessage.excerpt, body: body.latestMessage.body };
    };
    expect(await stateOf("headers")).toEqual({ excerpt: null, body: "syncing" });
    expect(await stateOf("failed")).toEqual({ excerpt: null, body: "failed" });
    expect(await stateOf("complete")).toEqual({ excerpt: null, body: "synced" });
  });

  test("bounds sender and attachment names like the text", async () => {
    const conversation = await insertConversation();
    await insertMessage({
      conversationId: conversation.id,
      minutesAgo: 1,
      from: { name: "Very long name ".repeat(500), email: "long@example.test" },
      plainText: "Hi",
      attachments: [`${"a".repeat(5_000)}.pdf`],
    });
    const body = (await (await preview("preview-owner-session", conversation.shortId)).json()) as MailConversationPreview;
    expect(body.latestMessage?.from?.name?.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_NAME_MAX_LENGTH);
    expect(body.attachments.firstName?.length).toBeLessThanOrEqual(MAIL_CONVERSATION_PREVIEW_NAME_MAX_LENGTH);
    expect(body.attachments.firstName?.endsWith("…")).toBeTrue();
  });

  test("changes nothing: no read marking, revision, activity, hydration, or command", async () => {
    const before = await observableState(main.id);
    for (let index = 0; index < 3; index += 1) expect((await preview("preview-owner-session", main.shortId)).status).toBe(200);
    expect(await observableState(main.id)).toEqual(before);
    expect(before.flags).toEqual(["", ""]);
  });

  test("answers 404 alike for an unknown conversation and for a user without mailbox access", async () => {
    const unknown = await preview("preview-owner-session", "Zz9Zz9");
    const denied = await preview("preview-outsider-session", main.shortId);
    expect(unknown.status).toBe(404);
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { code: string }).code).toBe(((await unknown.json()) as { code: string }).code);
  });

  test("lets agents read it through their grant and scopes like users", async () => {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Preview agent ${suffix}`}, 'agent') RETURNING id`;
    accountIds.push(account!.id);
    const token = async (scopes: string[]) => {
      const created = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account!.id,
        name: `preview ${scopes.join(" ")}`,
        scopes,
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data.token;
    };
    const readScoped = await token(["read"]);
    // Without a grant on this mailbox, the scope alone reaches nothing.
    expect((await preview(readScoped, main.shortId)).status).toBe(404);

    const [access] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${access!.id}::uuid)`;
    const granted = await preview(readScoped, main.shortId);
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as MailConversationPreview).assigneeName).toBe("Jonas Muster");

    // A token without a Mail scope cannot read even with the grant.
    expect((await preview(await token(["openid"]), main.shortId)).status).toBe(404);
  });
});
