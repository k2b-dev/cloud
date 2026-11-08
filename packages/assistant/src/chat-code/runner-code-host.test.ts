import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as codeExecution from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { generateCodeSdk } from "@k2b/cloud/code";
import { encodeChatValue } from "@k2b/cloud/code/chat-run";
import { z } from "zod";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { runtimeCapabilities } from "./capability-runtime";
import { runChatRunnerFixture } from "./runner-code.test-fixture";
import { createRunnerCodeHost as createManagedCodeHost } from "./runner-code-host";
import * as sdkProvider from "./runtime/code-run-sdk";
import { testIdentity } from "./test-identity";

useUnitClients();
const NOW = Date.UTC(2030, 0, 2);
afterEach(() => {
  jest.useRealTimers();
});
const manifest = compileCapabilityManifest("demo", {
  protocolVersion: 2,
  types: { folder: { title: "Folder", description: "Fixture folder" } },
  queries: {
    list: {
      title: "List",
      description: "Fixture list",
      target: "folder",
      openWorld: false,
      input: z.object({}).strict(),
      data: z.array(z.object({ name: z.string(), amount: z.number() })),
      run: () => {
        throw new Error("No live provider");
      },
    },
  },
});

/** Real Runner job dispatch and script bytes; this engine fixture only replaces Linux privilege isolation.
 * The image tests exercise the same chat-job adapter with the production workerd engine. */
function fixture(options: { remote?: boolean } = {}) {
  jest.setSystemTime(NOW);
  const sdk = spyOn(sdkProvider, "codeRunSdk").mockResolvedValue(generateCodeSdk([manifest], { mode: "code_run" }));
  const authorization = spyOn(codeExecution, "authorizeCodeExecution").mockResolvedValue({
    config: { kind: "chat", input: "Fixture" },
  } as Awaited<ReturnType<typeof codeExecution.authorizeCodeExecution>>);
  const calls: unknown[] = [];
  const capability = spyOn(runtimeCapabilities, "prepare").mockImplementation(async (request) => {
    calls.push(request);
    return { status: "completed", result: { ok: true, data: { data: [{ name: "Ada", amount: 12.5 }] } } };
  });
  const localPaths: string[] = [];
  const httpRequests: unknown[] = [];
  const approve = jest.fn(async (_request: unknown, _signal?: AbortSignal) => ({ approved: true }));
  const transport = jest.fn(async (_request: Request): Promise<Response> => {
    throw new Error("Unexpected live Core request");
  });
  const host = createManagedCodeHost({
    current: () => ({
      turnId: "22222222-2222-4222-8222-222222222222",
      context: {
        ...testIdentity("33333333-3333-4333-8333-333333333333"),
        conversationId: "11111111-1111-4111-8111-111111111111",
        locale: "en-US",
        timeZone: "UTC",
        signal: new AbortController().signal,
      },
    }),
    transport,
    fetch: async (path, init) => {
      localPaths.push(path);
      if (path === "/api/assistant/chat-code/runtime/http") {
        const body = JSON.parse(String(init?.body));
        httpRequests.push(body);
        return Response.json({
          id: body.id,
          url: body.request.url,
          method: body.request.method,
          headers: body.request.headers,
          bodyBytes: 4,
          bodyPreview: "test",
          bodyTruncated: false,
        });
      }
      if (path.startsWith("/api/assistant/chat-code/runtime/http/")) {
        const decision = JSON.parse(String(init?.body));
        httpRequests.push(decision);
        return decision.approved
          ? Response.json({ status: 200, headers: {}, body: btoa("response") })
          : Response.json({ code: "ACCESS_DENIED", message: "HTTP request denied" }, { status: 403 });
      }
      if (path.endsWith("/files") && init?.method === "POST") return Response.json({ file: { path: "/files/output.csv", version: 1 } });
      throw new Error(`Unexpected request ${path}`);
    },
    approve,
    start: options.remote ? undefined : runChatRunnerFixture,
  });
  const execute = (name: "code_run" | "code_inspect" | "code_stop" | "code_export", args: unknown, callId = "fixture-run") =>
    host.execute({
      name,
      args,
      callId,
      conversationId: "11111111-1111-4111-8111-111111111111",
      turnId: "22222222-2222-4222-8222-222222222222",
    });
  return {
    host,
    transport,
    execute,
    calls,
    localPaths,
    capability,
    authorization,
    approve,
    httpRequests,
    close: async () => {
      await host.close();
      sdk.mockRestore();
      capability.mockRestore();
      authorization.mockRestore();
    },
  };
}

test("code_run uses the runner fixture, generated SDK, same result card and captured CSV export without Chromium", async () => {
  const f = fixture();
  try {
    const result = await f.execute("code_run", {
      code: `import {demo, sheet} from "@sdk";
      export default async () => {
        const {data: rows} = await demo.folder(["dynamic", "folder"].join("-")).list({});
        await cloud.download("output.csv", await sheet.toCsv(rows, {bom:false}));
        console.info("calculated");
        return {answer:42, locale:cloud.locale};
      }`,
    });
    expect(result).toMatchObject({
      runId: "fixture-run",
      status: "ready",
      output: '{"answer":42,"locale":"en-US"}',
      userVisible: false,
      files: [{ name: "output.csv", type: "text/plain;charset=utf-8" }],
      logs: expect.arrayContaining([expect.objectContaining({ text: "calculated" })]),
    });
    expect(f.calls).toMatchObject([
      {
        name: "demo.list",
        target: { type: "demo.folder", id: "dynamic-folder" },
        refs: {},
        conversationId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    expect(await f.execute("code_export", { runId: "fixture-run", name: "output.csv" }, "export")).toMatchObject({
      path: "/files/output.csv",
      version: 1,
    });
    expect(await f.execute("code_stop", { runId: "fixture-run" }, "stop")).toEqual({ runId: "fixture-run", stopped: true });
  } finally {
    await f.close();
  }
}, 20_000);

test("code_run returns script exceptions and unavailable Studio database grants in its existing error/result fields", async () => {
  const f = fixture();
  try {
    expect(await f.execute("code_run", { code: 'export default () => {throw new Error("fixture failure");}' })).toMatchObject({
      status: "error",
      error: expect.stringContaining("fixture failure"),
    });
    expect(
      await f.execute(
        "code_run",
        { code: 'export default async () => {try {await cloud.db.list("rows");} catch(e) {return e.message;}}' },
        "db-run",
      ),
    ).toMatchObject({ status: "ready", output: expect.stringContaining("Studio RSQL database grants are unavailable") });
  } finally {
    await f.close();
  }
}, 20_000);

test("runner SDK HTTP keeps personal secret references and the turn approval decision", async () => {
  const f = fixture();
  try {
    const source = `import {http} from "@sdk"; export default async () => {
      const result = await http.fetch("https://api.example.com/data", {method:"POST",body:"test",headers:{authorization:"Bearer [secret:TOKEN]"}});
      return result.body;
    }`;
    expect(await f.execute("code_run", { code: source })).toMatchObject({ status: "ready", output: JSON.stringify(btoa("response")) });
    expect(f.httpRequests).toMatchObject([
      { request: { method: "POST", body: btoa("test"), headers: { authorization: { secret: "TOKEN", prefix: "Bearer " } } } },
      { approved: true },
    ]);
    expect(f.approve).toHaveBeenCalledTimes(1);
    f.approve.mockResolvedValue({ approved: false });
    expect(await f.execute("code_run", { code: source }, "denied-run")).toMatchObject({
      status: "error",
      error: expect.stringContaining("HTTP request denied"),
    });
  } finally {
    await f.close();
  }
}, 20_000);

test.each([true, false])(
  "runner capability Action waits for the turn decision (%s)",
  async (approved) => {
    const f = fixture();
    const id = "55555555-5555-4555-8555-555555555555";
    f.capability.mockResolvedValue({
      status: "approval",
      id,
      name: "demo.list",
      input: {},
      appName: "Demo",
      appIcon: "folder",
      appId: "demo",
      localId: "list",
      kind: "action",
      schemaHash: "fixture",
      approval: "rememberable",
      title: "List",
      review: null,
      allowAlways: false,
      scope: null,
    });
    const resolve = spyOn(runtimeCapabilities, "resolve").mockImplementation(async (_id, decision) => ({
      status: "completed",
      result: decision.approved
        ? { ok: true, data: { data: [{ name: "Approved", amount: 1 }] } }
        : { ok: false, error: { code: "denied", message: "Fixture Action rejected" } },
    }));
    f.approve.mockResolvedValue({ approved });
    try {
      const result = await f.execute("code_run", {
        code: 'import {demo} from "@sdk"; export default async()=>(await demo.folder("folder").list({})).data;',
      });
      expect(f.approve).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls[0]?.slice(0, 2)).toEqual([id, { approved }]);
      expect(result).toMatchObject(
        approved
          ? { status: "ready", output: '[{"name":"Approved","amount":1}]' }
          : { status: "error", error: expect.stringContaining("Fixture Action rejected") },
      );
    } finally {
      resolve.mockRestore();
      await f.close();
    }
  },
  20_000,
);

test("a late approval cannot execute after the runner mailbox has ended", async () => {
  const f = fixture({ remote: true });
  const id = "55555555-5555-4555-8555-555555555555";
  f.capability.mockResolvedValue({
    status: "approval",
    id,
    name: "demo.list",
    input: {},
    appName: "Demo",
    appIcon: "folder",
    appId: "demo",
    localId: "list",
    kind: "action",
    schemaHash: "fixture",
    approval: "rememberable",
    title: "List",
    review: null,
    allowAlways: false,
    scope: null,
  });
  const resolve = spyOn(runtimeCapabilities, "resolve").mockResolvedValue({
    status: "completed",
    result: { ok: false, error: { code: "denied", message: "cancelled" } },
  });
  let polled = false;
  f.transport.mockImplementation(async (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/start")) return Response.json({ id, deadlineAt: NOW + 60_000 });
    if (path.endsWith("/status")) return Response.json({ active: false });
    if (path.endsWith("/poll")) {
      if (polled) return Response.json({ state: "failed", result: { kind: "error", code: "code_job_failed" }, calls: [] });
      polled = true;
      return Response.json({
        state: "running",
        result: null,
        calls: [
          {
            id,
            operation: "chat.message",
            input: await encodeChatValue({
              type: "rpc",
              id: 1,
              method: "capabilities.run",
              args: ["demo.list", {}, { target: { type: "demo.folder", id: "folder" }, refs: {} }],
            }),
          },
        ],
      });
    }
    return Response.json({ resolved: true });
  });
  try {
    expect(await f.execute("code_run", { code: "export default()=>1" })).toMatchObject({ status: "error" });
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls.map((call) => call[1])).toEqual([{ approved: false }]);
  } finally {
    resolve.mockRestore();
    await f.close();
  }
}, 20_000);

test("closing a runner host drains a script that reported progress but never finishes", async () => {
  const f = fixture();
  try {
    expect(
      await f.execute("code_run", {
        code: 'export default async (_input,{progress})=>{progress(0,1,"Waiting");await new Promise(()=>{});}',
      }),
    ).toMatchObject({ status: "starting", work: { status: "running" } });
  } finally {
    await f.close();
  }
}, 20_000);

test("completed disposable runner results are reclaimed when the host reaches its run ceiling", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 33; index++)
      expect(await f.execute("code_run", { code: "export default()=>42" }, `pressure-${index}`)).toMatchObject({
        status: "ready",
        output: "42",
      });
    expect(await f.execute("code_inspect", { runId: "pressure-0" })).toMatchObject({
      failed: true,
      error: expect.stringContaining("no longer available"),
    });
  } finally {
    await f.close();
  }
}, 60_000);

test("signed chat code_run route resolves chat authority and executes through the runner fixture", async () => {
  const { Hono } = await import("hono");
  const { chatCodeToolRoutes } = await import("./code-tool-routes");
  const { agentHost } = await import("./agent-host");
  const identity = testIdentity("33333333-3333-4333-8333-333333333333");
  const f = fixture();
  const conversation = spyOn(codeExecution.aiConversations, "getConversation").mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    createdByUserId: identity.user.id,
    archivedAt: null,
    projectId: null,
  } as Awaited<ReturnType<typeof codeExecution.aiConversations.getConversation>>);
  const invocation = chatCodeToolRoutes.routes.filter((route) => route.path === "/code_run")[1];
  if (!invocation) throw new Error("Missing signed invocation middleware");
  // Replace only credential verification. Keep the registered tool handler, chat ownership and Runner execution real.
  const signed = spyOn(invocation, "handler").mockImplementation(async (_c, next) => next());
  const call = spyOn(agentHost, "call").mockImplementation(async (input, context) => {
    expect(context.actor).toEqual(identity.actor);
    expect(context.accessSubject).toEqual(identity.accessSubject);
    expect(context.conversationId).toBe("11111111-1111-4111-8111-111111111111");
    return {
      status: "done",
      result: await f.execute("code_run", input.args, input.callId),
      approvals: [],
      phase: undefined,
      receipts: [],
      moreReceipts: false,
    };
  });
  const router = new Hono<import("@k2b/cloud/server").AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      await next();
    })
    .route("/tools", chatCodeToolRoutes);
  try {
    const response = await router.request("/tools/code_run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "11111111-1111-4111-8111-111111111111",
        input: {
          name: "code_run",
          turnId: "22222222-2222-4222-8222-222222222222",
          callId: "signed-run",
          args: {
            code: 'import {demo} from "@sdk"; export default async()=>({rows:(await demo.folder("dynamic-folder").list({})).data});',
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { status: "done", result: { runId: "signed-run", status: "ready", output: '{"rows":[{"name":"Ada","amount":12.5}]}' } },
    });
    expect(f.calls).toHaveLength(1);
    conversation.mockResolvedValue(null);
    const denied = await router.request("/tools/code_run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "11111111-1111-4111-8111-111111111111",
        input: {
          name: "code_run",
          turnId: "22222222-2222-4222-8222-222222222222",
          callId: "denied",
          args: { code: "export default()=>42" },
        },
      }),
    });
    expect(denied.status).toBe(403);
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    signed.mockRestore();
    call.mockRestore();
    conversation.mockRestore();
    await f.close();
  }
}, 20_000);
