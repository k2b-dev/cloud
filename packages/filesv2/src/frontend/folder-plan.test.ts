import { expect, test } from "bun:test";
import { BATCH_LIMIT, FolderBatchInputSchema } from "../contracts";
import { planFolders } from "./folder-plan";

const plan = (input: string, parent = "", commas: "split" | "literal" = "split") => planFolders(input, { parent, commas });

test("parents precede nested folders and siblings, relative to the current folder", () => {
  expect(plan("A/B/C", "Documents")).toEqual({
    folders: [
      { name: "A", path: "Documents/A", depth: 0, issue: null },
      { name: "B", path: "Documents/A/B", depth: 1, issue: null },
      { name: "C", path: "Documents/A/B/C", depth: 2, issue: null },
    ],
    comma: false,
    tooMany: false,
    valid: true,
  });
  expect(plan("Testdaten/Test1, Test2,Test3").folders).toEqual([
    { name: "Testdaten", path: "Testdaten", depth: 0, issue: null },
    { name: "Test1", path: "Testdaten/Test1", depth: 1, issue: null },
    { name: "Test2", path: "Testdaten/Test2", depth: 1, issue: null },
    { name: "Test3", path: "Testdaten/Test3", depth: 1, issue: null },
  ]);
});

test("only the last segment offers comma splitting, and literal names are never trimmed", () => {
  expect(plan("A,B/C")).toMatchObject({ comma: false, valid: true, folders: [{ name: "A,B" }, { name: "C" }] });
  expect(plan("A/B, C", "", "literal")).toMatchObject({ comma: true, valid: true, folders: [{ name: "A" }, { name: "B, C" }] });
  expect(plan(" A,B ", "", "literal")).toMatchObject({ comma: true, valid: false, folders: [{ name: " A,B ", issue: "spaces" }] });
  expect(plan(" A ")).toMatchObject({ comma: false, valid: false, folders: [{ name: " A ", issue: "spaces" }] });
  expect(plan(" A , B ").folders.map((folder) => folder.name)).toEqual(["A", "B"]);
});

test("empty input has no preview, but empty segments remain visible", () => {
  expect(plan("")).toEqual({ folders: [], comma: false, tooMany: false, valid: false });
  for (const input of ["A//B", "/A", "A/", "A,,B", "A,", ",A"])
    expect(plan(input).folders.some((folder) => folder.issue === "empty")).toBe(true);
  expect(plan("A//B").folders.at(-1)).toMatchObject({ path: "A//B", issue: null });
  expect(plan("/A").folders.at(-1)?.path).toBe("/A");
});

test("names report the first applicable issue without hiding descendants", () => {
  for (const [input, issue] of [
    [" ", "spaces"],
    [".", "dot"],
    ["..", "dot"],
    ["a".repeat(256), "name_length"],
    ["a\\b", "character"],
    ["a\x00b", "character"],
    ["a\x1fb", "character"],
    ["a\x7fb", "character"],
    [".filegate", "reserved"],
    ["trash", "reserved"],
  ] as const)
    expect(plan(input).folders[0]?.issue).toBe(issue);
  expect(plan("../Child").folders).toMatchObject([{ issue: "dot" }, { issue: null }]);
  expect(plan(" ".repeat(256)).folders[0]?.issue).toBe("spaces");
  expect(plan(`${"a".repeat(256)}\x00`).folders[0]?.issue).toBe("name_length");
  expect(plan("A/.filegate").folders[1]?.issue).toBe("reserved");
  expect(plan("trash", "Documents").valid).toBe(true);
  expect(plan("A/trash").valid).toBe(true);
});

test("duplicates are exact sibling names after separator trimming", () => {
  expect(plan("A/A, A,a").folders.map((folder) => folder.issue)).toEqual([null, null, "duplicate", null]);
  expect(plan("A/A").valid).toBe(true);
  expect(plan("A,A", "", "literal").valid).toBe(true);
});

test("the shared bound counts every parent and sibling", () => {
  const input = Array.from({ length: BATCH_LIMIT }, (_, index) => `F${index}`).join("/");
  expect(plan(input)).toMatchObject({ tooMany: false, valid: true });
  expect(plan(`${input}/Child`)).toMatchObject({ tooMany: true, valid: false });
  const siblings = Array.from({ length: BATCH_LIMIT }, (_, index) => `F${index}`).join(",");
  expect(plan(siblings).valid).toBe(true);
  expect(plan(`Parent/${siblings}`).tooMany).toBe(true);
});

test("full paths include the current folder in their length limit", () => {
  expect(plan("X", "a".repeat(4094)).valid).toBe(true);
  expect(plan("X", "a".repeat(4095)).folders[0]?.issue).toBe("path_length");
  expect(plan("A,A", "a".repeat(4095)).folders.map((folder) => folder.issue)).toEqual(["path_length", "duplicate"]);
});

test("folder batches share the path and count bounds and default to a real run", () => {
  const paths = Array.from({ length: BATCH_LIMIT }, (_, index) => `Folder${index}`);
  expect(FolderBatchInputSchema.parse({ paths })).toEqual({ paths, dryRun: false });
  expect(FolderBatchInputSchema.parse({ paths, dryRun: true }).dryRun).toBe(true);
  expect(FolderBatchInputSchema.safeParse({ paths: [...paths, "Extra"] }).success).toBe(false);
  expect(FolderBatchInputSchema.safeParse({ paths: [] }).success).toBe(false);
  expect(FolderBatchInputSchema.safeParse({ paths: ["X".repeat(4096)] }).success).toBe(true);
  expect(FolderBatchInputSchema.safeParse({ paths: ["X".repeat(4097)] }).success).toBe(false);
});
