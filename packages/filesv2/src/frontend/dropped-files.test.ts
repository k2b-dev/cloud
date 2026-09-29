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

test("an unreadable folder is reported while the rest of the dropped folder is still read", async () => {
  // Volume roots carry system folders the person cannot list, such as .Spotlight-V100 on a memory card.
  const denied = {
    name: ".Spotlight-V100",
    isDirectory: true,
    isFile: false,
    createReader: () => ({ readEntries: (_: unknown, reject: (error: Error) => void) => reject(new Error("Permission denied")) }),
  } as unknown as FileSystemDirectoryEntry;
  const result = await readDroppedEntries(
    [directory("Card", [[denied, file("photo.jpg")], [directory("DCIM", [[file("one.jpg")]])]])],
    new AbortController().signal,
  );
  expect(result.files.map(uploadRelativePath)).toEqual(["Card/photo.jpg", "Card/DCIM/one.jpg"]);
  expect(result.directories).toEqual(["Card", "Card/.Spotlight-V100", "Card/DCIM"]);
  expect(result.errors).toEqual(["Card/.Spotlight-V100: Permission denied"]);
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

test("dot-files WebKit refuses are listed apart from errors", async () => {
  // WebKit hands out a dropped dot-file as an entry but rejects reading it as if it did not exist.
  const refused = new DOMException("Path does not exist", "NotFoundError");
  const env = { name: ".env", isDirectory: false, isFile: true, file: (_: unknown, reject: (error: unknown) => void) => reject(refused) };
  const missing = { ...env, name: "gone.txt" };
  const result = await readDroppedEntries(
    [directory("Docs", [[file("one.txt")]]), env, missing] as unknown as FileSystemEntry[],
    new AbortController().signal,
  );
  expect(result.files.map(uploadRelativePath)).toEqual(["Docs/one.txt"]);
  expect(result.directories).toEqual(["Docs"]);
  expect(result.hidden).toEqual([".env"]);
  expect(result.errors).toEqual(["gone.txt: Path does not exist"]);
});
