import { expect, test } from "bun:test";
import { Hono } from "hono";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { authenticateSignedAppRequest } from "./authenticate-app-request";

const admitted = async () => ({ limited: false, remaining: 1, resetIn: 1000 });
const request = (body: BodyInit, headers?: HeadersInit) =>
  new Request("http://core.test/invoke", {
    method: "POST",
    headers: new Headers([["authorization", "Bearer invalid.proof"], ...new Headers(headers)]),
    body,
  });
test("signed ingress bounds streamed bytes before verification, including forged content length", async () => {
  const routes = new Hono().post("/invoke", async (c) => {
    const result = await authenticateSignedAppRequest(c, "identity:invoke", { ingress: admitted });
    return result instanceof Response ? result : c.json({ unexpected: true });
  });
  for (const headers of [
    new Headers(),
    new Headers({ "content-length": "1" }),
    new Headers({ "content-length": String(CAPABILITY_MAX_REQUEST_BYTES + 1) }),
  ]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(CAPABILITY_MAX_REQUEST_BYTES + 1));
        controller.close();
      },
    });
    const response = await routes.request(request(body, headers));
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});
test("signed ingress rejects overload and fails closed when admission is unavailable", async () => {
  for (const state of ["limited", "unavailable"] as const) {
    const routes = new Hono().post("/invoke", async (c) => {
      const result = await authenticateSignedAppRequest(c, "identity:invoke", {
        ingress: async () => {
          if (state === "unavailable") throw new Error("Valkey unavailable");
          return { limited: true, remaining: 0, resetIn: 1500 };
        },
      });
      return result instanceof Response ? result : c.json({ unexpected: true });
    });
    const response = await routes.request(request("{}"));
    expect(response.status).toBe(state === "limited" ? 429 : 503);
    expect(response.headers.get("Retry-After")).toBe(state === "limited" ? "2" : "1");
  }
});
