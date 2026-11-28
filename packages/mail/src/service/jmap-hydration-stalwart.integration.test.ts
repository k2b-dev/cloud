import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { sql } from "@k2b/cloud";
import { encryptSecret } from "@k2b/cloud/services";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import { projectJmapFolders } from "./bindings";
import { discoverJmapFolders } from "./connectors/jmap";
import type { JmapSyncState } from "./connectors/jmap-account-state";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  jmapBasicAuthorization,
  jmapIdSchema,
  requireJmapMethodResult,
} from "./connectors/jmap-client";
import { jmapStateSchema } from "./connectors/jmap-sync-state";
import { type JmapTransportDependencies, requestJmap } from "./connectors/jmap-transport";
import { syncJmapAccountDelta } from "./jmap-sync-runtime";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { hydrateMessageBatch } from "./sync-runtime";

// Assertions and failures name their stage and error class only, never server values or credentials.
function check(condition: unknown, label: string): asserts condition {
  ok(Boolean(condition), label);
}
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "non-error";
  const parts = [error.name];
  for (const key of ["code", "status", "problemType", "methodType"]) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}
async function stage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${label}: failed (${describeFailure(error)})`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}

const receivedAt = "2026-01-15T12:34:56Z";
const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const sourceFor = (messageId: string, attachment: boolean) =>
  [
    "From: Sender <sender@example.invalid>",
    "To: Reader <reader@example.invalid>",
    "Date: Thu, 15 Jan 2026 12:00:00 +0000",
    `Message-ID: <${messageId}>`,
    "Subject: Hydration conformance",
    "MIME-Version: 1.0",
    ...(attachment
      ? [
          'Content-Type: multipart/mixed; boundary="fixture-boundary"',
          "",
          "--fixture-boundary",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Fictional text.",
          "--fixture-boundary",
          "Content-Type: application/octet-stream",
          "Content-Disposition: attachment; filename=fixture.bin",
          "Content-Transfer-Encoding: base64",
          "",
          binary.toString("base64"),
          "--fixture-boundary--",
          "",
        ]
      : ["Content-Type: text/plain; charset=utf-8", "", "Fictional text.", ""]),
  ].join("\r\n");

suiteFor(
  "jmap",
  "database",
  "nats",
  "valkey",
)("JMAP body hydration against CI Stalwart", () => {
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
    // Only the socket destination changes; origin checks and download URLs stay production behavior.
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
    // The integration runner owns this file's disposable database.
    await migrate();
    await buildFolderIdentityIndexes();
  });

  test("text and multipart sources load after a delta commit; one blob imported twice stays two messages", async () => {
    const signal = AbortSignal.timeout(60_000);
    const authorization = jmapBasicAuthorization(username, { kind: "password", password });
    const session = await stage("Session", () => fetchJmapSession({ origin, authorization, signal }, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, "Session: primary mail account");
    const call = async (step: string, name: string, args: Record<string, unknown>, requestSignal = signal) => {
      const response = await stage(step, () =>
        callJmap(
          {
            session,
            authorization,
            signal: requestSignal,
            using: [JMAP_CORE, JMAP_MAIL],
            methodCalls: [[name, { accountId, ...args }, "hydration"]],
          },
          dependencies,
        ),
      );
      const result = requireJmapMethodResult(response, "hydration", name);
      check(result.accountId === accountId, `${step}: account identity`);
      return result;
    };
    const startState = async (kind: "Email" | "Mailbox") =>
      parse(z.object({ state: jmapStateSchema }), await call(`${kind} start state`, `${kind}/get`, { ids: [], properties: ["id"] }), kind)
        .state;
    const owned: string[] = [];
    try {
      // The account's states before this test's mail: the delta then reports exactly what follows.
      const emailState = await startState("Email");
      const mailboxState = await startState("Mailbox");
      const folders = await stage("Folders", () => discoverJmapFolders({ origin, signal, authorization }, dependencies));
      const inbox = folders.find((folder) => folder.role === "inbox");
      check(inbox, "Folders: Inbox");

      const mailboxId = crypto.randomUUID(),
        remoteResourceId = crypto.randomUUID(),
        connectionId = crypto.randomUUID(),
        bindingId = crypto.randomUUID();
      const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin, accountId };
      const fingerprint = jmapScopeFingerprint(evidence);
      const initial: JmapSyncState = { version: 2, emailState, mailboxState, scan: null };
      await stage("Database rows", async () => {
        await sql`INSERT INTO mail.mailboxes (id, short_id, name, health)
          VALUES (${mailboxId}::uuid, ${newShortId()}, 'Stalwart hydration', 'active')`;
        await sql`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status, sync_state)
          VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active', ${initial}::jsonb)`;
        await sql`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
            imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, jmap_origin)
          VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Stalwart', 'reader@example.invalid', ${username}, 'jmap',
            'stalwart.example.invalid', 993, 'implicit', 'stalwart.example.invalid', 465, 'implicit', 'password',
            ${await encryptSecret({ kind: "password", password })}, ${origin})`;
        await sql`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator,
            verification_evidence, verified_scope_fingerprint)
          VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId }}::jsonb,
            ${evidence}::jsonb, ${fingerprint})`;
        await sql.begin((tx) =>
          projectJmapFolders(tx, {
            remoteResourceId,
            bindingId,
            discoveryGeneration: 1,
            evidence,
            folders,
            inventory: { kind: "snapshot" },
          }),
        );
      });

      const factory = dependencies.request;
      check(factory, "Upload: test request factory");
      const upload = async (label: string, source: string) => {
        const uploadUrl = new URL(session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId)));
        check(uploadUrl.origin === origin && !uploadUrl.username && !uploadUrl.password, `${label} upload: same origin`);
        const response = await stage(`${label} upload`, () =>
          requestJmap(
            { url: uploadUrl, method: "POST", authorization, body: source, maxBytes: JMAP_JSON_BYTES, signal },
            {
              ...dependencies,
              request: (options, callback) =>
                factory({ ...options, headers: { ...options.headers, "content-type": "message/rfc822" } }, callback),
            },
          ),
        );
        check(response.status >= 200 && response.status < 300, `${label} upload: HTTP success`);
        const json: unknown = await stage(`${label} upload JSON`, async () => JSON.parse(response.body));
        return parse(z.object({ blobId: jmapIdSchema, size: z.number().int() }), json, `${label} upload`).blobId;
      };
      const importEmail = async (label: string, blobId: string) => {
        const imported = parse(
          z.object({ created: z.object({ fixture: z.object({ id: jmapIdSchema }) }) }),
          await call(`${label} import`, "Email/import", {
            emails: { fixture: { blobId, mailboxIds: { [inbox.mailboxId]: true }, keywords: {}, receivedAt } },
          }),
          `${label} import`,
        );
        owned.push(imported.created.fixture.id);
        return imported.created.fixture.id;
      };
      // Fixed content; the PID separates simultaneous test processes without random fixtures.
      const text = await importEmail("Text", await upload("Text", sourceFor(`cloud-hydrate-${process.pid}-text@example.invalid`, false)));
      const multipart = await importEmail(
        "Multipart",
        await upload("Multipart", sourceFor(`cloud-hydrate-${process.pid}-multipart@example.invalid`, true)),
      );
      const twiceBlob = await upload("Twice", sourceFor(`cloud-hydrate-${process.pid}-twice@example.invalid`, false));
      const twiceA = await importEmail("Twice first", twiceBlob);
      const twiceB = await importEmail("Twice second", twiceBlob);
      check(twiceA !== twiceB, "Twice: two Email IDs");

      const account = {
        remoteResourceId,
        bindingId,
        secretRevision: 1,
        session,
        accountId,
        signal,
        authorization,
        transport: dependencies,
        captureWorkflowTriggers: false,
      };
      let finished = false;
      for (let turn = 0; turn < 20 && !finished; turn++) {
        const result = await stage("Delta", () => syncJmapAccountDelta(account));
        // Another test may change the shared account's folders meanwhile; the next turn catches up.
        if (result.status === "committed") finished = !result.hasMore;
        else check(result.status === "superseded", `Delta: ${result.status}`);
      }
      check(finished, "Delta: caught up");

      const messageOf = async (emailId: string) => {
        const [row] = await sql<{ message_id: string }[]>`
          SELECT ref.message_id FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id
          WHERE folder.remote_resource_id = ${remoteResourceId}::uuid AND ref.remote_id = ${emailId} AND ref.stale_at IS NULL LIMIT 1`;
        check(row, "Projection: own Email has a message");
        return row.message_id;
      };
      const ids = {
        text: await messageOf(text),
        multipart: await messageOf(multipart),
        twiceA: await messageOf(twiceA),
        twiceB: await messageOf(twiceB),
      };
      check(ids.twiceA !== ids.twiceB, "Projection: twice imported is two messages");
      for (const [label, messageId] of Object.entries(ids)) {
        await stage(`Hydrate ${label}`, () =>
          hydrateMessageBatch(
            { input: { messageId }, heartbeat: async () => undefined, resubmit: () => undefined },
            { jmapTransport: dependencies },
          ),
        );
      }

      const rows = await sql<{ id: string; hydration_status: string; plain_text: string | null; source_hash: string | null }[]>`
        SELECT id, hydration_status, plain_text, source_hash FROM mail.message_contents
        WHERE id IN (${ids.text}::uuid, ${ids.multipart}::uuid, ${ids.twiceA}::uuid, ${ids.twiceB}::uuid)`;
      const row = (id: string) => rows.find((candidate) => candidate.id === id);
      for (const [label, id] of Object.entries(ids)) {
        check(row(id)?.hydration_status === "complete", `Content ${label}: complete`);
        check(row(id)?.plain_text?.trim() === "Fictional text.", `Content ${label}: body text`);
      }
      const attachments = await sql<{ filename: string | null; content_type: string; size_bytes: string | number }[]>`
        SELECT filename, content_type, size_bytes FROM mail.attachments WHERE message_id = ${ids.multipart}::uuid`;
      check(attachments.length === 1, "Attachment: one");
      check(attachments[0]?.filename === "fixture.bin", "Attachment: file name");
      check(attachments[0]?.content_type === "application/octet-stream", "Attachment: content type");
      check(Number(attachments[0]?.size_bytes) === binary.byteLength, "Attachment: size");
      const textAttachments = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM mail.attachments WHERE message_id = ${ids.text}::uuid`;
      check(textAttachments[0]?.count === 0, "Text: no attachment");
      check(row(ids.twiceA)?.source_hash && row(ids.twiceA)?.source_hash === row(ids.twiceB)?.source_hash, "Twice: same source");
    } finally {
      if (owned.length) {
        const cleanup = AbortSignal.timeout(10_000);
        await call("Cleanup", "Email/set", { destroy: owned }, cleanup).catch(() => {
          throw new Error("Cleanup: own Emails not deleted");
        });
      }
    }
  }, 90_000);
});
