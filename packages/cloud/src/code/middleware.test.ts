import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeContext } from "./authoring-types";
import { requireCodeCapabilityDeclared } from "./capability-set";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkBridge } from "./types";

const sdk = generateCodeSdk([sdkFixture()], { mode: "personal" });
const analyze = (source: string, files: Record<string, string> = {}) =>
  analyzeCode({ sdk, entry: "code.ts", aiOperations: [], files: { ...files, "code.ts": source } });
async function runtime() {
  const directory = await mkdtemp(join(tmpdir(), "l12-code-middleware-"));
  const path = join(directory, "sdk.mjs");
  await writeFile(path, sdk.runtime);
  return import(path);
}
const request = (path: string, query = "") => ({
  method: "GET",
  path,
  query,
  params: {},
  contentType: "text/plain",
  body: "",
  user: { id: "u_one", username: "one", groupIds: [], groupNames: [], kind: "user", name: "One" },
});

test("middleware can abort with a checked Response before the handler", async () => {
  const module = await runtime();
  let handled = false;
  module.app.use((c: CodeContext) => c.json({ error: "forbidden" }, 403));
  module.app.get("/", (c: CodeContext) => {
    handled = true;
    return c.text("unexpected");
  });
  expect(await module.__codeSdk.run("route:GET:/", request("/"))).toEqual({ kind: "json", status: 403, body: '{"error":"forbidden"}' });
  expect(handled).toBe(false);
});

test("middleware registration order nests next and only covers later routes", async () => {
  const module = await runtime();
  const order: string[] = [];
  module.app.get("/before", (c: CodeContext) => c.text("before"));
  module.app.use(async (_c: CodeContext, next: () => Promise<Response>) => {
    order.push("a-before");
    const response = await next();
    order.push("a-after");
    return response;
  });
  module.app.get("/middle", (c: CodeContext) => {
    order.push("middle");
    return c.text("middle");
  });
  module.app.use(async (_c: CodeContext, next: () => Promise<Response>) => {
    order.push("b-before");
    await next();
    order.push("b-after");
  });
  module.app.get("/after", (c: CodeContext) => {
    order.push("handler");
    return c.text("after");
  });
  await module.__codeSdk.run("route:GET:/before", request("/before"));
  expect(order).toEqual([]);
  await module.__codeSdk.run("route:GET:/middle", request("/middle"));
  expect(order).toEqual(["a-before", "middle", "a-after"]);
  order.length = 0;
  expect(await module.__codeSdk.run("route:GET:/after", request("/after"))).toMatchObject({ body: "after" });
  expect(order).toEqual(["a-before", "b-before", "handler", "b-after", "a-after"]);
});

test("middleware prefixes match the path and children without matching sibling names", async () => {
  const module = await runtime();
  const visited: string[] = [];
  module.app.use("/private", async (c: CodeContext, next: () => Promise<Response>) => {
    visited.push(new URL(c.req.raw.url).pathname);
    return next();
  });
  for (const path of ["/private", "/private/:id", "/privately", "/public"]) module.app.get(path, (c: CodeContext) => c.text("ok"));
  for (const [route, path] of [
    ["/private", "/private"],
    ["/private/:id", "/private/one"],
    ["/privately", "/privately"],
    ["/public", "/public"],
  ])
    await module.__codeSdk.run(`route:GET:${route}`, request(path!));
  expect(visited).toEqual(["/private", "/private/one"]);
});

test("middleware variables belong to one request including overlapping requests", async () => {
  const module = await runtime();
  type Context = CodeContext<{ kunde: string }>;
  module.app.use(async (c: Context, next: () => Promise<Response>) => {
    expect(c.get("kunde")).toBeUndefined();
    c.set("kunde", c.req.query("id") ?? "missing");
    await Promise.resolve();
    return next();
  });
  module.app.get("/", (c: Context) => c.text(c.get("kunde")));
  const responses = await Promise.all(["one", "two", "three"].map((id) => module.__codeSdk.run("route:GET:/", request("/", `?id=${id}`))));
  expect(responses.map((response) => response.body)).toEqual(["one", "two", "three"]);
});

test("public routes run middleware with a null user even with a signed-in input", async () => {
  const module = await runtime();
  let visitor: unknown = "not run";
  module.app.use(async (c: CodeContext, next: () => Promise<Response>) => {
    visitor = c.user;
    return next();
  });
  module.app.get("/public", (c: CodeContext) => c.json(c.user), { public: true });
  expect(await module.__codeSdk.run("route:GET:/public", request("/public"))).toEqual({ kind: "json", status: 200, body: "null" });
  expect(visitor).toBeNull();
});

test("middleware SDK calls are attributed only to subsequent potentially matching routes", () => {
  const checked = analyze(`import { app, work_shop } from "@sdk";
app.get("/before", c => c.text("ok"));
app.use("/private", async (c, next) => { await work_shop.catalog.list({}); return next(); });
app.get("/private/:id", c => c.text("ok"));
app.get("/public", c => c.text("ok"), { public: true });
app.post("/private", c => c.text("ok"));
app.schedule({ cron: "0 8 * * *" }, () => {});`);
  expect(checked.diagnostics).toEqual([]);
  expect(checked.permissions).toMatchObject([
    { operation: "work-shop.catalog.list", entrypoints: ["route:GET:/private/:id", "route:POST:/private"] },
  ]);
  expect(checked.entrypoints).toHaveLength(5);
});

test("middleware registration must be static, including its prefix", () => {
  for (const registration of [
    "if (true) app.use((c, next) => next());",
    "function setup() { app.use((c, next) => next()); }",
    `app.use(JSON.parse('"/private"'), (c, next) => next());`,
  ])
    expect(
      analyze(`import { app } from "@sdk"; ${registration} app.get("/", c => c.text("ok"));`).diagnostics.some(
        (d) => d.code === "code_static_middleware",
      ),
    ).toBe(true);
});

test("middleware SDK calls pass the same declared-set guard before dispatch", async () => {
  const module = await runtime();
  const checked = analyze(`import { app, work_shop } from "@sdk";
app.use(async (c, next) => { await work_shop.catalog.list({}); return next(); });
app.get("/", c => c.text("ok"));`);
  expect(checked.diagnostics).toEqual([]);
  let declared = false;
  let dispatched = 0;
  const bridge: CodeSdkBridge = {
    async call(_operation, input) {
      if (!("call" in input)) throw new Error("unexpected HTTP call");
      requireCodeCapabilityDeclared(input.call, declared ? checked.permissions : []);
      dispatched++;
      return { data: [] };
    },
  };
  module.__codeSdk.bind(bridge);
  module.app.use(async (_c: CodeContext, next: () => Promise<Response>) => {
    await module.work_shop.catalog.list({});
    return next();
  });
  module.app.get("/", (c: CodeContext) => c.text("ok"));
  await expect(module.__codeSdk.run("route:GET:/", request("/"))).rejects.toMatchObject({
    code: "code_capability_undeclared",
    status: 403,
  });
  expect(dispatched).toBe(0);
  declared = true;
  expect(await module.__codeSdk.run("route:GET:/", request("/"))).toMatchObject({ status: 200 });
  expect(dispatched).toBe(1);
});

test("a repeated next is refused and missing next never silently succeeds", async () => {
  for (const repeat of [false, true]) {
    const module = await runtime();
    let handled = 0;
    module.app.use(async (_c: CodeContext, next: () => Promise<Response>) => {
      if (repeat) {
        await next();
        return next();
      }
    });
    module.app.get("/", (c: CodeContext) => {
      handled++;
      return c.text("ok");
    });
    await expect(module.__codeSdk.run("route:GET:/", request("/"))).rejects.toMatchObject({
      code: repeat ? "code_middleware_next_called_twice" : "code_invalid_response",
    });
    expect(handled).toBe(repeat ? 1 : 0);
  }
});

test("prefix checks decode literal segments and cover every HTTP method without touching schedules", async () => {
  const module = await runtime();
  module.app.use("/private/", (c: CodeContext) => c.text("denied", 403));
  for (const method of ["get", "post", "put", "delete", "all"]) module.app[method]("/:scope/:id", (c: CodeContext) => c.text("unexpected"));
  for (const method of ["GET", "POST", "PUT", "DELETE", "ALL"])
    expect(
      await module.__codeSdk.run(`route:${method}:/:scope/:id`, {
        ...request("/%70rivate/one"),
        method: method === "ALL" ? "PATCH" : method,
      }),
    ).toEqual({ kind: "text", status: 403, body: "denied" });
  let scheduled = false;
  module.app.schedule({ cron: "0 8 * * *", name: "tick" }, () => {
    scheduled = true;
  });
  await module.__codeSdk.run("tick", {});
  expect(scheduled).toBe(true);
});

test("named middleware in imported modules follows ESM evaluation order and route parameter overlap", () => {
  const checked = analyze(
    `import { app } from "@sdk"; import "./access";
app.get("/:scope/account", c => c.text("ok"));
app.get("/elsewhere", c => c.text("ok"));`,
    {
      "access.ts": `import { app, work_shop, type CodeMiddleware } from "@sdk";
const check: CodeMiddleware = async (c, next) => { await work_shop.catalog.list({}); return next(); };
app.use("/private", check);`,
    },
  );
  expect(checked.diagnostics).toEqual([]);
  expect(checked.permissions).toMatchObject([{ operation: "work-shop.catalog.list", entrypoints: ["route:GET:/:scope/account"] }]);
});

test("middleware may turn a caught downstream failure into a checked response", async () => {
  const module = await runtime();
  module.app.use(async (c: CodeContext, next: () => Promise<Response>) => {
    try {
      return await next();
    } catch {
      return c.json({ error: "unavailable" }, 503);
    }
  });
  module.app.get("/", () => {
    throw new Error("downstream unavailable");
  });
  expect(await module.__codeSdk.run("route:GET:/", request("/"))).toEqual({ kind: "json", status: 503, body: '{"error":"unavailable"}' });
});

test("middleware prefix evidence cannot be forged with a literal type assertion", () => {
  const checked = analyze(`import { app, work_shop } from "@sdk";
app.use(JSON.parse('"/"') as "/private", async (c, next) => { await work_shop.catalog.list({}); return next(); });
app.get("/private", c => c.text("ok"));
app.get("/public", c => c.text("ok"), { public: true });`);
  expect(checked.diagnostics.some((d) => d.code === "code_static_middleware")).toBe(true);
});

test("app registration cannot escape through reflection or structurally erased aliases", () => {
  for (const source of [
    "Reflect.apply(app.use, app, [async (c: CodeContext, next: CodeNext) => next()]);",
    'Reflect.apply(Reflect.get(app, "use"), app, [async (c: CodeContext, next: CodeNext) => next()]);',
    'const routes = app.use<{ label: string }>(async (c, next) => next()); Reflect.get(routes, "use");',
  ])
    expect(
      analyze(`import { app, type CodeContext, type CodeNext } from "@sdk"; ${source} app.get("/", c => c.text("ok"));`).diagnostics.length,
    ).toBeGreaterThan(0);
});
