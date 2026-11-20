import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { ENVELOPE_BATCH_SIZE } from "./contract";
import { callJmap, fetchJmapSession, JMAP_CORE, JMAP_JSON_BYTES, JMAP_MAIL, jmapBasicAuthorization, jmapIdSchema } from "./jmap-client";
import { readJmapMailboxDelta } from "./jmap-delta";
import type { JmapEmailSnapshot } from "./jmap-email";
import { type JmapScanPageStep, type JmapScanStep, readJmapAccountStart, readJmapEmailExistence, readJmapScanPage } from "./jmap-scan";
import { type JmapTransportDependencies, requestJmap } from "./jmap-transport";

// Assertions and request failures expose stages and error classes only, never server values.
function check(condition: unknown, label: string): asserts condition {
  ok(Boolean(condition), label);
}
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "non-error";
  const parts = [error.name];
  for (const key of ["code", "status", "problemType", "methodType", "cause"]) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}
async function stage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${label}: request failed (${describeFailure(error)})`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}

// All Stalwart suites share one account. This suite imports into its own fictional window in 2001
// (one day per process, one hour per test) and asserts only membership of its own ids.
const windowDay = Date.UTC(2001, 0, 1) + ((process.pid + Math.floor(Date.now() / 86_400_000)) % 365) * 86_400_000;
const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const uniqueId = () => `cloudtest-${process.pid}-${process.hrtime.bigint()}@example.invalid`;
const textSource = (messageId: string) =>
  [
    "From: Sender <sender@example.invalid>",
    "To: Reader <reader@example.invalid>",
    "Date: Mon, 15 Jan 2001 12:00:00 +0000",
    `Message-ID: <${messageId}>`,
    "Subject: Example scan",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Fictional text.",
    "",
  ].join("\r\n");
const setSchema = z.object({
  created: z.record(z.string(), z.object({ id: jmapIdSchema })).nullish(),
  destroyed: z.array(jmapIdSchema).nullish(),
  notDestroyed: z.record(jmapIdSchema, z.object({ type: z.string() })).nullish(),
});

suiteFor("jmap")("Mail account scan conformance against CI Stalwart", () => {
  const origin = "https://stalwart.example.invalid";
  let authorization: string;
  let dependencies: JmapTransportDependencies;

  beforeAll(() => {
    let target: URL;
    let username: string;
    let password: string;
    try {
      target = new URL(requireInfraUrl("jmap"));
      username = decodeURIComponent(target.username);
      password = decodeURIComponent(target.password);
    } catch {
      throw new Error("Setup: invalid JMAP infrastructure URL");
    }
    check(target.protocol === "http:" && target.hostname === "127.0.0.1", "Setup: expected CI HTTP loopback endpoint");
    check(username.length > 0 && password.length > 0, "Setup: credentials required");
    authorization = jmapBasicAuthorization(username, { kind: "password", password });
    const hostname = target.hostname;
    const port = Number(target.port || 80);
    // Only the socket destination changes; HTTPS and relative-URL validation stay real.
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
  });

  const fixture = async (label: string) => {
    const signal = AbortSignal.timeout(20_000);
    const session = await stage(`${label} Session`, () => fetchJmapSession({ origin, authorization, signal }, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, `${label} Session: primary mail account`);
    const emails = new Set<string>();
    const mailboxes = new Map<string, string | null>();
    const mailboxNames = new Set<string>();
    const imports: { messageId: string; count: number; complete: boolean }[] = [];
    const call = async (step: string, name: string, args: Record<string, unknown>, requestSignal = signal) => {
      // One method per request respects even maxCallsInRequest=1.
      const response = await stage(`${label} ${step}`, () =>
        callJmap(
          {
            session,
            authorization,
            signal: requestSignal,
            using: [JMAP_CORE, JMAP_MAIL],
            methodCalls: [[name, { accountId, ...args }, "conformance"]],
          },
          dependencies,
        ),
      );
      const result = response.methodResponses[0];
      check(
        response.methodResponses.length === 1 && result?.[0] === name && result[2] === "conformance",
        `${label} ${step}: method response`,
      );
      check(result[1].accountId === accountId, `${label} ${step}: account identity`);
      return result[1];
    };
    const set = async (kind: "Email" | "Mailbox", step: string, args: Record<string, unknown>, requestSignal = signal) =>
      parse(setSchema, await call(step, `${kind}/set`, args, requestSignal), `${label} ${step}`);
    const createMailbox = async (name = uniqueId(), parentId: string | null = null) => {
      mailboxNames.add(name); // Recover creates whose response is lost or malformed.
      const result = await set("Mailbox", "Create mailbox", { create: { fixture: { name, parentId } } });
      const created = result.created?.fixture;
      check(created, `${label} Create mailbox: acknowledged`);
      mailboxes.set(created.id, parentId);
      return created.id;
    };
    const destroyEmails = async (ids: string[], requestSignal = signal, cleanup = false) => {
      let succeeded = true;
      for (let offset = 0; offset < ids.length; offset += session.core.maxObjectsInSet) {
        const batch = ids.slice(offset, offset + session.core.maxObjectsInSet);
        try {
          const result = await set("Email", "Destroy emails", { destroy: batch }, requestSignal);
          for (const id of batch) {
            const removed = result.destroyed?.includes(id) || (cleanup && result.notDestroyed?.[id]?.type === "notFound");
            if (removed) emails.delete(id);
            else succeeded = false;
          }
        } catch {
          succeeded = false;
          if (!cleanup) break;
        }
      }
      check(succeeded, `${label} Destroy emails: every owned email deleted`);
    };
    const importEmails = async (mailboxId: string, receivedAt: string, count = 1) => {
      const messageId = uniqueId();
      const uploadUrl = new URL(session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId)));
      check(uploadUrl.origin === origin && !uploadUrl.username && !uploadUrl.password, `${label} Upload: same origin`);
      const factory = dependencies.request;
      check(factory, `${label} Upload: test request factory`);
      const upload = await stage(`${label} Upload`, () =>
        requestJmap(
          { url: uploadUrl, method: "POST", authorization, body: textSource(messageId), maxBytes: JMAP_JSON_BYTES, signal },
          {
            ...dependencies,
            request: (options, callback) =>
              factory({ ...options, headers: { ...options.headers, "content-type": "message/rfc822" } }, callback),
          },
        ),
      );
      check(upload.status >= 200 && upload.status < 300, `${label} Upload: HTTP success`);
      const json: unknown = await stage(`${label} Upload JSON`, async () => JSON.parse(upload.body));
      const blob = parse(z.object({ accountId: jmapIdSchema, blobId: jmapIdSchema }), json, `${label} Upload`);
      check(blob.accountId === accountId, `${label} Upload: account identity`);
      const entry = { messageId, count, complete: false };
      imports.push(entry);
      const ids: string[] = [];
      for (let offset = 0; offset < count; offset += session.core.maxObjectsInSet) {
        const batch = Array.from(
          { length: Math.min(count - offset, session.core.maxObjectsInSet) },
          (_, index) => `fixture${offset + index}`,
        );
        // One upload, repeated imports: measured to yield distinct ids (P8, gate 20.11.).
        const result = parse(
          setSchema,
          await call("Import", "Email/import", {
            emails: Object.fromEntries(batch.map((key) => [key, { blobId: blob.blobId, mailboxIds: { [mailboxId]: true }, receivedAt }])),
          }),
          `${label} Import`,
        );
        for (const key of batch) {
          const created = result.created?.[key];
          if (created) {
            emails.add(created.id);
            ids.push(created.id);
          }
        }
        check(
          batch.every((key) => result.created?.[key]),
          `${label} Import: every creation acknowledged`,
        );
      }
      entry.complete = true;
      check(ids.length === count && new Set(ids).size === count, `${label} Import: distinct email ids`);
      return ids;
    };
    return {
      pageSize: Math.min(ENVELOPE_BATCH_SIZE, session.core.maxObjectsInGet),
      call,
      createMailbox,
      importEmails,
      destroyEmails,
      page: (step: JmapScanPageStep) =>
        stage(`${label} Scan page ${step.kind}`, () => readJmapScanPage(session, authorization, accountId, step, signal, dependencies)),
      exists: (ids: string[]) =>
        stage(`${label} Existence`, () => readJmapEmailExistence(session, authorization, accountId, ids, signal, dependencies)),
      start: () => stage(`${label} Account start`, () => readJmapAccountStart(session, authorization, accountId, signal, dependencies)),
      mailboxDelta: (sinceState: string) =>
        stage(`${label} Mailbox delta`, () => readJmapMailboxDelta(session, authorization, accountId, sinceState, signal, dependencies)),
      cleanup: async () => {
        const cleanupSignal = AbortSignal.timeout(5_000);
        let succeeded = true;
        for (const entry of imports.filter((entry) => !entry.complete)) {
          try {
            let finished = false;
            let position = 0;
            const limit = session.core.maxObjectsInGet;
            // A unique Message-ID scopes recovery to this upload, including partial imports.
            for (let page = 0; page <= Math.ceil(entry.count / limit); page++) {
              const result = parse(
                z.object({ ids: z.array(jmapIdSchema) }),
                await call(
                  "Cleanup email inventory",
                  "Email/query",
                  { filter: { header: ["Message-ID", entry.messageId] }, position, limit },
                  cleanupSignal,
                ),
                `${label} Cleanup email inventory`,
              );
              for (const id of result.ids) emails.add(id);
              if (result.ids.length < limit) {
                finished = true;
                break;
              }
              position += result.ids.length;
            }
            check(finished, `${label} Cleanup email inventory: bounded recovery complete`);
          } catch {
            succeeded = false;
          }
        }
        try {
          await destroyEmails([...emails], cleanupSignal, true);
        } catch {
          succeeded = false;
        }
        if (mailboxNames.size) {
          try {
            const inventory = parse(
              z.object({ list: z.array(z.object({ id: jmapIdSchema, name: z.string(), parentId: jmapIdSchema.nullable() })) }),
              await call("Cleanup mailbox inventory", "Mailbox/get", { ids: null, properties: ["id", "name", "parentId"] }, cleanupSignal),
              `${label} Cleanup mailbox inventory`,
            );
            for (const box of inventory.list) {
              if (mailboxNames.has(box.name)) mailboxes.set(box.id, box.parentId);
            }
          } catch {
            succeeded = false;
          }
        }
        // Fixtures have at most two levels. Children first; never remove foreign
        // messages with onDestroyRemoveEmails, even when email cleanup failed.
        const childrenFirst = [...mailboxes].sort((a, b) => Number(b[1] !== null) - Number(a[1] !== null));
        for (const [id] of childrenFirst) {
          try {
            const result = await set("Mailbox", "Destroy mailbox", { destroy: [id] }, cleanupSignal);
            if (result.destroyed?.includes(id) || result.notDestroyed?.[id]?.type === "notFound") mailboxes.delete(id);
            else succeeded = false;
          } catch {
            succeeded = false;
          }
        }
        check(succeeded, `${label} Cleanup: all owned fixtures removed`);
      },
    };
  };
  const withFixtures = async (label: string, run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>) => {
    const context = await fixture(label);
    try {
      await run(context);
    } finally {
      await context.cleanup();
    }
  };

  test("1 Account start reads states and a folder snapshot with nested paths", async () => {
    await withFixtures("Account start", async (f) => {
      const parentName = uniqueId();
      const childName = uniqueId();
      const parent = await f.createMailbox(parentName);
      const child = await f.createMailbox(childName, parent);
      // Suites in one shard run one after another; tolerate a neighbor's change without looping forever.
      let start = await f.start();
      for (let attempt = 1; start.kind === "changed" && attempt < 3; attempt++) start = await f.start();
      check(start.kind === "ready", "Account start: ready");
      check(
        start.folders.some((folder) => folder.role === "inbox"),
        "Account start: Inbox present",
      );
      const own = start.folders.find((folder) => folder.mailboxId === child);
      check(own, "Account start: own mailbox present");
      check(own.path === `${parentName}/${childName}` && own.parentMailboxId === parent, "Account start: own mailbox path");
      const delta = await f.mailboxDelta(start.mailboxState);
      check(delta.oldState === start.mailboxState, "Account start: mailbox state accepted");
    });
  }, 30_000);

  test("2 Scan pages through distinct seconds and a same-second bucket", async () => {
    await withFixtures("Scan", async (f) => {
      const from = windowDay + 2 * 3_600_000;
      const mailbox = await f.createMailbox();
      const bucketSecond = utc(from + 5_000);
      // More than one page in a single second forces the bucket and a position > 0.
      const same = await f.importEmails(mailbox, bucketSecond, f.pageSize + 5);
      const distinct = [
        ...(await f.importEmails(mailbox, utc(from + 10_000))),
        ...(await f.importEmails(mailbox, utc(from + 20_000))),
        ...(await f.importEmails(mailbox, utc(from + 30_000))),
      ];
      const fractional = await f.importEmails(mailbox, new Date(from + 40_500).toISOString());
      const owned = new Set([...same, ...distinct, ...fractional]);
      // Unmeasured: whether Stalwart reports total for Email/query. Measure it directly first.
      const raw = await f.call("Total", "Email/query", {
        filter: { before: utc(from + 60_000), after: utc(from) },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 1,
        calculateTotal: true,
      });
      const totalReported = typeof raw.total === "number";
      let restarts = 0;
      let pages = 0;
      try {
        let step: JmapScanStep = { kind: "query", before: utc(from + 60_000) };
        const steps: JmapScanStep[] = [step];
        const seen = new Map<string, JmapEmailSnapshot>();
        let bucketReads: string[] = [];
        // 209 own messages need five pages with N=200; leave room for five restarts.
        while (step.kind !== "verify" && pages < 16) {
          pages++;
          const result = await f.page(step);
          if (result.kind === "restart") {
            check(++restarts <= 5, "Scan: restarts bounded");
            // Like the later commit, a restarted bucket is read again from position 0.
            if (step.kind === "bucket") for (const id of bucketReads) seen.delete(id);
            bucketReads = [];
          } else {
            const own = result.objects.filter((email) => owned.has(email.id));
            for (const email of own) {
              check(!seen.has(email.id), "Scan: own id returned once");
              seen.set(email.id, email);
            }
            const ids = own.map((email) => email.id);
            bucketReads = step.kind === "bucket" && result.next.kind === "bucket" ? [...bucketReads, ...ids] : [];
          }
          step = result.next;
          steps.push(step);
          const bound = step.kind === "query" ? step.before : step.kind === "bucket" ? step.second : null;
          if (bound !== null && Date.parse(bound) < from) break; // Left the own window: neighbors only.
        }
        check(step.kind === "verify" || [...owned].every((id) => seen.has(id)), "Scan: bounded traversal completed");
        check(seen.size === owned.size && [...owned].every((id) => seen.has(id)), "Scan: every own id exactly once");
        check(
          steps.some((entry) => entry.kind === "bucket" && entry.second === bucketSecond && entry.position > 0),
          "Scan: bucket paged by position",
        );
        check(
          steps.some((entry) => entry.kind === "query" && entry.before === bucketSecond),
          "Scan: continued before the bucket second",
        );
        check(
          same.every((id) => seen.get(id)?.receivedAt === bucketSecond),
          "Scan: bucket receivedAt preserved",
        );
        // Stalwart may drop the fraction on import; either way the message stays in its whole second.
        const fraction = fractional[0] ? seen.get(fractional[0]) : undefined;
        check(fraction && Math.floor(Date.parse(fraction.receivedAt) / 1_000) === (from + 40_000) / 1_000, "Scan: fraction in its second");
      } finally {
        console.info("JMAP_STALWART_SCAN", JSON.stringify({ restarts, pages, totalReported }));
      }
    });
  }, 30_000);

  test("3 Existence finds present ids and reports a deleted id as notFound", async () => {
    await withFixtures("Existence", async (f) => {
      const mailbox = await f.createMailbox();
      const [kept, deleted] = await f.importEmails(mailbox, utc(windowDay + 3 * 3_600_000), 2);
      check(kept && deleted, "Existence: two imports");
      await f.destroyEmails([deleted]);
      const result = await f.exists([kept, deleted]);
      check(result.foundIds.length === 1 && result.foundIds[0] === kept, "Existence: present id found");
      check(result.notFoundIds.length === 1 && result.notFoundIds[0] === deleted, "Existence: deleted id not found");
    });
  }, 30_000);
});
