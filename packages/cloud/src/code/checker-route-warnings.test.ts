import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const sdk = generateCodeSdk([sdkFixture()], { mode: "personal" });
const warnings = (source: string, files: Record<string, string> = {}) => {
  const result = analyzeCode({ sdk, entry: "code.ts", aiOperations: [], files: { ...files, "code.ts": source } });
  expect(result.diagnostics).toEqual([]);
  return result.warnings.map((warning) => `${warning.code}@${warning.file}:${warning.line}`);
};

test("a page that is not public and never reads c.user is a warning, never an error", () => {
  expect(
    warnings(`import { app } from "@sdk";
app.get("/", c => c.text("Hello"));
app.post("/save", async c => c.json({ saved: await c.req.text() }));
export default app;`),
  ).toEqual(["code_route_unchecked@code.ts:2", "code_route_unchecked@code.ts:3"]);
});

test("reading c.user in the handler, a named handler or matching middleware before it keeps the page quiet", () => {
  expect(
    warnings(`import { app } from "@sdk";
const owner = "u_owner";
function account(c: Parameters<Parameters<typeof app.get>[1]>[0]) {
  return c.user?.id === owner ? c.text("Mine") : c.json({ error: "forbidden" }, 403);
}
app.get("/inline", c => (c.user?.id === owner ? c.text("Mine") : c.json({ error: "forbidden" }, 403)));
app.get("/named", account);
app.get("/destructured", c => {
  const { user } = c;
  return user?.id === owner ? c.text("Mine") : c.json({ error: "forbidden" }, 403);
});
app.use("/private", async (c, next) => {
  if (c.user?.id !== owner) return c.json({ error: "forbidden" }, 403);
  return next();
});
app.get("/private/data", c => c.json({ data: 1 }));
app.get("/status", c => c.text("Ready"), { public: true });
export default app;`),
  ).toEqual([]);
});

test("middleware that does not read c.user, or whose prefix does not cover the route, is no access check", () => {
  expect(
    warnings(`import { app } from "@sdk";
app.use(async (c, next) => next());
app.use("/private", async (c, next) => (c.user ? next() : c.json({ error: "forbidden" }, 403)));
app.get("/privately", c => c.text("Open"));
app.get("/other/:id", c => c.text(c.req.param("id")));
export default app;`),
  ).toEqual(["code_route_unchecked@code.ts:4", "code_route_unchecked@code.ts:5"]);
});

test("a page registered before app.use runs without that middleware and is named, also across files", () => {
  expect(
    warnings(
      `import { app } from "@sdk";
import "./routes";
app.use(async (c, next) => (c.user?.groupNames.includes("staff") ? next() : c.json({ error: "forbidden" }, 403)));
app.get("/after", c => c.text("Checked"));
app.get("/open", c => c.text("Open"), { public: true });
export default app;`,
      {
        "routes.ts": `import { app } from "@sdk";
app.get("/before", c => c.text("Unchecked"));
app.get("/health", c => c.text("Ready"), { public: true });`,
      },
    ),
  ).toEqual(["code_route_before_middleware@routes.ts:2", "code_route_unchecked@routes.ts:2"]);
});

test("a parameter segment may meet the prefix, so the warning stays on the safe side", () => {
  expect(
    warnings(`import { app } from "@sdk";
app.get("/:section/list", c => (c.user ? c.text("Listed") : c.text("Nobody")));
app.use("/admin", async (c, next) => (c.user?.groupNames.includes("admin") ? next() : c.json({ error: "forbidden" }, 403)));
export default app;`),
  ).toEqual(["code_route_before_middleware@code.ts:2"]);
});
