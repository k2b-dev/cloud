import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { encryptSecret } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { projectJmapFolders } from "./bindings";
import { discoverJmapFolders } from "./connectors/jmap";
import type { JmapSyncState } from "./connectors/jmap-account-state";
import { fetchJmapSession, JMAP_CORE, jmapBasicAuthorization } from "./connectors/jmap-client";
import type { JmapEmailSnapshot } from "./connectors/jmap-email";
import { createJmapFixture, fixtureEmail } from "./connectors/jmap-fixture";
import type { JmapTransportDependencies } from "./connectors/jmap-transport";
import { loadJmapAccountAccess } from "./jmap-account-access";
import { hydrateJmapSource } from "./jmap-hydration";
import { syncJmapAccountDelta } from "./jmap-sync-runtime";
import { loadMailboxTransportFence } from "./mailbox-transport-fence";
import { createMailbox } from "./mailboxes";
import { requestMessageBody } from "./message-body-request";
import { hydrateMessageFromSource, JMAP_HYDRATION_INTERRUPTED } from "./message-hydration";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { providerBreakerOpenForMs } from "./provider-operation-lock";
import * as syncRuntime from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-21T09:00:00Z");
const password = "fixture-only-password";
const initial: JmapSyncState = { version: 2, emailState: "Email:0", mailboxState: "Mailbox:0", scan: null };
// Measured in the first gate: the statements of one mailbox batch with 1 and with 5 JMAP messages.
// The per-message part equals the IMAP batch's; the account access adds the loader's two reads.
const JMAP_HYDRATION_BUDGET: { one: number | null; five: number | null } = { one: null, five: null };
const noHeartbeat = async (): Promise<void> => undefined;
const codeOf = (error: unknown): unknown => (error instanceof Error ? Reflect.get(error, "code") : undefined);

const rfc822 = (messageId: string, body = "Fictional text.") =>
  Buffer.from(
    [
      "From: Sender <sender@example.invalid>",
      "To: Reader <reader@example.invalid>",
      "Date: Sat, 21 Nov 2026 08:00:00 +0000",
      `Message-ID: <${messageId}@example.invalid>`,
      "Subject: Hydration fixture",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n"),
  );

suite("JMAP body hydration", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const fixtures: ReturnType<typeof createJmapFixture>[] = [];
  const mailboxIds: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  let enqueued: string[] = [];
  let ownerId = "";
  let owner: MailRequestContext;

  beforeAll(async () => {
    // The integration runner owns this file's disposable database.
    await migrate();
    await buildFolderIdentityIndexes();
    const uid = `jmap-hydration-${suffix}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${uid}, 'local', 'user', ${uid}) RETURNING id`;
    if (!user) throw new Error("setup: user missing");
    ownerId = user.id;
    owner = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid,
          provider: "local",
          profile: "user",
          roles: ["user"],
          givenname: "Mail",
          sn: "Test",
          displayName: uid,
          mail: `${uid}@example.invalid`,
          avatarHash: null,
          ipa: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `jmap-hydration-${suffix}`,
    };
    spies.push(
      spyOn(syncRuntime, "enqueueMessageHydration").mockImplementation(async (messageId) => {
        enqueued.push(messageId);
      }),
    );
  });
  beforeEach(() => {
    setSystemTime(at);
    createAppEventTestHarness("mail", mailCapabilities);
    enqueued = [];
  });
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.close();
    setSystemTime();
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const { access_id } of access) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    }
    await sql`DELETE FROM audit.events WHERE request_id = ${owner.requestId ?? ""}`;
    if (ownerId) await sql`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
  });

  /** A JMAP mailbox with an active binding and an approved origin, folders from the fixture server. */
  async function setup(label: string) {
    const f = createJmapFixture();
    fixtures.push(f);
    f.session.capabilities[JMAP_CORE].maxObjectsInGet = 200;
    const mailbox = await createMailbox(owner, { name: `JMAP hydration ${label} ${suffix}` });
    if (!mailbox.ok) throw new Error(`setup: ${mailbox.error.message}`);
    const mailboxId = mailbox.data.id;
    mailboxIds.push(mailboxId);
    const remoteResourceId = crypto.randomUUID(),
      connectionId = crypto.randomUUID(),
      bindingId = crypto.randomUUID();
    const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: f.origin, accountId: "d333333" };
    const fingerprint = jmapScopeFingerprint(evidence);
    const authorization = jmapBasicAuthorization("reader", { kind: "password", password });
    await sql`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status, sync_state)
      VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active', ${initial}::jsonb)`;
    await sql`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, jmap_origin)
      VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'reader@example.invalid', 'reader', 'jmap',
        'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password',
        ${await encryptSecret({ kind: "password", password })}, ${f.origin})`;
    await sql`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator, verification_evidence, verified_scope_fingerprint)
      VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId: evidence.accountId }}::jsonb,
        ${evidence}::jsonb, ${fingerprint})`;
    const signal = new AbortController().signal;
    const folders = await discoverJmapFolders({ origin: f.origin, signal, authorization }, f.dependencies);
    const folderIds = await sql.begin((tx) =>
      projectJmapFolders(tx, { remoteResourceId, bindingId, discoveryGeneration: 1, evidence, folders, inventory: { kind: "snapshot" } }),
    );
    const session = await fetchJmapSession({ origin: f.origin, signal, authorization }, f.dependencies);
    const account = {
      remoteResourceId,
      bindingId,
      secretRevision: 1,
      session,
      accountId: evidence.accountId,
      signal,
      authorization,
      transport: f.dependencies,
      captureWorkflowTriggers: false,
    };
    /** Serves the source as the Email's blob, in two chunks. */
    const email = (
      id: string,
      source: Buffer,
      mailboxes: Record<string, boolean> = { a: true },
      receivedAt = "2026-11-19T10:00:00Z",
    ): JmapEmailSnapshot => {
      f.blobs.set(`blob-${id}`, [source.subarray(0, 40), source.subarray(40)]);
      return { ...fixtureEmail(id), mailboxIds: mailboxes, size: source.byteLength, subject: id, receivedAt };
    };
    /** Projects the Emails through account deltas, as the account job will. */
    const arrive = async (emails: JmapEmailSnapshot[]) => {
      for (const item of emails) {
        f.emails.push(item);
        f.journal.Email.push({ id: item.id, kind: "created" });
      }
      for (let turn = 0; turn < 10; turn++) {
        const result = await syncJmapAccountDelta(account);
        if (result.status !== "committed") throw new Error(`arrive: ${result.status}`);
        if (!result.hasMore) return;
      }
      throw new Error("arrive: delta did not finish");
    };
    const messageOf = async (emailId: string) => {
      const [row] = await sql<{ message_id: string }[]>`
        SELECT ref.message_id FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id
        WHERE folder.remote_resource_id = ${remoteResourceId}::uuid AND ref.remote_id = ${emailId} LIMIT 1`;
      if (!row) throw new Error(`messageOf: ${emailId} missing`);
      return row.message_id;
    };
    const hydrate = (input: { messageId: string } | { mailboxId: string }, transport: JmapTransportDependencies = f.dependencies) =>
      syncRuntime.hydrateMessageBatch({ input, heartbeat: noHeartbeat, resubmit: () => undefined }, { jmapTransport: transport });
    const downloads = () =>
      f.requests.filter((request) => request.path.startsWith("/jmap/download/")).map((request) => request.path.split("/")[4]);
    return { f, mailboxId, remoteResourceId, connectionId, bindingId, folderIds, account, email, arrive, messageOf, hydrate, downloads };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;

  const stateOf = async (messageId: string) => {
    const [row] = await sql<
      {
        hydration_status: string;
        hydration_attempt: number;
        hydration_error_code: string | null;
        hydration_claim_id: string | null;
        source_hash: string | null;
        source_blob_id: string | null;
        plain_text: string | null;
      }[]
    >`SELECT hydration_status, hydration_attempt, hydration_error_code, hydration_claim_id, source_hash, source_blob_id, plain_text
      FROM mail.message_contents WHERE id = ${messageId}::uuid`;
    return row ?? null;
  };
  const contentsOf = async (s: Fixture) =>
    (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.message_contents WHERE mailbox_id = ${s.mailboxId}::uuid`)[0]
      ?.count;
  /** An IMAP copy in the same mailbox, for the mixed and IMAP-only merge cases. */
  const imapMessage = async (s: Fixture, uid: number) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${s.mailboxId}::uuid, ${`<imap-${uid}-${suffix}@example.invalid>`}, 'IMAP copy', 'imap copy', ${at}, 1,
        ${crypto.randomUUID().replaceAll("-", "").repeat(2)}, 'envelope')
      RETURNING id`;
    if (!row) throw new Error("imapMessage: insert returned no row");
    const folderId = s.folderIds.get("b");
    if (!folderId) throw new Error("imapMessage: folder missing");
    await sql`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${row.id}::uuid, 1, ${uid})`;
    return row.id;
  };

  test("identity: two Email IDs with the same source stay two messages in both hydration orders", async () => {
    for (const [label, first, second] of [
      ["forward", "same-a", "same-b"],
      ["reverse", "same-b", "same-a"],
    ] as const) {
      const s = await setup(`same ${label}`);
      const source = rfc822(`same-${label}-${suffix}`);
      await s.arrive([s.email("same-a", source), s.email("same-b", source)]);
      const firstId = await s.messageOf(first);
      const secondId = await s.messageOf(second);
      expect(firstId, `${label}: two messages before hydration`).not.toBe(secondId);
      expect(await s.hydrate({ messageId: firstId }), `${label}: one batch loads both`).toEqual({ hydrated: true });
      expect(s.downloads(), `${label}: the requested message first`).toEqual([`blob-${first}`, `blob-${second}`]);
      const one = await stateOf(firstId);
      const two = await stateOf(secondId);
      expect([one?.hydration_status, two?.hydration_status], `${label}: both loaded, none merged away`).toEqual(["complete", "complete"]);
      expect(one?.source_hash, `${label}: same source`).toBe(two?.source_hash ?? "");
      // Storage may be shared; identity is not.
      expect(one?.source_blob_id, `${label}: one stored source`).toBe(two?.source_blob_id ?? "");
      expect(await contentsOf(s), `${label}: two contents`).toBe(2);
      expect(await s.messageOf(first), `${label}: refs keep their message`).toBe(firstId);
      expect(await s.messageOf(second), `${label}: refs keep their message`).toBe(secondId);
    }
  }, 30_000);

  test("identity: a stale JMAP reference on the candidate or on the hydrated message still prevents a merge", async () => {
    const s = await setup("stale");
    const source = rfc822(`stale-${suffix}`);
    await s.arrive([s.email("stale-a", source), s.email("stale-b", source), s.email("stale-c", source)]);
    const a = await s.messageOf("stale-a");
    const b = await s.messageOf("stale-b");
    const c = await s.messageOf("stale-c");
    // Hold b and c back as already tried, so the fresh batch loads only a.
    await sql`UPDATE mail.message_contents SET hydration_status = 'failed', hydration_attempt = 1 WHERE id IN (${b}::uuid, ${c}::uuid)`;
    expect(await s.hydrate({ mailboxId: s.mailboxId }), "stale: a alone").toEqual({ hydrated: true });
    expect((await stateOf(a))?.hydration_status, "stale: a loaded").toBe("complete");
    expect((await stateOf(b))?.hydration_status, "stale: b waits").toBe("failed");
    // The provider deleted a and c: their only references are stale. b must not merge into a.
    await sql`UPDATE mail.remote_message_refs SET stale_at = now() WHERE message_id IN (${a}::uuid, ${c}::uuid)`;
    expect(await s.hydrate({ messageId: b }), "candidate stale: b loads").toEqual({ hydrated: true });
    expect((await stateOf(b))?.hydration_status, "candidate stale: b is its own message").toBe("complete");
    expect((await stateOf(c))?.hydration_status, "candidate stale: c has no live copy to load").toBe("failed");
    // c, whose own reference is stale, loads directly and stays apart from a and b.
    const direct = await hydrateMessageFromSource({ messageId: c, source: Readable.from([source]), expectedSize: source.byteLength });
    expect(direct.status, "current stale: hydrated, not deduplicated").toBe("hydrated");
    expect(await contentsOf(s), "stale: three contents").toBe(3);
  }, 30_000);

  test("identity: one Email in two folders is one message with one download", async () => {
    const s = await setup("folders");
    await s.arrive([s.email("both", rfc822(`both-${suffix}`), { a: true, b: true })]);
    const id = await s.messageOf("both");
    const [refs] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM mail.remote_message_refs WHERE message_id = ${id}::uuid`;
    expect(refs?.count, "folders: two references").toBe(2);
    expect(await s.hydrate({ mailboxId: s.mailboxId }), "folders: loaded").toEqual({ hydrated: true });
    expect(s.downloads(), "folders: one download").toEqual(["blob-both"]);
    expect((await stateOf(id))?.hydration_status, "folders: complete").toBe("complete");
    expect(await contentsOf(s), "folders: one content").toBe(1);
  }, 30_000);

  test("identity: an IMAP and a JMAP copy of one source stay apart; two IMAP copies still merge", async () => {
    const s = await setup("mixed");
    // IMAP first, then JMAP.
    const imapFirstSource = rfc822(`mixed-imap-first-${suffix}`);
    const imapFirst = await imapMessage(s, 1);
    expect((await hydrateMessageFromSource({ messageId: imapFirst, source: Readable.from([imapFirstSource]) })).status).toBe("hydrated");
    await s.arrive([s.email("mixed-a", imapFirstSource)]);
    const jmapSecond = await s.messageOf("mixed-a");
    expect(await s.hydrate({ messageId: jmapSecond }), "IMAP then JMAP: JMAP loads").toEqual({ hydrated: true });
    expect((await stateOf(jmapSecond))?.hydration_status, "IMAP then JMAP: JMAP is its own message").toBe("complete");
    expect((await stateOf(imapFirst))?.hydration_status, "IMAP then JMAP: IMAP copy kept").toBe("complete");
    // JMAP first, then IMAP.
    const jmapFirstSource = rfc822(`mixed-jmap-first-${suffix}`);
    await s.arrive([s.email("mixed-b", jmapFirstSource)]);
    const jmapFirst = await s.messageOf("mixed-b");
    expect(await s.hydrate({ messageId: jmapFirst }), "JMAP then IMAP: JMAP loads").toEqual({ hydrated: true });
    const imapSecond = await imapMessage(s, 2);
    const imapResult = await hydrateMessageFromSource({ messageId: imapSecond, source: Readable.from([jmapFirstSource]) });
    expect(imapResult.status, "JMAP then IMAP: IMAP is not merged").toBe("hydrated");
    expect(await contentsOf(s), "mixed: four contents").toBe(4);
    // Two IMAP copies of another source merge as before.
    const other = rfc822(`imap-pair-${suffix}`);
    const pairFirst = await imapMessage(s, 3);
    const pairSecond = await imapMessage(s, 4);
    expect((await hydrateMessageFromSource({ messageId: pairFirst, source: Readable.from([other]) })).status).toBe("hydrated");
    const merged = await hydrateMessageFromSource({ messageId: pairSecond, source: Readable.from([other]) });
    expect(merged.status, "IMAP pair: deduplicated").toBe("deduplicated");
    expect(merged.canonicalMessageId, "IMAP pair: into the first copy").toBe(pairFirst);
    expect(await stateOf(pairSecond), "IMAP pair: second copy removed").toBeNull();
  }, 30_000);

  test("reader: a request for a JMAP body queues its job, which loads it", async () => {
    const s = await setup("reader");
    await s.arrive([s.email("opened", rfc822(`opened-${suffix}`, "Opened body."))]);
    const id = await s.messageOf("opened");
    const request = () => requestMessageBody({ context: owner, mailboxId: s.mailboxId, messageId: id, retry: false });
    const requested = await request();
    expect(requested.ok && requested.data.state, "reader: requested, not unavailable").toBe("requested");
    expect(enqueued, "reader: the message's own job").toEqual([id]);
    expect(await s.hydrate({ messageId: id }), "reader: the job loads it").toEqual({ hydrated: true });
    const after = await stateOf(id);
    expect(after?.hydration_status, "reader: complete").toBe("complete");
    expect(after?.plain_text?.trim(), "reader: body text").toBe("Opened body.");
    const loaded = await request();
    expect(loaded.ok && loaded.data.state, "reader: loaded").toBe("loaded");
  }, 30_000);

  test("missing source: an Email the server lacks and a source it cannot find count once and ask for an account delta", async () => {
    const s = await setup("missing");
    await s.arrive([s.email("gone", rfc822(`gone-${suffix}`)), s.email("blobless", rfc822(`blobless-${suffix}`))]);
    const gone = await s.messageOf("gone");
    const blobless = await s.messageOf("blobless");
    s.f.emails.splice(
      s.f.emails.findIndex((item) => item.id === "gone"),
      1,
    );
    s.f.blobs.delete("blob-blobless");
    expect(await s.hydrate({ mailboxId: s.mailboxId }), "missing: account delta requested").toEqual({
      hydrated: false,
      accountDeltaRequired: true,
    });
    expect(s.downloads(), "missing: only the listed Email is downloaded").toEqual(["blob-blobless"]);
    for (const id of [gone, blobless]) {
      const state = await stateOf(id);
      expect(
        { status: state?.hydration_status, attempt: state?.hydration_attempt, code: state?.hydration_error_code },
        "missing: one attempt",
      ).toEqual({ status: "envelope", attempt: 1, code: "MESSAGE_SOURCE_MISSING" });
    }
  }, 30_000);

  test("retry: a refused download counts an attempt; the reader's retry loads it", async () => {
    const s = await setup("retry");
    await s.arrive([s.email("flaky", rfc822(`flaky-${suffix}`))]);
    const id = await s.messageOf("flaky");
    s.f.download.status = 403;
    const failure = await s.hydrate({ messageId: id }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "retry: the requested message fails").toBe("JMAP_HTTP");
    const failed = await stateOf(id);
    expect(
      { status: failed?.hydration_status, attempt: failed?.hydration_attempt, code: failed?.hydration_error_code },
      "retry: one attempt",
    ).toEqual({ status: "failed", attempt: 1, code: "JMAP_HTTP" });
    s.f.download.status = undefined;
    const retried = await requestMessageBody({ context: owner, mailboxId: s.mailboxId, messageId: id, retry: true });
    expect(retried.ok && retried.data.state, "retry: requested again").toBe("requested");
    expect(await s.hydrate({ messageId: id }), "retry: loaded").toEqual({ hydrated: true });
    expect((await stateOf(id))?.hydration_status, "retry: complete").toBe("complete");
  }, 30_000);

  test("rotation: credentials replaced between Session and download leave the message as it was", async () => {
    const s = await setup("rotation");
    await s.arrive([s.email("rotated", rfc822(`rotated-${suffix}`))]);
    const id = await s.messageOf("rotated");
    s.f.controls.handle = async (request) => {
      if (new URL(request.url).pathname.startsWith("/jmap/download/")) {
        // What replacing the credentials does: a new revision, the binding to verify, the resource waiting for it.
        await sql`UPDATE mail.provider_connections SET secret_revision = secret_revision + 1 WHERE id = ${s.connectionId}::uuid`;
        await sql`UPDATE mail.provider_bindings SET state = 'pending' WHERE id = ${s.bindingId}::uuid`;
        await sql`UPDATE mail.remote_resources SET status = 'connection_required' WHERE id = ${s.remoteResourceId}::uuid`;
      }
      return undefined;
    };
    const failure = await s.hydrate({ messageId: id }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "rotation: the transport changed").toBe("MAILBOX_TRANSPORT_CHANGED");
    const state = await stateOf(id);
    expect(
      {
        status: state?.hydration_status,
        attempt: state?.hydration_attempt,
        code: state?.hydration_error_code,
        claim: state?.hydration_claim_id,
        source: state?.source_blob_id,
      },
      "rotation: no attempt, no claim, no source",
    ).toEqual({ status: "envelope", attempt: 0, code: null, claim: null, source: null });
    s.f.controls.handle = undefined;
    expect(await s.hydrate({ mailboxId: s.mailboxId }), "rotation: nothing runnable until verified again").toEqual({ hydrated: false });
    expect((await stateOf(id))?.hydration_attempt, "rotation: still no attempt").toBe(0);
  }, 30_000);

  test("interruption: an abort while the source streams restores the claim and counts no attempt", async () => {
    const s = await setup("abort");
    const source = rfc822(`abort-${suffix}`, "x".repeat(4_096));
    await s.arrive([s.email("aborted", source)]);
    const id = await s.messageOf("aborted");
    const loaded = await loadJmapAccountAccess({
      remoteResourceId: s.remoteResourceId,
      signal: new AbortController().signal,
      transport: s.f.dependencies,
    });
    if (loaded.status !== "ready") throw new Error(`abort: access ${loaded.status === "unavailable" ? loaded.reason : ""}`);
    const fence = await loadMailboxTransportFence(s.remoteResourceId);
    if (!fence) throw new Error("abort: fence missing");
    const turn = new AbortController();
    // Stop the turn, as a lost lease does, once the parser holds its claim.
    s.f.download.afterChunk = async (index) => {
      if (index !== 0) return;
      for (let poll = 0; (await stateOf(id))?.hydration_status !== "hydrating"; poll++) {
        if (poll > 500) throw new Error("abort: claim never taken");
        await Bun.sleep(10);
      }
      turn.abort(new Error("fixture lease lost"));
    };
    const outcome = await hydrateJmapSource({
      session: loaded.access.session,
      authorization: loaded.access.authorization,
      accountId: loaded.access.accountId,
      messageId: id,
      blobId: "blob-aborted",
      size: source.byteLength,
      sizeBytes: source.byteLength,
      claimId: crypto.randomUUID(),
      transportFence: fence,
      signal: turn.signal,
      transport: s.f.dependencies,
    });
    expect(outcome.kind, "abort: the parser had the source").toBe("failed");
    expect(outcome.kind === "failed" && codeOf(outcome.error), "abort: interruption").toBe(JMAP_HYDRATION_INTERRUPTED);
    const state = await stateOf(id);
    expect(
      {
        status: state?.hydration_status,
        attempt: state?.hydration_attempt,
        code: state?.hydration_error_code,
        claim: state?.hydration_claim_id,
        source: state?.source_blob_id,
      },
      "abort: claim restored without an attempt",
    ).toEqual({ status: "envelope", attempt: 0, code: null, claim: null, source: null });
  }, 30_000);

  test("interruption: a job lease lost before a claim leaves every message untouched", async () => {
    const s = await setup("lease");
    await s.arrive([s.email("leased", rfc822(`leased-${suffix}`))]);
    const id = await s.messageOf("leased");
    let calls = 0;
    const failure = await syncRuntime
      .hydrateMessageBatch(
        {
          input: { messageId: id },
          // The first heartbeat starts the job; the one before the first source fails.
          heartbeat: async () => {
            calls++;
            if (calls > 1) throw new Error("fixture job lease lost");
          },
          resubmit: () => undefined,
        },
        { jmapTransport: s.f.dependencies },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(codeOf(failure), "lease: lost").toBe("SYNC_JOB_LEASE_LOST");
    expect(s.downloads(), "lease: no download").toEqual([]);
    const state = await stateOf(id);
    expect({ status: state?.hydration_status, attempt: state?.hydration_attempt }, "lease: untouched").toEqual({
      status: "envelope",
      attempt: 0,
    });
  }, 30_000);

  /** One resource per case: a timeout opens that resource's breaker, which would turn later cases into SYNC_BUSY. */
  const failureCase = async (label: string, prepare: (s: Fixture) => JmapTransportDependencies | undefined) => {
    const s = await setup(`failure ${label}`);
    await s.arrive([s.email("throttled", rfc822(`throttled-${label}-${suffix}`))]);
    const id = await s.messageOf("throttled");
    const transport = prepare(s);
    const failure = await s.hydrate({ messageId: id }, transport).then(
      () => null,
      (error: unknown) => error,
    );
    const state = await stateOf(id);
    expect({ status: state?.hydration_status, attempt: state?.hydration_attempt }, `${label}: no attempt`).toEqual({
      status: "envelope",
      attempt: 0,
    });
    return { failure, breakerMs: await providerBreakerOpenForMs(s.remoteResourceId) };
  };

  test("provider failures: 429, 401, a timeout and a changed Session count no attempt", async () => {
    const throttled = await failureCase("download-429", (s) => {
      s.f.download.status = 429;
      return undefined;
    });
    expect(
      [codeOf(throttled.failure), throttled.failure instanceof Error && Reflect.get(throttled.failure, "retryAfterMs")],
      "429: waits",
    ).toEqual(["MAIL_RATE_LIMITED", 30_000]);
    const refused = await failureCase("download-401", (s) => {
      s.f.download.status = 401;
      return undefined;
    });
    expect([codeOf(refused.failure), refused.failure instanceof Error && Reflect.get(refused.failure, "status")], "401: refused").toEqual([
      "JMAP_HTTP",
      401,
    ]);
    const listThrottled = await failureCase("list-429", (s) => {
      s.f.controls.apiStatus = 429;
      return undefined;
    });
    expect(codeOf(listThrottled.failure), "Email/get 429: waits").toBe("MAIL_RATE_LIMITED");
    const moved = await failureCase("session-moved", (s) => {
      s.f.controls.handle = async (request) => {
        if (request.method === "POST") s.f.session.state = "session-state-moved";
        return undefined;
      };
      return undefined;
    });
    expect(codeOf(moved.failure), "Session changed: ends the batch").toBe("JMAP_SESSION_CHANGED");
    const timedOut = await failureCase("connect-timeout", (s) => ({
      ...s.f.dependencies,
      downloadTimer: (expire) => {
        queueMicrotask(expire);
        return () => undefined;
      },
    }));
    expect(codeOf(timedOut.failure), "timeout: before the source").toBe("JMAP_TIMEOUT");
    // Wanted: the timeout reaches the provider's breaker, as an IMAP timeout does.
    expect(timedOut.breakerMs, "timeout: breaker open").toBeGreaterThan(0);
    expect(throttled.breakerMs + refused.breakerMs, "429 and 401: breaker closed").toBe(0);
  }, 60_000);

  /** Three fresh messages of one resource, newest first: `first`, `second`, `third`. */
  const threeMessages = async (label: string) => {
    const s = await setup(label);
    await s.arrive([
      s.email("first", rfc822(`first-${label}-${suffix}`), { a: true }, "2026-11-19T12:00:00Z"),
      s.email("second", rfc822(`second-${label}-${suffix}`), { a: true }, "2026-11-19T11:00:00Z"),
      s.email("third", rfc822(`third-${label}-${suffix}`), { a: true }, "2026-11-19T10:00:00Z"),
    ]);
    const ids = { first: await s.messageOf("first"), second: await s.messageOf("second"), third: await s.messageOf("third") };
    const attempts = async () => ({
      first: (await stateOf(ids.first))?.hydration_attempt,
      second: (await stateOf(ids.second))?.hydration_attempt,
      third: (await stateOf(ids.third))?.hydration_attempt,
    });
    const rejected = (transport?: JmapTransportDependencies) =>
      s.hydrate({ mailboxId: s.mailboxId }, transport).then(
        () => null,
        (error: unknown) => error,
      );
    return { s, ids, attempts, rejected };
  };
  /** The download of each named blob answers with the given HTTP status. */
  const answerFor = (s: Fixture, blobs: Record<string, number>) => {
    s.f.controls.handle = async (request) => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/jmap/download/")) return undefined;
      const status = blobs[path.split("/")[4] ?? ""];
      return status === undefined ? undefined : new Response("", { status });
    };
  };

  test("one message: a server failure on its download counts its attempt and ends the batch; fresh mail goes first next", async () => {
    const t = await threeMessages("server-failure");
    answerFor(t.s, { "blob-first": 500 });
    const failure = await t.rejected();
    expect([codeOf(failure), failure instanceof Error && Reflect.get(failure, "status")], "500: the batch ends with the failure").toEqual([
      "JMAP_HTTP",
      500,
    ]);
    expect(t.s.downloads(), "500: no download after it").toEqual(["blob-first"]);
    expect(await t.attempts(), "500: one attempt for that message only").toEqual({ first: 1, second: 0, third: 0 });
    const first = await stateOf(t.ids.first);
    expect({ status: first?.hydration_status, code: first?.hydration_error_code }, "500: recorded by the parser").toEqual({
      status: "failed",
      code: "JMAP_HTTP",
    });
    expect(await t.s.hydrate({ mailboxId: t.s.mailboxId }), "next run: the fresh bodies load").toEqual({ hydrated: true });
    expect(t.s.downloads(), "next run: fresh first, the failed one waits").toEqual(["blob-first", "blob-second", "blob-third"]);
    expect((await stateOf(t.ids.second))?.hydration_status, "next run: second complete").toBe("complete");
    expect((await stateOf(t.ids.third))?.hydration_status, "next run: third complete").toBe("complete");
    expect((await stateOf(t.ids.first))?.hydration_attempt, "next run: first keeps one attempt").toBe(1);
  }, 30_000);

  test("one message: a refused download (403 or another 4xx) counts its attempt; the batch goes on", async () => {
    const t = await threeMessages("refused");
    answerFor(t.s, { "blob-first": 403, "blob-second": 410 });
    expect(await t.s.hydrate({ mailboxId: t.s.mailboxId }), "refused: the batch goes on").toEqual({ hydrated: true });
    expect(t.s.downloads(), "refused: every source asked for").toEqual(["blob-first", "blob-second", "blob-third"]);
    expect(await t.attempts(), "refused: one attempt each").toEqual({ first: 1, second: 1, third: 1 });
    for (const id of [t.ids.first, t.ids.second]) {
      const state = await stateOf(id);
      expect({ status: state?.hydration_status, code: state?.hydration_error_code }, "refused: recorded by the parser").toEqual({
        status: "failed",
        code: "JMAP_HTTP",
      });
    }
    expect((await stateOf(t.ids.third))?.hydration_status, "refused: the next message loads").toBe("complete");
  }, 30_000);

  test("missing source: counted even when a later message ends the batch", async () => {
    const t = await threeMessages("missing-then-throttled");
    t.s.f.emails.splice(
      t.s.f.emails.findIndex((item) => item.id === "first"),
      1,
    );
    answerFor(t.s, { "blob-second": 429 });
    const failure = await t.rejected();
    expect(codeOf(failure), "throttled: the batch ends").toBe("MAIL_RATE_LIMITED");
    expect(await t.attempts(), "throttled: the missing source counts, the throttled message does not").toEqual({
      first: 1,
      second: 0,
      third: 0,
    });
    expect((await stateOf(t.ids.first))?.hydration_error_code, "missing: recorded").toBe("MESSAGE_SOURCE_MISSING");
  }, 30_000);

  test("mid-stream: a broken connection counts that message's attempt and ends the batch", async () => {
    const t = await threeMessages("broken");
    const factory = t.s.f.dependencies.request;
    if (!factory) throw new Error("broken: fixture request factory missing");
    // The connection of the first source closes after its first bytes.
    const breaking: JmapTransportDependencies = {
      ...t.s.f.dependencies,
      request: (options, callback) =>
        factory(options, (response) => {
          if (options.path?.includes("/blob-first/")) response.once("data", () => response.destroy());
          callback(response);
        }),
    };
    const failure = await t.rejected(breaking);
    expect(codeOf(failure), "broken: the batch ends with the failure").toBe("JMAP_TRANSPORT");
    expect(t.s.downloads(), "broken: no download after it").toEqual(["blob-first"]);
    expect(await t.attempts(), "broken: one attempt for that message only").toEqual({ first: 1, second: 0, third: 0 });
    expect((await stateOf(t.ids.first))?.hydration_error_code, "broken: recorded").toBe("JMAP_TRANSPORT");
  }, 30_000);

  test("mid-stream: an idle deadline counts that message's attempt, ends the batch and opens the breaker", async () => {
    const t = await threeMessages("idle");
    // The network idle deadline expires once the first source started.
    let expired = false;
    const idle: JmapTransportDependencies = {
      ...t.s.f.dependencies,
      downloadTimer: (expire, milliseconds) => {
        if (milliseconds === 60_000 && !expired) {
          expired = true;
          queueMicrotask(expire);
        }
        return () => undefined;
      },
    };
    const failure = await t.rejected(idle);
    expect(codeOf(failure), "idle: the batch ends with the timeout").toBe("JMAP_TIMEOUT");
    expect(t.s.downloads(), "idle: no download after it").toEqual(["blob-first"]);
    expect(await t.attempts(), "idle: one attempt for that message only").toEqual({ first: 1, second: 0, third: 0 });
    expect((await stateOf(t.ids.first))?.hydration_error_code, "idle: recorded").toBe("JMAP_TIMEOUT");
    expect(await providerBreakerOpenForMs(t.s.remoteResourceId), "idle: breaker open").toBeGreaterThan(0);
  }, 30_000);

  test("not ready: a job for a JMAP message whose binding is not active ends without a mark or an attempt", async () => {
    const s = await setup("not-ready");
    await s.arrive([s.email("waiting", rfc822(`waiting-${suffix}`))]);
    const id = await s.messageOf("waiting");
    await sql`UPDATE mail.provider_bindings SET state = 'pending' WHERE id = ${s.bindingId}::uuid`;
    expect(await syncRuntime.canHydrateMessage(id), "not ready: nothing to fetch").toBe(false);
    expect(await s.hydrate({ messageId: id }), "not ready: nothing done").toEqual({ hydrated: false });
    expect(s.downloads(), "not ready: no download").toEqual([]);
    const state = await stateOf(id);
    expect(
      { status: state?.hydration_status, attempt: state?.hydration_attempt, code: state?.hydration_error_code },
      "not ready: unchanged",
    ).toEqual({ status: "envelope", attempt: 0, code: null });
  }, 30_000);

  test("DATA-13: a JMAP batch costs the IMAP statements per message and the loader's two reads", async () => {
    const measured: { one: number; five: number } = { one: 0, five: 0 };
    const meter = await meterSql();
    try {
      for (const [key, count] of [
        ["one", 1],
        ["five", 5],
      ] as const) {
        const s = await setup(`budget ${key}`);
        await s.arrive(Array.from({ length: count }, (_, index) => s.email(`${key}-${index}`, rfc822(`${key}-${index}-${suffix}`))));
        measured[key] = (await meter.during(() => s.hydrate({ mailboxId: s.mailboxId }))).length;
        expect(s.downloads().length, `${key}: every source once`).toBe(count);
      }
      // The line names the measured values for the budget.
      console.info("JMAP_HYDRATION_STATEMENTS", JSON.stringify(measured));
      if (JMAP_HYDRATION_BUDGET.one !== null && JMAP_HYDRATION_BUDGET.five !== null)
        expect(measured, "budget: exact statement counts").toEqual({ one: JMAP_HYDRATION_BUDGET.one, five: JMAP_HYDRATION_BUDGET.five });
    } finally {
      await meter.close();
    }
  }, 60_000);

  // Last in the file: it leaves 160,000 pending bodies behind in two mailboxes of their own.
  test("candidate plan: each status probe follows the hydration queue index among 160,000 pending bodies", async () => {
    const limit = 20;
    const fill = async (s: Fixture, prefix: string) => {
      const folderId = s.folderIds.get("a");
      if (!folderId) throw new Error("plan: folder missing");
      await sql`INSERT INTO mail.message_contents (short_id, mailbox_id, subject, internal_date, content_hash, hydration_status)
        SELECT ${prefix} || lpad(item::text, 5, '0'), ${s.mailboxId}::uuid, 'Plan', ${at}::timestamptz - make_interval(secs => item),
          md5(${prefix} || item::text) || md5(item::text), 'envelope'
        FROM generate_series(0, 79999) AS item`;
      await sql`INSERT INTO mail.remote_message_refs (folder_id, message_id, remote_id)
        SELECT ${folderId}::uuid, mc.id, 'E' || mc.short_id FROM mail.message_contents mc WHERE mc.mailbox_id = ${s.mailboxId}::uuid`;
    };
    const s = await setup("plan");
    const other = await setup("plan-other");
    await fill(s, "P");
    await fill(other, "Q");
    await sql`ANALYZE mail.message_contents`;
    await sql`ANALYZE mail.remote_message_refs`;
    const [newest] = await sql<{ id: string }[]>`SELECT id FROM mail.message_contents WHERE short_id = 'P00000'`;
    if (!newest) throw new Error("plan: newest body missing");
    const params = {
      mailboxId: s.mailboxId,
      remoteResourceId: s.remoteResourceId,
      bindingId: s.bindingId,
      targetId: newest.id,
      takesRetries: false,
      limit,
    };
    const rows = await syncRuntime.jmapHydrationCandidatesQuery(sql, params);
    expect(
      rows.map((row) => row.email_id),
      "plan: the newest bodies, the target first",
    ).toEqual(Array.from({ length: limit }, (_, index) => `EP${String(index).padStart(5, "0")}`));
    type Plan = {
      "Node Type": string;
      "Actual Rows"?: number;
      "Actual Loops"?: number;
      "Rows Removed by Filter"?: number;
      "Relation Name"?: string;
      "Index Name"?: string;
      Plans?: Plan[];
    };
    const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const [explained] = await sql<{ "QUERY PLAN": [{ Plan: Plan; "Execution Time": number }] }[]>`
      EXPLAIN (ANALYZE, FORMAT JSON) ${syncRuntime.jmapHydrationCandidatesQuery(sql, params)}`;
    const plan = explained?.["QUERY PLAN"][0];
    if (!plan) throw new Error("plan: missing");
    const all = nodes(plan.Plan);
    const read = (node: Plan) => (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0);
    const probes = all.filter((node) => node["Index Name"] === "message_contents_hydration_queue_idx");
    // One line for the driver; no expectation on time.
    console.info(
      "JMAP_HYDRATION_PLAN",
      JSON.stringify({
        nodes: all.map((node) => node["Node Type"] + (node["Index Name"] ? `(${node["Index Name"]})` : "")),
        probeRowsPerLoop: probes.map(read),
        probeLoops: probes.map((node) => node["Actual Loops"] ?? 1),
        rowsRead: all.filter((node) => node["Relation Name"]).reduce((sum, node) => sum + read(node) * (node["Actual Loops"] ?? 1), 0),
        rows: plan.Plan["Actual Rows"],
        executionMs: plan["Execution Time"],
      }),
    );
    expect(plan.Plan["Actual Rows"] ?? Number.POSITIVE_INFINITY, "plan: at most one batch of rows").toBeLessThanOrEqual(limit);
    expect(
      all.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "message_contents"),
      "plan: no sequential scan of the bodies",
    ).toBeFalse();
    expect(probes.length, "plan: the hydration queue index").toBeGreaterThan(0);
    for (const probe of probes) expect(read(probe), "plan: each status probe reads about one batch").toBeLessThanOrEqual(4 * limit);
  }, 120_000);
});
