import { beforeAll, test } from "bun:test";
import { ok } from "node:assert/strict";
import { request } from "node:http";
import { z } from "zod";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { downloadJmapEmailSource, readJmapEmailBlobs } from "./jmap";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_JSON_BYTES,
  JMAP_MAIL,
  jmapBasicAuthorization,
  jmapIdSchema,
  requireJmapMethodResult,
} from "./jmap-client";
import { type JmapTransportDependencies, JmapTransportError, requestJmap } from "./jmap-transport";

function check(condition: unknown, label: string): asserts condition {
  ok(condition, label);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: response shape`);
  return result.data;
}
async function stage<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(`${label}: failed`);
  }
}
const receivedAt = "2026-01-15T12:34:56Z";
const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const sourceFor = (messageId: string, attachment: boolean) =>
  [
    "From: Sender <sender@example.invalid>",
    "Date: Thu, 15 Jan 2026 12:00:00 +0000",
    `Message-ID: <${messageId}>`,
    "Subject: Source conformance",
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

suiteFor("jmap")("Mail source downloads against CI Stalwart", () => {
  const origin = "https://stalwart.example.invalid";
  let authorization: string;
  let dependencies: JmapTransportDependencies;
  beforeAll(() => {
    let target: URL;
    try {
      target = new URL(requireInfraUrl("jmap"));
    } catch {
      throw new Error("Setup: invalid JMAP infrastructure URL");
    }
    check(target.protocol === "http:" && target.hostname === "127.0.0.1", "Setup: expected CI HTTP loopback endpoint");
    const username = decodeURIComponent(target.username);
    const password = decodeURIComponent(target.password);
    check(username.length > 0 && password.length > 0, "Setup: credentials required");
    authorization = jmapBasicAuthorization(username, { kind: "password", password });
    const hostname = target.hostname;
    const port = Number(target.port || 80);
    dependencies = {
      resolveEndpoint: async (endpoint) => ({ ...endpoint, addresses: [{ address: hostname, family: 4 }] }),
      request: (options, callback) => request({ ...options, protocol: "http:", hostname, port, agent: false }, callback),
    };
  });

  test("downloads text and binary attachment sources byte-for-byte, missing emails and unknown blobs", async () => {
    const signal = AbortSignal.timeout(15_000);
    const session = await stage("Session", () => fetchJmapSession({ origin, authorization, signal }, dependencies));
    const accountId = session.primaryAccounts[JMAP_MAIL];
    check(accountId, "Session: primary mail account");
    const call = async (name: string, args: Record<string, unknown>, requestSignal = signal) => {
      const response = await stage(name, () =>
        callJmap(
          {
            session,
            authorization,
            signal: requestSignal,
            using: [JMAP_CORE, JMAP_MAIL],
            methodCalls: [[name, { accountId, ...args }, "blobs"]],
          },
          dependencies,
        ),
      );
      const result = requireJmapMethodResult(response, "blobs", name);
      check(result.accountId === accountId, `${name}: account identity`);
      return result;
    };
    const boxes = parse(
      z.object({ list: z.array(z.object({ id: jmapIdSchema, role: z.string().nullable() })) }),
      await call("Mailbox/get", { properties: ["id", "role"] }),
      "Inbox",
    );
    const inbox = boxes.list.find((box) => box.role === "inbox");
    check(inbox, "Inbox: present");
    const owned: Array<{ messageId: string; id?: string }> = [];
    const destroy = async (ids: string[], requestSignal = signal, cleanup = false) => {
      const result = parse(
        z.object({
          destroyed: z.array(jmapIdSchema).nullish(),
          notDestroyed: z.record(jmapIdSchema, z.object({ type: z.string() })).nullish(),
        }),
        await call("Email/set", { destroy: ids }, requestSignal),
        "Destroy",
      );
      check(
        ids.every((id) => result.destroyed?.includes(id) || (cleanup && result.notDestroyed?.[id]?.type === "notFound")),
        "Destroy: every owned email deleted",
      );
    };
    try {
      let unknownBlob: string | undefined;
      for (const attachment of [false, true]) {
        // Fixed dates/content; PID separates simultaneous test processes without random fixtures.
        const messageId = `cloud-blob-${process.pid}-${attachment ? "binary" : "text"}@example.invalid`;
        const source = sourceFor(messageId, attachment);
        const uploadUrl = new URL(session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId)));
        check(uploadUrl.origin === origin && !uploadUrl.username && !uploadUrl.password, "Upload: same origin");
        const factory = dependencies.request;
        check(factory, "Upload: test request factory");
        const upload = await stage("Upload", () =>
          requestJmap(
            { url: uploadUrl, method: "POST", authorization, body: source, maxBytes: JMAP_JSON_BYTES, signal },
            {
              ...dependencies,
              request: (options, callback) =>
                factory({ ...options, headers: { ...options.headers, "content-type": "message/rfc822" } }, callback),
            },
          ),
        );
        check(upload.status >= 200 && upload.status < 300, "Upload: HTTP success");
        const json: unknown = await stage("Upload JSON", async () => JSON.parse(upload.body));
        const blob = parse(z.object({ accountId: jmapIdSchema, blobId: jmapIdSchema, size: z.number().int() }), json, "Upload");
        check(blob.accountId === accountId && blob.size === Buffer.byteLength(source), "Upload: account and size");
        const entry: (typeof owned)[number] = { messageId };
        owned.push(entry); // Recover by header if an import response is lost.
        const imported = parse(
          z.object({ created: z.object({ fixture: z.object({ id: jmapIdSchema }) }) }),
          await call("Email/import", {
            emails: { fixture: { blobId: blob.blobId, mailboxIds: { [inbox.id]: true }, keywords: {}, receivedAt } },
          }),
          "Import",
        );
        const emailId = imported.created.fixture.id;
        entry.id = emailId;
        const result = await stage("Read blobs", () =>
          readJmapEmailBlobs(session, authorization, accountId, [emailId], signal, dependencies),
        );
        const reference = result.objects[0];
        check(
          reference && result.objects.length === 1 && !result.notFoundIds.length && reference.id === emailId,
          "Read blobs: exact coverage",
        );
        check(reference.size === Buffer.byteLength(source), "Read blobs: source size");
        const downloaded = await stage("Download", () =>
          downloadJmapEmailSource(
            session,
            authorization,
            accountId,
            reference.blobId,
            reference.size,
            async (stream) => {
              const chunks: Buffer[] = [];
              for await (const chunk of stream) chunks.push(Buffer.from(chunk));
              return Buffer.concat(chunks);
            },
            signal,
            dependencies,
          ),
        );
        check(downloaded.equals(Buffer.from(source)), "Download: exact source bytes");
        // Preserve the measured blob shape/prefix; change a middle hash character.
        const middle = Math.floor(reference.blobId.length / 2);
        unknownBlob =
          reference.blobId.slice(0, middle) + (reference.blobId[middle] === "a" ? "b" : "a") + reference.blobId.slice(middle + 1);
        await destroy([emailId]);
        const missing = await stage("Deleted email", () =>
          readJmapEmailBlobs(session, authorization, accountId, [emailId], signal, dependencies),
        );
        check(!missing.objects.length && missing.notFoundIds.length === 1 && missing.notFoundIds[0] === emailId, "Deleted email: notFound");
      }
      check(unknownBlob, "Unknown blob: reference available");
      let missing = false;
      try {
        await downloadJmapEmailSource(
          session,
          authorization,
          accountId,
          unknownBlob,
          0,
          async () => {
            throw new Error("Unexpected consumer");
          },
          signal,
          dependencies,
        );
      } catch (error) {
        missing = error instanceof JmapTransportError && error.code === "JMAP_SOURCE_MISSING";
      }
      // The source-missing contract accepts 404; Stalwart's actual status is first measured in CI.
      check(missing, "Unknown blob: source missing (HTTP 404 expected)");
    } finally {
      const cleanupSignal = AbortSignal.timeout(5_000);
      const ids = new Set(owned.flatMap((entry) => (entry.id ? [entry.id] : [])));
      let recovered = true;
      for (const entry of owned.filter((email) => !email.id)) {
        try {
          const result = parse(
            z.object({ ids: z.array(jmapIdSchema) }),
            await call("Email/query", { filter: { header: ["Message-ID", entry.messageId] } }, cleanupSignal),
            "Cleanup inventory",
          );
          for (const id of result.ids) ids.add(id);
        } catch {
          recovered = false;
        }
      }
      if (ids.size) await destroy([...ids], cleanupSignal, true);
      check(recovered, "Cleanup: every import with missing response recovered");
    }
  }, 25_000);
});
