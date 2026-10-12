import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import type { CommandState } from "../contracts";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { listCommands } from "./commands";
import { createMailbox } from "./mailboxes";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};

const suite = suiteFor("database", "nats");
const contextFor = (row: { id: string; uid: string }): MailRequestContext => {
  const user: User = {
    ...row,
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
  };
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, requestId: `command-list-${row.uid}` };
};

suite("Mail command state filtering and keyset pagination", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  const commands: Array<{ id: string; state: CommandState }> = [];
  let context: MailRequestContext;
  let readerContext: MailRequestContext;
  let outsiderContext: MailRequestContext;
  let assignedContext: MailRequestContext;
  let mailboxId = "";
  let foreignCommandId = "";

  beforeAll(async () => {
    await migrate();
    for (const name of ["owner", "reader", "outsider", "assigned"]) {
      const [row] = await sql<{ id: string; uid: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`command-list-${name}-${suffix}`}, 'local', 'user', ${name}, false) RETURNING id, uid
      `;
      userIds.push(required(row).id);
      if (name === "owner") context = contextFor(required(row));
      else if (name === "reader") readerContext = contextFor(required(row));
      else if (name === "outsider") outsiderContext = contextFor(required(row));
      else assignedContext = contextFor(required(row));
    }
    for (const name of ["Commands", "Other"]) {
      const mailbox = await createMailbox(context, { name: `${name} ${suffix}` });
      if (!mailbox.ok) throw new Error(mailbox.error.message);
      mailboxIds.push(mailbox.data.id);
    }
    mailboxId = required(mailboxIds[0]);
    const access = await grantMailboxAccess({
      context,
      mailboxId,
      principal: { type: "user", userId: required(userIds[1]) },
      permission: "read",
    });
    if (!access.ok) throw new Error(access.error.message);
    const assigned = await grantMailboxAccess({
      context,
      mailboxId,
      principal: { type: "user", userId: required(userIds[3]) },
      permission: "read",
      scope: "assigned",
    });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const states: CommandState[] = ["failed", "failed", "needs_attention", "confirmed", "failed", "queued"];
    for (const [index, state] of states.entries()) {
      const id = crypto.randomUUID();
      // Two rows share a timestamp; the next row differs only at microsecond precision.
      const createdAt = index < 2 ? "2026-01-01 00:00:00.000999+00" : `2026-01-01 00:00:00.000${998 - index}+00`;
      await sql`
        INSERT INTO mail.commands (id, mailbox_id, kind, state, actor_kind, access_subject_kind, idempotency_key,
          request_hash, target, payload, created_at, last_error_message)
        VALUES (${id}::uuid, ${mailboxId}::uuid, 'sync_mailbox', ${state}, 'system', 'system', ${id},
          ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb, ${createdAt}::timestamptz, ${state === "failed" ? "Provider did not answer" : null})
      `;
      commands.push({ id, state });
    }
    commands.splice(0, 2, ...commands.slice(0, 2).sort((a, b) => b.id.localeCompare(a.id)));
    foreignCommandId = crypto.randomUUID();
    await sql`
      INSERT INTO mail.commands (id, mailbox_id, kind, actor_kind, access_subject_kind, idempotency_key, request_hash, target, payload)
      VALUES (${foreignCommandId}::uuid, ${required(mailboxIds[1])}::uuid, 'sync_mailbox', 'system', 'system', ${foreignCommandId},
        ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb)
    `;
  });

  afterAll(async () => {
    for (const id of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      for (const row of access) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("returns the existing array contract and filters failed and needs_attention commands", async () => {
    const all = await listCommands(context, mailboxId);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.data.map((item) => item.id)).toEqual(commands.map((item) => item.id));
    for (const state of ["failed", "needs_attention"] as const) {
      const result = await listCommands(readerContext, mailboxId, { state });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((item) => item.id)).toEqual(commands.filter((item) => item.state === state).map((item) => item.id));
        if (state === "failed") expect(result.data.every((item) => item.lastError === "Provider did not answer")).toBe(true);
      }
    }
  });

  test("pages ties and sub-millisecond timestamps without overlap or omissions, with and without a state filter", async () => {
    for (const state of [undefined, "failed"] as const) {
      const ids: string[] = [];
      let before: string | undefined;
      for (let page = 0; page <= commands.length; page++) {
        const result = await listCommands(context, mailboxId, { state, before, limit: 1 });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        if (result.data.length === 0) break;
        before = required(result.data[0]).id;
        ids.push(before);
      }
      expect(ids).toEqual(commands.filter((item) => !state || item.state === state).map((item) => item.id));
    }
    // A cursor can identify a command with another state; state filters apply to the returned rows.
    const result = await listCommands(context, mailboxId, { state: "failed", before: required(commands[2]).id });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((item) => item.id)).toEqual([required(commands[4]).id]);
  });

  test("command list route preserves limits and validates state and UUID cursors", async () => {
    const [mailbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (context.actor.kind !== "user") throw new Error("Missing fixture user");
    const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
      kind: "user",
      payload: {},
      user: context.actor.user,
      scopes: [],
    });
    const request = (query: string) =>
      api.request(`/mailboxes/${required(mailbox).short_id}/commands${query}`, {
        headers: { authorization: "Bearer command-list-test", "x-forwarded-for": uniqueCallerAddress() },
      });
    try {
      for (const query of ["", "?limit=200"]) {
        const response = await request(query);
        expect(response.status).toBe(200);
        const rows = await response.json();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toHaveLength(commands.length);
      }
      for (const query of ["?before=not-a-uuid", "?state=unknown", "?limit=201"]) {
        expect((await request(query)).status).toBe(400);
      }
      const response = await request(`?state=needs_attention&before=${required(commands[0]).id}&limit=1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ id: required(commands[2]).id, state: "needs_attention" }]);
    } finally {
      verify.mockRestore();
    }
  });

  test("rejects malformed, missing and other-mailbox cursors and preserves actorRead access", async () => {
    for (const before of ["bad-id", crypto.randomUUID(), foreignCommandId]) {
      const result = await listCommands(context, mailboxId, { before });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(before === "bad-id" ? 400 : 404);
    }
    const invisible = await listCommands(assignedContext, mailboxId, { before: required(commands[0]).id });
    expect(invisible.ok).toBe(false);
    if (!invisible.ok) expect(invisible.error.status).toBe(404);
    const assigned = await listCommands(assignedContext, mailboxId, { state: "failed" });
    expect(assigned).toEqual({ ok: true, data: [] });
    const denied = await listCommands(outsiderContext, mailboxId, { state: "failed", before: required(commands[0]).id });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
  });
});
