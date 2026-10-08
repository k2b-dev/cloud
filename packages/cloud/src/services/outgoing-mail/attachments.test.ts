import { expect, spyOn, test } from "bun:test";
import type { ObjectStore } from "@k2b/sync";
import { cancelMailStreams, MAIL_ATTACHMENT_UPLOAD_MS, uploadMailAttachments, verifyMailAttachment } from "./attachments";
import * as sync from "./sync";

const fakeStore = () => {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    ready: async () => {},
    put: async ({ tenantId = "", key, body }) => {
      const buffer = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, buffer);
      return { storeId: "cloud-outgoing-mail-attachments", tenantId, key, size: buffer.byteLength, digest: "fixture" };
    },
    get: async (ref) => {
      const value = objects.get(ref.key);
      return value ? { ref, metadata: {}, updatedAt: new Date(), body: new Blob([new Uint8Array(value)]).stream() } : null;
    },
    delete: async ({ key }) => objects.delete(key),
    info: async () => null,
    list: async function* () {},
    watch: async function* () {},
  };
  return { objects, store };
};
const attachment = (content: Uint8Array | Blob | ReadableStream<Uint8Array>) => ({
  filename: "hello.txt",
  contentType: "text/plain",
  content,
});
test("attachments stream once, persist only metadata, and verify both size and SHA-256", async () => {
  const { objects, store } = fakeStore();
  const factory = spyOn(sync, "mailAttachments").mockReturnValue(store);
  let pulls = 0;
  try {
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const uploaded = await uploadMailAttachments("id", [attachment(source)], 5);
    expect(pulls).toBe(1);
    expect(uploaded.metadata).toEqual([
      {
        filename: "hello.txt",
        contentType: "text/plain",
        size: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    ]);
    const ref = uploaded.refs[0]!;
    await verifyMailAttachment(ref, uploaded.metadata[0]!);
    objects.set(ref.key, new TextEncoder().encode("other"));
    await expect(verifyMailAttachment(ref, uploaded.metadata[0]!)).rejects.toMatchObject({ code: "attachment_lost" });
    objects.set(ref.key, new Uint8Array(4));
    await expect(verifyMailAttachment(ref, uploaded.metadata[0]!)).rejects.toMatchObject({ code: "attachment_lost" });
    objects.delete(ref.key);
    await expect(verifyMailAttachment(ref, uploaded.metadata[0]!)).rejects.toMatchObject({ code: "attachment_lost" });
  } finally {
    factory.mockRestore();
  }
});
test("aggregate attachment overflow cleans prior uploads and cancels remaining streams", async () => {
  const { objects, store } = fakeStore();
  const factory = spyOn(sync, "mailAttachments").mockReturnValue(store);
  let cancelled = false;
  const untouched = new ReadableStream<Uint8Array>(
    {
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  try {
    await expect(
      uploadMailAttachments("id", [attachment(new Uint8Array(3)), attachment(new Blob([new Uint8Array(3)])), attachment(untouched)], 5),
    ).rejects.toMatchObject({ code: "attachments_too_large" });
    expect(objects.size).toBe(0);
    expect(cancelled).toBe(true);
  } finally {
    factory.mockRestore();
  }
});
test("a batch's expired upload budget cancels the next message without storing it", async () => {
  const { store } = fakeStore();
  const factory = spyOn(sync, "mailAttachments").mockReturnValue(store);
  const put = spyOn(store, "put");
  let cancelled = false,
    pulls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls++;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  try {
    await expect(uploadMailAttachments("later-message", [attachment(source)], 5, Date.now() - 1)).rejects.toMatchObject({
      code: "mail_unavailable",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(0);
    expect(put).not.toHaveBeenCalled();
  } finally {
    put.mockRestore();
    factory.mockRestore();
  }
});
test("duplicate stream cancellation never reads source attachments", async () => {
  let reads = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      pull() {
        reads++;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  cancelMailStreams([attachment(source)]);
  expect(reads).toBe(0);
  expect(cancelled).toBe(true);
});
test("stream cancellation returns immediately even when the source never settles", () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  expect(cancelMailStreams([attachment(source)])).toBeUndefined();
  expect(cancelled).toBe(true);
});
test("attachment store exhaustion has a stable acceptance error", async () => {
  const { store } = fakeStore();
  store.put = async () => {
    throw new Error("maximum bytes exceeded");
  };
  const factory = spyOn(sync, "mailAttachments").mockReturnValue(store);
  try {
    await expect(uploadMailAttachments("id", [attachment(new Uint8Array(1))], 5)).rejects.toMatchObject({
      code: "attachment_storage_full",
    });
  } finally {
    factory.mockRestore();
  }
});
test("all attachment puts share one upload deadline, including an already expired budget", async () => {
  const { objects, store } = fakeStore();
  const put = store.put;
  const signals: (AbortSignal | undefined)[] = [];
  const timer = spyOn(globalThis, "setTimeout");
  store.put = async (options) => {
    signals.push(options.signal);
    if (signals.length === 1) {
      const ref = await put(options);
      // Expire the whole call's budget after the first upload, without a wall-clock wait.
      const expire = timer.mock.calls.find(([, delay]) => delay === MAIL_ATTACHMENT_UPLOAD_MS)?.[0];
      if (!expire) throw new Error("Expected an upload deadline");
      expire();
      return ref;
    }
    expect(options.signal?.aborted).toBe(true);
    throw options.signal?.reason;
  };
  const factory = spyOn(sync, "mailAttachments").mockReturnValue(store);
  try {
    expect(MAIL_ATTACHMENT_UPLOAD_MS).toBe(60_000);
    await expect(uploadMailAttachments("id", [attachment(new Uint8Array(1)), attachment(new Uint8Array(1))], 5)).rejects.toThrow(
      "Attachment upload timed out",
    );
    expect(timer.mock.calls.filter(([, delay]) => delay === MAIL_ATTACHMENT_UPLOAD_MS)).toHaveLength(1);
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
    expect(objects.size).toBe(0);
  } finally {
    factory.mockRestore();
    timer.mockRestore();
  }
});
