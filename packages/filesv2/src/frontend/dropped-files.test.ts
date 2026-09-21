import { expect, test } from "bun:test";
import { readDroppedEntries, uploadRelativePath } from "./dropped-files";

function file(name: string, failure = false): FileSystemEntry {
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (file: File) => void, reject: (error: Error) => void) => {
      if (failure) reject(new Error("Permission denied"));
      else resolve(new File(["data"], name));
    },
  } as FileSystemFileEntry;
}
function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let page = 0;
      return { readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(batches[page++] ?? []) };
    },
  } as FileSystemDirectoryEntry;
}

test("folder drops read every browser directory batch, retain relative paths and preserve empty folders", async () => {
  const result = await readDroppedEntries(
    [directory("Docs", [[file("one.txt")], [directory("Empty", []), file("two.txt")]])],
    new AbortController().signal,
  );
  expect(result.files.map(uploadRelativePath)).toEqual(["Docs/one.txt", "Docs/two.txt"]);
  expect(result.directories).toEqual(["Docs", "Docs/Empty"]);
  expect(result.errors).toEqual([]);
});

test("individual unreadable files are reported while other dropped files remain available", async () => {
  const result = await readDroppedEntries(
    [directory("Docs", [[file("denied.txt", true), file("good.txt")]])],
    new AbortController().signal,
  );
  expect(result.files.map(uploadRelativePath)).toEqual(["Docs/good.txt"]);
  expect(result.errors).toEqual(["Docs/denied.txt: Permission denied"]);
});

test("cancelling a folder scan settles even if the browser never answers its callback", async () => {
  const never = {
    name: "Never",
    isDirectory: true,
    isFile: false,
    createReader: () => ({ readEntries: () => {} }),
  } as unknown as FileSystemDirectoryEntry;
  const controller = new AbortController();
  const pending = readDroppedEntries([never], controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
});
