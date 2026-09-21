import { expect, test } from "bun:test";
import { money } from "@k2b/stdlib";
import { compileArtifact } from "./runtime/compile";

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
    const compiled = await compileArtifact({
      entry: "main.js",
      files: [
        { path: "main.js", content },
        { path: "sales.csv", content: csv! },
      ],
    });
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
  const before = runtime.snapshot().find((node) => node.type === "chart");
  expect(before?.type).toBe("chart");
  const button = runtime.snapshot().find((node) => node.type === "button")!;
  await runtime.event(button.id, { type: "change", value: null });
  const after = runtime.snapshot().find((node) => node.type === "chart");
  expect(after?.type === "chart" && ChartOptions.safeParse(after.data.options).success).toBe(true);
  expect(after).not.toEqual(before);
});

test("first-file skill entry compiles without loading GUI references", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/SKILL.md", import.meta.url)).text();
  const content = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(content).toBeDefined();
  const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: content! }] });
  expect(compiled.code).toContain("__artifactStart");
});

test("analytics reference executes its example with the real UI builder", async () => {
  const { createAnalyticsUi } = await import("./runtime/analytics-ui");
  const document = await Bun.file(new URL("../../skills/code-mode/references/analytics.md", import.meta.url)).text();
  const code = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(code).toBeDefined();
  const runtime = createAnalyticsUi(() => {});
  new Function("ui", code!.replace("export default", "return"))(runtime.ui)();
  expect(runtime.snapshot().filter((node) => node.type === "explorer")).toHaveLength(1);
  await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code! }] });
});

test("every code-mode reference is directly routed and local links resolve", async () => {
  const { readdir } = await import("node:fs/promises");
  const directory = new URL("../../skills/code-mode/", import.meta.url);
  const names = (await readdir(new URL("references/", directory))).filter((name) => name.endsWith(".md"));
  const entry = await Bun.file(new URL("SKILL.md", directory)).text();
  for (const name of names) expect(entry).toContain(`(references/${name})`);
  for (const path of ["SKILL.md", ...names.map((name) => `references/${name}`)]) {
    const file = new URL(path, directory);
    const source = await Bun.file(file).text();
    for (const [, target] of source.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (!target || /^(?:https?:|\/|#)/.test(target)) continue;
      expect(await Bun.file(new URL(target.split("#")[0]!, file)).exists(), `${path}: ${target}`).toBe(true);
    }
  }
});

test("source workflow example uses the current atomic write contract", async () => {
  const { CODE_SOURCE_TOOLS } = await import("@k2b/cloud/ai");
  const document = await Bun.file(new URL("../../skills/code-mode/references/source-workflow.md", import.meta.url)).text();
  const source = document.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const input = { ...JSON.parse(source!), id: "AbC234" };
  expect(CODE_SOURCE_TOOLS.code_write.input.safeParse(input).success).toBe(true);
});

test("invoice reference generates parseable XML with matching calculated totals", async () => {
  const { einvoice } = await import("@k2b/stdlib/finance");
  const document = await Bun.file(new URL("../../skills/code-mode/references/einvoice.md", import.meta.url)).text();
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const outputs: Blob[] = [];
  const run = new Function("einvoice", "files", `return (async () => {${source}})()`);
  await run(einvoice, {
    save: async (blob: Blob) => {
      outputs.push(blob);
    },
  });
  expect(outputs).toHaveLength(1);
  const parsed = einvoice.parseXml(await outputs[0]!.text());
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const calculation = einvoice.calculate(parsed.data.invoice.lines);
  expect(calculation.ok).toBe(true);
  if (!calculation.ok) throw new Error(calculation.error.message);
  expect(calculation.data.grossAmount).toBe("119.00");
  expect(parsed.data.invoice.totals?.grossAmount).toBe(calculation.data.grossAmount);
});
