import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

async function runtime(sdk = generateCodeSdk([sdkFixture()], { mode: "personal" })) {
  const directory = await mkdtemp(join(tmpdir(), "l12-sdk-smoothing-"));
  const path = join(directory, "sdk.mjs");
  await writeFile(path, sdk.runtime);
  return import(path);
}
test("one schedule object carries metadata and forwards the durable run context", async () => {
  const sdk = await runtime();
  const context = { runId: "run-1", scheduledAt: "2026-11-11T08:00:00Z", input: { invoice: "one" } };
  let received: unknown;
  sdk.app.schedule({ cron: "0 8 * * *", name: "morning", title: "Morning" }, (c: unknown) => {
    received = c;
  });
  expect(sdk.__codeSdk.entries()).toEqual([{ kind: "schedule", entrypoint: "morning", cron: "0 8 * * *", title: "Morning" }]);
  await sdk.__codeSdk.run("morning", context);
  expect(received).toEqual(context);
  const manual = { runId: "manual-1", scheduledAt: null, input: null };
  await sdk.__codeSdk.run("morning", manual);
  expect(received).toEqual(manual);
  expect(() => sdk.app.schedule("0 8 * * *", () => {})).toThrow();
  expect(() => sdk.app.schedule({ cron: "0 8 * * *" }, () => {}, { name: "old" })).toThrow();
});
test("SDK CodeError preserves distinct refusal statuses and normalizes codes", async () => {
  const sdk = await runtime();
  let status = 403;
  sdk.__codeSdk.bind({
    call: async () => {
      throw { code: "MAIL-NOT-FOUND", status, message: "Unavailable", details: { retrySafe: true } };
    },
  });
  for (status of [403, 404]) {
    try {
      await sdk.work_shop.catalog.list({});
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(sdk.CodeError);
      expect(error).toMatchObject({ code: "mail_not_found", status, message: "Unavailable", details: { retrySafe: true } });
    }
  }
});
test("removed app stubs and visitor provider are absent from SDK and checker", async () => {
  const sdk = await runtime();
  for (const method of ["nav", "webhook", "fetch"]) expect(sdk.app[method]).toBeUndefined();
  const checked = analyzeCode({
    sdk: generateCodeSdk([], { mode: "personal" }),
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts":
        'import { app } from "@sdk"; app.nav(() => []); app.webhook("/", c => c.text("x")); app.fetch(new Request("https://x")); app.get("/", c => c.text(c.user?.provider)); app.get("/groups", c => c.json(c.user?.groups));',
    },
  });
  expect(checked.diagnostics.filter((d) => d.code === "code_removed_api").length).toBeGreaterThanOrEqual(5);
});

test("explicit visitor fields never confuse a username, group name or group ID", async () => {
  const sdk = await runtime();
  sdk.app.get("/user", (c: { user: { username: string } | null; json(value: unknown, status: number): Response }) =>
    c.json({}, c.user?.username === "foo" ? 200 : 403),
  );
  sdk.app.get("/group", (c: { user: { groupNames: string[] } | null; json(value: unknown, status: number): Response }) =>
    c.json({}, c.user?.groupNames.includes("foo") ? 200 : 403),
  );
  sdk.app.get("/group-id", (c: { user: { groupIds: string[] } | null; json(value: unknown, status: number): Response }) =>
    c.json({}, c.user?.groupIds.includes("foo") ? 200 : 403),
  );
  const request = { method: "GET", query: "", params: {}, contentType: "text/plain", body: "" };
  for (const [user, statuses] of [
    [{ id: "u1", username: "foo", groupIds: ["g1"], groupNames: ["other"], kind: "user", name: "Foo" }, [200, 403, 403]],
    [{ id: "u2", username: "other", groupIds: ["g2"], groupNames: ["foo"], kind: "user", name: "Other" }, [403, 200, 403]],
    [{ id: "u3", username: "other", groupIds: ["foo"], groupNames: ["g2"], kind: "user", name: "Other" }, [403, 403, 200]],
    [{ id: "foo", username: "other", groupIds: ["g1"], groupNames: ["g2"], kind: "user", name: "Other" }, [403, 403, 403]],
  ] as const) {
    for (const [index, path] of ["/user", "/group", "/group-id"].entries()) {
      const response = await sdk.__codeSdk.run(`route:GET:${path}`, { ...request, path, user });
      expect(response.status).toBe(statuses[index]);
    }
  }
});

test("target methods omit their repeated type path while preserving capability IDs", async () => {
  const manifest = sdkFixture("core");
  manifest.types = ["ai.chat", "ai.skill"].map((localId) => ({ localId, title: localId, description: localId }));
  const action = manifest.actions.find((action) => action.localId === "item.inspect")!;
  manifest.actions = [
    { ...action, localId: "ai.chat.run", target: "ai.chat" },
    { ...action, localId: "ai.skill.update", target: "ai.skill" },
  ];
  manifest.queries = [];
  manifest.events = [];
  const generated = generateCodeSdk([manifest], { mode: "personal" });
  const sdk = await runtime(generated);
  const calls: unknown[] = [];
  sdk.__codeSdk.bind({
    call: async (capability: string, invocation: unknown) => {
      calls.push({ capability, invocation });
      return {};
    },
  });
  await sdk.core.ai.chat("chat-1").run({});
  await sdk.core.ai.skill("skill-1").update({});
  expect(calls).toMatchObject([
    { capability: "core.ai.chat.run", invocation: { call: { target: { type: "core.ai.chat", id: "chat-1" } } } },
    { capability: "core.ai.skill.update", invocation: { call: { target: { type: "core.ai.skill", id: "skill-1" } } } },
  ]);
  expect(sdk.core.ai.chat("chat-1").ai).toBeUndefined();
  const check = (body: string) =>
    analyzeCode({
      sdk: generated,
      entry: "code.ts",
      aiOperations: [],
      files: {
        "code.ts": `import { app, core } from "@sdk"; app.schedule({ cron: "0 8 * * *" }, async () => { ${body} });`,
      },
    });
  expect(check('await core.ai.chat("chat-1").run({}); await core.ai.skill("skill-1").update({});').diagnostics).toEqual([]);
  expect(check('await core.ai.chat("chat-1").ai.chat.run({});').diagnostics.length).toBeGreaterThan(0);
});
