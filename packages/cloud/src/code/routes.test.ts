import { expect, test } from "bun:test";
import { CodeRouteSchema, codeOwnPath, matchCodeRoute } from "../contracts/code-routes";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const sdk = generateCodeSdk([sdkFixture()], {
  mode: "resource",
  owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner" } },
});
const analyze = (source: string) => analyzeCode({ sdk, entry: "code.ts", aiOperations: [], files: { "code.ts": source } });
test("routes are checked entrypoints; public exposure is explicit and permissions name their handler", () => {
  const result = analyze(`import { app, work_shop } from "@sdk";
app.get("/items/:id", async c => c.json(await work_shop.workshop("one").item.create({ title: c.req.param("id"), idempotencyKey: "one" })), { public: true });
app.post("/items", c => c.redirect("/"));`);
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((e) => e.route)).toEqual([
    { method: "GET", path: "/items/:id", public: true },
    { method: "POST", path: "/items", public: false },
  ]);
  expect(result.permissions[0]?.entrypoints).toEqual(["route:GET:/items/:id"]);
});
test("a route renders its pages without the Cloud layout only when it says layout plain, checked and at runtime alike", async () => {
  const source = `import { app } from "@sdk";
app.get("/survey", c => c.text("x"), { public: true, layout: "plain" });
app.get("/alone", c => c.text("x"), { layout: "plain" });
app.get("/", c => c.text("x"));`;
  const result = analyze(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((e) => e.route)).toEqual([
    { method: "GET", path: "/survey", public: true, layout: "plain" },
    { method: "GET", path: "/alone", public: false, layout: "plain" },
    { method: "GET", path: "/", public: false },
  ]);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  runtime.app.get("/survey", () => new Response(), { public: true, layout: "plain" });
  runtime.app.get("/", () => new Response());
  expect(runtime.__codeSdk.entries().map((entry: { route: unknown }) => entry.route)).toEqual([
    { method: "GET", path: "/survey", public: true, layout: "plain" },
    { method: "GET", path: "/", public: false },
  ]);
});
test("route options other than literal public and layout plain fail closed", () => {
  const options = [
    '{ layout: "full" }',
    "{ layout: kind }",
    "{ public: true, public: false }",
    '{ public: true, title: "x" }',
    "{ ...more }",
  ];
  const result = analyze(`import { app } from "@sdk";
const kind = "plain";
const more = { public: true };
${options.map((option, index) => `app.get("/r${index}", c => c.text("x"), ${option});`).join("\n")}`);
  expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "code_static_route")).toHaveLength(options.length);
  expect(result.entrypoints).toEqual([]);
});
test("computed exposure, unsafe paths, nested and duplicate registrations fail closed", () => {
  for (const registration of [
    'app.get("/", c => c.text("x"), { public: Boolean(1) });',
    'app.get("/../outside", c => c.text("x"));',
    'app.get("https://example.com", c => c.text("x"));',
    'function f() { app.get("/", c => c.text("x")); }',
    'app.get("/", c => c.text("x")); app.get("/", c => c.text("y"));',
  ])
    expect(analyze(`import { app } from "@sdk"; ${registration}`).diagnostics.length).toBeGreaterThan(0);
});
test("all methods, root and params share the checked route grammar", () => {
  const route = CodeRouteSchema.parse({ method: "GET", path: "/items/:id", public: false });
  expect(matchCodeRoute(route, "HEAD", "/items/a%20b")).toEqual({ id: "a b" });
  for (const path of ["/items/a/b", "/items/%2fother", "/items/%2e%2e", "/items/%ZZ"])
    expect(matchCodeRoute(route, "GET", path)).toBeNull();
  expect(matchCodeRoute(route, "POST", "/items/one")).toBeNull();
});
test("redirects resolve within the Code namespace and cannot escape through URL tricks", () => {
  expect(codeOwnPath("c_one", "/items?q=one")).toBe("/code/c_one/items?q=one");
  expect(codeOwnPath("c_one", "/code/c_one/items")).toBe("/code/c_one/items");
  for (const path of ["//evil.test", "https://evil.test", "/../admin", "/%2E%2e/admin", "/x%2fy", "/x\\y", "/code/c_two/"])
    expect(() => codeOwnPath("c_one", path)).toThrow();
});
test("SDK runtime routes return description responses without cookies, HTML or arbitrary headers", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  runtime.app.get("/items/:id", (c: { user: unknown; req: { param(name: string): string }; json(value: unknown): Response }) =>
    c.json({ user: c.user, id: c.req.param("id") }),
  );
  const result = await runtime.__codeSdk.run("route:GET:/items/:id", {
    method: "GET",
    path: "/items/a",
    query: "",
    contentType: "text/plain",
    body: "",
    params: { id: "a" },
    user: { id: "visitor", groups: [] },
  });
  expect(result).toEqual({ kind: "json", status: 200, body: JSON.stringify({ user: { id: "visitor", groups: [] }, id: "a" }) });
  runtime.app.get("/public", (c: { user: unknown; json(value: unknown): Response }) => c.json(c.user), { public: true });
  expect(
    await runtime.__codeSdk.run("route:GET:/public", {
      method: "GET",
      path: "/public",
      query: "",
      contentType: "text/plain",
      body: "",
      params: {},
      user: { id: "visitor" },
    }),
  ).toEqual({ kind: "json", status: 200, body: "null" });
});

test("personal Code registers private and public routes like resource Code", () => {
  for (const options of ["", ", { public: true }"]) {
    const result = analyzeCode({
      sdk: generateCodeSdk([], { mode: "personal" }),
      entry: "code.ts",
      aiOperations: [],
      files: { "code.ts": `import { app } from "@sdk"; app.get("/", c => c.text("x")${options});` },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.entrypoints.map((entry) => entry.route)).toEqual([{ method: "GET", path: "/", public: options !== "" }]);
  }
});

test("checked manifests bind route descriptors and public classification", async () => {
  const { CodeCheckedVersionManifestSchema } = await import("../contracts/code-version");
  const manifest = {
    version: 1,
    entry: "code.ts",
    entrypoints: [
      { kind: "route", entrypoint: "route:GET:/", route: { method: "GET", path: "/", public: true }, cron: null, file: "code.ts", line: 1 },
    ],
    permissions: [],
    ai: false,
    policyRows: [],
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
  };
  expect(CodeCheckedVersionManifestSchema.safeParse(manifest).success).toBe(false);
  expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, policyRows: ["public_routes"] }).success).toBe(true);
  for (const entry of [
    { ...manifest.entrypoints[0], route: undefined },
    { ...manifest.entrypoints[0], kind: "manual" },
  ])
    expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, entrypoints: [entry], policyRows: ["public_routes"] }).success).toBe(
      false,
    );
});
