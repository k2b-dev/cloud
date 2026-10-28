import { describe, expect, test } from "bun:test";
import { fileKindLabel } from "./FileTypeIcon";
import { formatFileViewSize } from "./FileView";

describe("file kind and size labels", () => {
  test("name the kind in the reader's language, the extension for unknown kinds, and File without one", () => {
    expect(fileKindLabel({ name: "Brochure-v3.pdf" }, "en")).toBe("PDF");
    expect(fileKindLabel({ name: "Page-4.jpg", mediaType: "image/jpeg" }, "de")).toBe("Bild");
    expect(fileKindLabel({ name: "Costing.xlsx" }, "de")).toBe("Tabelle");
    expect(fileKindLabel({ name: "Print-data.zip" }, "en")).toBe("Archive");
    expect(fileKindLabel({ name: "Colour-profile.icc" }, "de")).toBe("ICC");
    expect(fileKindLabel({ name: "site.webmanifest" }, "en")).toBe("WEBMANIFEST");
    expect(fileKindLabel({ name: "README" }, "de")).toBe("Datei");
    expect(fileKindLabel({ name: "Projects", folder: true }, "en")).toBe("Folder");
  });

  test("sizes follow the locale when one is given and keep the old output without", () => {
    expect(formatFileViewSize(4.2 * 1024 * 1024, "de")).toBe("4,2 MB");
    expect(formatFileViewSize(64 * 1024, "de")).toBe("64 KB");
    expect(formatFileViewSize(64 * 1024)).toBe("64.0 KB");
    expect(formatFileViewSize(512, "en")).toBe("512 B");
  });
});
