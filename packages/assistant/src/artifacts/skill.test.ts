import { expect, test } from "bun:test";
import { compileArtifact } from "./runtime/compile";
import { money } from "@k2b/stdlib";

test("money reference computes tax and preserves the allocated total", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/references/money.md", import.meta.url)).text();
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const start = new Function("money", source!.replace("export default", "return"));
  expect(start(money)()).toEqual({ net: "19.99", tax: "3.80", gross: "23.79", parts: ["7.93", "7.93", "7.93"] });
});

test("bundled code mode skill matches its canonical Markdown files", async () => {
  const generator = new URL("../../scripts/generate-code-mode-skill.ts", import.meta.url);
  const process = Bun.spawn(["bun", generator.pathname, "--check"], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  expect(await process.exited, error).toBe(0);
});

test("code mode reference examples compile with the artifact runtime", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/references/examples.md", import.meta.url)).text();
  const examples = [...document.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  expect(examples).toHaveLength(4);
  const csv = document.match(/```csv\n([\s\S]*?)\n```/)?.[1];
  expect(csv).toBeDefined();
  for (const content of examples) {
    const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content },{path:"sales.csv",content:csv!}] });
    expect(compiled.code).toContain("__artifactStart");
  }
});

test("chart reference uses accepted chart options", async () => {
  const { ChartOptions } = await import("./runtime/chart-schema");
  const document = await Bun.file(new URL("../../skills/code-mode/references/charts.md", import.meta.url)).text();
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const { createAnalyticsUi } = await import("./runtime/analytics-ui");
  const runtime = createAnalyticsUi(() => {});
  new Function("ui", source!.replace("export default", "return"))(runtime.ui)();
  const before = runtime.snapshot().find(node => node.type === "chart");
  expect(before?.type).toBe("chart");
  const button = runtime.snapshot().find(node => node.type === "button")!;
  await runtime.event(button.id, {type:"change",value:null});
  const after = runtime.snapshot().find(node => node.type === "chart");
  expect(after?.type === "chart" && ChartOptions.safeParse(after.data.options).success).toBe(true);
  expect(after).not.toEqual(before);
});

test("first-file skill entry compiles without loading GUI references", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/SKILL.md", import.meta.url)).text();
  const content = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(content).toBeDefined();
  const compiled = await compileArtifact({entry:"main.js",files:[{path:"main.js",content:content!}]});
  expect(compiled.code).toContain("__artifactStart");
});

test("analytics reference executes its example with the real UI builder", async () => {
  const { createAnalyticsUi } = await import("./runtime/analytics-ui");
  const document = await Bun.file(new URL("../../skills/code-mode/references/analytics.md", import.meta.url)).text();
  const code = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(code).toBeDefined();
  const runtime = createAnalyticsUi(() => {});
  new Function("ui", code!.replace("export default", "return"))(runtime.ui)();
  expect(runtime.snapshot().filter(node => node.type === "explorer")).toHaveLength(1);
  await compileArtifact({entry:"main.ts",files:[{path:"main.ts",content:code!}]});
});
