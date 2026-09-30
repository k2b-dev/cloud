import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { oauthTokens, serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { MailboxListInputSchema } from "../capability-contracts";
import { migrate } from "../migrate";
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

suite("Mail REST access for service-account credentials", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accountIds: string[] = [];
  const users = new Map<string, User>();
  let mailboxId = "";
  let mailboxShortId = "";
  let owner: User;
  let verifyAccessToken: { mockRestore: () => void } | undefined;

  const insertAccount = async (name: string, boundMailboxId?: string) => {
    const [row] = boundMailboxId
      ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
          VALUES (${name}, 'resource_bound', 'mail', 'mailbox', ${boundMailboxId}) RETURNING id`
      : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'agent') RETURNING id`;
    if (!row) throw new Error("Service account was not created");
    accountIds.push(row.id);
    return row.id;
  };

  const grant = async (serviceAccountId: string, permission: "read" | "write" | "admin") => {
    const [access] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (service_account_id, permission) VALUES (${serviceAccountId}::uuid, ${permission}) RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${access!.id}::uuid)`;
  };

  const tokenFor = async (serviceAccountId: string, scopes: string[]) => {
    const created = await serviceAccountCredentials.createApiToken({ serviceAccountId, name: `test ${scopes.join(" ")}`, scopes });
    if (!created.ok) throw new Error(created.error.message);
    return created.data.token;
  };

  const call = (token: string, path: string, init?: { method?: string; body?: unknown }) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  /** Runs `mailbox.list` the way an Assistant or MCP invocation does, as the credential behind `token`. */
  const capabilityMailboxes = async (token: string, minimumPermission: "read" | "write") => {
    const authenticated = await serviceAccountCredentials.authenticateApiToken(token);
    if (!authenticated) throw new Error("Test token did not authenticate");
    const context: CapabilityExecutionContext = {
      actor: {
        kind: "service_account",
        serviceAccount: authenticated.serviceAccount,
        delegatedUser: null,
        scopes: authenticated.credential.scopes,
        credentialId: authenticated.credential.id,
        credentialExpiresAt: authenticated.credential.expiresAt,
      },
      accessSubject: { type: "service_account", serviceAccountId: authenticated.serviceAccount.id },
      user: null,
      locale: "en",
      requestId: `mail-agent-capability-${suffix}`,
      origin: "assistant",
      signal: new AbortController().signal,
    };
    const list = mailCapabilities.queries?.["mailbox.list"];
    if (!list) throw new Error("mailbox.list is not defined");
    const result = await list.run(MailboxListInputSchema.parse({ minimumPermission }), context);
    if (!result.ok) throw new Error(result.error.message);
    return result.data.data.map((mailbox) => mailbox.permission);
  };

  let tagCount = 0;
  const createTag = (token: string) =>
    call(token, `/mailboxes/${mailboxShortId}/local-tags`, {
      method: "POST",
      body: { name: `Tag ${suffix} ${++tagCount}`, color: "#336699" },
    });

  const listedPermission = async (token: string) => {
    const response = await call(token, "/mailboxes");
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { id: string; permission: string }[];
    return listed.find((mailbox) => mailbox.id === mailboxShortId)?.permission ?? null;
  };

  beforeAll(async () => {
    await migrate();
    const rows = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-agent-owner-${suffix}`}, 'local', 'user', 'Owner', false)
      RETURNING id, uid
    `;
    const [ownerRow] = rows;
    if (!ownerRow) throw new Error("Failed to create the mailbox owner");
    owner = userFor(ownerRow);
    userIds.push(owner.id);
    users.set("owner-session", owner);
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = users.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
    });

    const ownerContext: MailRequestContext = {
      actor: { kind: "user", user: owner },
      accessSubject: { type: "user", userId: owner.id },
      requestId: `mail-agent-access-${suffix}`,
    };
    const mailbox = await createMailbox(ownerContext, { name: `Agent access ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = row!.short_id;
  });

  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const delegated = await sql<{ id: string }[]>`
      SELECT id FROM auth.service_accounts WHERE delegated_user_id IN ${sql(userIds.length ? userIds : [crypto.randomUUID()])}`;
    for (const id of [...accountIds, ...delegated.map((account) => account.id)]) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
      await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    if (userIds.length) await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
  });

  test("an agent token caps the agent's grant to its scopes", async () => {
    const agent = await insertAccount(`Mail agent ${suffix}`);
    await grant(agent, "write");

    const readOnly = await tokenFor(agent, ["read"]);
    expect((await call(readOnly, `/mailboxes/${mailboxShortId}`)).status).toBe(200);
    expect(await listedPermission(readOnly)).toBe("read");
    expect((await createTag(readOnly)).status).toBe(403);
    expect(await capabilityMailboxes(readOnly, "read")).toEqual(["read"]);
    expect(await capabilityMailboxes(readOnly, "write")).toEqual([]);

    const readWrite = await tokenFor(agent, ["read", "write"]);
    expect(await listedPermission(readWrite)).toBe("write");
    expect((await createTag(readWrite)).status).toBe(200);
    expect(await capabilityMailboxes(readWrite, "write")).toEqual(["write"]);

    // Scopes never raise a grant: an admin-scoped token still acts with the write grant.
    const adminScoped = await tokenFor(agent, ["admin"]);
    expect(await listedPermission(adminScoped)).toBe("write");
    expect((await call(adminScoped, `/mailboxes/${mailboxShortId}/access`)).status).toBe(403);

    // A token without a Mail scope reaches nothing.
    const openidOnly = await tokenFor(agent, ["openid"]);
    expect(await listedPermission(openidOnly)).toBeNull();
    expect((await call(openidOnly, `/mailboxes/${mailboxShortId}`)).status).toBe(403);
  });

  test("a resource-bound key keeps its binding and its scope cap", async () => {
    const bound = await insertAccount(`Mail bound ${suffix}`, mailboxId);
    await grant(bound, "write");

    expect((await createTag(await tokenFor(bound, ["mail:read"]))).status).toBe(403);
    const writer = await tokenFor(bound, ["mail:write"]);
    expect(await listedPermission(writer)).toBe("write");
    expect((await createTag(writer)).status).toBe(200);
  });

  test("user sessions and personal API keys keep acting with the user's grant", async () => {
    expect(await listedPermission("owner-session")).toBe("admin");
    expect((await createTag("owner-session")).status).toBe(200);

    // A personal key is minted without scopes and acts as its user.
    const personal = await serviceAccountCredentials.createUserApiToken({ user: owner, name: `personal ${suffix}` });
    if (!personal.ok) throw new Error(personal.error.message);
    expect(personal.data.credential.scopes).toEqual([]);
    expect(await listedPermission(personal.data.token)).toBe("admin");
    expect((await createTag(personal.data.token)).status).toBe(200);
  });
});
