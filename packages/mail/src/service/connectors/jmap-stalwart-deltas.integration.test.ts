import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { callJmap, fetchJmapSession, JMAP_CORE, JMAP_JSON_BYTES, JMAP_MAIL, jmapBasicAuthorization, jmapIdSchema } from "./jmap-client";
import { JmapReconciliationRequiredError, readJmapEmailDelta, readJmapMailboxDelta } from "./jmap-delta";
import { jmapStateSchema } from "./jmap-sync-state";
import { type JmapTransportDependencies, requestJmap } from "./jmap-transport";

// Assertions and request failures expose stages only, never server values.
function check(condition: unknown, label: string): asserts condition {
  ok(Boolean(condition), label);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  check(isDeepStrictEqual(actual, expected), label);
}
async function stage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(`${label}: request failed`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}

const receivedAt = "2026-01-15T12:34:56Z";
const uniqueId = () => `cloudtest-${process.pid}-${process.hrtime.bigint()}@example.invalid`;
const textSource = (messageId: string) =>
  [
    "From: Sender <sender@example.invalid>",
    "To: Reader <reader@example.invalid>",
    "Date: Thu, 15 Jan 2026 12:00:00 +0000",
    `Message-ID: <${messageId}>`,
    "Subject: Example delta",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Fictional text.",
    "",
  ].join("\r\n");
const setSchema = z.object({
  created: z.record(z.string(), z.object({ id: jmapIdSchema })).nullish(),
  updated: z.record(jmapIdSchema, z.unknown()).nullish(),
  destroyed: z.array(jmapIdSchema).nullish(),
  notDestroyed: z.record(jmapIdSchema, z.object({ type: z.string() })).nullish(),
});
const mailboxInventorySchema = z.object({
  list: z.array(z.object({ id: jmapIdSchema, name: z.string(), parentId: jmapIdSchema.nullable() })),
});

suiteFor("jmap")("Mail delta conformance against CI Stalwart", () => {
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
      // One method per request respects even maxCallsInRequest=1. Object writes
      // below are batched separately by the Session's maxObjectsInSet.
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
    const state = async (kind: "Email" | "Mailbox") => {
      const result = parse(
        z.object({ state: jmapStateSchema, list: z.array(z.unknown()), notFound: z.array(jmapIdSchema) }),
        await call(`${kind} start state`, `${kind}/get`, { ids: [], properties: ["id"] }),
        `${label} Start state`,
      );
      check(result.list.length === 0 && result.notFound.length === 0, `${label} Start state: empty get`);
      return result.state;
    };
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
    const destroyMailbox = async (id: string, requestSignal = signal, cleanup = false) => {
      const result = await set("Mailbox", "Destroy mailbox", { destroy: [id] }, requestSignal);
      check(
        result.destroyed?.includes(id) || (cleanup && result.notDestroyed?.[id]?.type === "notFound"),
        `${label} Destroy mailbox: acknowledged`,
      );
      mailboxes.delete(id);
    };
    const importEmails = async (mailboxId: string, count = 1, keywords: Record<string, true> = {}) => {
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
        const result = parse(
          setSchema,
          await call("Import", "Email/import", {
            emails: Object.fromEntries(
              batch.map((key) => [key, { blobId: blob.blobId, mailboxIds: { [mailboxId]: true }, keywords, receivedAt }]),
            ),
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
      maxChanges: Math.min(200, session.core.maxObjectsInGet),
      state,
      createMailbox,
      importEmails,
      destroyEmails,
      destroyMailbox,
      emailDelta: (sinceState: string) =>
        stage(`${label} Email delta`, () => readJmapEmailDelta(session, authorization, accountId, sinceState, signal, dependencies)),
      mailboxDelta: (sinceState: string) =>
        stage(`${label} Mailbox delta`, () => readJmapMailboxDelta(session, authorization, accountId, sinceState, signal, dependencies)),
      updateEmail: async (id: string, patch: Record<string, unknown>) => {
        const result = await set("Email", "Update email", { update: { [id]: patch } });
        check(result.updated && Object.hasOwn(result.updated, id), `${label} Update email: acknowledged`);
      },
      renameMailbox: async (id: string, name: string) => {
        mailboxNames.add(name);
        const result = await set("Mailbox", "Rename mailbox", { update: { [id]: { name } } });
        check(result.updated && Object.hasOwn(result.updated, id), `${label} Rename mailbox: acknowledged`);
      },
      inbox: async () => {
        const boxes = parse(
          z.object({ list: z.array(z.object({ id: jmapIdSchema, role: z.string().nullable() })) }),
          await call("Inbox", "Mailbox/get", { properties: ["id", "role"] }),
          `${label} Inbox`,
        );
        const inbox = boxes.list.find((box) => box.role === "inbox");
        check(inbox, `${label} Inbox: present`);
        return inbox.id;
      },
      rejectedState: async (kind: "Email" | "Mailbox") => {
        // States are opaque Strings (RFC 8620 §5.2), not server-encoded integers.
        // This is valid input to the reader, but was never issued by Stalwart.
        const unknownState = `unknown-${uniqueId()}`;
        check(jmapStateSchema.safeParse(unknownState).success, `${label} Rejected state: valid input`);
        let failure: unknown;
        try {
          const read = kind === "Email" ? readJmapEmailDelta : readJmapMailboxDelta;
          await read(session, authorization, accountId, unknownState, signal, dependencies);
        } catch (error) {
          failure = error;
        }
        check(failure instanceof JmapReconciliationRequiredError, `${label} Rejected state: reconciliation required`);
        check(failure.cause === "state_rejected" || failure.cause === "cannot_calculate", `${label} Rejected state: known cause`);
      },
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
              mailboxInventorySchema,
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
            await destroyMailbox(id, cleanupSignal, true);
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
  const firstId = (ids: string[]) => {
    const id = ids[0];
    check(id, "Import: first email present");
    return id;
  };
  const emailObject = (delta: Awaited<ReturnType<typeof readJmapEmailDelta>>, id: string) => {
    const object = delta.objects.find((email) => email.id === id);
    check(object, "Email delta: owned object present");
    check(!delta.notFoundIds.includes(id), "Email delta: owned object not missing");
    return object;
  };

  // run-tests.ts awaits each file in a shard; CI shards have separate Stalwarts.
  // Still tolerate other suites' records: assert only membership of owned ids,
  // never an empty account delta or exact account-wide change lists.
  test("1 Email start state from an empty get is accepted", async () => {
    await withFixtures("Email start", async (f) => {
      const state = await f.state("Email");
      equal((await f.emailDelta(state)).oldState, state, "Email start: oldState echoes get state");
    });
  }, 30_000);

  test("2 Email creation returns metadata and is not repeated", async () => {
    await withFixtures("Email created", async (f) => {
      const mailbox = await f.createMailbox();
      const state = await f.state("Email");
      const keywords = { $flagged: true, cloudtest: true } as const;
      const id = firstId(await f.importEmails(mailbox, 1, keywords));
      const delta = await f.emailDelta(state);
      check(delta.createdIds.includes(id), "Email created: own id included");
      equal(delta.oldState, state, "Email created: oldState");
      check(delta.newState !== delta.oldState, "Email created: state advanced");
      const object = emailObject(delta, id);
      equal(object.mailboxIds, { [mailbox]: true }, "Email created: mailbox membership");
      equal(object.receivedAt, receivedAt, "Email created: receivedAt preserved");
      // Stalwart 1.0.0 adds $hasnoattachment (driver experiment, observation 6).
      check(
        Object.keys(keywords).every((key) => object.keywords[key] === true),
        "Email created: keyword subset preserved",
      );
      const next = await f.emailDelta(delta.newState);
      equal(next.oldState, delta.newState, "Email created: next checkpoint accepted");
      check(
        ![...next.createdIds, ...next.updatedIds, ...next.destroyedIds, ...next.notFoundIds].includes(id) &&
          !next.objects.some((email) => email.id === id),
        "Email created: own id not repeated",
      );
    });
  }, 30_000);

  test("3 Email keyword and mailbox updates return updated objects", async () => {
    await withFixtures("Email updated", async (f) => {
      const source = await f.createMailbox();
      const destination = await f.createMailbox();
      const id = firstId(await f.importEmails(source));
      const state = await f.state("Email");
      await f.updateEmail(id, { "keywords/$seen": true });
      const seen = await f.emailDelta(state);
      check(seen.updatedIds.includes(id), "Email updated: seen id included");
      check(emailObject(seen, id).keywords.$seen === true, "Email updated: seen keyword");
      await f.updateEmail(id, { mailboxIds: { [destination]: true } });
      const moved = await f.emailDelta(seen.newState);
      check(moved.updatedIds.includes(id), "Email updated: moved id included");
      equal(emailObject(moved, id).mailboxIds, { [destination]: true }, "Email updated: new mailbox membership");
    });
  }, 30_000);

  test("4 Email destruction returns the id without an object", async () => {
    await withFixtures("Email destroyed", async (f) => {
      const id = firstId(await f.importEmails(await f.createMailbox()));
      const state = await f.state("Email");
      await f.destroyEmails([id]);
      const delta = await f.emailDelta(state);
      check(delta.destroyedIds.includes(id), "Email destroyed: own id included");
      check(!delta.objects.some((email) => email.id === id), "Email destroyed: no object");
    });
  }, 30_000);

  test("5 Email creation followed by destruction coalesces safely", async () => {
    await withFixtures("Email coalesced", async (f) => {
      const mailbox = await f.createMailbox();
      const state = await f.state("Email");
      const id = firstId(await f.importEmails(mailbox));
      await f.destroyEmails([id]);
      const delta = await f.emailDelta(state);
      // Measured on Stalwart 1.0.0: omitted entirely (driver experiment,
      // observation 5). Destroyed-only is also accepted, per RFC 8620 §5.2.
      check(!delta.createdIds.includes(id) && !delta.updatedIds.includes(id), "Email coalesced: absent or destroyed only");
      check(!delta.notFoundIds.includes(id) && !delta.objects.some((email) => email.id === id), "Email coalesced: no fetched object");
    });
  }, 30_000);

  test("6 Email pages accept intermediate states and cover every import once", async () => {
    await withFixtures("Email pages", async (f) => {
      const mailbox = await f.createMailbox();
      let state = await f.state("Email");
      // One upload, repeated imports: measured to yield distinct ids (P8).
      const owned = new Set(await f.importEmails(mailbox, f.maxChanges + 5));
      const seen = new Set<string>();
      let finished = false;
      // At most 205 own creations; 256 pages leave room for neighbors even
      // if the server returns just one own change per page, without an endless loop.
      for (let page = 0; page < 256; page++) {
        const delta = await f.emailDelta(state);
        equal(delta.oldState, state, "Email pages: intermediate checkpoint accepted");
        if (page === 0) check(delta.hasMoreChanges, "Email pages: first page has more changes");
        const ids = [...delta.createdIds, ...delta.updatedIds, ...delta.destroyedIds];
        check(ids.length <= f.maxChanges, "Email pages: total page size bounded");
        for (const id of ids.filter((id) => owned.has(id))) {
          check(!seen.has(id), "Email pages: no own id repeated");
          check(delta.createdIds.includes(id), "Email pages: own id classified as created");
          emailObject(delta, id);
          check(delta.objects.filter((email) => email.id === id).length === 1, "Email pages: exactly one own object");
          seen.add(id);
        }
        state = delta.newState;
        if (!delta.hasMoreChanges) {
          finished = true;
          break;
        }
      }
      check(finished, "Email pages: bounded traversal completed");
      check(seen.size === owned.size && [...owned].every((id) => seen.has(id)), "Email pages: all own imports covered exactly once");
      await f.destroyEmails([...owned]);
    });
  }, 30_000);

  test("7 Email unknown state requires reconciliation", async () => {
    await withFixtures("Email rejected", async (f) => f.rejectedState("Email"));
  }, 30_000);

  test("8 Mailbox start state from an empty get is accepted", async () => {
    await withFixtures("Mailbox start", async (f) => {
      const state = await f.state("Mailbox");
      equal((await f.mailboxDelta(state)).oldState, state, "Mailbox start: oldState echoes get state");
    });
  }, 30_000);

  test("9 Mailbox creation resolves nested paths with and without a changed parent", async () => {
    await withFixtures("Mailbox hierarchy", async (f) => {
      const state = await f.state("Mailbox");
      const parentName = uniqueId();
      const childName = uniqueId();
      const parent = await f.createMailbox(parentName);
      const parentState = await f.state("Mailbox");
      const child = await f.createMailbox(childName, parent);
      const together = await f.mailboxDelta(state);
      check(
        together.created.some((box) => box.mailboxId === parent && box.path === parentName),
        "Mailbox hierarchy: created parent",
      );
      const childOnly = await f.mailboxDelta(parentState);
      for (const delta of [together, childOnly]) {
        const box = delta.created.find((entry) => entry.mailboxId === child);
        check(box, "Mailbox hierarchy: created child");
        equal(box.path, `${parentName}/${childName}`, "Mailbox hierarchy: nested path");
        equal(box.parentMailboxId, parent, "Mailbox hierarchy: parent identity");
        equal(box.parentPath, parentName, "Mailbox hierarchy: parent path");
      }
      check(
        !childOnly.created.some((box) => box.mailboxId === parent) && !childOnly.updated.some((box) => box.mailboxId === parent),
        "Mailbox hierarchy: unchanged parent resolved without appearing in delta",
      );
    });
  }, 30_000);

  test("10 Mailbox rename returns the updated name", async () => {
    await withFixtures("Mailbox renamed", async (f) => {
      const id = await f.createMailbox();
      const state = await f.state("Mailbox");
      const name = uniqueId();
      await f.renameMailbox(id, name);
      const box = (await f.mailboxDelta(state)).updated.find((entry) => entry.mailboxId === id);
      check(box, "Mailbox renamed: own id updated");
      equal(box.name, name, "Mailbox renamed: new name");
    });
  }, 30_000);

  test("11 Mailbox destruction returns the owned id", async () => {
    await withFixtures("Mailbox destroyed", async (f) => {
      const id = await f.createMailbox();
      const state = await f.state("Mailbox");
      await f.destroyMailbox(id);
      check((await f.mailboxDelta(state)).destroyedIds.includes(id), "Mailbox destroyed: own id included");
    });
  }, 30_000);

  test("12 Mailbox counter-only changes omit the Inbox from updated", async () => {
    await withFixtures("Mailbox counters", async (f) => {
      const inbox = await f.inbox();
      const state = await f.state("Mailbox");
      await f.importEmails(inbox);
      const delta = await f.mailboxDelta(state);
      console.info(
        "JMAP_STALWART_MAILBOX_COUNTERS",
        JSON.stringify({ stateChanged: delta.newState !== state, updated: delta.updated.length, created: delta.created.length }),
      );
      // Unmeasured Stalwart assumption: RFC 8621 §2.2 permits null, but this
      // optimization requires counter-only updatedProperties. Deliberately hard-fail.
      check(!delta.updated.some((box) => box.mailboxId === inbox), "Mailbox counters: Inbox is not a structural update");
    });
  }, 30_000);

  test("13 Mailbox unknown state requires reconciliation", async () => {
    await withFixtures("Mailbox rejected", async (f) => f.rejectedState("Mailbox"));
  }, 30_000);
});
