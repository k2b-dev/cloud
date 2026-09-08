import { expect, test } from "bun:test";

test("telemetry enables original-consumer recovery and drains it on shutdown", async () => {
  // Keep the public service mock isolated from other Gateway-Ops tests.
  const serviceUrl = new URL("./telemetry.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    const abort = new AbortController();
    let registered = false;
    let drained = false;
    mock.module("@valentinkolb/cloud/services", () => ({
      GATEWAY_TELEMETRY_TENANT: "ops",
      gatewayTelemetryTopic: () => ({ process: async (options, handler) => {
        if (options.consumer !== "postgres-writer" || options.tenantId !== "ops" || options.recoverDeadLetters !== true || typeof handler !== "function") throw new Error("Recovery contract missing");
        registered = true;
        abort.abort();
        return { drain: async () => { drained = true; } };
      } }),
    }));
    const { consumeTelemetry } = await import(${JSON.stringify(serviceUrl)});
    await consumeTelemetry(abort.signal);
    console.log(JSON.stringify({ registered, drained }));
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual({ registered: true, drained: true });
});
