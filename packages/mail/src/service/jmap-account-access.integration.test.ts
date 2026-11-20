import { afterEach, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { encryptSecret } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import baseline from "../schema.sql" with { type: "text" };
import { callJmap, JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION, jmapBasicAuthorization } from "./connectors/jmap-client";
import { createJmapFixture } from "./connectors/jmap-fixture";
import { type JmapAccountAccessResult, loadJmapAccountAccess } from "./jmap-account-access";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";

const suite = suiteFor("database", "nats", "valkey");
// The loader reads without a transaction: one joined read of the account and one of the
// connection row that carries password, revision and origin together.
const JMAP_ACCESS_STATEMENTS = 2;
const password = "fixture-only-password";
let sequence = 0;
const uuid = () => `00000000-005a-4000-8000-${String(++sequence).padStart(12, "0")}`;
const shortId = () => `A${String(++sequence).padStart(5, "0")}`;
const signal = () => new AbortController().signal;
// Results carry the credentials: tests compare fields, never print a whole result.
const reason = (result: JmapAccountAccessResult) => (result.status === "unavailable" ? result.reason : "ready");

suite("JMAP account runtime access", () => {
  const fixtures: ReturnType<typeof createJmapFixture>[] = [];
  beforeAll(async () => {
    // The integration runner owns this file's disposable database.
    await migrate();
  });
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.close();
  });

  async function setup(accountId = "d333333") {
    const f = createJmapFixture();
    fixtures.push(f);
    const mailboxId = uuid(),
      remoteResourceId = uuid(),
      connectionId = uuid(),
      bindingId = uuid();
    const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: f.origin, accountId };
    const fingerprint = jmapScopeFingerprint(evidence);
    await sql<
      []
    >`INSERT INTO mail.mailboxes (id, short_id, name, health) VALUES (${mailboxId}::uuid, ${shortId()}, 'JMAP access fixture', 'active')`;
    await sql<
      []
    >`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active')`;
    await sql<[]>`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, jmap_origin)
      VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'reader@example.invalid', 'reader', 'jmap',
        'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password',
        ${await encryptSecret({ kind: "password", password })}, ${f.origin})`;
    await sql<[]>`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator,
        verification_evidence, verified_scope_fingerprint)
      VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId }}::jsonb,
        ${evidence}::jsonb, ${fingerprint})`;
    const load = () => loadJmapAccountAccess({ remoteResourceId, signal: signal(), transport: f.dependencies });
    return { f, mailboxId, remoteResourceId, connectionId, bindingId, load };
  }

  test("loads the Session from the approved origin with the revision the password was read with", async () => {
    const { f, mailboxId, connectionId, bindingId, load } = await setup();
    const result = await load();
    expect(reason(result)).toBe("ready");
    if (result.status !== "ready") return;
    const { access } = result;
    expect({
      origin: access.session.origin,
      accountId: access.accountId,
      bindingId: access.bindingId,
      connectionId: access.connectionId,
      mailboxId: access.mailboxId,
      secretRevision: access.secretRevision,
    }).toEqual({ origin: f.origin, accountId: "d333333", bindingId, connectionId, mailboxId, secretRevision: 1 });
    const expected = jmapBasicAuthorization("reader", { kind: "password", password });
    expect(access.authorization === expected).toBe(true);
    expect(f.requests.map((request) => [request.method, request.path, request.authorization === expected])).toEqual([
      ["GET", "/.well-known/jmap", true],
    ]);
    // The loaded Session serves the account's calls without a reported change.
    const response = await callJmap(
      {
        session: access.session,
        authorization: access.authorization,
        signal: signal(),
        using: [JMAP_CORE, JMAP_MAIL],
        methodCalls: [["Mailbox/get", { accountId: access.accountId, ids: [] }, "check"]],
      },
      f.dependencies,
    );
    expect(response.sessionState).toBe(access.session.state);
  });

  test("two loads read two Sessions; nothing is cached", async () => {
    const { f, load } = await setup();
    expect(reason(await load())).toBe("ready");
    f.session.state = "session-state-2";
    const second = await load();
    expect(second.status === "ready" && second.access.session.state).toBe("session-state-2");
    expect(f.requests.map((request) => request.path)).toEqual(["/.well-known/jmap", "/.well-known/jmap"]);
  });

  test("a rotation during the Session request leaves the read revision; the later commit rejects it", async () => {
    const { f, connectionId, load } = await setup();
    f.controls.handle = async (request) => {
      if (request.method === "GET")
        await sql<[]>`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${connectionId}::uuid`;
      return undefined;
    };
    const result = await load();
    expect(result.status === "ready" && result.access.secretRevision).toBe(1);
    // The next load sees the binding verified for the old revision only.
    expect(reason(await load())).toBe("binding_inactive");
  });

  test("a missing origin sends nothing", async () => {
    const { f, connectionId, load } = await setup();
    await sql<[]>`UPDATE mail.provider_connections SET jmap_origin = NULL WHERE id = ${connectionId}::uuid`;
    expect(reason(await load())).toBe("origin_missing");
    for (const origin of ["http://mail.example.invalid", "https://mail.example.invalid/jmap", "https://reader:x@mail.example.invalid"]) {
      await sql<[]>`UPDATE mail.provider_connections SET jmap_origin = ${origin} WHERE id = ${connectionId}::uuid`;
      expect(reason(await load())).toBe("origin_missing");
    }
    expect(f.requests).toHaveLength(0);
  });

  test("an IMAP resource or connection is not a JMAP account", async () => {
    const resource = await setup();
    await sql<[]>`UPDATE mail.remote_resources SET connector_kind = 'imap_smtp' WHERE id = ${resource.remoteResourceId}::uuid`;
    expect(reason(await resource.load())).toBe("not_jmap");
    const connection = await setup();
    await sql<[]>`UPDATE mail.provider_connections SET connector_kind = 'imap_smtp' WHERE id = ${connection.connectionId}::uuid`;
    expect(reason(await connection.load())).toBe("not_jmap");
    expect([...resource.f.requests, ...connection.f.requests]).toHaveLength(0);
  });

  test("an inactive binding, another verified fingerprint or revision, or a revoked connection is not runnable", async () => {
    const cases: Array<(ids: Awaited<ReturnType<typeof setup>>) => Promise<unknown>> = [
      ({ bindingId }) => sql`UPDATE mail.provider_bindings SET state = 'degraded' WHERE id = ${bindingId}::uuid`,
      ({ bindingId }) =>
        sql`UPDATE mail.provider_bindings SET verified_scope_fingerprint = ${"f".repeat(64)} WHERE id = ${bindingId}::uuid`,
      ({ connectionId }) => sql`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${connectionId}::uuid`,
      ({ connectionId }) =>
        sql`UPDATE mail.provider_connections SET status = 'revoked', encrypted_secret = NULL WHERE id = ${connectionId}::uuid`,
      ({ remoteResourceId }) => sql`UPDATE mail.remote_resources SET status = 'connection_required' WHERE id = ${remoteResourceId}::uuid`,
      ({ mailboxId }) => sql`UPDATE mail.mailboxes SET health = 'auth_required' WHERE id = ${mailboxId}::uuid`,
    ];
    for (const change of cases) {
      const account = await setup();
      await change(account);
      expect(reason(await account.load())).toBe("binding_inactive");
      expect(account.f.requests).toHaveLength(0);
    }
  });

  test("a paused or deleted mailbox is not runnable", async () => {
    const off = await setup();
    await sql<[]>`UPDATE mail.mailboxes SET sync_enabled = false WHERE id = ${off.mailboxId}::uuid`;
    expect(reason(await off.load())).toBe("paused");
    const paused = await setup();
    await sql<[]>`UPDATE mail.remote_resources SET status = 'paused' WHERE id = ${paused.remoteResourceId}::uuid`;
    expect(reason(await paused.load())).toBe("paused");
    const deleted = await setup();
    await sql<[]>`UPDATE mail.mailboxes SET deleted_at = now() WHERE id = ${deleted.mailboxId}::uuid`;
    expect(reason(await deleted.load())).toBe("missing");
    expect(reason(await loadJmapAccountAccess({ remoteResourceId: uuid(), signal: signal() }))).toBe("missing");
    expect([...off.f.requests, ...paused.f.requests, ...deleted.f.requests]).toHaveLength(0);
  });

  test("an account the Session does not serve is a mismatch, not an authentication failure", async () => {
    // Stored for another account than the Session has.
    const other = await setup("x999999");
    expect(reason(await other.load())).toBe("account_mismatch");
    expect(other.f.requests).toHaveLength(1);
    // The account exists but has no mail capability.
    const capability = await setup();
    const { session } = capability.f;
    capability.f.controls.handle = (request) =>
      request.method === "GET"
        ? Response.json({
            ...session,
            accounts: { d333333: { ...session.accounts.d333333, accountCapabilities: { [JMAP_SUBMISSION]: {} } } },
          })
        : undefined;
    expect(reason(await capability.load())).toBe("account_mismatch");
    // Evidence for another origin: the credentials never go to the approved origin for it.
    const origin = await setup();
    await sql<
      []
    >`UPDATE mail.provider_connections SET jmap_origin = 'https://other.example.invalid' WHERE id = ${origin.connectionId}::uuid`;
    expect(reason(await origin.load())).toBe("account_mismatch");
    expect(origin.f.requests).toHaveLength(0);
  });

  test("statement count of one load", async () => {
    const { load } = await setup();
    const meter = await meterSql();
    let statements: string[];
    try {
      statements = await meter.during(load);
    } finally {
      await meter.close();
    }
    // Statement texts carry no parameters; a mismatch shows which reads ran.
    expect(statements, "one load").toHaveLength(JMAP_ACCESS_STATEMENTS);
  });

  test("the migration adds a nullable origin once; the baseline has it", async () => {
    const table = baseline.match(/CREATE TABLE mail\.provider_connections \([\s\S]*?\n\);/)?.[0];
    expect(table?.includes("\n    jmap_origin text,\n")).toBe(true);
    const column = () => sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'mail' AND table_name = 'provider_connections' AND column_name = 'jmap_origin'`;
    const { connectionId } = await setup();
    const preserved = () =>
      sql<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(pc) - 'jmap_origin' AS row FROM mail.provider_connections pc
        WHERE id = ${connectionId}::uuid`;
    const before = await preserved();
    try {
      // Reproduce the predecessor table with its rows, then upgrade twice.
      await sql<[]>`ALTER TABLE mail.provider_connections DROP COLUMN jmap_origin`.simple();
      await migrate();
      expect(await column()).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
      expect(await preserved()).toEqual(before);
      expect(
        await sql<{ jmap_origin: string | null }[]>`SELECT jmap_origin FROM mail.provider_connections WHERE id = ${connectionId}::uuid`,
      ).toEqual([{ jmap_origin: null }]);
      await sql<[]>`UPDATE mail.provider_connections SET jmap_origin = 'https://mail.example.invalid' WHERE id = ${connectionId}::uuid`;
      await migrate();
      expect(await column()).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
      expect(
        await sql<{ jmap_origin: string | null }[]>`SELECT jmap_origin FROM mail.provider_connections WHERE id = ${connectionId}::uuid`,
      ).toEqual([{ jmap_origin: "https://mail.example.invalid" }]);
    } finally {
      await migrate();
    }
  });
});
