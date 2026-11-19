import { afterAll, expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { createDomTestHarness } from "../../../ui/test/dom";
import * as client from "./client";
import type { SecretRequestController } from "./secret-request";

const dom = createDomTestHarness();
afterAll(() => dom.cleanup());
const [secrets, { createChatSecretRuntime }] = await Promise.all([import("./SecretsDialog"), import("./secret-runtime")]);

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
  const dialogResult = { configured: true, name: "api", value: "fixture-private-dialog-field" };
  const dialog = spyOn(secrets, "openSecretsDialog").mockResolvedValue(dialogResult);
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createChatSecretRuntime();
    });
    expect(Object.keys(runtime)).toEqual(["code_secret"]);
    expect(await runtime.code_secret(call)).toEqual({ configured: true, name: "api" });
    expect(request.mock.calls.map(([path]) => path)).toEqual(["claim", "complete"]);
    expect(JSON.stringify(request.mock.calls)).not.toContain(dialogResult.value);
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
    request.mockResolvedValue({ status: "done", result: { configured: true, name: "api" } });
    expect(await runtime.code_secret(call)).toEqual({ configured: true, name: "api" });
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

test("target preflight precedes a headless card, capability stores once and completion never carries the value", async () => {
  const { secretRequestPorts } = await import("./secret-request-client");
  const transport = await import("./secret-request-client");
  let dispose = () => {};
  const privateValue = "fixture-never-in-history";
  const request = spyOn(client, "chatCodeRequest").mockImplementation(async (path) => (path === "claim" ? { status: "execute" } : {}));
  const calls: string[] = [];
  const ports = spyOn(transport, "secretRequestPorts").mockReturnValue({
    async list() {
      calls.push("list");
      return { ok: true, entry: null };
    },
    async check() {
      calls.push("check");
      return true;
    },
    async save(input) {
      calls.push("save");
      expect(input.value).toBe(privateValue);
      return { ok: true };
    },
  });
  const logs = spyOn(console, "error");
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createChatSecretRuntime({
        present(controller) {
          calls.push("card");
          controller.input(privateValue);
          void controller.submit();
        },
      });
    });
    const result = await runtime.code_secret({
      ...call,
      args: { ...call.args, prefix: "", target: { code: "Abc234", pathPrefix: "/v1" } },
    });
    expect(result).toEqual({ configured: true, name: "api" });
    expect(calls).toEqual(["list", "check", "card", "check", "save"]);
    expect(JSON.stringify(request.mock.calls)).not.toContain(privateValue);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateValue);
    expect(secretRequestPorts).toBeDefined();
  } finally {
    dispose();
    request.mockRestore();
    ports.mockRestore();
    logs.mockRestore();
  }
});

for (const code of ["FORBIDDEN", "NOT_FOUND"])
  test(`target ${code}: no card, completion explains editor right without value`, async () => {
    const transport = await import("./secret-request-client");
    let dispose = () => {};
    let shown = false;
    const request = spyOn(client, "chatCodeRequest").mockImplementation(async (path) => (path === "claim" ? { status: "execute" } : {}));
    const ports = spyOn(transport, "secretRequestPorts").mockReturnValue({
      async list() {
        return { ok: false, code, status: 403 };
      },
      async check() {
        throw new Error("must not check");
      },
      async save() {
        throw new Error("must not save");
      },
    });
    try {
      const runtime = createRoot((cleanup) => {
        dispose = cleanup;
        return createChatSecretRuntime({
          present() {
            shown = true;
          },
        });
      });
      expect(
        await runtime.code_secret({ ...call, args: { ...call.args, prefix: "", target: { code: "Abc234", pathPrefix: "/v1" } } }),
      ).toMatchObject({ failed: true, guidance: expect.stringContaining("edit this automation") });
      expect(shown).toBe(false);
      expect(request.mock.calls.map(([path]) => path)).toEqual(["claim", "complete"]);
    } finally {
      dispose();
      request.mockRestore();
      ports.mockRestore();
    }
  });

for (const completionFails of [false, true])
  test(`lease expiry while saving returns an uncertain outcome even when completion ${completionFails ? "fails" : "succeeds"}`, async () => {
    const transport = await import("./secret-request-client");
    const privateValue = "fixture-private-expired-save";
    let dispose = () => {};
    let controller: SecretRequestController | undefined;
    const request = spyOn(client, "chatCodeRequest").mockImplementation(async (path) => {
      if (path === "claim") return { status: "execute" };
      if (completionFails) throw new Error(privateValue);
      return {};
    });
    const ports = spyOn(transport, "secretRequestPorts").mockReturnValue({
      async list() { return { ok: true, entry: null }; },
      async check() { return true; },
      async save(input) {
        expect(input.value).toBe(privateValue);
        controller?.expire();
        return { ok: true };
      },
    });
    const logs = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = createRoot((cleanup) => {
        dispose = cleanup;
        return createChatSecretRuntime({ present(current) {
          controller = current;
          current.input(privateValue);
          void current.submit();
        } });
      });
      const result = await runtime.code_secret({ ...call, args: { ...call.args, prefix: "", target: { code: "Abc234", pathPrefix: "/v1" } } });
      expect(result).toMatchObject({ failed: true, error: "Secret save outcome is unknown." });
      expect(controller?.state.state).toBe("outcome-unknown");
      expect(request.mock.calls.map(([path]) => path)).toEqual(["claim", "complete"]);
      expect(request.mock.calls[1]?.[1]).toMatchObject({ result: { failed: true, error: "Secret save outcome is unknown." } });
      expect(JSON.stringify([result, controller?.state, request.mock.calls, logs.mock.calls])).not.toContain(privateValue);
    } finally {
      dispose();
      request.mockRestore();
      ports.mockRestore();
      logs.mockRestore();
    }
  });
