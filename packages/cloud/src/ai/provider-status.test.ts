import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Provider } from "@k2b/nessi/ai";
import * as connections from "./provider-connections";
import { withProviderErrors } from "./provider-errors";

afterEach(() => mock.restore());

for (const mode of ["complete", "complete-error", "stream", "stream-error", "stream-issue"] as const)
  test(`provider status is settled before ${mode} returns`, async () => {
    const statusStarted = Promise.withResolvers<void>();
    const statusFinished = Promise.withResolvers<void>();
    const status = spyOn(connections, "recordAiProviderStatus").mockImplementation(async () => {
      statusStarted.resolve();
      await statusFinished.promise;
    });
    const provider: Provider = {
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: false },
      complete: async () => {
        if (mode === "complete-error") throw new TypeError("fixture");
        return { message: { role: "assistant", content: [] }, finishReason: "stop" };
      },
      async *stream() {
        if (mode === "stream-error") throw new TypeError("fixture");
        if (mode === "stream-issue") yield { type: "issue", issue: { kind: "provider_error", message: "fixture", retryable: false } };
      },
    };
    const safe = withProviderErrors(provider, "fixture");
    let settled = false;
    const call = (mode.startsWith("complete") ? safe.complete({ messages: [] }) : Array.fromAsync(safe.stream({ messages: [] }))).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        statusStarted.promise,
        call.then(() => {
          throw new Error("Provider settled without waiting for status persistence");
        }),
      ]);
      // Flush promise callbacks so a detached status write would let the provider call settle.
      await Bun.sleep(0);
      expect(settled).toBe(false);
      expect(status).toHaveBeenCalledTimes(1);
      expect(status.mock.calls[0]?.[1].status).toBe(
        mode === "complete" || mode === "stream" ? "ok" : mode === "stream-issue" ? "error" : "unreachable",
      );
    } finally {
      statusFinished.resolve();
      await call;
    }
    expect(settled).toBe(true);
  });
