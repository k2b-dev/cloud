import { describe, expect, test } from "bun:test";
import { resolveUiMessages } from "../intl/messages";
import { fileDropRejectionMessage, partitionDroppedFiles } from "./file-drop";

const file = (name: string, type: string, size = 1) => new File([new Uint8Array(size)], name, { type });

describe("dropped files", () => {
  test("keep their order and leave out a wrong type, an oversized file, and files past the count, in that order", () => {
    const files = [
      file("a.png", "image/png"),
      file("b.exe", "application/x-msdownload"),
      file("c.png", "image/png", 2_000),
      file("d.jpg", "image/jpeg"),
      file("e.png", "image/png"),
    ];
    const { accepted, rejected } = partitionDroppedFiles(files, { accept: "image/*", maxSize: 1_000, maxFiles: 2 });
    expect(accepted.map((entry) => entry.name)).toEqual(["a.png", "d.jpg"]);
    expect(rejected.map((entry) => [entry.file.name, entry.reason])).toEqual([
      ["b.exe", "type"],
      ["c.png", "size"],
      ["e.png", "count"],
    ]);
  });

  test("take only the first fitting file when the target takes one", () => {
    const { accepted, rejected } = partitionDroppedFiles([file("a.pdf", "application/pdf"), file("b.pdf", "application/pdf")], {
      multiple: false,
    });
    expect(accepted.map((entry) => entry.name)).toEqual(["a.pdf"]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["count"]);
  });

  test("name what was left out and why, shortening long lists", () => {
    const rejected = [
      ...["1.exe", "2.exe", "3.exe", "4.exe", "5.exe"].map((name) => ({
        file: file(name, "application/x-msdownload"),
        reason: "type" as const,
      })),
      { file: file("big.mov", "video/quicktime", 2_000_000), reason: "size" as const },
    ];
    expect(fileDropRejectionMessage(rejected, { maxSize: 1024 * 1024 }, resolveUiMessages("de"), "de")).toBe(
      "Nicht hinzugefügt, dieser Dateityp wird hier nicht angenommen: 1.exe, 2.exe, 3.exe und 2 weitere\nNicht hinzugefügt, größer als 1 MiB: big.mov",
    );
  });
});
