import { expect, test } from "bun:test";
import { createHttp, secret } from "./http";
import { HttpRequest, SecretSave, HTTP_BYTES } from "../http-contracts";

test("secret references clone as data, cannot concatenate, and never resolve in the worker", async () => {
  const reference = secret("crm", { prefix: "Bearer " });
  expect(structuredClone(reference)).toEqual({ secret: "crm", prefix: "Bearer " });
  expect(() => `${reference}`).toThrow("directly as a header");
  const http = createHttp(async (method, args) => {
    expect(method).toBe("http.fetch");
    expect(args).toEqual([
      { url: "https://example.com/", method: "GET", headers: { authorization: { secret: "crm", prefix: "Bearer " } } },
    ]);
    return { status: 200, headers: { "content-type": "application/json" }, body: btoa('{"answer":42}') };
  });
  const response = await http.fetch("https://example.com/", { headers: { Authorization: reference } });
  expect(response.ok).toBe(true);
  expect(await response.json()).toEqual({ answer: 42 });
});
test("HTTP errors are responses; binary bodies and empty responses preserve bytes", async () => {
  const http = createHttp(async (_method, args) => {
    expect(args[0]).toMatchObject({ body: "AP+A", method: "POST" });
    return { status: 429, headers: { "retry-after": "3" }, body: "AP+A" };
  });
  const response = await http.fetch("https://example.com/", { method: "POST", body: new Uint8Array([0, 255, 128]) });
  expect(response.ok).toBe(false);
  expect(response.status).toBe(429);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  const empty = createHttp(async () => ({ status: 204, headers: {}, body: "" }));
  expect(await (await empty.fetch("https://example.com/")).text()).toBe("");
});
test("invalid targets, header injection, arbitrary reference fields and GET bodies are rejected", () => {
  for (const url of ["invalid", "http://example.com/", "https://user:pass@example.com/", "https://example.com/#secret"])
    expect(HttpRequest.safeParse({ url }).success).toBe(false);
  for (const headers of [
    { Cookie: "session" },
    { Host: "internal" },
    { Authorization: "value\r\nx: y" },
    { Authorization: { secret: "x", value: "not-allowed" } },
  ])
    expect(HttpRequest.safeParse({ url: "https://example.com/", headers }).success).toBe(false);
  expect(HttpRequest.safeParse({ url: "https://example.com/", body: "YQ==" }).success).toBe(false);
  expect(
    SecretSave.safeParse({ name: "crm", origin: "https://example.com", header: "authorization", value: "\r\n", expectedRevision: null })
      .success,
  ).toBe(false);
});

test("header collisions and malformed base64 cannot alter a reviewed request", () => {
  expect(HttpRequest.safeParse({ url: "https://example.com", headers: { Authorization: "a", authorization: "b" } }).success).toBe(false);
  expect(HttpRequest.safeParse({ url: "https://example.com", method: "POST", body: "not base64" }).success).toBe(false);
});

test("the documented body budget accepts an actual 4 MiB request", () => {
  const body = Buffer.alloc(HTTP_BYTES).toString("base64");
  expect(HttpRequest.safeParse({ url: "https://example.com", method: "POST", body }).success).toBe(true);
  expect(HttpRequest.safeParse({ url: "https://example.com", method: "POST", body: body + "AAAA" }).success).toBe(false);
});
