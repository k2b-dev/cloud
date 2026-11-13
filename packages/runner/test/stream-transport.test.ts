import { expect, setSystemTime, test } from "bun:test";
import type { AppKey } from "@k2b/cloud/app-key";
import { RUNNER_PATHS } from "@k2b/cloud/code/runner";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../scripts/fixtures/app-key-fixtures";
import { CoreBridge } from "../src/bridge";
import { config } from "./fixtures";

// Core is stubbed: this verifies chunk assembly, not database costs in Core or the provider.
// Runner diagnostics go to stderr and child console output is discarded; there is no log-event stream.
test("runner transport assembles a capability reply split across output chunks", async () => {
  const key: AppKey = { installationId: INSTALLATION_ID, keyId: KEY_ID, appId: "runner", seed: APP_KEY_FIXTURES[0].seed };
  const pending = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = Object.assign(
    async (url: URL | RequestInfo) => {
      if (String(url).endsWith(RUNNER_PATHS.config)) return Response.json(config);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
            pending.resolve();
          },
        }),
      );
    },
    { preconnect: fetch.preconnect },
  );
  const bridge = new CoreBridge(key, "http://core.test", send);
  setSystemTime(new Date("2030-01-02T00:00:00Z"));
  try {
    await bridge.configure(AbortSignal.timeout(2_000));
    const signal = AbortSignal.timeout(2_000);
    const result = bridge.call({ runId: INSTALLATION_ID, generation: 1, token: "fixture", operation: "example.read", input: {} }, signal);
    await pending.promise;
    for (const chunk of ['{"ok":true,', '"data":', '{"text":"output"}}']) {
      output!.enqueue(encoder.encode(chunk));
      await Bun.sleep(0);
    }
    output!.close();
    expect(await result).toEqual({ ok: true, data: { text: "output" } });
  } finally {
    setSystemTime();
  }
});
