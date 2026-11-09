import { expect, test } from "bun:test";

// Exercise the shipped host adapter; only workerd's base class is replaced.
const source = await Bun.file(new URL("../src/assets/host.js", import.meta.url)).text();
const { Cloud } = await import(
  `data:text/javascript;base64,${Buffer.from(
    source.replace(
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
