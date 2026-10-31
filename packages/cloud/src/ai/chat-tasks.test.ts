import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import * as mandates from "../services/mandates";
import { AiChatTaskAuthorityError, aiChatTasks } from "./chat-tasks";

afterEach(() => mock.restore());

const call = {
  mandate: { id: "11111111-1111-4111-8111-111111111111", revision: 3 },
  appId: "spaces",
  capabilityId: "space.list",
  kind: "query" as const,
  input: { status: "done" },
};

describe("background capability authorization errors", () => {
  test("preserves a policy denial code and gives the model a recovery instruction", async () => {
    const authorize = spyOn(mandates, "validateMandateIssueAuthority").mockResolvedValue(
      fail(err.forbidden("Mandate policy does not allow this operation")),
    );
    await expect(aiChatTasks.authorizeCapability(call)).rejects.toMatchObject({
      code: "MANDATE_POLICY_DENIED",
      message:
        "This task's grants do not allow spaces.space.list with these inputs; continue with the granted tools or explain what is missing.",
    });
    expect(authorize).toHaveBeenCalledWith({
      mandateId: call.mandate.id,
      expectedRevision: 3,
      ownerAppId: "core",
      targetAppId: "spaces",
      operation: "capability.query:space.list",
      input: call.input,
      capabilityApproval: undefined,
    });
  });

  test.each([
    err.forbidden("Mandate is unavailable"),
    err.forbidden("Mandate is not active"),
    err.forbidden("Mandate policy is invalid"),
    err.conflict("Mandate revision changed"),
  ])("preserves other authority failures without classifying them as policy denials: %j", async (error) => {
    spyOn(mandates, "validateMandateIssueAuthority").mockResolvedValue(fail(error));
    await expect(aiChatTasks.authorizeCapability(call)).rejects.toBeInstanceOf(AiChatTaskAuthorityError);
    await expect(aiChatTasks.authorizeCapability(call)).rejects.toMatchObject({
      code: error.code,
      message: expect.stringContaining(error.message),
    });
  });
});

test("legacy task grants require target-aware support for resource-bound operations", async () => {
  const { compileCapabilities } = await import("../_internal/capabilities");
  const registry = await import("../_internal/registry");
  const { z } = await import("zod");
  const manifest = compileCapabilities("demo", {
    protocolVersion: 2,
    types: { book: { title: "Book", description: "A book." } },
    actions: {
      write: {
        title: "Write",
        description: "Write a book.",
        target: "book",
        approval: "none",
        idempotency: "none",
        destructive: false,
        openWorld: false,
        input: z.object({ title: z.string().describe("Title.") }).strict(),
        data: z.object({}).strict(),
        run: () => ({ ok: true, data: { data: {} } }),
      },
    },
  }).manifest;
  spyOn(registry, "getCapability").mockResolvedValue({
    appId: "demo",
    appName: "Demo",
    appIcon: "ti ti-book",
    appDescription: "Demo",
    endpoint: "http://demo.test",
    manifest,
  });
  await expect(aiChatTasks.validateGrants([{ appId: "demo", capabilityId: "write", kind: "action", fixedInput: {} }])).rejects.toThrow(
    "target-aware mandate",
  );
});
