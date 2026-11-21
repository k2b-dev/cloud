import { expect, spyOn, test } from "bun:test";
import { CODE_SECRET_ERRORS, CODE_SECRET_GUIDANCE } from "@k2b/cloud/ai/browser";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { createChatCodeServiceRoutes } from "./api";
import { clientCalls } from "./client-calls";
import { httpService as chatHttpService } from "./http-service";
import { testIdentity } from "./test-identity";

const owner = testIdentity("00000000-0000-4000-8000-000000000001");
for (const configured of [true, false])
  test(`completion ${configured} pins the requested name and strips private browser fields`, async () => {
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
          result: { configured, name: privateValue, value: privateValue },
        }),
      });
      expect(response.status).toBe(200);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[0]).toMatchObject({ result: { configured, name: "API" } });
      expect(JSON.stringify(complete.mock.calls)).not.toContain(privateValue);
      expect(await response.text()).not.toContain(privateValue);
    } finally {
      complete.mockRestore();
    }
  });

test("completion keeps only the fixed error and hint sentences", async () => {
  const privateValue = "fixture-private-hint";
  const complete = spyOn(clientCalls, "complete").mockResolvedValue({ saved: true });
  const api = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("credentialKind", "session");
      c.set("actor", owner.actor);
      c.set("accessSubject", owner.accessSubject);
      await next();
    })
    .route("/", createChatCodeServiceRoutes());
  const send = (result: unknown) =>
    api.request("/runtime/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "Chat42",
        turnId: "Turn42",
        callId: "secret-call",
        clientId: "11111111-1111-4111-8111-111111111111",
        input: { operation: "secret", name: "API", origin: "https://api.example.com" },
        result,
      }),
    });
  try {
    for (const [sent, kept] of [
      [
        { failed: true, error: CODE_SECRET_ERRORS.signInExpired, guidance: CODE_SECRET_GUIDANCE.signIn },
        { failed: true, error: CODE_SECRET_ERRORS.signInExpired, guidance: CODE_SECRET_GUIDANCE.signIn },
      ],
      [
        { failed: true, error: `${privateValue} error`, guidance: `${privateValue} hint` },
        { failed: true, error: CODE_SECRET_ERRORS.incomplete },
      ],
      [
        { configured: true, name: "API", guidance: CODE_SECRET_GUIDANCE.keptDestination },
        { configured: true, name: "API", guidance: CODE_SECRET_GUIDANCE.keptDestination },
      ],
      [
        { configured: true, name: "API", guidance: privateValue },
        { configured: true, name: "API" },
      ],
    ] as const) {
      complete.mockClear();
      expect((await send(sent)).status).toBe(200);
      // The whole kept result: a dropped hint must be gone, not only the expected fields present.
      expect(complete.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ result: kept }));
      expect(JSON.stringify(complete.mock.calls)).not.toContain(privateValue);
    }
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
