import { expect, test } from "bun:test";
import { money } from "@k2b/stdlib";
import { createDomTestHarness } from "../../../ui/test/dom";
import { lintApp } from "./html/compose";
import { compileArtifact } from "./runtime/compile";
import { chart } from "./runtime/lib";

test("money reference computes tax and preserves the allocated total", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/references/money.md", import.meta.url)).text();
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(source).toBeDefined();
  const start = new Function("cloud", source!.replace("export default", "return"));
  expect(start({ money })()).toEqual({ net: "19.99", tax: "3.80", gross: "23.79", parts: ["7.93", "7.93", "7.93"] });
});

test("bundled code mode skill matches its canonical Markdown files", async () => {
  const generator = new URL("../../scripts/generate-code-mode-skill.ts", import.meta.url);
  const process = Bun.spawn(["bun", generator.pathname, "--check"], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(process.stderr).text();
  expect(await process.exited, error).toBe(0);
});

/** Code blocks of a reference, in order, with their fence language. */
const blocks = async (name: string) => {
  const document = await Bun.file(new URL(`../../skills/code-mode/references/${name}`, import.meta.url)).text();
  return [...document.matchAll(/```(\w+)\n([\s\S]*?)\n```/g)].map((match) => ({ language: match[1]!, code: match[2]! }));
};
/** Static findings of an app the way code_write and code_present check it. */
const appErrors = (files: Record<string, string>) => {
  const dom = createDomTestHarness();
  const globals = globalThis as unknown as { DOMParser?: unknown };
  globals.DOMParser = dom.window.DOMParser;
  try {
    return lintApp(files).filter((issue) => issue.severity === "error");
  } finally {
    delete globals.DOMParser;
    dom.cleanup();
  }
};

test("code mode script examples compile and app examples pass the static app checks", async () => {
  const examples = await blocks("examples.md");
  const scripts = examples.filter((block) => block.language === "js" && block.code.includes("export default"));
  expect(scripts).toHaveLength(2);
  for (const { code } of scripts) {
    const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: code }] });
    expect(compiled.code).toContain("__artifactStart");
  }
  const html = examples.filter((block) => block.language === "html");
  const apps = examples.filter((block) => block.language === "js" && !block.code.includes("export default"));
  expect(apps).toHaveLength(2);
  expect(appErrors({ "index.html": html[0]!.code, "app.js": apps[0]!.code })).toEqual([]);
  expect(
    appErrors({
      "index.html": "<main><form><input name=customer><input name=amount><button>Create</button></form></main>",
      "app.js": apps[1]!.code,
    }),
  ).toEqual([]);
});

test("the apps reference todo example and confirm snippet pass the static app checks", async () => {
  const examples = await blocks("apps.md");
  const html = examples.filter((block) => block.language === "html").map((block) => block.code);
  const js = examples.filter((block) => block.language === "js").map((block) => block.code);
  expect(html).toHaveLength(2);
  expect(js).toHaveLength(2);
  expect(appErrors({ "index.html": html.join("\n"), "app.js": js.join("\n") })).toEqual([]);
  // The same checks catch the traps the reference warns about.
  expect(
    appErrors({ "index.html": '<button onclick="go()">Go</button>', "app.js": 'alert("x"); localStorage.x = 1; fetch("/a");' }).map(
      (issue) => issue.kind,
    ),
  ).toEqual(["inline-handler", "dialog", "storage", "network"]);
});

test("chart reference draws Cloud chart markup", async () => {
  const [example] = await blocks("charts.md");
  const element = { innerHTML: "", addEventListener: () => {} };
  new Function("cloud", "document", example!.code)(
    { chart: (options: Parameters<typeof chart>[0]) => chart(options, "en-US") },
    { querySelector: () => element },
  );
  expect(element.innerHTML).toStartWith('<div class="k2b-chart" data-chart-kind="bar" role="img" aria-label="Orders by region">');
});

test("first-file skill entry compiles without loading app references", async () => {
  const document = await Bun.file(new URL("../../skills/code-mode/SKILL.md", import.meta.url)).text();
  const content = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  expect(content).toBeDefined();
  const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: content! }] });
  expect(compiled.code).toContain("__artifactStart");
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
  const run = new Function("cloud", `return (async () => {${source}})()`);
  await run({
    finance: { einvoice },
    download: async (_name: string, blob: Blob) => {
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

// Generated apps read parser results by this type block: a field stdlib may
// omit must be marked optional there, and a required one must stay required.
test("invoice reference declares the fields, kinds and payment codes stdlib accepts", async () => {
  const { einvoice } = await import("@k2b/stdlib/finance");
  const { invoice } = await import("./test-invoice");
  const document = await Bun.file(new URL("../../skills/code-mode/references/einvoice.md", import.meta.url)).text();
  const block = document.match(/^type Invoice = \{\n([\s\S]*?)\n\};/m)?.[1];
  expect(block).toBeDefined();
  // Top-level fields only: comments and nested object types carry names of their own.
  let fields = block!.replaceAll(/\/\/.*$/gm, "");
  while (/\{[^{}]*\}/.test(fields)) fields = fields.replaceAll(/\{[^{}]*\}/g, "object");
  const declared = [...fields.matchAll(/(\w+)(\??):/g)].map(([, name, optional]) => ({ name: name!, optional: optional === "?" }));
  expect(declared.map((field) => field.name)).toEqual(expect.arrayContaining(Object.keys(invoice)));
  for (const { name, optional } of declared) {
    const { [name]: _removed, ...rest } = invoice as Record<string, unknown>;
    expect(einvoice.validate(rest).ok, name).toBe(optional);
  }
  const literals = (pattern: RegExp) => [...(block!.match(pattern)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const kinds = literals(/kind: ([^;]+);/);
  expect(kinds).toContain("invoice");
  const precedingInvoice = { number: "TEST-41", invoiceDate: invoice.invoiceDate };
  for (const kind of kinds) expect(einvoice.validate({ ...invoice, kind, precedingInvoice }).ok, kind).toBe(true);
  const codes = literals(/typeCode\?: ([^;]+);/);
  expect(codes).toContain("58");
  for (const typeCode of codes) {
    // Only credit transfers carry the account; the other codes forbid it.
    const payment = typeCode === "30" || typeCode === "58" ? { ...invoice.payment, typeCode } : { typeCode };
    expect(einvoice.validate({ ...invoice, payment }).ok, typeCode).toBe(true);
  }
});

test("database setup examples use the Manage tool and expose write rules without managed columns", async () => {
  const { CODE_SOURCE_TOOLS } = await import("@k2b/cloud/ai");
  for (const folder of ["importer", "invoice-matcher"]) {
    const input = await Bun.file(new URL(`../../examples/studio-actions/${folder}/setup.json`, import.meta.url)).json();
    expect(CODE_SOURCE_TOOLS.code_database.input.safeParse({ ...input, id: "AbC234" }).success).toBe(true);
  }
  for (const write of ["everyone", "own", "managers"]) {
    expect(
      CODE_SOURCE_TOOLS.code_database.input.safeParse({ id: "AbC234", operation: "tables.update", table: "todos", changes: { write } })
        .success,
    ).toBe(true);
  }
  expect(
    CODE_SOURCE_TOOLS.code_database.input.safeParse({
      id: "AbC234",
      operation: "tables.create",
      name: "todos",
      columns: [{ name: "created_by", type: "text" }],
    }).success,
  ).toBe(false);
  expect(CODE_SOURCE_TOOLS.code_storage_list.input.safeParse({ id: "AbC234", scope: "user", area: "files" }).success).toBe(false);
});
