import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { unwrap } from "@k2b/stdlib";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import * as mailboxes from "./mailboxes";
import * as messages from "./messages";
import { loadMailboxListView, resolveWorkspaceRequest } from "./workspace";

const suite = suiteFor("database", "nats", "valkey");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: null,
});
const anchor = new Date("2026-10-01T12:00:00.000Z");

suite("Mail Assigned to me groups", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let owner: User;
  let mailboxId = "";
  let mailboxShortId = "";
  let folderId = "";
  /** Subject by conversation ID. */
  const subjects = new Map<string, string>();

  const conversation = async (subject: string, minutesAgo: number, workStatus: "needs_action" | "waiting" | "done", assigned: boolean) => {
    const date = new Date(anchor.getTime() - minutesAgo * 60_000);
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'Customer', ${date}, ${workStatus}) RETURNING id`;
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${suffix}-${subject}@example.test>`}, ${subject}, ${subject.toLowerCase()},
        ${date}, ${date}, 100, ${Bun.hash(subject).toString(16).padStart(64, "0")}, 'complete', 'Body') RETURNING id`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${row!.id}::uuid, ${message!.id}::uuid, 1, 'headers')`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message!.id}::uuid, 1, ${subjects.size + 1}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${message!.id}::uuid, ARRAY['\\Seen']::text[])`;
    if (assigned)
      await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id, assigned_at)
        VALUES (${row!.id}::uuid, ${owner.id}::uuid, ${anchor})`;
    subjects.set(row!.id, subject);
  };

  /** Every page of Assigned to me at this page size, as subjects. */
  const pages = async (limit: number) => {
    const result: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(await messages.listConversations({ context: contextFor(owner), mailboxId, view: "mine", cursor, limit }));
      result.push(page.items.map((item) => subjects.get(item.id)!));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && result.length < 10);
    return result;
  };

  beforeAll(async () => {
    const uid = `mail-assigned-groups-${suffix}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Lea Brandt', false) RETURNING id`;
    owner = {
      id: user!.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Lea",
      sn: "Brandt",
      displayName: "Lea Brandt",
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
    mailboxId = unwrap(await mailboxes.createMailbox(contextFor(owner), { name: `Assigned groups ${suffix}` })).id;
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}', '{}', ${"e".repeat(64)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    folderId = folder!.id;
    // The newest conversation waits for a reply; it still lists after every one that needs action.
    await conversation("waiting newest", 0, "waiting", true);
    await conversation("needs 1", 1, "needs_action", true);
    await conversation("needs 2", 2, "needs_action", true);
    await conversation("waiting 2", 3, "waiting", true);
    await conversation("needs 3", 4, "needs_action", true);
    await conversation("waiting 3", 5, "waiting", true);
    // Neither belongs to Assigned to me.
    await conversation("done", 6, "done", true);
    await conversation("someone else's", 7, "needs_action", false);
  }, 30_000);

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("lists whose turn it is before what waits, each newest first, in one page", async () => {
    expect(await pages(50)).toEqual([["needs 1", "needs 2", "needs 3", "waiting newest", "waiting 2", "waiting 3"]]);
  });

  test("a page that ends exactly at the group boundary continues with the waiting group", async () => {
    expect(await pages(3)).toEqual([
      ["needs 1", "needs 2", "needs 3"],
      ["waiting newest", "waiting 2", "waiting 3"],
    ]);
  });

  test("a page boundary inside either group keeps the order and repeats nothing", async () => {
    expect(await pages(2)).toEqual([
      ["needs 1", "needs 2"],
      ["needs 3", "waiting newest"],
      ["waiting 2", "waiting 3"],
    ]);
    expect(await pages(4)).toEqual([
      ["needs 1", "needs 2", "needs 3", "waiting newest"],
      ["waiting 2", "waiting 3"],
    ]);
  });

  test("a cursor without its group cannot continue Assigned to me", async () => {
    const first = unwrap(await messages.listConversations({ context: contextFor(owner), mailboxId, view: "mine", limit: 2 }));
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    expect(decoded.group).toBe("needs_action");
    delete decoded.group;
    const stale = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const result = await messages.listConversations({ context: contextFor(owner), mailboxId, view: "mine", cursor: stale, limit: 2 });
    expect(result.ok).toBe(false);
  });

  test("the headings count the whole view from the view counts, and only Assigned to me has them", async () => {
    const counts = unwrap(await messages.getMailboxConversationCounts({ context: contextFor(owner), mailboxId }));
    expect(counts.views.mine).toBe(6);
    expect(counts.mineWaiting).toBe(3);
    const resolved = await resolveWorkspaceRequest(new URL(`/app/mail/${mailboxShortId}?view=mine`, "https://cloud.test"), mailboxId);
    const view = unwrap(await loadMailboxListView({ context: contextFor(owner), mailboxId, ...resolved! }));
    expect(view.assignedGroups).toEqual({ needsAction: 3, waiting: 3 });
    expect(view.listItems.map((item) => item.workStatus)).toEqual([
      "needs_action",
      "needs_action",
      "needs_action",
      "waiting",
      "waiting",
      "waiting",
    ]);
    const all = await resolveWorkspaceRequest(new URL(`/app/mail/${mailboxShortId}`, "https://cloud.test"), mailboxId);
    expect(unwrap(await loadMailboxListView({ context: contextFor(owner), mailboxId, ...all! })).assignedGroups).toBeNull();
  });
});
