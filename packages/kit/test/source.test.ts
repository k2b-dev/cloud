import { expect, test } from "bun:test";
import { mergeSource, SourceChanges, sourceManifest } from "../src/source";
import { blankStarter } from "../src/starter";
import { validateProject } from "../src/project";

test("atomic source changes preserve omitted files and require a valid final project", () => {
  const project = { ...blankStarter, files: [...blankStarter.files, { path: "helper.js", content: "export const value = 1;" }] };
  const changes = SourceChanges.parse({
    expectedRevision: 1,
    upsert: [{ path: "extra.script.js", content: 'export default kit.script({name:"Extra",run(){}});' }],
  });
  const result = mergeSource(project, changes);
  expect(result.entries).toHaveLength(2);
  expect(result.project.files.find((f) => f.path === "helper.js")?.content).toBe("export const value = 1;");
  expect(project.files).toHaveLength(2);
  expect(() => mergeSource(blankStarter, SourceChanges.parse({ expectedRevision: 1, delete: ["main.script.js"] }))).toThrow();
  expect(() => mergeSource(project, SourceChanges.parse({ expectedRevision: 1, delete: ["missing.js"] }))).toThrow();
  expect(() =>
    mergeSource(project, SourceChanges.parse({ expectedRevision: 1, delete: ["helper.js"], upsert: [{ path: "helper.js", content: "" }] })),
  ).toThrow();
});

test("range edits preserve unread content and use revision-relative UTF-16 offsets", () => {
  const content = "// 😀\nexport const value = 123;\n" + "// retained\n".repeat(4000);
  const project = { ...blankStarter, files: [...blankStarter.files, { path: "helper.js", content }] };
  const changes = SourceChanges.parse({
    expectedRevision: 1,
    edits: [{ path: "helper.js", offset: content.indexOf("123"), deleteCount: 3, content: "456" }],
  });
  expect(mergeSource(project, changes).project.files.find((f) => f.path === "helper.js")?.content).toBe(content.replace("123", "456"));
  expect(() => mergeSource(project, { ...changes, edits: [{ ...changes.edits[0]!, offset: content.length + 1 }] })).toThrow();
  const manifest = sourceManifest({
    ...project,
    id: "abc123",
    revision: 1,
    sdkVersion: 1,
    updatedAt: "now",
    permission: "admin",
    entries: validateProject(project).entries,
  });
  expect(manifest.files[1]!.bytes).toBeGreaterThan(manifest.files[1]!.length);
  expect(manifest.files[1]).not.toHaveProperty("content");
});
