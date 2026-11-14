import { expect, test } from "bun:test";
import { previewSourceKind } from "./previews";

test("detects supported extensions without browser or server state", () => {
  for (const extension of ["jpg", "jpeg", "PNG", "webp", "gif", "avif", "tiff"]) expect(previewSourceKind(`a.${extension}`)).toBe("image");
  for (const extension of ["docx", "doc", "odt", "xlsx", "xls", "ods", "pptx", "ppt", "odp", "rtf"])
    expect(previewSourceKind(`a.${extension}`)).toBe("office");
  for (const extension of ["txt", "md", "csv", "json", "log", "ts", "py", "go", "rs"])
    expect(previewSourceKind(`a.${extension}`)).toBe("text");
  expect(previewSourceKind("a.PDF", "image/jpeg")).toBe("pdf");
  expect(previewSourceKind("download", "application/pdf; charset=binary")).toBe("pdf");
  expect(previewSourceKind("a.svg", "image/svg+xml")).toBeNull();
  expect(previewSourceKind("image.jpeg.exe")).toBeNull();
  expect(previewSourceKind("file")).toBeNull();
});
