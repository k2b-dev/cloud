import { expect, test } from "bun:test";

// Exercise the shipped host adapter; only workerd's base class is replaced.
const source = await Bun.file(new URL("../src/assets/host.js", import.meta.url)).text();
const { Cloud } = await import(
  `data:text/javascript;base64,${Buffer.from(
    source
      .replace(
        'import consoleSource from "console-source";',
        `const consoleSource = ${JSON.stringify(await Bun.file(new URL("../src/assets/console.js", import.meta.url)).text())};`,
      )
      .replace(
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        "class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      ),
  ).toString("base64")}`
);

test.each(["disconnect", "http", "json"])("host transport failure (%s) exposes a stable code and status", async (failure) => {
  const host = new Cloud(
    { props: { runId: "run" } },
    {
      CAPABILITY: "private-capability",
      BRIDGE: {
        fetch: async () => {
          if (failure === "disconnect") throw new Error("private transport details");
          return new Response("private transport details", { status: failure === "http" ? 413 : 200 });
        },
      },
    },
  );
  await expect(host.call("example.read", null)).rejects.toMatchObject({
    code: "runner_bridge_unavailable",
    status: 503,
    message: "The Code bridge is unavailable.",
  });
});

test.each([403, 404, 429])("host preserves a structured refusal with status %s", async (status) => {
  const host = new Cloud(
    { props: { runId: "run" } },
    {
      BRIDGE: { fetch: async () => Response.json({ ok: false, error: { code: "example_refused", status } }) },
    },
  );
  await expect(host.call("example.read", null)).rejects.toMatchObject({
    code: "example_refused",
    status,
    message: "The Code call was refused.",
  });
});

// A successful HTTP transport must still carry a bridge response envelope.
test.each([null, true, [], {}, { ok: false }, { ok: false, error: null }].map((envelope) => ({ envelope })))(
  "host rejects a malformed JSON envelope (%j) with the stable transport error",
  async ({ envelope }) => {
    const host = new Cloud({ props: { runId: "run" } }, { BRIDGE: { fetch: async () => Response.json(envelope) } });
    await expect(host.call("example.read", null)).rejects.toMatchObject({
      code: "runner_bridge_unavailable",
      status: 503,
      message: "The Code bridge is unavailable.",
    });
  },
);

test("the shipped loader binds logger inside the isolate and keeps terminal errors text-free", async () => {
  const { CODE_OUTPUT_STEP_LIMITS, CODE_OUTPUT_INTERVAL_MS, CODE_OUTPUT_OPERATION, CodeOutputBatchSchema } = await import(
    "@k2b/cloud/code"
  );
  const { LIVE_LIMITS } = await import("@k2b/cloud/events/limits");
  const hostModule = await import(
    `data:text/javascript;base64,${Buffer.from(
      source
        .replace(
          'import consoleSource from "console-source";',
          `const consoleSource = ${JSON.stringify(await Bun.file(new URL("../src/assets/console.js", import.meta.url)).text())};`,
        )
        .replace(
          'import { WorkerEntrypoint } from "cloudflare:workers";',
          "class WorkerEntrypoint { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
        ),
    ).toString("base64")}`
  );
  const batches: unknown[] = [];
  const transport = {
    call: async (operation: string, input: unknown) => {
      expect(operation).toBe(CODE_OUTPUT_OPERATION);
      batches.push(CodeOutputBatchSchema.parse(input));
      return null;
    },
  };
  const env = {
    LOADER: {
      load(config: { modules: Record<string, string>; mainModule: string }) {
        const consoleUrl = `data:text/javascript;base64,${Buffer.from(config.modules["console.js"]!).toString("base64")}`;
        const bundleUrl = `data:text/javascript;base64,${Buffer.from(config.modules["bundle.js"]!).toString("base64")}`;
        const entry = config.modules[config.mainModule]!.replace(
          "import {WorkerEntrypoint} from 'cloudflare:workers';",
          "class WorkerEntrypoint { constructor(env){this.env=env;} }",
        )
          .replace("'./console.js'", JSON.stringify(consoleUrl))
          .replace("'./bundle.js'", JSON.stringify(bundleUrl))
          .replace("if (output) globalThis.console = output.console;", "");
        return {
          getEntrypoint: () => ({
            run: async (name: string, input: unknown) => {
              const module = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`);
              return new module.default({ cloud: transport }).run(name, input);
            },
          }),
        };
      },
    },
  };
  const request = new Request("http://host/run", {
    method: "POST",
    body: JSON.stringify({
      runId: "fixture",
      entrypoint: "main",
      input: null,
      modules: {},
      source: `export async function main(_,cloud) { const step=cloud.logger.step("Read"); step.start(); throw new Error("Document unavailable"); }`,
      outputLimits: {
        bytes: LIVE_LIMITS.frameBytes,
        intervalMs: CODE_OUTPUT_INTERVAL_MS,
        operation: CODE_OUTPUT_OPERATION,
        step: CODE_OUTPUT_STEP_LIMITS,
      },
    }),
  });
  const response = await hostModule.default.fetch(request, env, { exports: { Cloud: () => transport } });
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("{}");
  expect(batches).toContainEqual(
    expect.objectContaining({
      entries: expect.arrayContaining([expect.objectContaining({ kind: "step", status: "failed", message: "Document unavailable" })]),
    }),
  );
});
