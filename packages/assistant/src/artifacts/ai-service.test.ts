import { expect, spyOn, test } from "bun:test";
import * as ai from "@k2b/cloud/ai";
import { runCodeAi } from "./ai-service";
import * as scope from "./runtime-scope";
import { ArtifactError, user } from "./service";
import { testIdentity } from "./test-identity";

const identity = testIdentity("00000000-0000-4000-8000-000000000001");
test("Code AI uses the caller's model access and allowance and propagates cancellation", async () => {
  const authorize = spyOn(scope, "authorizeRuntimeScope").mockResolvedValue({ scope: { resourceId: "aBc234" }, actor: user(identity) });
  const select = spyOn(ai, "selectAssistantAiModelId").mockResolvedValue("allowed-model");
  const execute = spyOn(ai, "executeAiTask").mockResolvedValue({ output: "Summary", usage: null });
  const abort = new AbortController();
  try {
    expect(
      await runCodeAi({ kind: "generate_text", prompt: "Summarize", input: "Text" }, { resourceId: "aBc234" }, identity, abort.signal),
    ).toBe("Summary");
    expect(select).toHaveBeenCalledWith(identity.accessSubject, undefined);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      usageSubject: identity.accessSubject,
      attribution: { userId: user(identity).id },
      signal: abort.signal,
      requestedModelId: "allowed-model",
      taskPrefix: "code",
    });
    select.mockRejectedValueOnce(new Error("Model not allowed"));
    await expect(runCodeAi({ kind: "generate_text", prompt: "Test" }, { resourceId: "aBc234" }, identity, abort.signal)).rejects.toThrow(
      "Model not allowed",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    abort.abort();
    await expect(runCodeAi({ kind: "generate_text", prompt: "Test" }, { resourceId: "aBc234" }, identity, abort.signal)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    authorize.mockRejectedValueOnce(new ArtifactError("ACCESS_DENIED"));
    await expect(
      runCodeAi({ kind: "generate_text", prompt: "Test" }, { resourceId: "aBc234" }, identity, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    authorize.mockRestore();
    select.mockRestore();
    execute.mockRestore();
  }
});
