import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";

test("route metadata distinguishes pages from data, including named and imported helpers", () => {
  const result = analyzeCode({
    sdk: generateCodeSdk([], { mode: "personal" }),
    entry: "code.tsx",
    aiOperations: [],
    files: {
      "view.tsx": `import { Page, Text, jsx } from "@sdk";
export const view = (c: Parameters<Parameters<typeof import("@sdk").app.get>[1]>[0]) => c.page(<Page title="Home"><Text>Hello</Text></Page>);`,
      "code.tsx": `import { app, Page, Text, jsx } from "@sdk";
import { view } from "./view";
app.get("/", c => c.page(<Page title="Home"><Text>Hello</Text></Page>));
app.get("/data", c => c.json({ ok: true }));
app.get("/helper", c => view(c));
app.get("/unused", c => { const unused = () => view(c); return c.text("Data"); });
app.get("/conditional", c => c.user ? view(c) : c.json({ error: "forbidden" }, 403));
export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((entry) => entry.route?.page)).toEqual([true, false, true, false, true]);
});

test("page evidence follows passed callbacks; unresolved calls stay unknown rather than claiming data", () => {
  const result = analyzeCode({
    sdk: generateCodeSdk([], { mode: "personal" }),
    entry: "code.tsx",
    aiOperations: [],
    files: {
      "code.tsx": `import { app, Page, Text, jsx } from "@sdk";
type Context = Parameters<Parameters<typeof app.get>[1]>[0];
const view = (c: Context) => c.page(<Page title="Home"><Text>Hello</Text></Page>);
const forward = <T,>(callback: () => T) => callback();
let dynamic = view;
app.get("/promise", c => Promise.resolve().then(() => view(c)));
app.get("/forward", c => forward(() => view(c)));
app.get("/unknown", c => dynamic(c));
app.get("/data", c => c.json({ ok: true }));
export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((entry) => entry.route?.page)).toEqual([true, true, undefined, false]);
  expect(result.entrypoints[2]!.route).not.toHaveProperty("page");
});

test("only proven data returns exclude pages; constructors and dynamic response values stay unknown", () => {
  const result = analyzeCode({
    sdk: generateCodeSdk([], { mode: "personal" }),
    entry: "code.tsx",
    aiOperations: [],
    files: {
      "code.tsx": `import { app, Page, Text, jsx } from "@sdk";
app.get("/executor", c => new Promise<Response>(resolve => resolve(c.page(<Page title="Home"><Text>Hello</Text></Page>))));
app.get("/dynamic", c => {
  const responses = [() => c.page(<Page title="Home"><Text>Hello</Text></Page>), () => c.json({ ok: true })];
  return responses[c.user ? 0 : 1]!();
});
app.get("/mixed", c => c.user ? c.text("data") : new Promise<Response>(resolve => resolve(c.page(<Page title="Home"><Text>Hello</Text></Page>))));
const stateful = app.use<{ response: Response }>("/state", async (c, next) => {
  c.set("response", c.page(<Page title="Home"><Text>Hello</Text></Page>));
  return next();
});
stateful.get("/state", c => c.get("response"));
app.get("/data", async c => { if (c.user) return c.json({ ok: true }); return c.text("Data"); });
app.get("/redirect", c => c.redirect("/data"));
app.get("/conditional-data", c => c.user ? c.json({ ok: true }) : c.text("Data"));
export default app;`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((entry) => entry.route?.page)).toEqual([undefined, undefined, undefined, undefined, false, false, false]);
  for (const entry of result.entrypoints.slice(0, 4)) expect(entry.route).not.toHaveProperty("page");
});
