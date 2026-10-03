import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
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
  let owner: User | undefined;
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";

  const request = (path: string, method = "GET") => app.request(path, { method, headers: { authorization: "Bearer owner" } });

  beforeAll(async () => {
    await migrate();
    const [row] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-deleted-route-${suffix}`}, 'local', 'user', 'Deleted route owner', false)
      RETURNING id, uid
    `;
    const user = userFor(row!);
    owner = user;
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) =>
      token === "owner" ? { kind: "user", payload: {}, user, scopes: [] } : null,
    );
    const mailbox = await createMailbox(
      { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, requestId: null },
      { name: `Deleted route ${suffix}` },
    );
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailboxRow!.short_id;
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
    if (owner) await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
  });

  test("lists, shows, and restores a deleted mailbox by its public ID", async () => {
    expect((await request(`/mailboxes/${mailboxShortId}`, "DELETE")).status).toBe(200);

    const listed = await request("/mailboxes/deleted?limit=200");
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: Array<{ id: string }> };
    expect(page.items.map((mailbox) => mailbox.id)).toContain(mailboxShortId);

    const shown = await request(`/mailboxes/${mailboxShortId}/deleted`);
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { id: string }).id).toBe(mailboxShortId);

    expect((await request(`/mailboxes/${mailboxShortId}/restore`, "POST")).status).toBe(200);
    const afterRestore = (await (await request("/mailboxes/deleted?limit=200")).json()) as { items: Array<{ id: string }> };
    expect(afterRestore.items.map((mailbox) => mailbox.id)).not.toContain(mailboxShortId);
  });

  test("answers an unknown mailbox ID below a collection route with not found", async () => {
    expect((await request("/mailboxes/zzzzzz/deleted")).status).toBe(404);
    expect((await request("/mailboxes/zzzzzz/restore", "POST")).status).toBe(404);
  });
});
