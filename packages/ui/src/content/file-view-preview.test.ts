import { describe, expect, test } from "bun:test";
import { canPreviewFile, getFileViewPreviewKind, parseDelimitedText } from "./file-view-preview";

describe("file preview capability", () => {
  test("recognizes supported MIME types and extensions", () => {
    expect(getFileViewPreviewKind({ path: "report.json", mediaType: "application/octet-stream" })).toBe("json");
    expect(getFileViewPreviewKind({ path: "clip.bin", mediaType: "video/mp4; charset=binary" })).toBe("video");
    expect(getFileViewPreviewKind({ path: "notes.md" })).toBe("markdown");
    expect(getFileViewPreviewKind({ path: "data.tsv" })).toBe("delimited-text");
    expect(getFileViewPreviewKind({ path: "diagram.svg", mediaType: "image/svg+xml" })).toBe("image");
  });

  test("stays conservative for unsupported and oversized files", () => {
    expect(canPreviewFile({ path: "workbook.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(
      false,
    );
    expect(canPreviewFile({ path: "huge.csv", mediaType: "text/csv", size: 2 * 1024 * 1024 + 1 })).toBe(false);
    expect(canPreviewFile({ path: "archive.zip", mediaType: "application/zip" })).toBe(false);
  });
});

describe("parseDelimitedText", () => {
  test("parses quoted commas, escaped quotes, CRLF and multiline fields", () => {
    expect(parseDelimitedText('name,note\r\nAda,"Hello, ""world"""\r\nGrace,"two\nlines"', ",")).toEqual({
      rows: [
        ["name", "note"],
        ["Ada", 'Hello, "world"'],
        ["Grace", "two\nlines"],
      ],
      truncated: false,
      totalRows: 3,
      columnsTruncated: false,
    });
  });

  test("parses TSV and reports bounded output", () => {
    expect(parseDelimitedText("a\tb\n1\t2\n3\t4", "\t", { rows: 2 })).toEqual({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      truncated: true,
      totalRows: 3,
      columnsTruncated: false,
    });
  });
});

test("counts CSV records beyond the retained page, including quoted newlines", () => {
  const csv = 'name,note\n' + Array.from({length: 9000}, (_, i) => `${i},"two\nlines"`).join("\n");
  const first = parseDelimitedText(csv, ",", {rows: 6});
  expect(first.rows).toHaveLength(6);
  expect(first.totalRows).toBe(9001);
  const last = parseDelimitedText(csv, ",", {rows: 201, offset: 8800});
  expect(last.rows).toHaveLength(201);
  expect(last.rows[1]).toEqual(["8800", "two\nlines"]);
  expect(last.rows.at(-1)).toEqual(["8999", "two\nlines"]);
});
