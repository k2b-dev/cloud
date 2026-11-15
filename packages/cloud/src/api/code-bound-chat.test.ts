import { expect, test } from "bun:test";
import { CodeRunTokenClaimsSchema } from "../code/run-token";
import { dispatchCodeSdkCall } from "./capabilities";

const claims = CodeRunTokenClaimsSchema.parse({
  ver: 1,
  token_use: "code_run",
  iss: "https://cloud.example",
  aud: "cloud-code-bridge",
  iat: 1894003200,
  nbf: 1894003200,
  exp: 1894003500,
  codeId: "c_fixture",
  versionId: "c4330000-0000-4000-8000-000000000001",
  runId: "c4330000-0000-4000-8000-000000000002",
  generation: 1,
  mandateId: "c4330000-0000-4000-8000-000000000003",
  mandateRevision: 1,
  entrypoint: "morning",
  bundleHash: "a".repeat(64),
});
const call = { capability: "core.ai.chat.send", target: null, refs: {}, input: { text: "Review the facts." } };

test("the authenticated SDK ingress forwards the bound marker and leaves its resolution to the Core host", async () => {
  let received = false;
  const response = await dispatchCodeSdkCall({
    claims,
    operationId: call.capability,
    invocation: { call, metadata: { idempotencyKey: "morning" }, bound: "chat" },
    request: new Request("https://cloud.example/internal/code/call"),
    dependencies: {
      ownOrigins: async () => [],
      dispatch: { getCapability: async () => null },
      host: {
        withCall: async (input) => {
          received = true;
          expect(input.bound).toBe("chat");
          expect(input.call).toEqual(call);
          return Response.json({ ok: false, error: { code: "chat_unbound", status: 409 } });
        },
      },
    },
  });
  expect(received).toBe(true);
  expect(await response.json()).toEqual({ ok: false, error: { code: "chat_unbound", status: 409 } });
});

test.each([
  { ...call, capability: "core.ai.chat.read" },
  { ...call, target: { type: "core.ai.chat", id: "Claimed433" } },
  { ...call, refs: { destination: { type: "core.ai.chat", id: "Claimed433" } } },
])("a bound marker cannot decorate another operation or claim coordinates: %j", async (call) => {
  const response = await dispatchCodeSdkCall({
    claims,
    operationId: call.capability,
    invocation: { call, metadata: { idempotencyKey: "morning" }, bound: "chat" },
    request: new Request("https://cloud.example/internal/code/call"),
    dependencies: {
      ownOrigins: async () => [],
      host: {
        withCall: async () => {
          throw new Error("Invalid input reached the host");
        },
      },
    },
  });
  expect(await response.json()).toMatchObject({ ok: false, error: { code: "code_invalid_call" } });
});
