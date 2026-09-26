import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { providerErrorCode } from "./provider-errors";
import { executeBindingRediscovery } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

// Short enough for a test, long enough for a healthy rediscovery against local infrastructure.
const TEST_DEADLINE_MS = 2_000;

const inbox = () => ({
  stableKey: "INBOX:10",
  path: "INBOX",
  name: "INBOX",
  delimiter: "/",
  parentPath: null,
  role: "inbox" as const,
  subscribed: true,
  selectable: true,
  uidValidity: "10",
  uidNext: "1",
  highestModseq: "1",
  rights: ["read", "write_flags", "insert", "move", "delete_messages"],
  rightsSource: "acl" as const,
});

const fixtureVerification = (account: string): ConnectorVerification => ({
  authenticatedPrincipal: account,
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
  accounts: [{ id: account, name: account, locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] }],
});

suite("mail binding rediscovery", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  let userId = "";
  let ownerContext: MailRequestContext;

  const createBoundMailbox = async (label: string): Promise<{ bindingId: string; account: string }> => {
    const account = `${label}-${suffix}@example.test`;
    const mailbox = await createMailbox(ownerContext, { name: `Rediscovery ${label} ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification(account));
    let connectionId = "";
    try {
      const connection = await createProviderConnection({
        context: ownerContext,
        mailboxId: mailbox.data.id,
        input: {
          name: `Rediscovery ${label}`,
          email: account,
          username: account,
          imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      connectionId = connection.data.connection.id;
    } finally {
      verify.mockRestore();
    }
    const folder = inbox();
    const evidence = {
      version: 1,
      serverKey: sha256Json({ host: "imap.example.test", port: 993, tlsMode: "implicit", serverInfo: { name: "fixture" } }),
      accountId: account,
      namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
      folders: [
        {
          relativePath: folder.path,
          parentRelativePath: null,
          name: folder.name,
          role: folder.role,
          remotePath: folder.path,
          delimiter: folder.delimiter,
          selectable: folder.selectable,
          subscribed: folder.subscribed,
          uidValidity: folder.uidValidity,
          uidNext: folder.uidNext,
          highestModseq: folder.highestModseq,
          rights: folder.rights,
          rightsSource: folder.rightsSource,
        },
      ],
    };
    const scope = sha256Json(evidence);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailbox.data.id}::uuid, ${{ accountId: account }}::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
        capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
      ) VALUES (
        ${resource!.id}::uuid, ${connectionId}::uuid, 'active', ${account},
        ${{ accountId: account }}::jsonb, ${fixtureVerification(account).capabilities}::jsonb, '{}'::jsonb,
        ${evidence}::jsonb, ${scope}, 1, now()
      ) RETURNING id
    `;
    return { bindingId: binding!.id, account };
  };

  beforeAll(async () => {
    await migrate();
    const uid = `mail-rediscovery-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${uid}, false)
      RETURNING id
    `;
    if (!user) throw new Error("Failed to create the rediscovery test user");
    userId = user.id;
    ownerContext = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          displayName: uid,
          givenName: "Mail",
          sn: "Test",
          mail: `${uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-rediscovery-${suffix}`,
    };
  });

  afterAll(async () => {
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("a provider that never answers cannot keep rediscovery from other mailboxes", async () => {
    const hung = await createBoundMailbox("hung");
    const healthy = await createBoundMailbox("healthy");
    let hungSignal: AbortSignal | undefined;
    // The hung provider neither answers nor honors cancellation, like the stalled production rediscovery.
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation((config, signal) => {
      if (config.username !== hung.account) return Promise.resolve(fixtureVerification(config.username));
      hungSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => [inbox()]);
    try {
      // The rediscovery job handles one binding at a time per process: drain both queued bindings in order.
      const outcomes: string[] = [];
      for (const binding of [hung, healthy]) {
        outcomes.push(
          await executeBindingRediscovery(binding.bindingId, false, async () => undefined, TEST_DEADLINE_MS).then(
            (result) => result.state,
            (error: unknown) => providerErrorCode(error, "UNEXPECTED_FAILURE"),
          ),
        );
      }
      expect(outcomes).toEqual(["PROVIDER_REDISCOVERY_TIMEOUT", "active"]);
      expect(hungSignal?.aborted).toBe(true);

      const [diagnostic] = await sql<{ state: string; last_error_code: string | null; last_error_message: string | null }[]>`
        SELECT state, last_error_code, last_error_message FROM mail.provider_bindings WHERE id = ${hung.bindingId}::uuid
      `;
      expect(diagnostic).toMatchObject({ state: "degraded", last_error_code: "PROVIDER_REDISCOVERY_TIMEOUT" });
      expect(diagnostic?.last_error_message).toContain("did not finish within 2 seconds");

      // The timed-out attempt released its provider lease, so its retry takes the mailbox and recovers the binding.
      verify.mockImplementation(async (config) => fixtureVerification(config.username));
      await expect(executeBindingRediscovery(hung.bindingId, false, async () => undefined)).resolves.toMatchObject({ state: "active" });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  }, 15_000);
});
