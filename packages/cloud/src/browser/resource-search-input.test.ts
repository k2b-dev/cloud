import { expect, test } from "bun:test";
import { commitTypedTags, matchingSearchTags, searchTags, tagAtCursor } from "./resource-search-input";

const apps = [
  {
    id: "files",
    name: "Files",
    icon: "ti ti-files",
    tags: [
      { tag: "file", title: "Files", description: "Documents", aliases: ["document"] },
      { tag: "folder", title: "Folders", description: "Directories", aliases: ["directory"] },
    ],
  },
];

test("keeps canonical suggestions while finding aliases and respecting an initial app scope", () => {
  const catalog = searchTags(apps);
  expect(matchingSearchTags(catalog, "doc", []).map((tag) => tag.tag)).toEqual(["file"]);
  expect(matchingSearchTags(catalog, "", ["document"]).map((tag) => tag.tag)).toEqual(["folder"]);
  expect(searchTags(apps, "other")).toEqual([]);
});

test("commits complete pasted tags, not the unfinished prefix, without losing query text", () => {
  expect(commitTypedTags("budget #FILE #folder next #fo", 28)).toEqual({ input: "budget   next #fo", caret: 16, tags: ["file", "folder"] });
  expect(commitTypedTags("#file", 5).tags).toEqual([]);
  expect(commitTypedTags("#file ", 6)).toEqual({ input: " ", caret: 1, tags: ["file"] });
});

test("replaces the whole edited tag token while matching only the prefix before the caret", () => {
  expect(tagAtCursor("budget #folder later", 10)).toEqual({ start: 7, end: 14, prefix: "fo" });
  expect(tagAtCursor("#fi#le", 3)).toBeNull();
  expect(tagAtCursor("note #file ", 11)).toBeNull();
});
