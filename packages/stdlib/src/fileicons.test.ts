import { describe, it, expect } from "bun:test";
import { getFileCategory, getFileIcon, type FileInfoLike } from "./fileicons";

const file = (name: string, mimeType?: string): FileInfoLike => ({
  name,
  type: "file",
  mimeType,
});

const dir = (name: string): FileInfoLike => ({
  name,
  type: "directory",
});

// ==========================
// getFileCategory
// ==========================

describe("getFileCategory", () => {
  it("returns 'image' for image mime types", () => {
    expect(getFileCategory(file("x.png", "image/png"))).toBe("image");
  });

  it("returns 'image' for image extensions without mime", () => {
    expect(getFileCategory(file("photo.jpg"))).toBe("image");
  });

  it("returns 'pdf' for PDF", () => {
    expect(getFileCategory(file("doc.pdf"))).toBe("pdf");
  });

  it("returns 'pdf' by mime type", () => {
    expect(getFileCategory(file("doc", "application/pdf"))).toBe("pdf");
  });

  it("returns 'video' for video files", () => {
    expect(getFileCategory(file("clip.mp4"))).toBe("video");
  });

  it("returns 'audio' for audio files", () => {
    expect(getFileCategory(file("song.mp3"))).toBe("audio");
  });

  it("returns 'code' for source code extensions", () => {
    expect(getFileCategory(file("app.ts"))).toBe("code");
    expect(getFileCategory(file("main.py"))).toBe("code");
  });

  it("returns 'text' for text files", () => {
    expect(getFileCategory(file("readme.md"))).toBe("text");
  });

  it("returns 'text' for text/ mime type", () => {
    expect(getFileCategory(file("x", "text/plain"))).toBe("text");
  });

  it("returns 'document' for office files", () => {
    expect(getFileCategory(file("report.docx"))).toBe("document");
  });

  it("returns 'archive' for compressed files", () => {
    expect(getFileCategory(file("data.zip"))).toBe("archive");
  });

  it("returns 'archive' by mime type", () => {
    expect(getFileCategory(file("x", "application/zip"))).toBe("archive");
  });

  it("returns 'other' for unknown file", () => {
    expect(getFileCategory(file("file.xyz"))).toBe("other");
  });
});

// ==========================
// getFileIcon
// ==========================

describe("getFileIcon", () => {
  it("returns folder icon for directories", () => {
    expect(getFileIcon(dir("src"))).toContain("ti-folder");
  });

  it("returns special folder icon for known directories", () => {
    expect(getFileIcon(dir("Documents"))).toContain("ti-briefcase");
    expect(getFileIcon(dir("downloads"))).toContain("ti-download");
  });

  it("returns icon by exact filename match", () => {
    expect(getFileIcon(file("package.json"))).toContain("ti-brand-npm");
    expect(getFileIcon(file("Dockerfile"))).toContain("ti-brand-docker");
  });

  it("returns icon by extension", () => {
    expect(getFileIcon(file("app.ts"))).toContain("ti-brand-typescript");
  });

  it("falls back to mime-based icon", () => {
    expect(getFileIcon(file("unknown", "image/svg+xml"))).toContain("ti-photo");
  });

  it("returns generic file icon for completely unknown files", () => {
    expect(getFileIcon(file("x.asdfgh"))).toContain("ti-file");
  });

  it("is case-insensitive for folder names", () => {
    expect(getFileIcon(dir("DOCUMENTS"))).toContain("ti-briefcase");
  });
});
