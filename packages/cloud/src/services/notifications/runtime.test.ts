import { expect, test } from "bun:test";

test("notification jobs preserve delivery recovery, retries, and bounded worker lifecycle", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    let processOptions, handler, declaration;
    let starts = 0, stops = 0, drains = 0, recoveryCalls = 0;
    let result = { status: "delivered" };
    let failure;
    const submitted = [], batches = [], processed = [], continuations = [];
    const job = {
      deadLetters: {},
      submit: async input => { submitted.push(input); return { jobId: "job" }; },
      submitMany: async inputs => { batches.push([...inputs]); return { accepted: inputs.length, duplicates: 0 }; },
      process: async (options, callback) => {
        starts++; processOptions = options; handler = callback;
        return { stop: () => { stops++; }, drain: async () => { drains++; } };
      },
    };
    mock.module(${JSON.stringify(new URL("../../_internal/process-sync.ts", import.meta.url).pathname)}, () => ({
      lazySync: factory => {
        let handle;
        return () => handle ??= factory({ job: config => { declaration = config; return job; } });
      },
    }));
    mock.module(${JSON.stringify(new URL("../logging/index.ts", import.meta.url).pathname)}, () => ({
      logger: () => ({ error() {} }), trace: { withSpan: (_options, callback) => callback() },
    }));
    mock.module(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).pathname)}, () => ({
      processNotificationDelivery: async id => { processed.push(id); if (failure) throw failure; return result; },
      recoverNotificationDeliveries: async () => { recoveryCalls++; return ["persisted-before-migration"]; },
    }));
    const { startNotificationRuntime, stopNotificationRuntime, enqueueNotificationDelivery } =
      await import(${JSON.stringify(new URL("./runtime.ts", import.meta.url).pathname)});
    await Promise.all([startNotificationRuntime({ concurrency: 7 }), startNotificationRuntime({ concurrency: 7 })]);
    assert.equal(starts, 1);
    assert.equal(processOptions.concurrency, 7);
    assert.equal(declaration.id, "cloud-notification-deliveries");
    assert.equal(declaration.owner, "core");
    assert.equal(recoveryCalls, 1);
    assert.deepEqual(batches[0][0].input, { deliveryId: "persisted-before-migration" });
    assert.equal(batches[0][0].coalesce, undefined);
    await enqueueNotificationDelivery("delayed", 2000);
    assert.deepEqual(submitted[0].input, { deliveryId: "delayed" });
    assert.equal(submitted[0].delayMs, 2000);
    assert.match(submitted[0].key, /^delivery:delayed:\\d+$/);
    const context = {
      input: { deliveryId: "delivery" },
      signal: new AbortController().signal,
      resubmit: options => continuations.push(options),
    };
    result = { status: "retry", retryAfterMs: 1234, error: "provider retry" };
    await handler(context);
    assert.deepEqual(continuations, [{ delayMs: 1234 }]);
    result = { status: "failed", activatedIds: ["fallback"] };
    await handler(context);
    assert.deepEqual(batches.at(-1)[0].input, { deliveryId: "fallback" });
    assert.equal(continuations.length, 1);
    failure = new Error("database unavailable");
    await assert.rejects(handler(context), /database unavailable/);
    assert.deepEqual(processOptions.onError({ context, error: failure }), { action: "retry", delayMs: 5000 });
    assert.deepEqual(processed, ["delivery", "delivery", "delivery"]);
    await Promise.all([stopNotificationRuntime(), stopNotificationRuntime()]);
    assert.equal(stops, 1);
    assert.equal(drains, 1);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
