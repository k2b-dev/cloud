import { expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { createChatCodeServiceRoutes } from "./api";
import { clientCalls } from "./client-calls";
import { httpService as chatHttpService } from "./http-service";
import { testIdentity } from "./test-identity";

const owner = testIdentity("00000000-0000-4000-8000-000000000001");
test("completion persists only the secret output contract, even if the browser adds a private field", async () => {
  const privateValue = "fixture-private-completion-field";
  const complete = spyOn(clientCalls, "complete").mockResolvedValue({ saved: true });
  const api = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("credentialKind", "session");
      c.set("actor", owner.actor);
      c.set("accessSubject", owner.accessSubject);
      await next();
    })
    .route("/", createChatCodeServiceRoutes());
  try {
    const response = await api.request("/runtime/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "Chat42",
        turnId: "Turn42",
        callId: "secret-call",
        clientId: "11111111-1111-4111-8111-111111111111",
        input: { operation: "secret", name: "API", origin: "https://api.example.com" },
        result: { configured: true, name: "API", value: privateValue },
      }),
    });
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls)).not.toContain(privateValue);
  } finally {
    complete.mockRestore();
  }
});

test("a failed private write never echoes the value or exception to logs or the response", async () => {
  const privateValue = "fixture-private-error-echo";
  const save = spyOn(chatHttpService, "save").mockRejectedValue(new Error(privateValue));
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const api = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("credentialKind", "session");
      c.set("actor", owner.actor);
      c.set("accessSubject", owner.accessSubject);
      await next();
    })
    .route("/", createChatCodeServiceRoutes());
  try {
    const response = await api.request("/runtime/secrets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { conversationId: "Chat42" },
        secret: {
          name: "API",
          origin: "https://api.example.com",
          header: "authorization",
          prefix: "",
          value: privateValue,
          expectedRevision: null,
        },
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(privateValue);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateValue);
  } finally {
    save.mockRestore();
    logs.mockRestore();
  }
});
