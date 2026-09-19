import { afterEach, expect, test } from "bun:test";
import type { UploadSession } from "./contracts";
import { transferUpload } from "./upload-transfer";

const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});
const session: UploadSession = {
  id: "upload",
  path: "file",
  size: 0,
  chunkSize: 8 * 1024 * 1024,
  state: "open",
  url: "https://filegate.test/lease-secret",
  expires: "2099-01-01",
};

test("SDK transport retry budget is not multiplied by the application", async () => {
  let requests = 0,
    renews = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ error: "busy", message: "lease-secret" }, { status: 503, headers: { "Retry-After": "0" } });
    },
    { preconnect: nativeFetch.preconnect },
  );
  await expect(
    transferUpload(new Blob([]), session, {
      signal: new AbortController().signal,
      renew: async () => {
        renews++;
        return { url: session.url! };
      },
      failure: "Upload failed",
    }),
  ).rejects.toThrow("Upload failed");
  expect(requests).toBe(3);
  expect(renews).toBe(0);
});

test("long Retry-After returns control without an application retry", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return Response.json({ error: "busy" }, { status: 429, headers: { "Retry-After": "5" } });
    },
    { preconnect: nativeFetch.preconnect },
  );
  await expect(
    transferUpload(new Blob([]), session, {
      signal: new AbortController().signal,
      renew: async () => {
        throw new Error("must not renew");
      },
      failure: "Upload failed",
    }),
  ).rejects.toThrow("Upload failed");
  expect(requests).toBe(1);
});

test("a committed creation replay requires no lease or transfer", async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("must not fetch");
    },
    { preconnect: nativeFetch.preconnect },
  );
  const { url: _url, ...terminal } = session;
  await transferUpload(
    new Blob([]),
    { ...terminal, state: "committed" },
    {
      signal: new AbortController().signal,
      renew: async () => {
        throw new Error("must not renew");
      },
      failure: "Upload failed",
    },
  );
});
