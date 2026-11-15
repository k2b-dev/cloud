import { expect, test } from "bun:test";
import { aiChatSendAction } from "../../../core/src/ai-chat-send";
import { aiCapabilities } from "../../../core/src/capabilities";
import { compileCapabilities, invokeCompiledCapability } from "../_internal/capabilities";
import { analyzeCode } from "../code/checker-analysis";
import { generateCodeSdk } from "../code/generator";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import { userResourceContext } from "./projects.test-fixture";

const identity = userResourceContext({ type: "user", userId: "11111111-1111-4111-8111-111111111111" });
if (identity.actor.kind !== "user") throw new Error("Expected user fixture");
const fixtureUser = identity.actor.user;
const context: CapabilityExecutionContext = {
  ...identity,
  user: identity.actor.user,
  locale: "en",
  origin: "http",
  requestId: "delivery-test",
  idempotencyKey: "summary",
  signal: new AbortController().signal,
};
const compiled = compileCapabilities("core", aiCapabilities);
const action = compiled.actions.get("ai.chat.send")!;
const invoke = (text: string, ctx = context) =>
  invokeCompiledCapability({
    compiled,
    kind: "action",
    localId: "ai.chat.send",
    target: { type: "core.ai.chat", id: "Chat23" },
    input: { text },
    context: ctx,
    expectedSchemaHash: action.manifest.schemaHash,
  });

test("personal SDK offers the reviewed send Action", () => {
  const manifest = compiled.manifest;
  expect(action.manifest).toMatchObject({ target: "ai.chat", idempotency: "required" });
  expect(manifest.policies?.["ai.chat.send"]).toEqual({ silent: "you" });
  expect(
    generateCodeSdk([manifest], { mode: "personal" }).manifest.operations.some((op) => op.capability === "core.ai.chat.send"),
  ).toBeTrue();
});

test("callers without session authority cannot send", async () => {
  expect(await invoke("Result.")).toMatchObject({ ok: false, error: { code: "source_restricted" } });
  expect(await aiChatSendAction.review({ text: "Result." }, context)).toMatchObject({ ok: false, error: { code: "source_restricted" } });
});

test("resource Code cannot send even when its creator is a delegated person", async () => {
  const machine: CapabilityExecutionContext = {
    ...context,
    user: null,
    accessSubject: { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
    actor: {
      kind: "service_account",
      delegatedUser: null,
      scopes: ["read", "write"],
      serviceAccount: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Code account",
        kind: "code",
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: fixtureUser.id,
        createdAt: "2026-11-07T00:00:00Z",
      },
      delegation: {
        kind: "invocation",
        callingAppId: "core",
        credentialKind: "mandate",
        invocationId: "resource-code",
        workloadType: "code.version",
        workloadId: "33333333-3333-4333-8333-333333333333",
        workloadRun: "44444444-4444-4444-8444-444444444444",
      },
    },
  };
  expect(await invoke("Resource result.", machine)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
});

test("capability rejects blank/oversized messages and missing effect keys before any effect", async () => {
  for (const text of [" ", "x".repeat(10_001)])
    expect(await invoke(text)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  expect(await invoke("Result.", { ...context, idempotencyKey: undefined })).toMatchObject({
    ok: false,
    error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
  });
  expect(aiChatSendAction.input.safeParse({ text: "x".repeat(10_000) }).success).toBeTrue();
});

test("a personal recurring report checks with the actual generated send handle", () => {
  const sdk = generateCodeSdk([compiled.manifest], { mode: "personal" });
  const checked = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: ["core.ai.chat.send"],
    files: {
      "code.ts": `
import { app, core } from "@sdk";
app.schedule({ cron: "0 9 * * 1", timeZone: "Europe/Berlin", name: "weekly-report" }, async () => {
  await core.ai.chat("Chat23").send({ text: "Your weekly report is ready.", idempotencyKey: "weekly-report" });
});
export default app;
`,
    },
  });
  expect(checked.diagnostics).toEqual([]);
  expect(checked.ai).toBeTrue();
  expect(checked.permissions).toMatchObject([{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: "Chat23" } }]);
});
