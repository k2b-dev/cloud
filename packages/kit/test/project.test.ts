import { test, expect } from "bun:test";
import { validateProject } from "../src/project";
import { starter } from "../src/starter";
test("discovers script metadata without executing code", () => {
  const p = validateProject(starter);
  expect(p.entries.map((e) => e.name)).toEqual(["CSV umwandeln", "Vergangene Exporte"]);
});
test("rejects computed metadata, traversal, missing imports and missing entries", () => {
  for (const content of [
    'export default kit.script({name: fetch("/"),run(){}})',
    'import x from "../escape.js"; export default kit.script({name:"A",run(){}})',
    'import x from "./missing.js"; export default kit.script({name:"A",run(){}})',
    "export default {}",
  ])
    expect(() =>
      validateProject({
        ...starter,
        files: [{ path: "main.script.js", content }],
      }),
    ).toThrow();
});
test("accepts multiple entries and helper default exports", () => {
  expect(
    validateProject({
      ...starter,
      files: [...starter.files, { path: "helpers.js", content: "export default 42;" }],
    }).entries,
  ).toHaveLength(2);
});

test("incomplete entries keep their identities and syntax errors name the file", async () => {
  const { discoverEntries, ProjectValidationError } = await import("../src/project");
  const previous = validateProject(starter).entries;
  const files = starter.files.map(file => ({ ...file, content: file.content + "\nconst broken =" }));
  expect(discoverEntries(files, previous)).toEqual(previous);
  try { validateProject({ ...starter, files }); throw new Error("Expected validation failure"); }
  catch (error) {
    expect(error).toBeInstanceOf(ProjectValidationError);
    if (error instanceof ProjectValidationError) {
      expect(error.localized("de")).toContain(files[0]!.path);
      expect(error.localized("de")).toContain("Ungültiges JavaScript");
    }
  }
});

test("rename updates import and re-export paths, including moved relative imports, without touching strings", async () => {
  const { renameProjectFile } = await import("../src/project");
  const files = [
    { path: "main.script.js", content: 'import { x } from "./lib/a.js"; export { x } from "./lib/a.js"; const label = "./lib/a.js"; export default kit.script({name:"Main",run(){}})' },
    { path: "lib/a.js", content: 'export { x } from "../value.js";' },
    { path: "value.js", content: 'export const x = 1;' },
  ];
  const next = renameProjectFile(files, "lib/a.js", "nested/deep/b.js");
  expect(next[0]!.content).toContain('from "./nested/deep/b.js"');
  expect(next[0]!.content).toContain('const label = "./lib/a.js"');
  expect(next[1]!.content).toContain('from "../../value.js"');
  expect(validateProject({ ...starter, files: next }).entries).toHaveLength(1);
  expect(files[1]!.path).toBe("lib/a.js");
  expect(() => renameProjectFile([{ path: "bad.js", content: "const broken =" }], "bad.js", "ok.js")).toThrow();
});
