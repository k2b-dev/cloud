import { expect, test } from "bun:test";
import { basename, resolve } from "node:path";

const dist = resolve(import.meta.dir, "../../dist");

test("a confirmation prompt keeps the form fields out of its first script and loads them on demand", async () => {
  const entry = resolve(import.meta.dir, "confirm-bundle-entry.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { prompts } from ${JSON.stringify(resolve(dist, "browser/index.js"))}; globalThis.ask = () => prompts.confirm("Delete?");`,
    },
    target: "browser",
    conditions: ["browser", "production"],
    format: "esm",
    splitting: true,
    metafile: true,
  });
  if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Confirmation bundle failed");
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
  const inputsOf = (dynamic: boolean): string[] => {
    const seen = new Set<string>();
    const visit = (path: string) => {
      const key = basename(path);
      if (seen.has(key)) return;
      seen.add(key);
      for (const edge of outputs.get(key)!.imports) if (dynamic || edge.kind !== "dynamic-import") visit(edge.path);
    };
    visit("confirm-bundle-entry.js");
    return [...seen].flatMap((key) => Object.keys(outputs.get(key)!.inputs));
  };
  const eager = inputsOf(false);
  const reachable = inputsOf(true);

  expect(eager.some((input) => input.endsWith("/feedback/prompts.js"))).toBe(true);
  for (const field of [
    /\/feedback\/prompt-form\.js$/,
    /\/inputs\/DatePicker\.js$/,
    /\/inputs\/NumberInput\.js$/,
    /\/inputs\/TagsInput\.js$/,
    /\/inputs\/FileInputs\.js$/,
    /\/inputs\/TextInput\.js$/,
    /\/inputs\/markdown\/MarkdownEditor\.js$/,
  ]) {
    expect(eager.filter((input) => field.test(input))).toEqual([]);
    expect(reachable.some((input) => field.test(input))).toBe(true);
  }
}, 60_000);
