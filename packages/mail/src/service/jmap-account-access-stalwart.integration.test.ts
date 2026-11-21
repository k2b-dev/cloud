import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { sql } from "@k2b/cloud";
import { encryptSecret } from "@k2b/cloud/services";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { verifyJmap } from "./connectors/jmap";
import { callJmap, JMAP_CORE, JMAP_MAIL, jmapBasicAuthorization } from "./connectors/jmap-client";
import type { JmapTransportDependencies } from "./connectors/jmap-transport";
import { loadJmapAccountAccess } from "./jmap-account-access";
import { classifyJmapFailure } from "./jmap-failure";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";

// Assertions print only their stage, never results, server bodies, credentials or tokens.
function check(condition: unknown, stage: string): asserts condition {
  ok(condition, stage);
}

suiteFor(
  "jmap",
  "database",
  "nats",
  "valkey",
)("JMAP account runtime access against CI Stalwart", () => {
  const origin = "https://stalwart.example.invalid";
  let username: string;
  let password: string;
  let dependencies: JmapTransportDependencies;

  beforeAll(async () => {
    let target: URL;
    try {
      target = new URL(requireInfraUrl("jmap"));
      username = decodeURIComponent(target.username);
      password = decodeURIComponent(target.password);
    } catch {
      throw new Error("Setup: invalid JMAP infrastructure URL");
    }
    check(target.protocol === "http:" && target.hostname === "127.0.0.1", "Setup: expected CI HTTP loopback endpoint");
    check(username.length > 0 && password.length > 0, "Setup: credentials required");
    const hostname = target.hostname;
    const port = Number(target.port || 80);
    // Only the socket destination changes; origin checks, redirects and Session parsing stay production behavior.
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
    // The integration runner owns this file's disposable database.
    await migrate();
  });

  test("loads the stored account's Session; a wrong password is auth_required", async () => {
    const signal = new AbortController().signal;
    let accountId: string;
    try {
      ({ accountId } = await verifyJmap(
        { origin, signal, authorization: jmapBasicAuthorization(username, { kind: "password", password }) },
        dependencies,
      ));
    } catch {
      throw new Error("Setup: verify the CI account");
    }
    const mailboxId = crypto.randomUUID(),
      remoteResourceId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin, accountId };
    const fingerprint = jmapScopeFingerprint(evidence);
    await sql<
      []
    >`INSERT INTO mail.mailboxes (id, short_id, name, health) VALUES (${mailboxId}::uuid, 'StwA5a', 'Stalwart access', 'active')`;
    await sql<
      []
    >`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active')`;
    await sql<[]>`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, jmap_origin)
      VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Stalwart', 'reader@example.invalid', ${username}, 'jmap',
        'stalwart.example.invalid', 993, 'implicit', 'stalwart.example.invalid', 465, 'implicit', 'password',
        ${await encryptSecret({ kind: "password", password })}, ${origin})`;
    await sql<[]>`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator,
        verification_evidence, verified_scope_fingerprint)
      VALUES (${crypto.randomUUID()}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId }}::jsonb,
        ${evidence}::jsonb, ${fingerprint})`;
    const load = () => loadJmapAccountAccess({ remoteResourceId, signal, transport: dependencies });

    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load();
    } catch {
      throw new Error("Load: request failed");
    }
    check(loaded.status === "ready", "Load: ready");
    const { access } = loaded;
    check(access.session.origin === origin && access.accountId === accountId && access.secretRevision === 1, "Load: identity and revision");
    check(access.connectionId === connectionId && access.mailboxId === mailboxId, "Load: rows");
    // A freshly loaded Session answers with its own state: no JMAP_SESSION_CHANGED.
    let sessionState: string;
    try {
      ({ sessionState } = await callJmap(
        {
          session: access.session,
          authorization: access.authorization,
          signal,
          using: [JMAP_CORE, JMAP_MAIL],
          methodCalls: [["Mailbox/get", { accountId, ids: [] }, "check"]],
        },
        dependencies,
      ));
    } catch (error) {
      throw new Error(`Call: ${classifyJmapFailure(error, Date.now())?.kind ?? "not a JMAP failure"}`);
    }
    check(sessionState === access.session.state, "Call: same Session state");

    await sql<[]>`UPDATE mail.provider_connections
      SET encrypted_secret = ${await encryptSecret({ kind: "password", password: `${password}-incorrect` })}
      WHERE id = ${connectionId}::uuid`;
    const outcome = await load().then(
      (result) => (result.status === "unavailable" ? result.reason : "ready"),
      (error: unknown) => classifyJmapFailure(error, Date.now())?.kind ?? "not a JMAP failure",
    );
    // As in jmap-stalwart.integration.test.ts: setup mode may answer with the public Session
    // without accounts instead of 401. Neither outcome is ever ready.
    check(outcome === "auth_required" || outcome === "account_mismatch", `Wrong password: auth_required (got ${outcome})`);
  });
});
