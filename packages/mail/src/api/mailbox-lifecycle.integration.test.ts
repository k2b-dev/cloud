import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
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

suite("Mail API for recently deleted mailboxes", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const tokens = new Map<string, User>();
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";

  const request = (path: string, method = "GET", token = "owner") =>
    app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
  const deletedIds = async (token: string) => {
    const listed = await request("/mailboxes/deleted?limit=200", "GET", token);
    expect(listed.status).toBe(200);
    return ((await listed.json()) as { items: Array<{ id: string }> }).items.map((mailbox) => mailbox.id);
  };

  beforeAll(async () => {
    await migrate();
    const userWithToken = async (token: "owner" | "reader") => {
      const [row] = await sql<{ id: string; uid: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`mail-deleted-route-${token}-${suffix}`}, 'local', 'user', ${`Deleted route ${token}`}, false)
        RETURNING id, uid
      `;
      const user = userFor(row!);
      tokens.set(token, user);
      return user;
    };
    const owner = await userWithToken("owner");
    const reader = await userWithToken("reader");
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = tokens.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
    });
    const ownerContext: MailRequestContext = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId: owner.id },
      requestId: null,
    };
    const mailbox = await createMailbox(ownerContext, { name: `Deleted route ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailboxRow!.short_id;
    const readAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!readAccess.ok) throw new Error(readAccess.error.message);
  });

  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((entry) => entry.access_id)}::jsonb))
        `;
      }
    }
    const userIds = [...tokens.values()].map((user) => user.id);
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("lists, shows, and restores a deleted mailbox by its public ID for its administrators only", async () => {
    expect((await request(`/mailboxes/${mailboxShortId}`, "DELETE")).status).toBe(200);

    expect(await deletedIds("owner")).toContain(mailboxShortId);
    const shown = await request(`/mailboxes/${mailboxShortId}/deleted`);
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { id: string }).id).toBe(mailboxShortId);

    // Read access to the mailbox does not extend to its lifecycle.
    expect(await deletedIds("reader")).not.toContain(mailboxShortId);
    expect((await request(`/mailboxes/${mailboxShortId}/deleted`, "GET", "reader")).status).toBe(403);
    expect((await request(`/mailboxes/${mailboxShortId}/restore`, "POST", "reader")).status).toBe(403);
    expect(await deletedIds("owner")).toContain(mailboxShortId);

    expect((await request(`/mailboxes/${mailboxShortId}/restore`, "POST")).status).toBe(200);
    expect(await deletedIds("owner")).not.toContain(mailboxShortId);
  });

  test("answers an unknown mailbox ID below a collection route with not found", async () => {
    expect((await request("/mailboxes/zzzzzz/deleted")).status).toBe(404);
    expect((await request("/mailboxes/zzzzzz/restore", "POST")).status).toBe(404);
  });
});
