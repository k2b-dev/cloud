import { expect, test } from "bun:test";
import { isSystemFileName, systemEntry, systemEntryLabel } from "./system-files";

test("well-known macOS, Windows and Linux system names match regardless of case", () => {
  for (const name of [
    ".DS_Store",
    "._report.pdf",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    "Icon\r",
    "Thumbs.db",
    "thumbs.db",
    "ehthumbs.db",
    "desktop.ini",
    "Desktop.ini",
    "$RECYCLE.BIN",
    "$Recycle.Bin",
    "System Volume Information",
    ".directory",
    ".Trash-1000",
  ])
    expect(isSystemFileName(name)).toBeTrue();
});

test("ordinary dotfiles and look-alikes stay user content", () => {
  for (const name of [
    ".gitignore",
    ".env",
    ".config",
    ".Trash",
    ".Trash-",
    "._",
    "Icon",
    "Icons",
    "notes.db",
    "DS_Store",
    "my desktop.ini",
  ])
    expect(isSystemFileName(name)).toBeFalse();
});

test("system entries resolve to their outermost path inside an uploaded folder", () => {
  expect(systemEntry("Photos/.DS_Store")).toBe("Photos/.DS_Store");
  expect(systemEntry("Photos/2026/Thumbs.db")).toBe("Photos/2026/Thumbs.db");
  expect(systemEntry("Drive/$RECYCLE.BIN/S-1-5/desktop.ini")).toBe("Drive/$RECYCLE.BIN");
  expect(systemEntry("Drive/.Spotlight-V100")).toBe("Drive/.Spotlight-V100");
  expect(systemEntry("Project/.gitignore")).toBeNull();
  expect(systemEntry("Project/src/.env")).toBeNull();
});

test("the entry the person picked or dragged directly is never treated as a system file", () => {
  expect(systemEntry(".DS_Store")).toBeNull();
  expect(systemEntry(".Trashes")).toBeNull();
  expect(systemEntry(".Trashes/501/.DS_Store")).toBe(".Trashes/501/.DS_Store");
});

test("labels show the bare name without the carriage return of the macOS icon file", () => {
  expect(systemEntryLabel("Photos/Icon\r")).toBe("Icon");
  expect(systemEntryLabel("Drive/$RECYCLE.BIN")).toBe("$RECYCLE.BIN");
});
