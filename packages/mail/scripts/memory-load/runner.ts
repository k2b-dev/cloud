import { heapStats } from "bun:jsc";
import { appendFileSync, createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { User } from "@k2b/cloud/contracts";
import { redis, sql } from "bun";
import { z } from "zod";
import type { ConnectorVerification } from "../../src/contracts";
import type { MailRequestContext } from "../../src/service/auth";
import type { ConnectorEnvelope } from "../../src/service/connectors";
import { type Fixture, fixtures, MiB, mimeStructure, type Options, sourceStream } from "./model";

type Mailbox = { id: string; shortId: string; folders: string[] };
type State = {
  at: number;
  messages: { status: string; error: string | null; count: number }[];
  extractions: { status: string; count: number }[];
  hydrating: number;
  extractionPending: number;
  extractionRunning: number;
  complete: number;
  failed: number;
  pending: number;
  retryable: number;
  attachments: number;
  extractionUnsettled: number;
};
const rssResult = z.object({ peakRss: z.number(), peakAt: z.number(), longestStallMs: z.number(), samples: z.number() });
const workerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("snapshot") }),
  z.object({ type: z.literal("done"), result: rssResult }),
]);
// This worker writes RSS samples itself: a blocked main thread cannot delay samples or retain an unbounded message queue.
export const observerSource = `
import { appendFileSync } from "node:fs";
let file, timer, lastTick = 0, baseline = 0, threshold = 0, fired = false;
let result = { peakRss: 0, peakAt: 0, longestStallMs: 0, samples: 0 };
function sample() {
  const at = Date.now(), rss = process.memoryUsage().rss;
  appendFileSync(file, JSON.stringify({kind:"rss",at,rss}) + "\\n");
  result.samples++;
  if (rss > result.peakRss) { result.peakRss = rss; result.peakAt = at; }
  result.longestStallMs = Math.max(result.longestStallMs, at - lastTick);
  if (threshold && !fired && rss - baseline > threshold) { fired = true; postMessage({type:"snapshot"}); }
}
onmessage = ({data}) => {
  if (data.type === "start") {
    file=data.file; baseline=data.baseline; threshold=data.threshold; lastTick=Date.now();
    sample(); timer=setInterval(sample,20); postMessage({type:"started"});
  } else if (data.type === "tick") {
    result.longestStallMs = Math.max(result.longestStallMs, Date.now() - lastTick);
    lastTick=Date.now();
  } else if (data.type === "stop") {
    clearInterval(timer); if(file) sample(); postMessage({type:"done",result}); close();
  }
};
postMessage({type:"ready"});
`;

export async function run(options: Options): Promise<void> {
  const manifest = fixtures(options); // Validate all component budgets before allocating infrastructure.
  if (!manifest.length) throw new Error("The selected fixture has no messages");
  const out = resolve(options.out ?? join(".local/mail-memory", new Date().toISOString().replaceAll(":", "-")));
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Exclusive even for explicit --out; never overwrite a previous run.
  const sampleFile = join(out, "samples.ndjson");
  await writeFile(sampleFile, "", { flag: "wx" });
  const errors: string[] = [];
  const controller = new AbortController();
  const interrupted = (signal: NodeJS.Signals) => {
    controller.abort(new Error(`Interrupted by ${signal}`));
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const signal = controller.signal;
  const cleanup: Array<() => Promise<unknown> | void> = [];
  const tasks: Promise<void>[] = [];
  let observer: Worker | undefined;
  let observerDone: Promise<z.infer<typeof rssResult>> | undefined;
  let observation: z.infer<typeof rssResult> | undefined;
  let baseline = 0,
    startedAt = 0,
    endedAt = 0;
  let peakHeapUsed = 0,
    peakExternal = 0,
    peakArrayBuffers = 0,
    peakHeapTotal = 0;
  let nearestPeakState: State | undefined, finalState: State | undefined;
  let correctness: unknown = null;
  let correctnessTotals: Record<string, number> | null = null;
  let readCorrectness: (() => Promise<void>) | undefined;
  let readFinalState: (() => Promise<State>) | undefined;
  const apiCoverage = new Set<number>();
  let snapshot = false,
    requests = 0,
    folderSyncs = 0;
  let baselineState: State | undefined;
  let memoryBudget: typeof import("../../src/service/processing-memory-budget") | undefined;
  const record = (data: unknown) => appendFileSync(sampleFile, `${JSON.stringify(data)}\n`);
  const check = () => signal.throwIfAborted();
  const waitForObserver = async (pending: Promise<void>) => {
    check();
    let aborted: () => void = () => undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  };
  const tracked = (task: () => Promise<void>) => {
    const promise = task().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      controller.abort(error);
    });
    tasks.push(promise);
  };
  const cleanupStep = async (action: () => Promise<unknown> | void) => {
    try {
      await action();
    } catch (error) {
      errors.push(`Cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let measuring = false;
  const preparationTimer = setTimeout(() => controller.abort(new Error("Preparation timed out")), options.timeoutS * 1000);
  let measurementTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The fixture guards the database suffix, maps credentials and probes the NATS test identity.
    const { createDisposableDatabase, requireInfra } = await import("../../../../scripts/fixtures/test-infra");
    await requireInfra("database", "nats", "valkey");
    check();
    const database = await createDisposableDatabase("mail");
    cleanup.push(() => database.drop());
    process.env.DATABASE_URL = database.url;
    const namespace = `test-mail-memory-${crypto.randomUUID()}`;
    process.env.SYNC_NAMESPACE = namespace;
    memoryBudget = await import("../../src/service/processing-memory-budget");
    const { deleteTestNamespace } = await import("../../../../scripts/fixtures/test-sync");
    cleanup.push(() => redis.close());
    cleanup.push(() => sql.close());
    cleanup.push(() => deleteTestNamespace(namespace));
    const { startProcessSync } = await import("@k2b/cloud");
    const processSync = await startProcessSync({ application: "mail" });
    cleanup.push(() => processSync.stop());
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    const { migrate } = await import("../../src/migrate");
    await migrate();
    check();
    const { unavailableProviderLimitSnapshot } = await import("../../src/contracts");
    const { imapSmtpConnector } = await import("../../src/service/connectors");
    const { oauthTokens } = await import("@k2b/cloud/services");
    const { createMailbox } = await import("../../src/service/mailboxes");
    const { createProviderConnection } = await import("../../src/service/provider-connections");
    const { sha256Json } = await import("../../src/service/canonical");
    const { newShortId } = await import("../../src/lib/short-id");
    const hydration = await import("../../src/service/sync-runtime");
    const { attachmentExtractionRuntime, recoverAttachmentExtractions, MAIL_ATTACHMENT_EXTRACTOR_VERSION } = await import(
      "../../src/service/attachment-extraction"
    );
    const { default: app } = await import("../../src/api");
    const original = { ...imapSmtpConnector };
    const originalVerify = oauthTokens.verifyAccessToken;
    cleanup.push(() => {
      Object.assign(imapSmtpConnector, original);
      oauthTokens.verifyAccessToken = originalVerify;
    });
    cleanup.push(async () => {
      if (readFinalState) finalState = await readFinalState();
      if (readCorrectness) await readCorrectness();
    });
    // Register drains before starting: partial runtime startup must also be cleaned up.
    cleanup.push(() => attachmentExtractionRuntime.stop());
    cleanup.push(() => hydration.stopHydrationRuntime());
    const byFolder = new Map<string, Fixture[]>();
    const lookup = (account: string, path: string) => byFolder.get(`${account}/${path}`) ?? [];
    const verification = (account: string): ConnectorVerification => ({
      authenticatedPrincipal: account,
      serverIdentity: { serverInfo: { name: "memory-fixture" } },
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
    imapSmtpConnector.verify = async (config, abort) => {
      check();
      abort?.throwIfAborted();
      return verification(config.username);
    };
    imapSmtpConnector.withSession = async (config, fn) => fn(config);
    imapSmtpConnector.getFolderStatus = async (config, path, abort) => {
      check();
      abort?.throwIfAborted();
      const sources = lookup(config.username, path);
      return { uidValidity: "10", uidNext: sources.length + 1, highestModseq: "1", messages: sources.length };
    };
    const envelope = (f: Fixture, folderId: string): ConnectorEnvelope => ({
      remoteRef: { folderStableKey: folderId, uidValidity: "10", uid: String(f.uid), modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: `<${f.id}@memory.test>`,
      inReplyTo: null,
      references: [],
      subject: `Memory newsletter ${f.id}`,
      sentAt: new Date("2026-10-01T00:00:00Z"),
      internalDate: new Date(Date.parse("2026-10-01T00:00:00Z") + f.uid * 60_000),
      sizeBytes: f.size,
      flags: [],
      labels: [],
      addresses: {
        from: [{ name: null, address: "sender@example.test" }],
        to: [{ name: null, address: `mailbox-${f.mailbox}@example.test` }],
        replyTo: [],
        cc: [],
        bcc: [],
      },
      mimeStructure: mimeStructure(f),
    });
    imapSmtpConnector.fetchEnvelopeBatch = async (config, request, abort) => {
      check();
      abort?.throwIfAborted();
      const candidates = lookup(config.username, request.folderPath)
        .filter((f) => f.uid >= (request.lowUid ?? 1) && f.uid <= request.highUid && (!request.uids || request.uids.includes(f.uid)))
        .toReversed();
      const selected = candidates.slice(0, request.limit);
      return {
        messages: selected.map((f) => envelope(f, request.folderStableKey)),
        nextHighUid: candidates.length > selected.length ? selected.at(-1)!.uid - 1 : null,
      };
    };
    imapSmtpConnector.fetchFlagChanges = async () => {
      check();
      return [];
    };
    imapSmtpConnector.fetchUidWindow = async (config, path, _validity, low, high, abort) => {
      check();
      abort?.throwIfAborted();
      return lookup(config.username, path)
        .filter((f) => f.uid >= low && f.uid <= high)
        .map((f) => ({ uid: f.uid, modseq: null, flags: [], labels: [] }));
    };
    imapSmtpConnector.countDraftMessages = async () => {
      check();
      return 0;
    };
    imapSmtpConnector.downloadSourceBatch = async (config, path, requested, consume, abort) => {
      for (const request of requested) {
        check();
        abort?.throwIfAborted();
        const f = lookup(config.username, path).find((f) => f.uid === request.uid);
        if (!f) throw new Error(`Unknown simulated source ${path}/${request.uid}`);
        const stream = sourceStream(f, AbortSignal.any([signal, ...(abort ? [abort] : [])]));
        try {
          if ((await consume({ ...request, stream, expectedSize: f.size })) === "stop") break;
        } finally {
          stream.destroy();
        }
      }
    };
    const uid = `memory-${crypto.randomUUID()}`;
    const [userRow] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile, display_name, admin) VALUES (${uid}, 'local', 'user', ${uid}, false) RETURNING id`;
    if (!userRow) throw new Error("No fixture user created");
    const user: User = {
      id: userRow.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: uid,
      sn: "Test",
      displayName: uid,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
    const context: MailRequestContext = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, requestId: uid };
    oauthTokens.verifyAccessToken = async (token) => (token === "memory-load" ? { kind: "user", payload: {}, user, scopes: [] } : null);
    const create = async (sources: Fixture[], label: string, smallFolders = options.folders): Promise<Mailbox> => {
      check();
      const mailbox = await createMailbox(context, { name: `Memory ${label}` });
      if (!mailbox.ok) throw new Error(mailbox.error.message);
      const id = mailbox.data.id,
        account = `${label}@example.test`;
      const connection = await createProviderConnection({
        context,
        mailboxId: id,
        input: {
          name: label,
          email: account,
          username: account,
          imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      const scope = sha256Json({ account });
      const [resource] = await sql<
        { id: string }[]
      >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${id}::uuid, ${{ accountId: account }}::jsonb, '{}'::jsonb, ${scope}, 'active') RETURNING id`;
      if (!resource) throw new Error("No remote resource created");
      const [binding] = await sql<
        { id: string }[]
      >`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
          capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at)
        VALUES (${resource.id}::uuid, ${connection.data.connection.id}::uuid, 'active', ${account}, ${{ accountId: account }}::jsonb,
          ${verification(account).capabilities}::jsonb, '{}'::jsonb, '{}'::jsonb, ${scope}, 1, now()) RETURNING id`;
      if (!binding) throw new Error("No binding created");
      const folders: string[] = [];
      for (const path of new Set([
        "INBOX",
        ...Array.from({ length: smallFolders }, (_, i) => `Folder-${i}`),
        ...sources.map((f) => f.folder),
      ])) {
        check();
        const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role)
          VALUES (${newShortId()}, ${resource.id}::uuid, ${`${path}:10`}, ${path}, ${path === "INBOX" ? "inbox" : "other"}) RETURNING id`;
        if (!folder) throw new Error("No folder created");
        folders.push(folder.id);
        await sql`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_path, uid_validity, uid_next, highest_modseq, effective_rights, rights_source, last_verified_at)
          VALUES (${binding.id}::uuid, ${folder.id}::uuid, ${path}, 10, 1, 1, ARRAY['read']::text[], 'acl', now())`;
        byFolder.set(
          `${account}/${path}`,
          sources.filter((f) => f.folder === path),
        );
        // Import all envelope pages, bounded by the fixture's message count.
        for (let page = 0; page <= sources.length; page++) {
          check();
          const batch = await hydration.syncFolderBatch(folder.id, async () => check());
          if (!batch.hasMore) break;
          if (page === sources.length) throw new Error("Envelope import did not finish");
        }
      }
      const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${id}::uuid`;
      if (!row) throw new Error("Mailbox missing after creation");
      return { id, shortId: row.short_id, folders };
    };
    // SQL has no separate running extraction status: pending + attempt_count>0 is an in-progress attempt.
    const state = async (): Promise<State> => {
      const messages = await sql<
        { status: string; error: string | null; count: number }[]
      >`SELECT hydration_status AS status, hydration_error_code AS error, count(*)::int AS count FROM mail.message_contents GROUP BY 1,2`;
      const extractions = await sql<
        { status: string; count: number }[]
      >`SELECT status, count(*)::int AS count FROM mail.attachment_extractions WHERE extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION} GROUP BY 1`;
      const [counts] = await sql<{ pending: number; running: number; attachments: number; unsettled: number; retryable: number }[]>`SELECT
        (SELECT count(*)::int FROM (SELECT DISTINCT a.blob_id FROM mail.attachments a LEFT JOIN mail.attachment_extractions e ON e.blob_id = a.blob_id AND e.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
          WHERE e.blob_id IS NULL OR (e.status = 'pending' AND e.attempt_count = 0) OR (e.status = 'failed' AND e.attempt_count < 5)) queued) AS pending,
        (SELECT count(*)::int FROM mail.attachment_extractions WHERE status = 'pending' AND attempt_count > 0) AS running,
        (SELECT count(*)::int FROM mail.attachments) AS attachments,
        (SELECT count(*)::int FROM (SELECT DISTINCT a.blob_id FROM mail.attachments a LEFT JOIN mail.attachment_extractions e ON e.blob_id = a.blob_id AND e.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
          WHERE e.blob_id IS NULL OR e.status = 'pending' OR (e.status = 'failed' AND e.attempt_count < 5)) work) AS unsettled,
        (SELECT count(*)::int FROM mail.message_contents WHERE hydration_status NOT IN ('complete','failed') OR (hydration_status = 'failed' AND hydration_attempt < 5)) AS retryable`;
      if (!counts) throw new Error("Missing state counters");
      const count = (status: string) => messages.filter((m) => m.status === status).reduce((n, m) => n + m.count, 0);
      return {
        at: Date.now(),
        messages,
        extractions,
        hydrating: count("hydrating"),
        extractionPending: counts.pending,
        extractionRunning: counts.running,
        complete: count("complete"),
        failed: count("failed"),
        pending: messages.reduce((n, m) => n + m.count, 0) - count("complete") - count("failed"),
        retryable: counts.retryable,
        attachments: counts.attachments,
        extractionUnsettled: counts.unsettled,
      };
    };
    readFinalState = state;
    const settle = async (extraction: boolean) => {
      while (true) {
        check();
        const s = await state();
        if (!s.retryable && (!extraction || !s.extractionUnsettled)) return s;
        await hydration.submitDueHydrationWork();
        await Bun.sleep(100);
      }
    };
    const request = async (path: string, body?: unknown) => {
      check();
      const response = await app.request(path, {
        method: body ? "POST" : "GET",
        headers: { authorization: "Bearer memory-load", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      // Drain without retaining large attachment or detail responses in the harness.
      if (response.body)
        for await (const _chunk of response.body) {
          check();
        }
      if (!response.ok) throw new Error(`API ${path} returned ${response.status}`);
      if (measuring) requests++;
    };
    const apiRound = async (mailbox: Mailbox, largeOnly: boolean) => {
      const base = `/mailboxes/${mailbox.shortId}`;
      await request(`${base}/conversations?limit=20`);
      const [message] = await sql<
        { short_id: string; id: string; size: number }[]
      >`SELECT short_id, id, size_bytes::float8 AS size FROM mail.message_contents
        WHERE mailbox_id = ${mailbox.id}::uuid AND hydration_status = 'complete' ORDER BY size_bytes DESC LIMIT 1`;
      if (message) {
        await request(`${base}/messages/${message.short_id}`);
        const [attachment] = await sql<
          { short_id: string }[]
        >`SELECT short_id FROM mail.attachments WHERE message_id = ${message.id}::uuid ORDER BY size_bytes DESC LIMIT 1`;
        if (attachment) await request(`${base}/messages/${message.short_id}/attachments/${attachment.short_id}`);
      }
      await request(`${base}/search`, { expression: { type: "text", field: "subject", query: "newsletter" }, limit: 20 });
      return !!message && (!largeOnly || !manifest.some((f) => f.large) || message.size >= options.largeMinMib * MiB - 8);
    };
    console.log("Warming hydration, extraction and API paths…");
    const warmSources = fixtures({ ...options, seed: options.seed + 1, mailboxes: 1, folders: 0, largePerMailbox: 0, smallPerMailbox: 1 });
    readCorrectness = async () => {
      const storedMessages = await sql<
        { id: string; message_id: string; status: string; error: string | null }[]
      >`SELECT id, message_id, hydration_status AS status, hydration_error_code AS error FROM mail.message_contents`;
      const storedAttachments = await sql<
        { message_id: string; filename: string | null; size_bytes: number }[]
      >`SELECT message_id, filename, size_bytes::int AS size_bytes FROM mail.attachments`;
      const missingMessages: string[] = [],
        incompleteMessages: typeof storedMessages = [],
        missingAttachments: string[] = [];
      for (const f of manifest) {
        const message = storedMessages.find((m) => m.message_id === `<${f.id}@memory.test>`);
        if (!message) {
          missingMessages.push(f.id);
          continue;
        }
        if (message.status !== "complete") incompleteMessages.push(message);
        for (const part of f.parts.filter((p) => p.filename)) {
          if (!storedAttachments.some((a) => a.message_id === message.id && a.filename === part.filename && a.size_bytes === part.bytes))
            missingAttachments.push(`${f.id}/${part.filename}`);
        }
      }
      const measuredIds = new Set(manifest.map((f) => `<${f.id}@memory.test>`));
      const measuredMessages = storedMessages.filter((m) => measuredIds.has(m.message_id));
      const measuredInternalIds = new Set(measuredMessages.map((m) => m.id));
      correctnessTotals = {
        complete: measuredMessages.filter((m) => m.status === "complete").length,
        failed: measuredMessages.filter((m) => m.status === "failed").length,
        pending: measuredMessages.filter((m) => m.status !== "complete" && m.status !== "failed").length,
        missingMessages: missingMessages.length,
        storedAttachments: storedAttachments.filter((a) => measuredInternalIds.has(a.message_id)).length,
        generatedAttachments: manifest.reduce((n, f) => n + f.parts.filter((p) => p.filename).length, 0),
        missingAttachments: missingAttachments.length,
      };
      correctness = {
        complete: measuredMessages.filter((m) => m.status === "complete").length,
        failed: measuredMessages.filter((m) => m.status === "failed"),
        pending: measuredMessages.filter((m) => m.status !== "complete" && m.status !== "failed").length,
        generatedMessages: manifest.length,
        generatedAttachments: manifest.reduce((n, f) => n + f.parts.filter((p) => p.filename).length, 0),
        storedMessages: measuredMessages.length,
        storedAttachments: storedAttachments.filter((a) => measuredInternalIds.has(a.message_id)).length,
        warmupMessages: warmSources.length,
        warmupAttachments: warmSources.reduce((n, f) => n + f.parts.filter((p) => p.filename).length, 0),
        missingMessages,
        incompleteMessages,
        missingAttachments,
      };
      if (missingMessages.length || incompleteMessages.length || missingAttachments.length)
        errors.push("Correctness failed: missing/incomplete messages or missing attachments");
    };
    const warm = await create(warmSources, "warmup", 0);
    await hydration.startHydrationRuntime();
    await attachmentExtractionRuntime.start();
    await hydration.enqueueMailboxHydration(warm.id);
    const warmState = await settle(true);
    if (warmState.failed || warmState.pending) throw new Error("Warm-up hydration failed");
    const [warmCsv] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM mail.attachments a
      JOIN mail.attachment_extractions e ON e.blob_id = a.blob_id AND e.extractor_version = ${MAIL_ATTACHMENT_EXTRACTOR_VERSION}
      WHERE a.filename LIKE '%.csv' AND e.status = 'complete'`;
    if (!warmCsv?.count) throw new Error("Warm-up CSV did not extract successfully");
    await apiRound(warm, false);
    await hydration.stopHydrationRuntime();
    await attachmentExtractionRuntime.stop();
    const mailboxes: Mailbox[] = [];
    for (let m = 0; m < options.mailboxes; m++)
      mailboxes.push(
        await create(
          manifest.filter((f) => f.mailbox === m),
          `mailbox-${m}`,
        ),
      );
    if (!options.only.includes("hydration")) {
      console.log("Preparing hydrated bodies before measurement (--only excludes hydration)…");
      await hydration.startHydrationRuntime();
      for (const m of mailboxes) await hydration.enqueueMailboxHydration(m.id);
      await settle(false);
      await hydration.stopHydrationRuntime();
    }
    baselineState = await state();
    console.log(`Measuring ${manifest.length} messages; output ${out}`);
    const workerUrl = URL.createObjectURL(new Blob([observerSource], { type: "text/javascript" }));
    cleanup.push(() => URL.revokeObjectURL(workerUrl));
    observer = new Worker(workerUrl);
    let readyResolve: () => void = () => undefined;
    let startResolve: () => void = () => undefined;
    const observing = new Promise<void>((resolve) => {
      startResolve = resolve;
    });
    let doneResolve: (result: z.infer<typeof rssResult>) => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    observerDone = new Promise((resolve) => {
      doneResolve = resolve;
    });
    observer.onerror = (event) => {
      errors.push(`RSS worker: ${event.message}`);
      controller.abort(new Error("RSS worker failed"));
      readyResolve();
      startResolve();
      doneResolve({ peakRss: 0, peakAt: 0, longestStallMs: 0, samples: 0 });
    };
    observer.onmessage = (event: MessageEvent<unknown>) => {
      const message = workerMessage.parse(event.data);
      if (message.type === "ready") readyResolve();
      if (message.type === "started") startResolve();
      if (message.type === "done") doneResolve(message.result);
      if (message.type === "snapshot" && !snapshot) {
        snapshot = true;
        try {
          const stats = heapStats();
          const topObjectTypes = Object.entries(stats.objectTypeCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30);
          appendFileSync(join(out, "heap-stats.json"), JSON.stringify({ at: Date.now(), stats, topObjectTypes }));
          appendFileSync(join(out, "heap.heapsnapshot"), JSON.stringify(Bun.generateHeapSnapshot()));
        } catch (error) {
          errors.push(`Heap snapshot: ${String(error)}`);
        }
      }
    };
    await waitForObserver(ready);
    check();
    Bun.gc(true);
    memoryBudget.resetProcessingMemoryHighWater();
    baseline = process.memoryUsage().rss;
    startedAt = Date.now();
    measuring = true;
    clearTimeout(preparationTimer);
    measurementTimer = setTimeout(
      () => controller.abort(new Error(`Measurement timed out after ${options.timeoutS}s`)),
      options.timeoutS * 1000,
    );
    record({ kind: "state", ...baselineState, at: startedAt });
    observer.postMessage({ type: "start", baseline, file: sampleFile, threshold: (options.heapSnapshotMib ?? 0) * MiB });
    const tick = setInterval(() => observer?.postMessage({ type: "tick" }), 20);
    const sampleMemory = () => {
      const usage = process.memoryUsage();
      peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
      peakHeapTotal = Math.max(peakHeapTotal, usage.heapTotal);
      peakExternal = Math.max(peakExternal, usage.external);
      peakArrayBuffers = Math.max(peakArrayBuffers, usage.arrayBuffers);
      record({ kind: "memory", at: Date.now(), ...usage });
    };
    sampleMemory();
    const memory = setInterval(sampleMemory, 100);
    cleanup.push(() => {
      clearInterval(tick);
      clearInterval(memory);
    });
    await waitForObserver(observing);
    check();
    if (options.only.includes("extraction")) await attachmentExtractionRuntime.start();
    if (options.only.includes("hydration")) {
      await hydration.startHydrationRuntime();
      for (const m of mailboxes) await hydration.enqueueMailboxHydration(m.id);
    }
    if (options.only.includes("api"))
      for (let reader = 0; reader < options.readers; reader++)
        tracked(async () => {
          let round = reader;
          while (measuring && !signal.aborted) {
            if (await apiRound(mailboxes[round++ % mailboxes.length]!, true)) apiCoverage.add(reader);
            // Respect the real app's per-second limiter and bound request pressure.
            await Bun.sleep(1000);
          }
        });
    let churnDone = !options.only.includes("folders");
    if (!churnDone)
      tracked(async () => {
        // One pass per mailbox, in parallel across mailboxes, serial inside each provider resource.
        await Promise.all(
          mailboxes.map(async (m) => {
            for (const folder of m.folders.slice(1)) {
              check();
              for (;;) {
                check();
                try {
                  await hydration.syncFolderBatch(folder, async () => check());
                  folderSyncs++;
                  break;
                } catch (error) {
                  if (!(error instanceof Error) || !("code" in error) || error.code !== "SYNC_BUSY") throw error;
                  await Bun.sleep(100);
                }
              }
            }
          }),
        );
        churnDone = true;
      });
    while (true) {
      check();
      const s = await state();
      finalState = s;
      record({ kind: "state", ...s });
      const apiDone = !options.only.includes("api") || apiCoverage.size === options.readers || s.failed > 0;
      if (!s.retryable && (!options.only.includes("extraction") || !s.extractionUnsettled) && churnDone && apiDone) break;
      if (options.only.includes("extraction")) await recoverAttachmentExtractions();
      if (options.only.includes("hydration")) await hydration.submitDueHydrationWork();
      await Bun.sleep(250);
    }
    measuring = false;
    await Promise.all(tasks);
    check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error(message);
  } finally {
    measuring = false;
    if (!signal.aborted) controller.abort(new Error("Run finished; draining background work"));
    clearTimeout(preparationTimer);
    clearTimeout(measurementTimer);
    await Promise.all(tasks);
    if (observer && observerDone) {
      observer.postMessage({ type: "stop" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        observation = await Promise.race([
          observerDone,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("RSS worker did not stop")), 5000);
          }),
        ]);
      } catch (error) {
        errors.push(String(error));
      } finally {
        clearTimeout(timer);
        observer.terminate();
        observer = undefined;
      }
    }
    endedAt = Date.now();
    // Reverse ownership order: timers, runtime drains, connector restore, process sync, namespace, SQL, database.
    for (const action of cleanup.toReversed()) await cleanupStep(action);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    // Stream samples back from disk: do not load a 15-minute sample file into memory to find peak attribution.
    if (observation) {
      nearestPeakState = undefined;
      for await (const line of createInterface({ input: createReadStream(sampleFile), crlfDelay: Infinity })) {
        const value: unknown = JSON.parse(line);
        if (
          typeof value === "object" &&
          value !== null &&
          "kind" in value &&
          value.kind === "state" &&
          "at" in value &&
          typeof value.at === "number"
        ) {
          if (!nearestPeakState || Math.abs(value.at - observation.peakAt) < Math.abs(nearestPeakState.at - observation.peakAt)) {
            // State rows were written by this process; validation below keeps the disk boundary checked.
            nearestPeakState = stateSchema.parse(value);
          }
        }
      }
    }
    if (startedAt && (!observation || observation.samples === 0)) errors.push("No RSS samples recorded");
    const summary = {
      profile: options.profile,
      options,
      manifest,
      manifestTotals: {
        messages: manifest.length,
        sourceBytes: manifest.reduce((n, f) => n + f.size, 0),
        htmlBytes: manifest.reduce((n, f) => n + f.htmlBytes, 0),
        attachmentBytes: manifest.reduce((n, f) => n + f.attachmentBytes, 0),
      },
      processingMemory: memoryBudget?.processingMemoryState() ?? null,
      baselineRss: baseline,
      peakRss: observation?.peakRss ?? null,
      peakAboveBaseline: observation ? Math.max(0, observation.peakRss - baseline) : null,
      peakAt: observation ? new Date(observation.peakAt).toISOString() : null,
      inFlightAtPeak: nearestPeakState,
      baselineState,
      finalState,
      peakHeapUsed,
      peakHeapTotal,
      peakExternal,
      peakArrayBuffers,
      longestEventLoopStallMs: observation?.longestStallMs ?? null,
      rssSamples: observation?.samples ?? 0,
      durationMs: startedAt ? endedAt - startedAt : 0,
      requests,
      folderSyncs,
      readersWithBodyCoverage: apiCoverage.size,
      snapshot,
      correctness,
      correctnessTotals,
      errors,
      limits: [
        "Simulated IMAP; no network or provider latency",
        "In-process Hono requests; no browser or HTTP sockets",
        "State/heap sampling pauses during main-thread stalls; RSS uses worker",
        "In-flight counts use sequential SQL reads and nearest sample, not an atomic snapshot",
        "Extraction running inferred from pending status + attempt_count > 0",
        "Warm-up mailbox included in state counts; correctness compares every measured fixture",
        "Snapshots perturb measurements; hard OOM/SIGKILL cannot run cleanup",
      ],
    };
    await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
    const mib = (bytes: number | null) => (bytes === null ? "unavailable" : `${(bytes / MiB).toFixed(1)} MiB`);
    const markdown = [
      "# Mail memory load",
      "",
      `Result: **${errors.length ? "FAILED" : "PASS"}**. Profile: ${options.profile}; seed: ${options.seed}; duration: ${(summary.durationMs / 1000).toFixed(2)} s.`,
      "",
      `Fixtures: ${manifest.length} messages; ${mib(summary.manifestTotals.sourceBytes)} source, ${mib(summary.manifestTotals.htmlBytes)} HTML, ${mib(summary.manifestTotals.attachmentBytes)} attachments.`,
      "",
      "| Metric | Peak |",
      "| --- | --- |",
      `| RSS baseline | ${mib(baseline)} |`,
      `| RSS | ${mib(summary.peakRss)} |`,
      `| Processing budget high-water | ${mib(summary.processingMemory?.highWaterBytes ?? null)} |`,
      `| Largest item run alone | ${mib(summary.processingMemory?.largestAloneBytes ?? null)} |`,
      `| RSS above baseline | ${mib(summary.peakAboveBaseline)} |`,
      `| Heap used / total | ${mib(peakHeapUsed)} / ${mib(peakHeapTotal)} |`,
      `| External / array buffers | ${mib(peakExternal)} / ${mib(peakArrayBuffers)} |`,
      `| Main-thread tick gap | ${summary.longestEventLoopStallMs ?? "unavailable"} ms |`,
      "",
      `RSS peak at ${summary.peakAt ?? "unavailable"}; nearest state ${nearestPeakState ? new Date(nearestPeakState.at).toISOString() : "unavailable"}: ${nearestPeakState?.hydrating ?? "?"} hydrating, ${nearestPeakState?.extractionPending ?? "?"} extractions pending, ${nearestPeakState?.extractionRunning ?? "?"} running, ${nearestPeakState?.complete ?? "?"} messages complete.`,
      "",
      `API requests: ${requests}; readers with body/download coverage: ${apiCoverage.size}/${options.readers}; folder syncs: ${folderSyncs}.`,
      "",
      "Correctness (measured fixtures):",
      "",
      "```json",
      JSON.stringify(correctnessTotals, null, 2),
      "```",
      "",
      "Extraction statuses (including warm-up):",
      "",
      "```json",
      JSON.stringify(finalState?.extractions ?? null, null, 2),
      "```",
      "",
      "Options:",
      "",
      "```json",
      JSON.stringify(options, null, 2),
      "```",
      "",
      "The full manifest, failure codes, missing attachments and peak state are in summary.json; raw samples are in samples.ndjson.",
      "",
      ...summary.limits.map((limit) => `- ${limit}`),
      "",
      ...(errors.length ? ["Errors:", "", ...errors.map((error) => `- ${error}`), ""] : []),
    ].join("\n");
    await writeFile(join(out, "summary.md"), markdown, { flag: "wx" });
    console.log(`Summary: ${join(out, "summary.md")}`);
    if (options.json) {
      const { manifest: _manifest, correctness: _correctness, ...compact } = summary;
      console.log(JSON.stringify(compact));
    }
    if (errors.length) process.exitCode ||= 1;
  }
}
const stateSchema = z.object({
  at: z.number(),
  messages: z.array(z.object({ status: z.string(), error: z.string().nullable(), count: z.number() })),
  extractions: z.array(z.object({ status: z.string(), count: z.number() })),
  hydrating: z.number(),
  extractionPending: z.number(),
  extractionRunning: z.number(),
  complete: z.number(),
  failed: z.number(),
  pending: z.number(),
  retryable: z.number(),
  attachments: z.number(),
  extractionUnsettled: z.number(),
});
