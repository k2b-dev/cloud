import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { sha256Json } from "../service/canonical";
import { imapSmtpConnector } from "../service/connectors";
import { createMailbox } from "../service/mailboxes";
import { createProviderConnection } from "../service/provider-connections";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "../service/provider-operation-lock";
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

const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-default-sender-${user.uid}`,
});

const fixtureVerification = (): ConnectorVerification => ({
  authenticatedPrincipal: "sender-setup@example.test",
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: true,
    qresync: true,
    move: true,
    uidplus: true,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: true,
    notify: false,
    quota: false,
    gmailExtensions: false,
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [
    { id: "sender-setup@example.test", name: "Fixture", locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] },
  ],
});

const connectionInput = {
  name: "Sender setup fixture",
  email: "sender-setup@example.test",
  username: "sender-setup@example.test",
  imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" as const },
  smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" as const },
  secret: { kind: "password" as const, password: "fixture-secret" },
};

suite("Mail default sender setup through the API", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const tokens = new Map<string, User>();
  const userIds: string[] = [];
  let mailboxId = "";
  let mailboxShortId = "";
  let connectionId = "";
  let bindingId = "";
  let remoteResourceId = "";

  const request = (token: string, path: string, init: { method: string; body: unknown; locale?: string }) =>
    app.request(`/mailboxes/${mailboxShortId}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.locale ? { "accept-language": init.locale } : {}),
      },
      body: JSON.stringify(init.body),
    });
  const setupSending = (token: string, locale?: string) =>
    request(token, "/sender-identities/default/setup", { method: "POST", body: { bindingId, savesSentAutomatically: true }, locale });

  beforeAll(async () => {
    await migrate();
    const rows = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`mail-sender-owner-${suffix}`}, 'local', 'user', 'Owner', false),
        (${`mail-sender-reader-${suffix}`}, 'local', 'user', 'Reader', false),
        (${`mail-sender-outsider-${suffix}`}, 'local', 'user', 'Outsider', false)
      RETURNING id, uid
    `;
    const [owner, reader, outsider] = rows.map(userFor);
    if (!owner || !reader || !outsider) throw new Error("Failed to create sender setup users");
    userIds.push(owner.id, reader.id, outsider.id);
    tokens.set("owner", owner).set("reader", reader).set("outsider", outsider);
    spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = tokens.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: [] } : null;
    });

    const ownerContext = contextFor(owner);
    const mailbox = await createMailbox(ownerContext, { name: `Sender setup ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [shortId] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = shortId!.short_id;
    const readAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!readAccess.ok) throw new Error(readAccess.error.message);

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    try {
      const connection = await createProviderConnection({ context: ownerContext, mailboxId, input: connectionInput });
      if (!connection.ok) throw new Error(connection.error.message);
      connectionId = connection.data.connection.id;
    } finally {
      verify.mockRestore();
    }
    // An active, verified binding is the state connect leaves behind once receiving works.
    const scope = sha256Json({ accountId: "sender-setup@example.test" });
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status, discovery_generation)
      VALUES (${mailboxId}::uuid, ${{ accountId: "sender-setup@example.test" }}::jsonb, '{}'::jsonb, ${scope}, 'active', 0)
      RETURNING id
    `;
    remoteResourceId = resource!.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
        capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      )
      VALUES (
        ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', 'sender-setup@example.test',
        ${{ accountId: "sender-setup@example.test" }}::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${scope}, 1, now()
      )
      RETURNING id
    `;
    bindingId = binding!.id;
  });

  afterAll(async () => {
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (userIds.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
  });

  test("keeps mailbox and sender identity resolution for other routes", async () => {
    const unknownMailbox = await app.request("/mailboxes/Zzz999/sender-identities/default/setup", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ bindingId, savesSentAutomatically: true }),
    });
    expect(unknownMailbox.status).toBe(404);

    const unknownIdentity = await request("owner", "/sender-identities/Zzz999/verify", { method: "POST", body: { bindingId } });
    expect(unknownIdentity.status).toBe(404);
    expect(await unknownIdentity.json()).toMatchObject({ message: "Sender identity not found" });
  });

  test("keeps mailbox admin access required for sender setup", async () => {
    for (const token of ["reader", "outsider"]) {
      const response = await setupSending(token);
      expect(response.status).toBe(403);
    }
    const [identities] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.sender_identities WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(identities?.count).toBe(0);
  });

  test(
    "reports running synchronization as a retryable provider-busy state",
    async () => {
      const held = await mailProviderOperationMutex().acquire({ resource: remoteResourceId, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
      if (!held) throw new Error("Could not hold the provider operation lease");
      const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
      try {
        const sending = await setupSending("owner", "de");
        expect(sending.status).toBe(409);
        expect(await sending.json()).toEqual({
          code: "PROVIDER_BUSY",
          message: "Die Synchronisierung läuft gerade. Versuche es in einem Moment erneut.",
        });

        const replaced = await request("owner", `/connections/${connectionId}`, { method: "PUT", body: connectionInput });
        expect(replaced.status).toBe(409);
        expect(await replaced.json()).toMatchObject({ code: "PROVIDER_BUSY" });
        expect(verify).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
        await mailProviderOperationMutex().release(held);
      }
      const [binding] = await sql<{ state: string }[]>`SELECT state FROM mail.provider_bindings WHERE id = ${bindingId}::uuid`;
      expect(binding?.state).toBe("active");
    },
    { timeout: 60_000 },
  );

  test("sets up the default sender on the connected binding", async () => {
    const send = spyOn(imapSmtpConnector, "send").mockImplementation(async (_connection, message) => ({
      accepted: message.to.map((recipient) => recipient.address),
      rejected: [],
      response: "250 accepted",
      messageId: message.messageId,
    }));
    try {
      const response = await setupSending("owner");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        fromAddress: "sender-setup@example.test",
        isDefault: true,
        status: "verified",
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
    const [binding] = await sql<{ state: string }[]>`SELECT state FROM mail.provider_bindings WHERE id = ${bindingId}::uuid`;
    expect(binding?.state).toBe("active");
  });
});
