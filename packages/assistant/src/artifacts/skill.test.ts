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
  expect(examples).toHaveLength(3);
  for (const content of examples) {
    const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content }] });
    expect(compiled.code).toContain("__artifactStart");
  }
});

test("chart reference uses accepted chart options", async () => {
  const { ChartOptions } = await import("./runtime/chart-schema");
  const document = await Bun.file(new URL("../../skills/code-mode/references/charts.md", import.meta.url)).text();
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const callbacks: Array<() => void> = [];
  const options: unknown[] = [];
  const start = new Function("ui", source!.replace("export default", "return"));
  start({
    chart: (value: unknown) => { options.push(ChartOptions.parse(value)); return { set: (next: unknown) => options.push(ChartOptions.parse(next)) }; },
    button: (_label: string, callback: () => void) => callbacks.push(callback),
  })();
  callbacks[0]!();
  expect(options).toHaveLength(2);
});
