import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import * as client from "./client";
import * as secrets from "./SecretsDialog";
import { createChatSecretRuntime } from "./secret-runtime";

const call = {
  name: "code_secret",
  args: { name: "api", origin: "https://example.com" },
  conversationId: "chat",
  turnId: "turn",
  callId: "call",
};
test("chat secret entry keeps claim/completion, returns no secret value and offers no code executor", async () => {
  let dispose = () => {};
  const request = spyOn(client, "chatCodeRequest").mockImplementation(async (path) => (path === "claim" ? { status: "execute" } : {}));
  const dialog = spyOn(secrets, "openSecretsDialog").mockResolvedValue({ configured: true, name: "api" });
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createChatSecretRuntime();
    });
    expect(Object.keys(runtime)).toEqual(["code_secret"]);
    expect(await runtime.code_secret(call)).toEqual({ configured: true, name: "api" });
    expect(request.mock.calls.map(([path]) => path)).toEqual(["claim", "complete"]);
    expect(dialog).toHaveBeenCalledWith(
      { conversationId: "chat" },
      expect.objectContaining({ name: "api", origin: "https://example.com" }),
      expect.any(AbortSignal),
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      conversationId: "chat",
      turnId: "turn",
      callId: "call",
      result: { configured: true, name: "api" },
    });
  } finally {
    dispose();
    request.mockRestore();
    dialog.mockRestore();
  }
});
test("completed or interrupted secret claims never reopen entry", async () => {
  let dispose = () => {};
  const request = spyOn(client, "chatCodeRequest");
  const dialog = spyOn(secrets, "openSecretsDialog");
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createChatSecretRuntime();
    });
    request.mockResolvedValue({ status: "done", result: { configured: true } });
    expect(await runtime.code_secret(call)).toEqual({ configured: true });
    request.mockResolvedValue({ status: "interrupted" });
    expect(await runtime.code_secret(call)).toMatchObject({ failed: true, error: expect.stringContaining("No entry was replayed") });
    expect(dialog).not.toHaveBeenCalled();
  } finally {
    dispose();
    request.mockRestore();
    dialog.mockRestore();
  }
});
test("chat secret entry rejects Studio resource contexts before claiming execution", async () => {
  let dispose = () => {};
  const request = spyOn(client, "chatCodeRequest");
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createChatSecretRuntime();
    });
    expect(await runtime.code_secret({ ...call, args: { ...call.args, resourceId: "App234" } })).toMatchObject({ failed: true });
    expect(request).not.toHaveBeenCalled();
  } finally {
    dispose();
    request.mockRestore();
  }
});
