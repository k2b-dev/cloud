import { describe, expect, test } from "bun:test";
import { resolveUiMessages } from "../intl/messages";
import { fileDropRejectionMessage, partitionDroppedFiles, refusesDraggedTypes } from "./file-drop";

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

describe("a drag in progress", () => {
  test("is refused only when no file it carries can fit a type-only accept", () => {
    expect(refusesDraggedTypes(["application/pdf"], "image/*")).toBe(true);
    expect(refusesDraggedTypes(["application/pdf", "image/png"], "image/*")).toBe(false);
    // Engines that hide the types during the drag leave the decision to the drop.
    expect(refusesDraggedTypes([""], "image/*")).toBe(false);
    expect(refusesDraggedTypes([], "image/*")).toBe(false);
    expect(refusesDraggedTypes(["application/pdf"], undefined)).toBe(false);
  });

  test("leaves extensions to the drop, which matches them by name", () => {
    // Windows reports a .csv as an Excel sheet when Excel is installed, and a .ts as a video stream.
    expect(refusesDraggedTypes(["application/vnd.ms-excel"], ".pdf,.csv")).toBe(false);
    expect(refusesDraggedTypes(["video/vnd.dlna.mpeg-tts"], "image/*, .ts")).toBe(false);
    const { accepted } = partitionDroppedFiles([file("report.csv", "application/vnd.ms-excel")], { accept: ".pdf,.csv" });
    expect(accepted.map((entry) => entry.name)).toEqual(["report.csv"]);
  });
});
