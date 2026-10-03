import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { imapSmtpConnector } from "./connectors";
import { createMailbox } from "./mailboxes";
import { createProviderConnection } from "./provider-connections";
import { providerErrorCode } from "./provider-errors";
import { executeBindingRediscovery, submitDueFolderSyncs } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");

// Only the hung binding gets this short deadline; it hangs right after taking its provider lease.
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

const folder = (path: string, uidValidity: string, uidNext: string, highestModseq = "1") => ({
  ...inbox(),
  stableKey: `${path}:${uidValidity}`,
  path,
  name: path,
  role: "other" as const,
  uidValidity,
  uidNext,
  highestModseq,
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

  const createBoundMailbox = async (label: string): Promise<{ bindingId: string; account: string; mailboxId: string }> => {
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
    return { bindingId: binding!.id, account, mailboxId: mailbox.data.id };
  };

  /** The binding's folders by provider path, with their discovery state. */
  const projectedFolders = async (bindingId: string): Promise<Record<string, { id: string; state: string }>> => {
    const rows = await sql<{ id: string; remote_path: string; discovery_state: string }[]>`
      SELECT folder.id, ref.remote_path, folder.discovery_state
      FROM mail.binding_folder_refs ref
      JOIN mail.folders folder ON folder.id = ref.folder_id
      WHERE ref.binding_id = ${bindingId}::uuid
    `;
    return Object.fromEntries(rows.map((row) => [row.remote_path, { id: row.id, state: row.discovery_state }]));
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
        const deadlineMs = binding === hung ? TEST_DEADLINE_MS : undefined;
        outcomes.push(
          await executeBindingRediscovery(binding.bindingId, false, async () => undefined, deadlineMs).then(
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

  test("a new folder that shares another folder's UIDVALIDITY is projected as a folder of its own", async () => {
    const bound = await createBoundMailbox("collision");
    let folders = [inbox(), folder("Zeta", "7", "40")];
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation(async (config) => fixtureVerification(config.username));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => folders);
    try {
      await rediscoverProviderBinding({ bindingId: bound.bindingId });
      const before = await projectedFolders(bound.bindingId);
      // Another client creates a folder whose UIDVALIDITY collides, as on a server that derives it from the creation second.
      folders = [inbox(), folder("Alpha", "7", "1"), folder("Zeta", "7", "40")];
      for (let run = 0; run < 2; run += 1) {
        await expect(rediscoverProviderBinding({ bindingId: bound.bindingId })).resolves.toMatchObject({ ambiguous: 0, renamed: 0 });
      }
      const after = await projectedFolders(bound.bindingId);
      expect(after.Zeta).toEqual(before.Zeta!);
      expect(after.Alpha).toMatchObject({ state: "active" });
      expect(after.Alpha?.id).not.toBe(before.Zeta!.id);
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  });

  test("a folder that replaces a deleted one with the same UIDVALIDITY starts fresh, while a rename keeps its folder", async () => {
    const bound = await createBoundMailbox("replaced");
    let folders = [inbox(), folder("Projects", "7", "50", "90")];
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation(async (config) => fixtureVerification(config.username));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => folders);
    try {
      await rediscoverProviderBinding({ bindingId: bound.bindingId });
      const projects = (await projectedFolders(bound.bindingId)).Projects!;

      // Renamed by another client: the provider keeps UIDVALIDITY and never lowers UIDNEXT or HIGHESTMODSEQ.
      folders = [inbox(), folder("Clients", "7", "52", "95")];
      await expect(rediscoverProviderBinding({ bindingId: bound.bindingId })).resolves.toMatchObject({ renamed: 1 });
      expect((await projectedFolders(bound.bindingId)).Clients).toEqual(projects);

      // Deleted, and an unrelated folder created with the same UIDVALIDITY: its counters start below the old ones.
      folders = [inbox(), folder("Receipts", "7", "3", "4")];
      await expect(rediscoverProviderBinding({ bindingId: bound.bindingId })).resolves.toMatchObject({ renamed: 0, ambiguous: 0 });
      const after = await projectedFolders(bound.bindingId);
      expect(after.Clients).toEqual({ id: projects.id, state: "missing" });
      expect(after.Receipts?.state).toBe("active");
      expect(after.Receipts?.id).not.toBe(projects.id);
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  });

  test("a provider outage during rediscovery keeps folders syncing, and only rejected credentials degrade the binding", async () => {
    const bound = await createBoundMailbox("outage");
    const verify = spyOn(imapSmtpConnector, "verify").mockImplementation(async (config) => fixtureVerification(config.username));
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockImplementation(async () => [inbox()]);
    const bindingState = async () => {
      const [row] = await sql<{ binding: string; code: string | null; connection: string }[]>`
        SELECT binding.state AS binding, binding.last_error_code AS code, connection.status AS connection
        FROM mail.provider_bindings binding
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE binding.id = ${bound.bindingId}::uuid
      `;
      return row;
    };
    const mailboxHealth = async () => {
      const [row] = await sql<{ health: string; health_reason: string | null }[]>`
        SELECT health, health_reason FROM mail.mailboxes WHERE id = ${bound.mailboxId}::uuid
      `;
      return row;
    };
    try {
      await rediscoverProviderBinding({ bindingId: bound.bindingId });
      const inboxId = (await projectedFolders(bound.bindingId)).INBOX!.id;
      const unreachable = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:993"), { code: "ECONNREFUSED" });
      const outages: Array<[string, Error]> = [
        ["unreachable", unreachable],
        // The connector's verification wraps the IMAP and SMTP failures.
        [
          "verification",
          Object.assign(new Error("IMAP: Server could not be reached; SMTP: Server could not be reached"), {
            code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED",
            failures: [unreachable, unreachable],
          }),
        ],
        // RFC 5530: the server refuses the login for now, not the password.
        [
          "temporary login refusal",
          Object.assign(new Error("Command failed"), {
            authenticationFailed: true,
            serverResponseCode: "UNAVAILABLE",
            responseText: "Temporary authentication failure",
          }),
        ],
        // ImapFlow marks a LOGIN whose connection closed before the reply as an authentication failure.
        [
          "connection lost during login",
          Object.assign(new Error("Connection not available"), { code: "NoConnection", authenticationFailed: true }),
        ],
        // RFC 4954: the SMTP server cannot check the credentials for now.
        [
          "temporary SMTP login failure",
          Object.assign(new Error("IMAP: Verified; SMTP: Authentication failed"), {
            code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED",
            failures: [
              Object.assign(new Error("Invalid login: 454 4.7.0 Temporary authentication failure"), { code: "EAUTH", responseCode: 454 }),
            ],
          }),
        ],
      ];
      for (const [label, error] of outages) {
        // Every attempt of the job, as during an outage longer than its retry budget.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          verify.mockRejectedValueOnce(error);
          await expect(rediscoverProviderBinding({ bindingId: bound.bindingId }), label).rejects.toThrow();
        }
        verify.mockReset();
        verify.mockImplementation(async (config) => fixtureVerification(config.username));
        expect(await bindingState(), label).toMatchObject({ binding: "active", connection: "active" });
        expect(await submitDueFolderSyncs(100_000), label).toContain(inboxId);
        // The mailbox shows the outage, as after a failed folder sync, instead of restored access.
        expect(await mailboxHealth(), label).toEqual({ health: "degraded", health_reason: error.message });
      }
      await rediscoverProviderBinding({ bindingId: bound.bindingId });
      expect(await mailboxHealth()).toEqual({
        health: "bootstrapping",
        health_reason: "Provider access restored; synchronization pending",
      });

      const rejected = Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        serverResponseCode: "AUTHENTICATIONFAILED",
        responseText: "Invalid credentials",
      });
      verify.mockRejectedValueOnce(rejected);
      await expect(rediscoverProviderBinding({ bindingId: bound.bindingId })).rejects.toThrow();
      expect(await bindingState()).toMatchObject({ binding: "degraded", connection: "degraded" });
      expect(await mailboxHealth()).toMatchObject({ health: "auth_required" });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
  });
});
