import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Heavy parts load only when a host uses them: Mermaid and KaTeX through their extensions, code languages when a
// fenced block of that language appears. A host using a few extensions must not download them up front. HTML, CSS
// and JavaScript stay: @codemirror/lang-markdown itself imports them for HTML inside Markdown.
const languages = "cpp|go|java|json|php|python|rust|sql|xml|yaml";
const heavy = new RegExp(`node_modules/(mermaid|katex)/|@codemirror/lang-(${languages})/|@lezer/(${languages})/`);

test("a host that uses a few Markdown extensions loads Mermaid, KaTeX and code languages only on demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "editor-bundle-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { linksExtension, listsExtension, markdownExtension, markExtension } from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
export const used = [linksExtension, listsExtension, markdownExtension, markExtension];\n`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      conditions: ["browser", "production"],
      format: "esm",
      splitting: true,
      metafile: true,
      external: ["solid-js", "solid-js/*", "@k2b/ui", "@k2b/ui/*"],
    });
    if (!build.success) throw new AggregateError(build.logs, "Bundle fixture did not build");
    if (!build.metafile) throw new Error("Bundle build is missing its dependency graph");
    const outputs = new Map(Object.entries(build.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const initial = new Set<string>();
    const visit = (path: string) => {
      const key = basename(path);
      const output = outputs.get(key);
      if (!output || initial.has(key)) return;
      initial.add(key);
      for (const imported of output.imports) if (imported.kind !== "dynamic-import") visit(imported.path);
    };
    for (const output of build.outputs) if (output.kind === "entry-point") visit(output.path);
    const eager = [...initial].flatMap((key) => Object.keys(outputs.get(key)?.inputs ?? {})).filter((input) => heavy.test(input));
    const deferred = [...outputs.keys()]
      .filter((key) => !initial.has(key))
      .flatMap((key) => Object.keys(outputs.get(key)?.inputs ?? {}))
      .filter((input) => heavy.test(input));
    expect(eager).toEqual([]);
    // The code languages are still part of the build, as chunks loaded on demand.
    expect(deferred.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
