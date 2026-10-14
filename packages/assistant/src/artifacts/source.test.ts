import { expect, test } from "bun:test";
import { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { artifactCodeHandlers } from "./code-tools";
import { lineCount, sourceDiagnostics, sourceManifest } from "./source";

test("direct source tools require revisions for atomic writes", () => {
  expect(Object.keys(artifactCodeHandlers).sort()).toEqual(Object.keys(CODE_SOURCE_TOOLS).sort());
  expect(
    CODE_SOURCE_TOOLS.code_write.input.parse({
      id: "aBc234",
      expectedRevision: 1,
      path: "main.ts",
      content: "export default !!!",
    }),
  ).toBeDefined();
});

test("missing helpers and invalid intermediate code produce diagnostics", async () => {
  expect((await sourceDiagnostics({ entry: "main.ts", files: [] })).length).toBeGreaterThan(0);
  const errors = await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default !!!" }] });
  expect(errors.join(" ")).toContain("main.ts");
  expect(errors.join(" ")).not.toBe("Bundle failed");
  expect(await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 42" }] })).toEqual([]);
});

test("an invalid steps.json is reported while the app is written", async () => {
  const files = [
    { path: "index.html", content: "<main><h1>Tasks</h1></main>" },
    { path: "steps.json", content: JSON.stringify([{ action: "click", target: { role: "button", name: "Add", exact: true } }]) },
  ];
  const diagnostics = await sourceDiagnostics({ entry: "index.html", files });
  expect(diagnostics).toContainEqual(expect.stringMatching(/^error steps\.json: Invalid steps\.json: step 1 \(click\): target must be/));
  files[1] = { path: "steps.json", content: JSON.stringify([{ action: "click", target: { role: "button", name: "Add" } }]) };
  expect(await sourceDiagnostics({ entry: "index.html", files })).toEqual([]);
});

for (const [content, lines] of [
  ["", 0],
  ["a", 1],
  ["a\n", 1],
  ["a\nb", 2],
  ["<!doctype html>\n<html>\n</html>\n", 3],
] as const)
  test(`source manifest counts ${lines} lines in ${JSON.stringify(content)}`, () => {
    expect(lineCount(content)).toBe(lines);
    const manifest = sourceManifest({
      kind: "app",
      id: "aBc234",
      revision: 1,
      sourceRevision: 1,
      updatedAt: "2026-10-10",
      publishedRevision: null,
      forkedFromId: null,
      forkedFromRevision: null,
      icon: "",
      publishedVersion: null,
      title: "Lines",
      description: "",
      permission: "admin",
      source: { entry: "index.html", files: [{ path: "index.html", content }] },
    });
    expect(manifest.files).toEqual([{ path: "index.html", lines, length: content.length }]);
  });
