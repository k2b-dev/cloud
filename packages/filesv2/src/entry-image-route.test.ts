import { expect, mock, test } from "bun:test";
import * as cloudServer from "@k2b/cloud/server";
import type { PreviewReadResult } from "@k2b/cloud/services";
import { Hono, type MiddlewareHandler } from "hono";
import { testActor, testCall } from "../test/files-call";
import { FilesError } from "./service/errors";

const pass: MiddlewareHandler = async (_c, next) => next();
mock.module("@k2b/cloud/server", () => ({
  ...cloudServer,
  auth: { ...cloudServer.auth, requireRole: () => pass },
  rateLimit: () => pass,
}));

let answer: { result: PreviewReadResult; immutable: boolean } | FilesError = new FilesError("not_found", 404);
const requests: unknown[] = [];
mock.module("./service", () => ({
  FilesError,
  EDITOR_DOCUMENT_LIMIT: 256 * 1024 * 1024,
  filesService: {
    entryImage: async (call: unknown, input: unknown) => {
      requests.push({ call, input });
      if (answer instanceof FilesError) throw answer;
      return answer;
    },
  },
}));

const { default: routes } = await import("./api");
const api = new Hono<cloudServer.AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", testActor);
    c.set("accessSubject", testCall(testActor).accessSubject);
    c.set("credentialKind", "session");
    await next();
  })
  .route("/", routes);
const picture = (id = "entry-id", rev = "r1") => api.request(`/entries/${encodeURIComponent(id)}/image?rev=${encodeURIComponent(rev)}`);
const ready = (immutable: boolean) => ({
  result: { state: "ready" as const, body: new Blob(["webp"]), type: "image/webp", bytes: 4 },
  immutable,
});

test("a readable picture is private to the session that was allowed to read it", async () => {
  requests.length = 0;
  answer = ready(true);
  const response = await picture("p:abc", "r/1");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("webp");
  expect(Object.fromEntries(response.headers)).toMatchObject({
    "content-type": "image/webp",
    "content-length": "4",
    "cache-control": "private, max-age=31536000, immutable",
    vary: "Cookie, Authorization",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  expect(requests).toEqual([
    { call: expect.objectContaining({ accessSubject: testCall(testActor).accessSubject }), input: { id: "p:abc", rev: "r/1" } },
  ]);
  answer = ready(false);
  expect((await picture()).headers.get("cache-control")).toBe("no-store");
});

test("a refused, missing, or undrawable picture answers with one and the same 404", async () => {
  answer = new FilesError("not_found", 404);
  const missing = await picture();
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const body = await missing.json();
  expect(body).toEqual({ code: "not_found", message: "The requested path or identity was not found." });
  for (const state of ["failed", "too_large", "unsupported"] as const) {
    answer = { result: { state }, immutable: true };
    const response = await picture();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(body);
  }
});

test("a picture still being drawn asks the browser to come back", async () => {
  answer = { result: { state: "pending", retryAfter: 2 }, immutable: true };
  const response = await picture();
  expect(response.status).toBe(202);
  expect(response.headers.get("retry-after")).toBe("2");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("a later try of the browser, under a retry address, is checked again like the first", async () => {
  requests.length = 0;
  answer = ready(true);
  expect((await api.request("/entries/p%3Aabc/image?rev=r1&retry=2")).status).toBe(200);
  expect(requests).toEqual([
    { call: expect.objectContaining({ accessSubject: testCall(testActor).accessSubject }), input: { id: "p:abc", rev: "r1" } },
  ]);
});

test("an entry ref longer than any Files hands out is rejected before the service", async () => {
  requests.length = 0;
  expect((await picture("x".repeat(513))).status).toBe(400);
  expect(requests).toEqual([]);
});
