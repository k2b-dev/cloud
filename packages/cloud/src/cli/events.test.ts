import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import events from "./events";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "./index";

const fixture = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "core.user.created",
  version: 1,
  source: "core",
  time: "2026-01-01T00:00:00Z",
  subject: { type: "core.user", id: "fixture-user" },
  data: { userId: "fixture-user", provider: "local" },
};
const catalog = {
  events: [
    {
      type: fixture.type,
      version: 1,
      title: "User created",
      description: "A user was created.",
      subject: "core.user",
      place: null,
      automation: true,
      dataSchema: z.toJSONSchema(z.object({ userId: z.string().max(256), provider: z.string().max(80) }).strict()),
      subscribers: [],
    },
  ],
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "cloud-event-cli-"));
  dirs.push(path);
  return path;
};
const context = (
  args: string[],
  flags: CloudCliFlags = {},
  output: CloudCliOutputMode = "json",
  respond: (path: string) => Response = () => Response.json(catalog),
) => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const printed: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://cloud.test", token: "fixture", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, init });
      return respond(path);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return response.json();
    },
    print: (value) => {
      printed.push(value);
    },
    write: async (value) => {
      printed.push(value);
    },
    error: (value) => {
      printed.push(value);
    },
    json: (value) => {
      printed.push(value);
    },
    jsonLine: (value) => {
      printed.push(value);
    },
    table: (value) => {
      printed.push(value);
    },
  };
  return { ctx, requests, printed };
};

test.each(["text", "json", "jsonl"] as const)("catalog and paginated deliveries preserve %s output", async (output) => {
  const list = context(["ls"], { app: "core" }, output);
  await events.run(list.ctx);
  expect(list.requests).toEqual([{ path: "/api/app-events/catalog", init: undefined }]);
  expect(list.printed).toEqual([output === "text" ? catalog.events : catalog]);
  const page = {
    items: [{ id: "delivery-1", state: "failed", attempts: 8 }],
    pagination: { offset: 2, limit: 3, total: 5 },
  };
  const deliveries = context(
    ["deliveries"],
    { app: "demo", state: "failed", "event-type": fixture.type, offset: "2", limit: "3" },
    output,
    () => Response.json(page),
  );
  await events.run(deliveries.ctx);
  const url = new URL(deliveries.requests[0]!.path, "https://cloud.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    app: "demo",
    state: "failed",
    eventType: fixture.type,
    offset: "2",
    limit: "3",
  });
  expect(deliveries.printed).toEqual([output === "text" ? page.items : page]);
});

test("help and missing confirmation never call Cloud", async () => {
  const help = context(["record"], { help: true });
  help.ctx.options.locale = "de";
  await events.run(help.ctx);
  expect(help.printed.join("\n")).toContain("synthetischen");
  expect(help.requests).toEqual([]);
  for (const [args, flags, message] of [
    [["record", fixture.type], {}, "--shape-only"],
    [["record", fixture.type], { "shape-only": true, limit: "101" }, "100"],
    [["redeliver", "delivery-1"], {}, "--yes"],
    [["acknowledge-gap"], {}, "--yes"],
  ] as const) {
    const blocked = context([...args], flags);
    await expect(events.run(blocked.ctx)).rejects.toThrow(message);
    expect(blocked.requests).toEqual([]);
  }
});

test("redeliver, subscriptions and status use their administrative API routes", async () => {
  const redelivery = context(["redeliver", "a/b"], { yes: true }, "jsonl", () => Response.json({ queued: true }));
  await events.run(redelivery.ctx);
  expect(redelivery.requests).toEqual([{ path: "/api/app-events/deliveries/a%2Fb/redeliver", init: { method: "POST" } }]);
  expect(redelivery.printed).toEqual([{ queued: true }]);
  for (const [args, flags, path] of [
    [["subscriptions"], { app: "demo" }, "/api/app-events/subscriptions?app=demo"],
    [["status"], {}, "/api/app-events/status"],
  ] as const) {
    const result = context([...args], flags);
    await events.run(result.ctx);
    expect(result.requests[0]?.path).toBe(path);
  }
});

test("record exports JSONL, JSON arrays and exclusive files", async () => {
  const line = `${JSON.stringify(fixture)}\n`;
  for (const output of ["text", "json", "jsonl"] as const) {
    const recording = context(["record", fixture.type], { "shape-only": true, limit: "1" }, output, () => new Response(line));
    await events.run(recording.ctx);
    expect(recording.requests[0]?.path).toBe("/api/app-events/record/core.user.created?shapeOnly=true&limit=1");
    expect(recording.printed).toEqual([output === "json" ? [fixture] : line]);
  }
  const out = join(await directory(), "fixtures.jsonl");
  const recording = context(["record", fixture.type], { "shape-only": true, out }, "json", () => new Response(line));
  await events.run(recording.ctx);
  expect(await readFile(out, "utf8")).toBe(line);
  await expect(events.run(recording.ctx)).rejects.toThrow();
  expect(await readFile(out, "utf8")).toBe(line);
});

test("record refuses invalid, excessive and oversized fixtures and propagates authorization errors", async () => {
  for (const body of ["not json\n", `${JSON.stringify(fixture)}\n`.repeat(2), "x".repeat(4097)]) {
    const invalid = context(["record", fixture.type], { "shape-only": true, limit: "1" }, "text", () => new Response(body));
    await expect(events.run(invalid.ctx)).rejects.toThrow();
    expect(invalid.printed).toEqual([]);
  }
  const denied = context(["record", fixture.type], { "shape-only": true }, "json", () =>
    Response.json({ code: "FORBIDDEN" }, { status: 403 }),
  );
  await expect(events.run(denied.ctx)).rejects.toThrow("403");
});

test("replay validates current schemas and only sends the catalog request", async () => {
  const dir = await directory();
  const input = join(dir, "fixtures.jsonl");
  const result = join(dir, "handled.jsonl");
  const handler = join(dir, "handler.ts");
  await writeFile(
    handler,
    `import { appendFile } from "node:fs/promises"; export async function handle(event, context) {
      if (context.subscriptionId !== "replay:core.user.created@1" || context.eventId !== event.id || context.attempt !== 1 || context.signal.aborted) throw new Error("Invalid context");
      await appendFile(${JSON.stringify(result)}, JSON.stringify(event) + "\\n");
    }`,
  );
  await writeFile(input, `${JSON.stringify(fixture)}\n`);
  const replay = context(["replay", input], { handler: `${handler}#handle` });
  await events.run(replay.ctx);
  expect(replay.requests).toEqual([{ path: "/api/app-events/catalog", init: undefined }]);
  expect(await readFile(result, "utf8")).toBe(`${JSON.stringify(fixture)}\n`);
  expect(replay.printed).toEqual([{ delivered: 1 }]);
  for (const invalid of [
    { ...fixture, version: 2 },
    { ...fixture, data: { userId: 123, provider: "local" } },
    { ...fixture, source: "other" },
    { ...fixture, subject: { type: "core.other", id: "fixture-user" } },
  ]) {
    await writeFile(input, `${JSON.stringify(invalid)}\n`);
    await expect(events.run(replay.ctx)).rejects.toThrow("0 completed");
  }
  expect(await readFile(result, "utf8")).toBe(`${JSON.stringify(fixture)}\n`);
});

test("replay supports a default export and reports partial progress without hiding the failure", async () => {
  const dir = await directory();
  const input = join(dir, "fixtures.jsonl");
  const handler = join(dir, "handler.ts");
  await writeFile(handler, 'let count = 0; export default async () => { if (++count === 2) throw new Error("Try again after repair"); };');
  await writeFile(input, `${JSON.stringify(fixture)}\n`.repeat(2));
  const replay = context(["replay", input], { handler });
  await expect(events.run(replay.ctx)).rejects.toThrow("1 completed fixtures: Try again after repair");
  expect(replay.requests.map((request) => request.path)).toEqual(["/api/app-events/catalog"]);
  expect(replay.printed).toEqual([]);
});

test("record decodes UTF-8 across stream chunks and rejects jsonb-size overflow", async () => {
  const value = { ...fixture, data: { userId: "Müller", provider: "local" } };
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const recording = context(
    ["record", fixture.type],
    { "shape-only": true },
    "json",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
      ),
  );
  await events.run(recording.ctx);
  expect(recording.printed).toEqual([[value]]);
  const oversized = { ...fixture, data: { values: Array.from({ length: 1400 }, () => 0) } };
  expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeLessThan(4096);
  const invalid = context(["record", fixture.type], { "shape-only": true }, "json", () => new Response(JSON.stringify(oversized)));
  await expect(events.run(invalid.ctx)).rejects.toThrow("Invalid event fixture");
});

test("acknowledge-gap calls the audited administrator endpoint only after confirmation", async () => {
  const acknowledged = context(["acknowledge-gap"], { yes: true }, "json", () => Response.json({ state: "ready" }));
  await events.run(acknowledged.ctx);
  expect(acknowledged.requests).toEqual([{ path: "/api/app-events/status/acknowledge", init: { method: "POST" } }]);
  expect(acknowledged.printed).toEqual([{ state: "ready" }]);
});
