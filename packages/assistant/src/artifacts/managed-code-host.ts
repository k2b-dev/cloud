import { parseCodeToolInput } from "@k2b/cloud/ai";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { createRunnerCodeHost } from "../chat-code/runner-code-host";
import { createCliCodeHost } from "../cli/code-host";

/** Only the surviving one-off path is eager. Studio checks/actions/presentations retain a lazy Chromium host. */
export function createManagedCodeHost(options: Parameters<typeof createRunnerCodeHost>[0], browserOptions?: { entry?: string }) {
  const runner = createRunnerCodeHost(options);
  let browser: ReturnType<typeof createCliCodeHost> | undefined;
  return {
    async execute(call: Parameters<AiFrontendToolHandler>[0], signal?: AbortSignal) {
      const input = parseCodeToolInput(call.name, call.args);
      if (input.operation === "run" || ("runId" in input && runner.has(input.runId))) return runner.execute(call);
      if (["inspect", "stop", "export"].includes(input.operation))
        return { failed: true, error: "Test run is no longer available. Inspect saved effects before starting a new run." };
      browser ??= createCliCodeHost({ fetch: options.fetch }, options.approve, browserOptions);
      return (await browser).execute(call, signal);
    },
    async health() {
      if (browser) await (await browser).health();
    },
    async close() {
      await runner.close();
      if (browser) await (await browser).close();
    },
  };
}
