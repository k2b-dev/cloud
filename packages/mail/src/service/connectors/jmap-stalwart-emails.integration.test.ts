import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { JMAP_EMAIL_RESPONSE_BYTES, readJmapEmails } from "./jmap";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  type JmapSession,
  jmapBasicAuthorization,
  jmapIdSchema,
} from "./jmap-client";
import {
  JMAP_EMAIL_BODY_PROPERTIES,
  JMAP_EMAIL_PROPERTIES,
  jmapEmailSnapshotSchema,
  mapJmapEmailSnapshot,
  mapJmapKeywords,
  mapJmapMimeStructure,
} from "./jmap-email";
import { type JmapTransportDependencies, requestJmap } from "./jmap-transport";

// Failures name stages, never response bodies, credentials or message contents.
function check(condition: unknown, label: string): asserts condition {
  ok(condition, label);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  check(isDeepStrictEqual(actual, expected), label);
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
    throw new Error(`${label}: request failed (${describeFailure(error)})`);
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}

const receivedAt = "2026-01-15T12:34:56Z";
const dateHeader = "Date: Thu, 15 Jan 2026 12:00:00 +0000";
const uniqueId = () => `cloudtest-${process.pid}-${process.hrtime.bigint()}@example.invalid`;
const textSource = (messageId: string) =>
  [
    "From: Sender <sender@example.invalid>",
    dateHeader,
    `Message-ID: <${messageId}>`,
    "Subject: Example",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Fictional text.",
    "",
  ].join("\r\n");
const setSchema = z.object({
  destroyed: z.array(jmapIdSchema).nullish(),
  notDestroyed: z.record(jmapIdSchema, z.object({ type: z.string() })).nullish(),
});
type Fixture = { source: string; header: [string, string]; keywords?: Record<string, true> };
type OwnedEmail = { header: [string, string]; id?: string };

suiteFor("jmap")("Mail email reading conformance against CI Stalwart", () => {
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
    // Only the socket destination changes; production resolves relative Session URLs.
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
  });

  const method = async (
    session: JmapSession,
    accountId: string,
    signal: AbortSignal,
    label: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const response = await stage(label, () =>
      callJmap(
        {
          session,
          authorization,
          signal,
          using: [JMAP_CORE, JMAP_MAIL],
          methodCalls: [[name, { accountId, ...args }, "conformance"]],
          maxBytes: JMAP_EMAIL_RESPONSE_BYTES,
        },
        dependencies,
      ),
    );
    const result = response.methodResponses[0];
    check(response.methodResponses.length === 1 && result?.[0] === name && result[2] === "conformance", `${label}: method response`);
    check(result[1].accountId === accountId, `${label}: account identity`);
    return result[1];
  };

  const withEmails = async (
    label: string,
    run: (context: {
      inboxId: string;
      create: (fixture: Fixture) => Promise<string>;
      read: (ids: string[]) => ReturnType<typeof readJmapEmails>;
      destroy: (ids: string[]) => Promise<void>;
    }) => Promise<void>,
  ) => {
    // Leave time for a separate diagnostic read and cleanup before the test's deadline.
    const signal = AbortSignal.timeout(15_000);
    const session = await stage(`${label} Session`, () => fetchJmapSession({ origin, authorization, signal }, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, `${label} Session: primary mail account`);
    const call = (step: string, name: string, args: Record<string, unknown>, requestSignal = signal) =>
      method(session, accountId, requestSignal, `${label} ${step}`, name, args);
    const boxes = parse(
      z.object({ list: z.array(z.object({ id: jmapIdSchema, role: z.string().nullable() })) }),
      await call("Inbox", "Mailbox/get", { properties: ["id", "role"] }),
      `${label} Inbox`,
    );
    const inbox = boxes.list.find((box) => box.role === "inbox");
    check(inbox, `${label} Inbox: present`);
    const owned: OwnedEmail[] = [];
    const destroy = async (ids: string[], requestSignal = signal, cleanup = false) => {
      const result = parse(setSchema, await call("Destroy", "Email/set", { destroy: ids }, requestSignal), `${label} Destroy`);
      check(
        ids.every((id) => result.destroyed?.includes(id) || (cleanup && result.notDestroyed?.[id]?.type === "notFound")),
        `${label} Destroy: every owned email deleted`,
      );
    };
    try {
      await run({
        inboxId: inbox.id,
        create: async ({ source, header, keywords = {} }) => {
          const uploadUrl = new URL(session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId)));
          check(uploadUrl.origin === origin && !uploadUrl.username && !uploadUrl.password, `${label} Upload: same origin`);
          const factory = dependencies.request;
          check(factory, `${label} Upload: test request factory`);
          const upload = await stage(`${label} Upload`, () =>
            requestJmap(
              { url: uploadUrl, method: "POST", authorization, body: source, maxBytes: JMAP_JSON_BYTES, signal },
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
          const entry: OwnedEmail = { header };
          owned.push(entry); // Also recover an import whose response was lost or malformed.
          const imported = await call("Import", "Email/import", {
            emails: { fixture: { blobId: blob.blobId, mailboxIds: { [inbox.id]: true }, keywords, receivedAt } },
          });
          const created = parse(z.object({ created: z.object({ fixture: z.object({ id: jmapIdSchema }) }) }), imported, `${label} Import`);
          entry.id = created.created.fixture.id;
          return entry.id;
        },
        read: async (ids) => {
          try {
            return await readJmapEmails(session, authorization, accountId, ids, signal, dependencies);
          } catch (error) {
            let diagnostic: string;
            try {
              const raw = await call(
                "Schema diagnostic",
                "Email/get",
                { ids, properties: JMAP_EMAIL_PROPERTIES, bodyProperties: JMAP_EMAIL_BODY_PROPERTIES },
                AbortSignal.timeout(5_000),
              );
              const list = parse(z.array(z.unknown()), raw.list, `${label} Schema diagnostic`);
              const issues = list.flatMap((value, index) => {
                const parsed = jmapEmailSnapshotSchema.safeParse(value);
                return parsed.success
                  ? []
                  : parsed.error.issues.map((issue) => ({ path: ["list", index, ...issue.path], code: issue.code }));
              });
              // No Zod messages, inputs or server values: only field paths and codes.
              diagnostic = issues.length ? JSON.stringify(issues) : "snapshot schema accepted; inspect Email/get envelope or transport";
            } catch {
              diagnostic = "raw Email/get unavailable";
            }
            throw new Error(`${label} Read: ${describeFailure(error)}; schema diagnostic: ${diagnostic}`);
          }
        },
        destroy: async (ids) => {
          await destroy(ids);
          for (const id of ids) {
            const index = owned.findIndex((entry) => entry.id === id);
            if (index !== -1) owned.splice(index, 1);
          }
        },
      });
    } finally {
      const cleanupSignal = AbortSignal.timeout(5_000);
      const ids = new Set(owned.flatMap((entry) => (entry.id ? [entry.id] : [])));
      let recovered = true;
      for (const entry of owned.filter((email) => !email.id)) {
        try {
          // Sparse mail has no Message-ID; its unique From serves the same purpose.
          const result = parse(
            z.object({ ids: z.array(jmapIdSchema) }),
            await call("Cleanup inventory", "Email/query", { filter: { header: entry.header } }, cleanupSignal),
            `${label} Cleanup inventory`,
          );
          for (const id of result.ids) ids.add(id);
        } catch {
          recovered = false;
        }
      }
      if (ids.size) await destroy([...ids], cleanupSignal, true);
      check(recovered, `${label} Cleanup: every import with a missing response recovered`);
    }
  };

  const one = (result: Awaited<ReturnType<typeof readJmapEmails>>, id: string, label: string) => {
    equal(result.notFoundIds, [], `${label} Read: no missing ids`);
    check(result.objects.length === 1 && result.objects[0]?.id === id, `${label} Read: exactly the imported email`);
    return result.objects[0];
  };

  test("reads a text email and maps addresses, headers and provider metadata", async () => {
    await withEmails("Text", async ({ create, read, inboxId }) => {
      const messageId = uniqueId();
      const parentId = uniqueId();
      const rootId = uniqueId();
      const source = [
        "From: Sender Name <SENDER@EXAMPLE.INVALID>",
        "To: Reader Name <READER@EXAMPLE.INVALID>",
        "Cc: Copy Name <COPY@EXAMPLE.INVALID>",
        "Bcc: Hidden Name <HIDDEN@EXAMPLE.INVALID>",
        "Reply-To: Reply Name <REPLY@EXAMPLE.INVALID>",
        "Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=",
        dateHeader,
        `Message-ID: <${messageId}>`,
        `In-Reply-To: <${parentId}>`,
        `References: <${rootId}> <${parentId}>`,
        "Auto-Submitted: auto-generated",
        "List-Id: Example <list.example.invalid>",
        "List-Unsubscribe: <https://example.invalid/unsubscribe>, <mailto:unsubscribe@example.invalid>",
        "Precedence: bulk",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Fictional text.",
        "",
      ].join("\r\n");
      const id = await create({ source, header: ["Message-ID", messageId] });
      const email = one(await read([id]), id, "Text");
      const mapped = mapJmapEmailSnapshot(email);
      const envelope = mapped.envelope;
      equal(
        envelope.addresses,
        {
          from: [{ name: "Sender Name", address: "sender@example.invalid" }],
          to: [{ name: "Reader Name", address: "reader@example.invalid" }],
          cc: [{ name: "Copy Name", address: "copy@example.invalid" }],
          bcc: [{ name: "Hidden Name", address: "hidden@example.invalid" }],
          replyTo: [{ name: "Reply Name", address: "reply@example.invalid" }],
        },
        "Text Map: lowercase addresses and preserved names in all roles",
      );
      equal(envelope.subject, "Grüße", "Text Map: RFC 2047 subject");
      equal(envelope.messageId, `<${messageId}>`, "Text Map: bracketed Message-ID");
      equal(envelope.inReplyTo, `<${parentId}>`, "Text Map: bracketed In-Reply-To");
      equal(envelope.references, [`<${rootId}>`, `<${parentId}>`], "Text Map: ordered bracketed References");
      equal(envelope.internalDate, new Date(receivedAt), "Text Map: imported receivedAt");
      equal(envelope.sentAt, new Date("2026-01-15T12:00:00Z"), "Text Map: parsed Date header");
      equal(envelope.sizeBytes, Buffer.byteLength(source, "utf8"), "Text Map: complete source byte length");
      check(jmapIdSchema.safeParse(envelope.providerThreadId).success, "Text Map: provider thread id set");
      equal(envelope.providerThreadId, email.threadId, "Text Map: provider thread identity");
      equal(envelope.providerMessageId, null, "Text Map: no IMAP provider message id");
      equal(mapped.emailId, id, "Text Map: email identity");
      equal(mapped.mailboxIds, [inboxId], "Text Map: only Inbox membership");
      check(envelope.protocolFacts, "Text Map: protocol facts present");
      equal(envelope.protocolFacts.autoSubmitted, "auto-generated", "Text Map: trimmed Auto-Submitted");
      equal(envelope.protocolFacts.precedence, "bulk", "Text Map: Precedence");
      equal(envelope.protocolFacts.list.id, "Example <list.example.invalid>", "Text Map: List-Id");
      equal(
        envelope.protocolFacts.list.unsubscribe,
        ["https://example.invalid/unsubscribe", "mailto:unsubscribe@example.invalid"],
        "Text Map: List-Unsubscribe URLs",
      );
      equal(envelope.protocolFacts.contentType, "text/plain; charset=utf-8", "Text Map: Content-Type");
    });
  }, 30_000);

  test("maps imported flags and labels alongside server attachment keywords", async () => {
    await withEmails("Keywords", async ({ create, read }) => {
      const messageId = uniqueId();
      const id = await create({
        source: textSource(messageId),
        header: ["Message-ID", messageId],
        keywords: { $seen: true, $flagged: true, cloudtest: true },
      });
      const email = one(await read([id]), id, "Keywords");
      const keywords = mapJmapKeywords(email.keywords);
      equal(keywords.flags, ["\\Flagged", "\\Seen"], "Keywords Map: system flags");
      check(keywords.labels.includes("cloudtest"), "Keywords Map: custom label");
      check(
        email.keywords.$hasnoattachment === true || email.keywords.$hasattachment === true,
        "Keywords Read: measured server attachment keyword",
      );
      for (const keyword of ["$hasnoattachment", "$hasattachment"]) {
        if (email.keywords[keyword]) check(keywords.labels.includes(keyword), "Keywords Map: server keyword preserved");
      }
      equal(keywords.skippedKeywordCount, 0, "Keywords Map: no rejected keyword");
      const mapped = mapJmapEmailSnapshot(email);
      equal(mapped.envelope.flags, keywords.flags, "Keywords Envelope: flags");
      equal(mapped.envelope.labels, keywords.labels, "Keywords Envelope: labels");
    });
  }, 30_000);

  test("reads nested multipart structure with a named attachment", async () => {
    await withEmails("Multipart", async ({ create, read }) => {
      const messageId = uniqueId();
      const source = [
        "From: Sender <sender@example.invalid>",
        dateHeader,
        `Message-ID: <${messageId}>`,
        "Subject: Example attachment",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="cloud-mixed"',
        "",
        "--cloud-mixed",
        'Content-Type: multipart/alternative; boundary="cloud-alternative"',
        "",
        "--cloud-alternative",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Fictional text.",
        "--cloud-alternative",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Fictional text.</p>",
        "--cloud-alternative--",
        "--cloud-mixed",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="example.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        "RXhhbXBsZQo=",
        "--cloud-mixed--",
        "",
      ].join("\r\n");
      const id = await create({ source, header: ["Message-ID", messageId] });
      const email = one(await read([id]), id, "Multipart");
      const mime = parse(
        z.object({
          type: z.literal("multipart/mixed"),
          childNodes: z.tuple([
            z.object({
              type: z.literal("multipart/alternative"),
              childNodes: z.tuple([
                z.object({ type: z.literal("text/plain") }),
                z.object({ type: z.literal("text/html"), size: z.null() }),
              ]),
            }),
            z.object({
              type: z.literal("application/octet-stream"),
              parameters: z.object({ name: z.literal("example.txt") }),
              disposition: z.literal("attachment"),
            }),
          ]),
        }),
        mapJmapMimeStructure(email.bodyStructure),
        "Multipart MIME: tree, attachment filename and unknown HTML size",
      );
      equal(mime.childNodes[0].childNodes[1].size, null, "Multipart MIME: HTML size is not an encoded byte budget");
      const mapped = mapJmapEmailSnapshot(email);
      equal(mapped.envelope.mimeStructure, mapJmapMimeStructure(email.bodyStructure), "Multipart Map: MIME tree preserved");
      check(mapped.hasAttachment, "Multipart Map: attachment present");
    });
  }, 30_000);

  test("reads a sparse email without subject, message id or recipients", async () => {
    await withEmails("Sparse", async ({ create, read }) => {
      const sender = uniqueId();
      const source = [`From: Sender <${sender}>`, dateHeader, "", "Fictional text.", ""].join("\r\n");
      const id = await create({ source, header: ["From", sender] });
      const email = one(await read([id]), id, "Sparse");
      const { envelope } = mapJmapEmailSnapshot(email);
      equal(envelope.subject, "", "Sparse Map: empty subject");
      equal(envelope.messageId, null, "Sparse Map: absent Message-ID");
      equal(envelope.inReplyTo, null, "Sparse Map: absent In-Reply-To");
      equal(envelope.references, [], "Sparse Map: absent References");
      for (const role of ["to", "cc", "bcc", "replyTo"] as const) equal(envelope.addresses[role], [], `Sparse Map: empty ${role}`);
      equal(envelope.addresses.from, [{ name: "Sender", address: sender }], "Sparse Map: From retained");
    });
  }, 30_000);

  test("returns a destroyed id in notFound alongside an existing email", async () => {
    await withEmails("NotFound", async ({ create, read, destroy }) => {
      const existingMessageId = uniqueId();
      const deletedMessageId = uniqueId();
      const existing = await create({ source: textSource(existingMessageId), header: ["Message-ID", existingMessageId] });
      const deleted = await create({ source: textSource(deletedMessageId), header: ["Message-ID", deletedMessageId] });
      await destroy([deleted]);
      const result = await read([deleted, existing]);
      equal(result.notFoundIds, [deleted], "NotFound Read: destroyed id reported");
      equal(
        result.objects.map((email) => email.id),
        [existing],
        "NotFound Read: existing email retained",
      );
      const email = result.objects[0];
      check(email, "NotFound Map: existing email present");
      equal(mapJmapEmailSnapshot(email).envelope.messageId, `<${existingMessageId}>`, "NotFound Map: existing message identity");
    });
  }, 30_000);

  test("reads three emails in one call with each id exactly once", async () => {
    await withEmails("Multiple", async ({ create, read }) => {
      const expected = new Map<string, string>();
      for (let index = 0; index < 3; index++) {
        const messageId = uniqueId();
        const id = await create({ source: textSource(messageId), header: ["Message-ID", messageId] });
        check(!expected.has(id), "Multiple Import: distinct email ids");
        expected.set(id, `<${messageId}>`);
      }
      const result = await read([...expected.keys()]);
      equal(result.notFoundIds, [], "Multiple Read: no missing ids");
      equal(result.objects.map((email) => email.id).sort(), [...expected.keys()].sort(), "Multiple Read: exactly three ids, once each");
      for (const email of result.objects)
        equal(mapJmapEmailSnapshot(email).envelope.messageId, expected.get(email.id), "Multiple Map: content belongs to its id");
    });
  }, 30_000);
});
