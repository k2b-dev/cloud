import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { oauthTokens, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { MailboxListInputSchema } from "../capability-contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { getMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { loadAssignmentReviewChange } from "../service/capability-review-readers";
import { listLapsedAssignees } from "../service/collaborators";
import { commandStillAuthorized, type StoredCommandAuthorization } from "../service/command-authorization";
import { mailboxLiveKeys } from "../service/live-channels";
import { createMailbox } from "../service/mailboxes";
import { loadMailWorkflowCatalog } from "../service/workflow-catalog-service";
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

  const insertAccount = async (name: string, boundMailboxId?: string, kind: "agent" | "standalone" = "agent") => {
    const [row] = boundMailboxId
      ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
          VALUES (${name}, 'resource_bound', 'mail', 'mailbox', ${boundMailboxId}) RETURNING id`
      : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, ${kind}) RETURNING id`;
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
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": uniqueCallerAddress(),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
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

  test("an agent pins and hides mailboxes for itself, like a person, and loses them with its account", async () => {
    const agent = await insertAccount(`Mail tidy agent ${suffix}`);
    await grant(agent, "read");
    const token = await tokenFor(agent, ["mail:read"]);
    const preferences = async (bearer: string) => {
      const response = await call(bearer, "/mailboxes/preferences");
      expect(response.status).toBe(200);
      return response.json();
    };

    const hidden = await call(token, `/mailboxes/${mailboxShortId}/preference`, { method: "PATCH", body: { hidden: true } });
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({ pinned: false, hidden: true });
    expect(await preferences(token)).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [mailboxShortId] });
    // The owner's overview is the owner's own; a personal API key acts as the owner.
    expect(await preferences("owner-session")).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });
    const personal = await serviceAccountCredentials.createUserApiToken({
      user: owner,
      browserSignIn: await createTestBrowserSignIn(owner.id),
      name: `personal preferences ${suffix}`,
    });
    if (!personal.ok) throw new Error(personal.error.message);
    expect(
      (await call(personal.data.token, `/mailboxes/${mailboxShortId}/preference`, { method: "PATCH", body: { pinned: true } })).status,
    ).toBe(200);
    expect(await preferences("owner-session")).toEqual({ pinnedMailboxIds: [mailboxShortId], hiddenMailboxIds: [] });

    // Without a Mail scope the agent reads no mailbox, so it can neither change nor see a preference.
    const openidOnly = await tokenFor(agent, ["openid"]);
    expect((await call(openidOnly, `/mailboxes/${mailboxShortId}/preference`, { method: "PATCH", body: { pinned: true } })).status).toBe(
      403,
    );
    expect(await preferences(openidOnly)).toEqual({ pinnedMailboxIds: [], hiddenMailboxIds: [] });

    await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${agent}::uuid`;
    await sql`DELETE FROM auth.access WHERE service_account_id = ${agent}::uuid`;
    await sql`DELETE FROM auth.service_accounts WHERE id = ${agent}::uuid`;
    const [left] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.personal_mailbox_preferences WHERE service_account_id = ${agent}::uuid`;
    expect(left?.count).toBe(0);
  });

  test("user sessions and personal API keys keep acting with the user's grant", async () => {
    expect(await listedPermission("owner-session")).toBe("admin");
    expect((await createTag("owner-session")).status).toBe(200);

    // A personal key is minted without scopes and acts as its user.
    const personal = await serviceAccountCredentials.createUserApiToken({
      user: owner,
      browserSignIn: await createTestBrowserSignIn(owner.id),
      name: `personal ${suffix}`,
    });
    if (!personal.ok) throw new Error(personal.error.message);
    expect(personal.data.credential.scopes).toEqual([]);
    expect(await listedPermission(personal.data.token)).toBe("admin");
    expect((await createTag(personal.data.token)).status).toBe(200);
  });
  // Real message placements make list, search, focus, and worker authorization exercise their SQL boundaries.
  const conversationFixture = async (label: string) => {
    const stamp = new Date("2026-10-01T12:00:00.000Z");
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active')
      ON CONFLICT (mailbox_id) DO UPDATE SET mailbox_id = EXCLUDED.mailbox_id RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${label}, 'Inbox', 'inbox', 'current') RETURNING id`;
    const [conversation] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${label}, 'customer@example.test', ${stamp}, ${stamp}) RETURNING id, short_id`;
    const [message] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${label}-${suffix}@example.test>`}, ${label}, ${label.toLowerCase()},
        ${stamp}, 1, ${new Bun.CryptoHasher("sha256").update(label).digest("hex")}, 'complete', ${label}) RETURNING id, short_id`;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, email, normalized_email)
      VALUES (${message!.id}::uuid, 'from', 0, 'customer@example.test', 'customer@example.test')`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position)
      VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folder!.id}::uuid, ${message!.id}::uuid, 1, 1) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${folder!.id}::uuid, ${message!.id}::uuid, ARRAY[]::text[])`;
    return { id: conversation!.id, shortId: conversation!.short_id, messageId: message!.short_id, refId: ref!.id };
  };

  for (const kind of ["agent", "standalone"] as const) {
    test(`${kind}: a person grants and assigns the named account; its token accesses only assigned conversations, within scopes and until revoked`, async () => {
      const name = `Mail ${kind} assignee ${suffix}`;
      const accountId = await insertAccount(name, undefined, kind);
      const token = await tokenFor(accountId, ["mail:write"]);
      const reader = await tokenFor(accountId, ["mail:read"]);
      const assigned = await conversationFixture(`${kind} assigned`);
      const elsewhere = await conversationFixture(`${kind} elsewhere`);
      const base = `/mailboxes/${mailboxShortId}`;
      const path = (id: string) => `${base}/conversations/${id}/collaboration`;
      expect(
        (
          await call("owner-session", `${base}/access`, {
            method: "POST",
            body: {
              principal: { type: "service_account", serviceAccountId: accountId },
              permission: "admin",
              scope: "assigned",
            },
          })
        ).status,
      ).toBe(400);
      const grantResponse = await call("owner-session", `${base}/access`, {
        method: "POST",
        body: {
          principal: { type: "service_account", serviceAccountId: accountId },
          permission: "write",
          scope: "assigned",
        },
      });
      expect(grantResponse.status).toBe(200);
      const entry = (await grantResponse.json()) as { id: string; scope: string };
      expect(entry.scope).toBe("assigned");
      const listedAccess = await call("owner-session", `${base}/access`);
      expect(await listedAccess.json()).toContainEqual(
        expect.objectContaining({
          id: entry.id,
          displayName: name,
          serviceAccountKind: kind,
        }),
      );
      // The grant alone confers no conversation access.
      expect((await call(token, path(assigned.shortId))).status).toBe(404);
      const eligible = await call("owner-session", `${base}/assignable-users?search=${encodeURIComponent(name)}`);
      const principal = {
        id: accountId,
        uid: name,
        displayName: name,
        avatarHash: null,
        type: "service_account" as const,
        serviceAccountKind: kind,
      };
      expect(await eligible.json()).toEqual([expect.objectContaining({ ...principal, scope: "assigned" })]);
      const catalog = await loadMailWorkflowCatalog({
        context: {
          actor: { kind: "user", user: owner },
          accessSubject: { type: "user", userId: owner.id },
        },
        mailboxId,
      });
      expect(catalog.assignableUsers.refs.get(name)).toEqual({ id: accountId, name, type: "service_account", serviceAccountKind: kind });
      expect(catalog.notificationUsers.refs.has(name)).toBe(false);
      const change = await loadAssignmentReviewChange({
        mailboxId,
        conversationIds: [assigned.shortId],
        assigneeUserIds: [accountId],
        mode: "add",
        actorUserId: owner.id,
      });
      expect(change.requested).toEqual([{ name }]);
      expect(change.granted).toEqual([{ name }]);
      expect(change.addedTotal).toBe(0); // Accounts have no user notification inbox.
      const assign = (mode: "add" | "remove") =>
        call("owner-session", `${base}/conversations/assign`, {
          method: "POST",
          body: {
            conversationIds: [assigned.shortId],
            assigneeUserIds: [accountId],
            mode,
          },
        });
      const assignedResponse = await assign("add");
      expect(assignedResponse.status).toBe(200);
      expect(await assignedResponse.json()).toMatchObject({
        assignees: [principal],
        results: [{ conversationId: assigned.shortId, status: "ok" }],
      });
      const [stored] = await sql<{ user_id: string | null; service_account_id: string }[]>`
        SELECT user_id, service_account_id FROM mail.conversation_assignees WHERE conversation_id = ${assigned.id}::uuid`;
      expect(stored).toEqual({ user_id: null, service_account_id: accountId });
      const stateResponse = await call(token, path(assigned.shortId));
      expect(stateResponse.status).toBe(200);
      const state = (await stateResponse.json()) as { revision: number; assignees: unknown[] };
      expect(state.assignees).toEqual([principal]);
      const preview = await call(token, `${base}/conversations/${assigned.shortId}/preview`);
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ assigneeName: name });
      expect((await call(token, path(elsewhere.shortId))).status).toBe(404);
      expect((await call(token, `${base}/messages/${assigned.messageId}`)).status).toBe(200);
      expect((await call(token, `${base}/messages/${elsewhere.messageId}`)).status).toBe(404);
      for (const expression of [{ type: "assigned_to_me" }, { type: "assignee", userId: accountId }] as const) {
        const search = await call(token, `${base}/search`, { method: "POST", body: { expression, sort: "newest", limit: 20 } });
        expect(search.status).toBe(200);
        expect(await search.json()).toMatchObject({
          items: [expect.objectContaining({ conversationId: assigned.shortId, assigneeUserIds: [accountId] })],
        });
      }
      const focus = await call(token, "/overview/conversations?view=mine&limit=20");
      expect(focus.status).toBe(200);
      expect(await focus.json()).toMatchObject({ items: [expect.objectContaining({ id: assigned.shortId })] });
      expect((await call(token, `${base}/conversations?view=mine`)).status).toBe(200);
      const authenticated = await serviceAccountCredentials.authenticateApiToken(token);
      if (!authenticated) throw new Error("Assignment token did not authenticate");
      const context: CapabilityExecutionContext = {
        actor: {
          kind: "service_account",
          serviceAccount: authenticated.serviceAccount,
          delegatedUser: null,
          scopes: authenticated.credential.scopes,
          credentialId: authenticated.credential.id,
          credentialExpiresAt: authenticated.credential.expiresAt,
        },
        accessSubject: { type: "service_account", serviceAccountId: accountId },
        user: null,
        locale: "en",
        requestId: `mail-assignee-${kind}`,
        origin: "assistant",
        signal: new AbortController().signal,
      };
      const read = mailCapabilities.queries["conversation.read"];
      const readResult = await read.run({ id: assigned.shortId }, context);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) expect(readResult.data.data.collaboration.assignees).toEqual([principal]);
      expect((await read.run({ id: elsewhere.shortId }, context)).ok).toBe(false);
      const access = await getMailboxAccess(context, mailboxId);
      expect(access).toEqual({ scope: "assigned", permission: "write", serviceAccountId: accountId });
      expect(mailboxLiveKeys(mailboxId, access!)).toEqual([`${mailboxId}:${accountId}`, `${mailboxId}:assigned`]);
      const command: StoredCommandAuthorization = {
        id: crypto.randomUUID(),
        kind: "set_flags",
        target: { remoteMessageRefId: assigned.refId },
        mailbox_id: mailboxId,
        actor_kind: "service_account",
        actor_id: accountId,
        initiator_actor_kind: null,
        initiator_actor_id: null,
        access_subject_kind: "service_account",
        access_subject_id: accountId,
        credential_scopes: authenticated.credential.scopes,
        credential_id: authenticated.credential.id,
        credential_expires_at: authenticated.credential.expiresAt,
      };
      expect(await commandStillAuthorized(command, "write")).toBe(true);
      expect(await commandStillAuthorized({ ...command, target: { remoteMessageRefId: elsewhere.refId } }, "write")).toBe(false);
      const patch = { expectedRevision: state.revision, snoozedUntil: "2099-01-01T12:00:00.000Z" };
      expect((await call(reader, path(assigned.shortId), { method: "PATCH", body: patch })).status).toBe(403);
      expect((await call(token, path(assigned.shortId), { method: "PATCH", body: patch })).status).toBe(200);
      expect((await call(token, path(elsewhere.shortId), { method: "PATCH", body: { ...patch, expectedRevision: 1 } })).status).toBe(404);
      expect(
        (
          await call(token, path(assigned.shortId), {
            method: "PATCH",
            body: { expectedRevision: state.revision + 1, assigneeUserIds: [accountId] },
          })
        ).status,
      ).toBe(403);
      expect((await createTag(token)).status).toBe(403); // Assigned write is never mailbox-wide write.
      expect((await call(await tokenFor(accountId, ["openid"]), path(assigned.shortId))).status).toBe(403);
      expect((await call("owner-session", `${base}/access/${entry.id}`, { method: "PATCH", body: { permission: "read" } })).status).toBe(
        200,
      );
      expect((await call(token, path(assigned.shortId))).status).toBe(200);
      expect(
        (await call(token, path(assigned.shortId), { method: "PATCH", body: { expectedRevision: state.revision + 1, snoozedUntil: null } }))
          .status,
      ).toBe(403);
      expect((await call("owner-session", `${base}/access/${entry.id}`, { method: "PATCH", body: { permission: "write" } })).status).toBe(
        200,
      );
      await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${accountId}::uuid`;
      expect((await call(token, path(assigned.shortId))).status).not.toBe(200);
      expect(await listLapsedAssignees({ mailboxIds: [mailboxId] })).toContainEqual({ mailbox_id: mailboxId, user_id: accountId });
      expect(await commandStillAuthorized(command, "write")).toBe(false);
      await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${accountId}::uuid`;
      expect((await assign("remove")).status).toBe(200);
      expect((await call(token, path(assigned.shortId))).status).toBe(404);
      expect(await commandStillAuthorized(command, "write")).toBe(false);
      const beforeRestore = (await (await call("owner-session", path(assigned.shortId))).json()) as { revision: number };
      const restored = await call("owner-session", path(assigned.shortId), {
        method: "PATCH",
        body: {
          expectedRevision: beforeRestore.revision,
          assigneeUserIds: [accountId],
        },
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ assignees: [principal] });
      expect((await call("owner-session", `${base}/access/${entry.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await call(token, path(assigned.shortId))).status).toBe(403);
      expect((await call(token, path(assigned.shortId), { method: "PATCH", body: patch })).status).toBe(403);
      expect(await commandStillAuthorized(command, "write")).toBe(false);
      const noLongerEligible = await call("owner-session", `${base}/assignable-users?search=${encodeURIComponent(name)}`);
      expect(await noLongerEligible.json()).toEqual([]);
      expect(
        (
          await call("owner-session", `${base}/conversations/assign`, {
            method: "POST",
            body: {
              conversationIds: [elsewhere.shortId],
              assigneeUserIds: [accountId],
              mode: "add",
            },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("owner-session", `${base}/access`, {
            method: "POST",
            body: {
              principal: { type: "service_account", serviceAccountId: accountId },
              permission: "write",
              scope: "assigned",
            },
          })
        ).status,
      ).toBe(200);
      expect((await call(reader, path(assigned.shortId))).status).toBe(200);
      await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now()
        WHERE id = ${authenticated.credential.id}::uuid`;
      expect((await call(token, path(assigned.shortId))).status).not.toBe(200);
      expect((await call(reader, path(assigned.shortId))).status).toBe(200);
      expect(await commandStillAuthorized(command, "write")).toBe(false);
      const [currentGrant] = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_assigned_access
        WHERE mailbox_id = ${mailboxId}::uuid AND access_id IN (SELECT id FROM auth.access WHERE service_account_id = ${accountId}::uuid)`;
      expect(
        (
          await call("owner-session", `${base}/access/${currentGrant!.access_id}`, {
            method: "PATCH",
            body: { permission: "write", scope: "mailbox" },
          })
        ).status,
      ).toBe(200);
      const self = await call(reader, `${base}/assignable-users?self=true&limit=1`);
      expect(self.status).toBe(200);
      expect(await self.json()).toEqual([expect.objectContaining(principal)]);
    });
  }

  test("assignee eligibility keeps resource bindings and excludes personal API-key identities", async () => {
    const matching = await insertAccount(`Matching bound ${suffix}`, mailboxId);
    const foreign = await insertAccount(`Other bound ${suffix}`, crypto.randomUUID());
    const personal = await serviceAccountCredentials.createUserApiToken({
      user: owner,
      browserSignIn: await createTestBrowserSignIn(owner.id),
      name: `Personal assignee ${suffix}`,
    });
    if (!personal.ok) throw new Error(personal.error.message);
    const personalId = personal.data.credential.serviceAccountId;
    for (const id of [matching, foreign, personalId]) await grant(id, "write");
    const response = await call("owner-session", `/mailboxes/${mailboxShortId}/assignable-users?limit=200`);
    const eligible = (await response.json()) as Array<{ id: string; serviceAccountKind?: string }>;
    expect(eligible).toContainEqual(expect.objectContaining({ id: matching, serviceAccountKind: "resource_bound" }));
    expect(eligible.some((principal) => principal.id === foreign || principal.id === personalId)).toBe(false);
    const conversation = await conversationFixture("bound eligibility");
    for (const id of [foreign, personalId])
      expect(
        (
          await call("owner-session", `/mailboxes/${mailboxShortId}/conversations/assign`, {
            method: "POST",
            body: { conversationIds: [conversation.shortId], assigneeUserIds: [id], mode: "replace" },
          })
        ).status,
      ).toBe(400);
  });
});
