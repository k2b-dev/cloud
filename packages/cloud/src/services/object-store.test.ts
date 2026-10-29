import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { S3Client } from "bun";
import { objectStoreBackend, testObjectStoreConnection } from "../_internal/object-store-config";
import { bindProcessApplicationId, clearProcessApplicationId, getProcessApplicationId } from "../_internal/process-identity";
import { storage } from "./object-store";
import * as settingsStore from "./settings/store";

const defaults = {
  "storage.endpoint": "http://127.0.0.1:1",
  "storage.bucket": "cloud-test",
  "storage.access_key_id": "test-access",
  "storage.secret_access_key": "test-secret",
  "storage.region": "garage",
  "storage.max_object_bytes": 32,
  "app.url": "https://cloud.example.test",
};
let config: Record<string, unknown>;
let restoreSettings: () => void;
let previousId: string | undefined;
beforeEach(() => {
  config = { ...defaults };
  const spy = spyOn(settingsStore, "readStates").mockImplementation(
    async (keys) => new Map(keys.map((key) => [key, { stored: "readable" as const, value: config[key] }])),
  );
  const readSpy = spyOn(settingsStore, "readKey").mockImplementation(async (key) => config[key]);
  restoreSettings = () => {
    spy.mockRestore();
    readSpy.mockRestore();
  };
  previousId = getProcessApplicationId();
  clearProcessApplicationId();
  bindProcessApplicationId("inventory");
});
afterEach(() => {
  restoreSettings();
  clearProcessApplicationId();
  if (previousId) bindProcessApplicationId(previousId);
});

const malicious = [
  "",
  ".",
  "..",
  "../secret",
  "../../../secret.txt",
  "x/../secret",
  "x/./secret",
  "x/..",
  "x/.",
  "/secret",
  "//host/secret",
  "x//secret",
  "x/",
  "x///y",
  "\\secret",
  "x\\..\\secret",
  "x/..\\secret",
  "%2e%2e/secret",
  "%2E%2E/secret",
  ".%2e/secret",
  "%2e./secret",
  "%2fsecret",
  "x%2F..%2Fsecret",
  "%5c..%5csecret",
  "%252e%252e%252fsecret",
  "%25%32%65",
  "%00secret",
  "100%.txt",
  "x\0y",
  "x\ny",
  "x\ry",
  "x\ty",
  "x\u007fy",
  "x\u0085y",
  "x\u202ey",
  "x\u200by",
  "x\ud800y",
  "cafe\u0301.txt",
  "a/" + "x".repeat(1024),
  "界".repeat(342),
];

describe("object-store key boundary", () => {
  test.each(malicious)("rejects key %j before issuing an S3 request", (key) => {
    expect(() => storage.file(key)).toThrow();
    expect(() => storage.public.file(key)).toThrow();
  });
  test.each(malicious.filter((key) => key !== "" && !key.endsWith("/")))("rejects list prefix %j", async (prefix) => {
    await expect(storage.list({ prefix })).rejects.toThrow();
  });
  test.each(malicious)("rejects copy target and startAfter %j", async (key) => {
    await expect(storage.file("valid.txt").copy(key)).rejects.toThrow();
    await expect(storage.list({ startAfter: key })).rejects.toThrow();
  });
  test("accepts literal Unicode, punctuation, and the full S3 UTF-8 byte boundary", () => {
    for (const key of ["café/界.txt", "a..b/.hidden", "a?b#c", "a:b", "space name.txt"]) {
      expect(storage.file(key).key).toBe(key);
    }
    const prefixBytes = Buffer.byteLength("private/inventory/");
    expect(storage.file("x".repeat(1024 - prefixBytes)).key.length).toBe(1024 - prefixBytes);
    expect(() => storage.file("x".repeat(1025 - prefixBytes))).toThrow("1,024");
  });
  test("two apps in one declared package resolve to the same area", async () => {
    clearProcessApplicationId();
    bindProcessApplicationId("orders", [], "warenfluss");
    const first = new URL(await storage.file("document.pdf").presign()).pathname;
    clearProcessApplicationId();
    bindProcessApplicationId("stock", [], "warenfluss");
    expect(new URL(await storage.file("document.pdf").presign()).pathname).toBe(first);
    expect(first).toBe("/cloud-test/private/warenfluss/document.pdf");
    expect(() => storage.public.file("photo.png").presign()).toThrow("url");
  });
  test("requires a started application and validates even internal app identifiers", () => {
    clearProcessApplicationId();
    expect(() => storage.file("file")).toThrow("Start the application");
    bindProcessApplicationId("../other");
    expect(() => storage.file("file")).toThrow("application package");
  });
  test("rejects extra signing methods and bounds expiry", async () => {
    const file = storage.file("file");
    for (const expiresIn of [0, -1, 901, NaN, Infinity, 1.5]) expect(() => file.presign({ expiresIn })).toThrow();
    // A JavaScript caller is not restricted by TypeScript's option types.
    const options = JSON.parse('{"method":"PUT","bucket":"other"}');
    expect(() => file.presign(options)).toThrow("upload through write");
    const url = new URL(await file.presign());
    expect(url.pathname).toBe("/cloud-test/private/inventory/file");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(new URL(await file.presign({ expiresIn: 900 })).searchParams.get("X-Amz-Expires")).toBe("900");
    const injected = JSON.parse(
      '{"endpoint":"http://other.test","bucket":"other","accessKeyId":"other","secretAccessKey":"other","acl":"public-read"}',
    );
    const signed = new URL(await file.presign(injected));
    expect(signed.origin).toBe("http://127.0.0.1:1");
    expect(signed.pathname).toStartWith("/cloud-test/private/inventory/");
    expect(signed.searchParams.get("X-Amz-Credential")).toStartWith("test-access/");
  });
  test("bounds known and streamed upload sizes before contacting S3 and cancels overload", async () => {
    const file = storage.file("file");
    for (const data of ["界".repeat(11), new Uint8Array(33), new ArrayBuffer(33), new Blob([new Uint8Array(33)])]) {
      await expect(file.write(data)).rejects.toThrow("32-byte");
    }
    let cancelled = false;
    const data = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(17));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(file.write(new Response(data))).rejects.toThrow("32-byte");
    expect(cancelled).toBe(true);
  });
  test("returns a stable installation URL only for public objects", async () => {
    expect(() => storage.file("document.pdf").url).toThrow("Private");
    const file = storage.public.file("café/a?b#c.png");
    expect(await file.url).toBe("https://cloud.example.test/public/storage/inventory/caf%C3%A9/a%3Fb%23c.png");
    expect(await file.url).toBe(await file.url);
    expect(Object.isFrozen(file)).toBe(true);
    expect(Object.keys(file)).not.toContain("client");
    config["app.url"] = "https://cloud2.example.test/";
    expect(await file.url).toStartWith("https://cloud2.example.test/public/storage/");
  });
  test("applies saved configuration changes to existing file handles without restart", async () => {
    const file = storage.file("document.pdf");
    expect(new URL(await file.presign()).pathname).toBe("/cloud-test/private/inventory/document.pdf");
    config["storage.bucket"] = "other-test";
    config["storage.access_key_id"] = "rotated-access";
    config["storage.endpoint"] = "http://127.0.0.1:2";
    const rotated = new URL(await file.presign());
    expect(rotated.origin).toBe("http://127.0.0.1:2");
    expect(rotated.pathname).toBe("/other-test/private/inventory/document.pdf");
    expect(rotated.searchParams.get("X-Amz-Credential")).toStartWith("rotated-access/");
    config["storage.secret_access_key"] = "";
    await expect(file.presign()).rejects.toThrow("Storage is not configured");
  });
  test("Bun signing and WHATWG URL parsing normalize literal parent segments; the wrapper rejects them", () => {
    const client = new S3Client({
      endpoint: defaults["storage.endpoint"],
      bucket: defaults["storage.bucket"],
      accessKeyId: defaults["storage.access_key_id"],
      secretAccessKey: defaults["storage.secret_access_key"],
      region: "us-east-1",
    });
    const traversal = "inventory/../other/secret.txt";
    expect(new URL(client.file(traversal).presign()).pathname).toBe("/cloud-test/other/secret.txt");
    expect(new URL("http://example.test/packages/inventory/%2e%2e/other").pathname).toBe("/packages/other");
    expect(() => storage.file("../../other/private/secret.txt").presign()).toThrow();
  });
});

describe("object-store transport boundary", () => {
  test("forces relative prefixes and pagination even when a JavaScript caller supplies transport overrides", async () => {
    let query: URL | undefined;
    let responseKey = "private/inventory/folder/item.txt";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        query = new URL(request.url);
        return new Response(
          `<?xml version="1.0"?><ListBucketResult><Name>cloud-test</Name><Prefix>private/inventory/folder/</Prefix><KeyCount>1</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>${responseKey}</Key><Size>4</Size><ETag>"etag"</ETag></Contents></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      },
    });
    config["storage.endpoint"] = server.url.origin;
    try {
      const options = {
        prefix: "folder/",
        startAfter: "folder/before.txt",
        maxKeys: 2,
        continuationToken: "opaque-token",
        bucket: "foreign",
        endpoint: "http://foreign.test",
        delimiter: "/",
        encodingType: "url",
      };
      const result = await storage.list(options);
      expect(query?.pathname).toBe("/cloud-test/");
      expect(query?.searchParams.get("prefix")).toBe("private/inventory/folder/");
      expect(query?.searchParams.get("start-after")).toBe("private/inventory/folder/before.txt");
      expect(query?.searchParams.get("continuation-token")).toBe("opaque-token");
      expect(query?.searchParams.get("max-keys")).toBe("2");
      expect(query?.searchParams.has("delimiter")).toBe(false);
      expect(query?.searchParams.has("encoding-type")).toBe(false);
      expect(result.contents?.map((item) => item.key)).toEqual(["folder/item.txt"]);
      for (const bad of ["other/item.txt", "private/inventory/elsewhere.txt"]) {
        responseKey = bad;
        await expect(storage.list({ prefix: "folder/" })).rejects.toThrow();
      }
    } finally {
      await server.stop(true);
    }
  });
  test("list skips nonconforming external keys without losing the page token", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>${["folder/", "100%.pdf", "x/../secret", "valid.pdf"].map((key) => `<Contents><Key>private/inventory/${key}</Key><Size>1</Size></Contents>`).join("")}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        ),
    });
    config["storage.endpoint"] = server.url.origin;
    try {
      const result = await storage.list();
      expect(result.contents?.map((item) => item.key)).toEqual(["valid.pdf"]);
      expect(result.nextContinuationToken).toBe("next");
    } finally {
      await server.stop(true);
    }
  });
  test("stat and size use HEAD; writes ignore credential and ACL overrides; streamed reads have a byte budget", async () => {
    const requests: { method: string; path: string; acl: string | null; body: string }[] = [];
    const contentTypes: (string | null)[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        contentTypes.push(request.headers.get("content-type"));
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          acl: request.headers.get("x-amz-acl"),
          body: await request.text(),
        });
        if (request.method === "HEAD")
          return new Response(null, {
            headers: {
              "content-length": "4",
              "content-type": "text/plain",
              etag: '"etag"',
              "last-modified": "Wed, 28 Oct 2026 12:00:00 GMT",
            },
          });
        if (request.method === "PUT" || request.method === "DELETE") return new Response(null, { headers: { etag: '"etag"' } });
        return new Response("x".repeat(33));
      },
    });
    config["storage.endpoint"] = server.url.origin;
    try {
      const file = storage.file("safe.txt");
      expect(await file.size).toBe(4);
      expect((await file.stat()).size).toBe(4);
      expect(requests.map((request) => request.method)).toEqual(["HEAD", "HEAD"]);
      const options = {
        type: "text/plain",
        bucket: "foreign",
        endpoint: "http://foreign.test",
        acl: "public-read",
        secretAccessKey: "foreign",
      };
      expect(await file.write("safe", options)).toBe(4);
      expect(requests.at(-1)).toEqual({ method: "PUT", path: "/cloud-test/private/inventory/safe.txt", acl: null, body: "safe" });
      await file.write(new Blob(["safe"], { type: "image/png" }));
      expect(contentTypes.at(-1)).toBe("image/png");
      await file.write(new Response("safe", { headers: { "content-type": "image/webp" } }));
      expect(contentTypes.at(-1)).toBe("image/webp");
      await file.write(new Blob(["safe"], { type: "image/png" }), { type: "text/plain" });
      expect(contentTypes.at(-1)).toStartWith("text/plain");
      await expect(file.bytes()).rejects.toThrow("32-byte");
      await expect(file.text()).rejects.toThrow("32-byte");
      await expect(new Response(file.stream()).bytes()).rejects.toThrow("32-byte");
      await file.delete();
      expect(requests.at(-1)?.path).toBe("/cloud-test/private/inventory/safe.txt");
      expect(requests.at(-1)?.method).toBe("DELETE");
    } finally {
      await server.stop(true);
    }
  });
});

describe("saved storage connection", () => {
  test("rejects incomplete, invalid and unreadable settings without exposing secrets", async () => {
    for (const endpoint of [
      "",
      "ftp://garage.test",
      "http://user:secret@garage.test",
      "https://garage.test/path",
      "https://garage.test/?secret=value",
    ]) {
      config["storage.endpoint"] = endpoint;
      await expect(objectStoreBackend()).rejects.toThrow(/Storage/);
    }
    const unreadable = spyOn(settingsStore, "readStates").mockResolvedValue(
      new Map([["storage.secret_access_key", { stored: "unreadable", value: "" }]]),
    );
    try {
      await expect(objectStoreBackend()).rejects.toThrow("cannot be decrypted");
    } finally {
      unreadable.mockRestore();
    }
  });
  test("administrator probe writes, reads and deletes a single randomized object", async () => {
    let content: string | undefined;
    const requests: { method: string; path: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({ method: request.method, path: new URL(request.url).pathname });
        if (request.method === "PUT") {
          content = await request.text();
          return new Response(null);
        }
        if (request.method === "DELETE") {
          content = undefined;
          return new Response(null, { status: 204 });
        }
        if (content === undefined) return new Response(null, { status: 404 });
        return new Response(content);
      },
    });
    config["storage.endpoint"] = server.url.origin;
    try {
      await testObjectStoreConnection();
      expect(requests.map((request) => request.method)).toEqual(["PUT", "GET", "DELETE", "HEAD"]);
      expect(new Set(requests.map((request) => request.path)).size).toBe(1);
      expect(requests[0]?.path).toStartWith("/cloud-test/cloud-connection-test/");
      expect(content).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
