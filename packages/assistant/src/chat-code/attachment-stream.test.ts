import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { CapabilityFileMetadataSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { createChatAttachmentStream } from "./attachment-stream";
import { ArtifactError } from "./identity";
import { createServiceCalls } from "./runtime/services";
import { testIdentity } from "./test-identity";

const NOW = new Date("2026-11-11T10:00:00.000Z");
afterEach(() => setSystemTime());
function fixture(grantId?: string) {
  setSystemTime(NOW);
  const identity = testIdentity("person-one");
  const context: CapabilityExecutionContext = {
    ...identity,
    user: identity.actor.kind === "user" ? identity.actor.user : null,
    locale: "en",
    requestId: "request-one",
    origin: "assistant",
    signal: new AbortController().signal,
  };
  const file = {
    path: "/photo.jpg",
    size: 3,
    mediaType: "image/jpeg",
    version: 1,
    updatedAt: NOW.toISOString(),
    origin: "user" as const,
    bytes: new Uint8Array([1, 2, 3]),
  };
  let allowed = true;
  let missing = false;
  let reads = 0;
  const spent = new Set<string>();
  const grants = new Map<string, unknown>();
  const stream = createChatAttachmentStream({
    authorize: async (_id, caller) => {
      if (!allowed || caller.accessSubject.type !== "user" || caller.accessSubject.userId !== "person-one")
        throw new ArtifactError("ACCESS_DENIED");
      return { id: "chat-one" };
    },
    stat: async () => (missing ? null : file),
    read: async (input) => {
      reads++;
      return missing || input.version !== file.version || file.size > (input.maxBytes ?? 0) ? null : file;
    },
    seal: async (value) => {
      const id = grantId ?? `grant-${grants.size}`;
      grants.set(id, value);
      return id;
    },
    unseal: async (id) => grants.get(id),
    consume: async (nonce) => {
      if (spent.has(nonce)) return false;
      spent.add(nonce);
      return true;
    },
  });
  return {
    context,
    file,
    stream,
    revoke: () => {
      allowed = false;
    },
    remove: () => {
      missing = true;
    },
    reads: () => reads,
  };
}
test("chat attachment issues metadata without bytes, then transfers once under current access", async () => {
  const f = fixture();
  const ref = await f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context);
  expect(f.reads()).toBe(0);
  expect(ref).toMatchObject({ name: "photo.jpg", size: 3, mediaType: "image/jpeg", expiresAt: "2026-11-11T10:10:00.000Z" });
  const response = await f.stream.read(ref, f.context);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.file.bytes);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  await expect(f.stream.read(ref, f.context)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.reads()).toBe(1);
});
test("concurrent redemptions reserve single use before reading file content", async () => {
  const f = fixture();
  const ref = await f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.stream.read(ref, f.context)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(f.reads()).toBe(1);
});
test("the chat attachment becomes a run FileRef and feeds an app Action through the existing dispatcher", async () => {
  const f = fixture();
  let received: Uint8Array | undefined;
  const call = createServiceCalls({
    capability: async (name, input) => {
      const stream =
        name === "assistant.chat.file.read.v1"
          ? await f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context)
          : {
              ...z.object({ file: CapabilityFileMetadataSchema }).parse(input).file,
              id: "destination",
              direction: "write" as const,
              expiresAt: "2026-11-11T10:10:00.000Z",
            };
      return { data: {}, stream: { ...stream, callId: "11111111-1111-4111-8111-111111111111" } };
    },
    stream: async (stream, verb, body) => {
      if (verb === "read") return new File([await (await f.stream.read(stream, f.context)).blob()], stream.name ?? "photo.jpg");
      received = new Uint8Array(await body!.arrayBuffer());
      return { data: { imported: true } };
    },
  });
  const result = await call(
    "capabilities.run",
    ["assistant.chat.file.read.v1", { chatId: "chat-one", path: "/photo.jpg" }, undefined, "read"],
    f.context.signal,
  );
  const { data: file } = z.object({ data: CapabilityFileMetadataSchema.extend({ id: z.string() }) }).parse(result);
  expect(f.reads()).toBe(0);
  expect(await call("capabilities.run", ["imports.import", { file }, undefined, "write"], f.context.signal)).toEqual({
    data: { imported: true },
  });
  expect(received).toEqual(f.file.bytes);
  await expect(call("capabilities.run", ["imports.import", { file }, undefined, "write"], f.context.signal)).rejects.toMatchObject({
    code: "denied",
  });
});
test("changed account, revoked chat access, deleted file and changed revision refuse transfer", async () => {
  for (const change of ["person", "access", "deleted", "version", "recreated", "metadata"] as const) {
    const f = fixture();
    const ref = await f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context);
    if (change === "person") f.context.accessSubject = { type: "user", userId: "person-two" };
    if (change === "access") f.revoke();
    if (change === "deleted") f.remove();
    if (change === "version") f.file.version++;
    if (change === "recreated") f.file.updatedAt = "2026-11-11T10:00:01.000Z";
    if (change === "metadata") ref.size++;
    await expect(f.stream.read(ref, f.context)).rejects.toMatchObject({ status: expect.any(Number) });
  }
});
test("expired and oversized chat files fail before reading bytes", async () => {
  const f = fixture();
  const ref = await f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context);
  setSystemTime(new Date(NOW.getTime() + 600_000));
  await expect(f.stream.read(ref, f.context)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(f.reads()).toBe(0);
  f.file.size = 50 * 1024 * 1024 + 1;
  await expect(f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context)).rejects.toMatchObject({
    code: "BAD_INPUT",
    status: 400,
  });
  expect(f.reads()).toBe(0);
});

test("provider continuations larger than the shared 2 KiB budget fail as bad input", async () => {
  const f = fixture("x".repeat(2049));
  await expect(f.stream.issue({ chatId: "chat-one", path: "/photo.jpg" }, f.context)).rejects.toMatchObject({
    code: "BAD_INPUT",
    status: 400,
  });
  expect(f.reads()).toBe(0);
});
