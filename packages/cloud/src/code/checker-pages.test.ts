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
