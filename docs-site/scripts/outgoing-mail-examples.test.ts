import { describe, expect, mock, spyOn, test } from "bun:test";
import { mail } from "@k2b/cloud/services";
import { createInvoiceMailReader, enqueueStockRun } from "../examples/cloud-docs/platform-outgoing-mail";

const page = await Bun.file(new URL("../docs/en/platform/outgoing-mail.md", import.meta.url)).text();
const fixture = await Bun.file(new URL("../examples/cloud-docs/platform-outgoing-mail.ts", import.meta.url)).text();
const snippets = [...page.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
const normalize = (source: string) =>
  source
    .replace(/^import .*;\n/gm, "")
    .replace(/\s+/g, " ")
    .trim();

describe("outgoing mail worked examples", () => {
  // typecheck:examples compiles the fixture, so each worked snippet compiles against the public exports.
  test("every worked snippet is included in the compile-checked fixture", () => {
    const worked = snippets.filter((snippet) =>
      /export const (sendInvoiceMail|sendDownloadLink|enqueueStockRun|createEmailRoutes|createInvoiceMailReader) =/.test(snippet),
    );
    expect(worked).toHaveLength(5);
    for (const snippet of worked) expect(normalize(fixture)).toContain(normalize(snippet));
  });

  const customers = Array.from({ length: 1200 }, (_, index) => ({ id: String(index), email: `customer${index}@example.org` }));

  test("bulk runs use the remaining recipient quota before pausing", async () => {
    const limit = 500;
    let used = 100;
    const enqueue = spyOn(mail, "enqueue").mockImplementation(async (messages): ReturnType<typeof mail.enqueue> => {
      const requested = messages.reduce((sum, message) => sum + message.to.length, 0);
      if (used + requested > limit) {
        return { ok: false, error: { code: "quota_exceeded", message: "Recipient quota exceeded.", status: 400, limit, used, requested } };
      }
      used += requested;
      return { ok: true, data: { batchId: "stock-batch", ids: messages.map((_, index) => `record-${index}`) } };
    });
    const saveBatch = mock(async (_batch: { batchId: string; ids: string[]; nextOffset: number }) => {});
    try {
      expect(await enqueueStockRun(crypto.randomUUID(), customers, 0, saveBatch)).toEqual({ nextOffset: 400, reason: "quota_exceeded" });
      expect(saveBatch).toHaveBeenCalledTimes(1);
      expect(saveBatch.mock.calls[0]?.[0]).toEqual({
        batchId: "stock-batch",
        ids: Array.from({ length: 400 }, (_, index) => `record-${index}`),
        nextOffset: 400,
      });
      expect(enqueue.mock.calls.map(([messages]) => messages.length)).toEqual([1000, 400, 400]);
      expect(enqueue.mock.calls.every(([messages]) => messages.length <= 1000)).toBe(true);
    } finally {
      enqueue.mockRestore();
    }
  });

  test("bulk runs without a recipient limit accept chunks of at most 1000", async () => {
    const enqueue = spyOn(mail, "enqueue").mockImplementation(
      async (messages): ReturnType<typeof mail.enqueue> => ({
        ok: true,
        data: { batchId: "stock-batch", ids: messages.map((_, index) => `record-${index}`) },
      }),
    );
    const saveBatch = mock(async (_batch: { batchId: string; ids: string[]; nextOffset: number }) => {});
    try {
      expect(await enqueueStockRun(crypto.randomUUID(), customers, 0, saveBatch)).toEqual({ nextOffset: 1200 });
      expect(enqueue.mock.calls.map(([messages]) => messages.length)).toEqual([1000, 200]);
      expect(saveBatch.mock.calls.map(([batch]) => batch.nextOffset)).toEqual([1000, 1200]);
    } finally {
      enqueue.mockRestore();
    }
  });
});

test("invoice content checks source, actual ref, scopes, resource binding and domain visibility before releasing data", async () => {
  const { buildProjectedUser } = await import("../../packages/cloud/src/services/session/user");
  const user = buildProjectedUser({ id: "14180000-0000-4000-8000-000000000001", uid: "reader", provider: "local", profile: "user" });
  const authority: import("@k2b/cloud/server").RequestAuthority = {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "session",
    scopes: [],
  };
  const record: import("@k2b/cloud/contracts").MailRecord = {
    id: "14180000-0000-4000-8000-000000000002",
    appId: "invoices",
    profile: "sender",
    to: ["private@example.org"],
    subject: "Private",
    text: "private body",
    attachments: [],
    status: "sent",
    failures: [],
    attempts: 1,
    createdAt: "2026-10-21T00:00:00Z",
    ref: { scope: "invoice", id: "42" },
  };
  const readable = spyOn(mail, "readableApps").mockResolvedValue({ ok: true, data: ["backoffice", "invoices"] });
  const list = spyOn(mail, "list").mockResolvedValue({
    ok: true,
    data: { items: [record], page: 1, perPage: 1, total: 1, hasNext: false },
  });
  const content = spyOn(mail, "content").mockResolvedValue({ ok: true, data: { purged: false, text: "approved", attachmentNames: [] } });
  let visible = false;
  const mayRead = mock(async (_subject: import("@k2b/cloud/contracts").AccessSubject, id: string) => visible && id === "42");
  const read = createInvoiceMailReader(mayRead);
  const hidden = { ok: false, error: { code: "message_unknown", message: "Mail unavailable.", status: 404 } };
  try {
    expect(await read(record.id, authority, "request")).toEqual(hidden);
    visible = true;
    for (const invalid of [
      { ...record, appId: "hr" },
      { ...record, ref: { scope: "hr", id: "42" } },
      { ...record, ref: undefined },
      { ...record, ref: { scope: "invoice", id: "unknown" } },
    ]) {
      list.mockResolvedValue({ ok: true, data: { items: [invalid], page: 1, perPage: 1, total: 1, hasNext: false } });
      expect(await read(record.id, authority, "request")).toEqual(hidden);
    }
    list.mockResolvedValue({ ok: true, data: { items: [], page: 1, perPage: 1, total: 0, hasNext: false } });
    expect(await read(record.id, authority, "request")).toEqual(hidden);
    list.mockResolvedValue({ ok: true, data: { items: [record], page: 1, perPage: 1, total: 1, hasNext: false } });
    expect(await read(record.id, { ...authority, credentialKind: "oauth", scopes: [] }, "request")).toEqual(hidden);
    const actor: import("@k2b/cloud/contracts").RequestActor = {
      kind: "service_account",
      delegatedUser: null,
      scopes: ["read"],
      serviceAccount: {
        id: "14180000-0000-4000-8000-000000000003",
        name: "invoice",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "backoffice",
        resourceType: "invoice",
        resourceId: "other",
        createdAt: "2026-10-21T00:00:00Z",
        createdBy: null,
      },
    };
    expect(await read(record.id, { ...authority, actor, credentialKind: "api_key", scopes: ["read"] }, "request")).toEqual(hidden);
    expect(content).not.toHaveBeenCalled();
    expect(await read(record.id, authority, "request")).toMatchObject({ ok: true, data: { text: "approved" } });
    expect(content).toHaveBeenCalledWith(record.id, { actor: authority.actor, requestId: "request" });
    expect(mayRead).toHaveBeenLastCalledWith(authority.accessSubject, "42");
  } finally {
    readable.mockRestore();
    list.mockRestore();
    content.mockRestore();
  }
});
