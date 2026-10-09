import { describe, expect, mock, spyOn, test } from "bun:test";
import { mail } from "@k2b/cloud/services";
import { enqueueStockRun } from "../examples/cloud-docs/platform-outgoing-mail";

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
      /export const (sendInvoiceMail|sendDownloadLink|enqueueStockRun|createEmailRoutes) =/.test(snippet),
    );
    expect(worked).toHaveLength(4);
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
