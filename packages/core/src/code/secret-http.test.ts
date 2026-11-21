import { expect, test } from "bun:test";
import { CodeHttpRequestSchema, CodeSecretBindingSchema, type CodeSecretVersionBinding } from "@k2b/cloud/contracts";
import { codeSecretHeaderPlan, codeSecretRequestUrl, redactCodeHttpResponse } from "./secret-http";

const binding: CodeSecretVersionBinding = {
  name: "API",
  binding_revision: "11111111-1111-4111-8111-111111111111",
  origin: "https://api.example:8443",
  pathPrefix: "/v1",
  headers: ["authorization"],
};
const request = (url = "https://api.example:8443/v1/items", headers = { authorization: "Bearer [secret:API]" }) =>
  CodeHttpRequestSchema.parse({ url, headers });
test("binding checks the exact origin, effective port, segment boundary and allowed header", () => {
  expect(CodeSecretBindingSchema.safeParse({ origin: "invalid", pathPrefix: "/", headers: ["authorization"] }).success).toBe(false);
  expect(codeSecretHeaderPlan(request(), [binding], [])).toMatchObject({ names: ["API"] });
  expect(codeSecretHeaderPlan(request("https://api.example:8443/v1"), [binding], []).names).toEqual(["API"]);
  for (const url of [
    "https://api.example/v1",
    "https://api.example:9443/v1",
    "https://evil.example:8443/v1",
    "https://api.example:8443/v10",
    "https://api.example:8443/v1evil",
  ]) {
    expect(() => codeSecretHeaderPlan(request(url), [binding], [])).toThrow("code_http_secret_forbidden");
  }
  expect(() => codeSecretHeaderPlan(request(undefined, { authorization: "[secret:MISSING]" }), [binding], [])).toThrow();
  expect(() => codeSecretHeaderPlan(request(undefined, { authorization: "[secret:API" }), [binding], [])).toThrow();
  expect(() =>
    codeSecretHeaderPlan(CodeHttpRequestSchema.parse({ url: request().url, headers: { "x-api-key": "[secret:API]" } }), [binding], []),
  ).toThrow();
  expect(() => codeSecretHeaderPlan(request(), [binding], [binding.origin])).toThrow("code_http_origin_forbidden");
});
test("raw traversal, backslashes, encoded/double-encoded separators and fragments are refused before normalization", () => {
  for (const path of [
    "/v1/../other",
    "/v1/./items",
    "/v1/%2e%2e/other",
    "/v1/a%2fb",
    "/v1/a%2Fb",
    "/v1/a%5cb",
    "/v1/%252e%252e/other",
    "/v1/a\\..\\b",
    "/v1/a#fragment",
    "/v1/\t../other",
  ]) {
    expect(() => codeSecretRequestUrl(binding.origin + path, [])).toThrow();
  }
  for (const url of [
    "https:////api.example:8443/v1/../v1",
    "https:/api.example:8443/v1/%2f..",
    "https:api.example:8443/v1/..%2fadmin",
    "HTTPS:////api.example:8443/v1/..%2fadmin",
  ])
    expect(() => codeSecretRequestUrl(url, [])).toThrow();
  for (const pathPrefix of ["/v1/../other", "/v1/%2f", "/v1/%252f", "/v1/a\\b"])
    expect(CodeSecretBindingSchema.safeParse({ origin: binding.origin, headers: binding.headers, pathPrefix }).success).toBe(false);
});
test("header smuggling, placeholders in body/URL and Cloud session headers are refused", () => {
  for (const headers of [
    { authorization: "[secret:API]\r\nHost: evil.example" },
    { authorization: "[secret:API]", Authorization: "other" },
    { cookie: "[secret:API]" },
    { host: "evil.example" },
    { "x-forwarded-host": "evil.example" },
  ])
    expect(() => codeSecretHeaderPlan(CodeHttpRequestSchema.parse({ url: request().url, headers }), [binding], [])).toThrow();
  expect(() => codeSecretHeaderPlan({ ...request(), method: "POST", body: "[secret:API]" }, [binding], [])).toThrow();
  expect(() => codeSecretHeaderPlan(request(request().url + "?key=[secret:API]"), [binding], [])).toThrow();
});
test("remote echoes are redacted in response bytes and headers before they can enter a runner or call list", () => {
  const value = 'token/with+"quotes';
  const sent = "Bearer " + value;
  const echoes = [
    value,
    sent,
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    JSON.stringify(value).slice(1, -1),
  ];
  const response = redactCodeHttpResponse({ status: 200, headers: { etag: value }, body: Buffer.from(echoes.join("\n")) }, [
    { name: "API", value, sent },
  ]);
  expect(response.headers.etag).toBe("[secret:API]");
  const text = Buffer.from(response.body, "base64").toString();
  expect(text).toBe(echoes.map(() => "[secret:API]").join("\n"));
  for (const echo of echoes) expect(JSON.stringify(response)).not.toContain(echo);
});
test("binary bytes remain unchanged without inserted credentials", () => {
  const bytes = new Uint8Array([0, 255, 128, 42]);
  expect(Buffer.from(redactCodeHttpResponse({ status: 200, headers: {}, body: bytes }, []).body, "base64")).toEqual(Buffer.from(bytes));
});

test("declared origins are exact for every HTTP call, including without secrets", async () => {
  const { requireCodeHttpOrigin } = await import("./secret-http");
  expect(requireCodeHttpOrigin("https://api.example:8443/items", [binding.origin], []).origin).toBe(binding.origin);
  for (const url of ["https://other.example/items", "https://api.example/items", "https://api.example:9443/items"]) {
    try {
      requireCodeHttpOrigin(url, [binding.origin], []);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "code_http_origin_undeclared", origin: new URL(url).origin });
    }
  }
  expect(() => requireCodeHttpOrigin(binding.origin, [binding.origin], [binding.origin])).toThrow("code_http_origin_forbidden");
  expect(() => requireCodeHttpOrigin(binding.origin, [], [])).toThrow("code_http_origin_undeclared");
  for (const origin of ["https://evil.example.", "https://a*b.example"])
    expect(() => requireCodeHttpOrigin(origin, [], [])).toThrow("code_http_origin_forbidden");
});
