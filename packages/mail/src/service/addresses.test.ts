import { describe, expect, test } from "bun:test";
import { matchMailFolders, normalizeMailFolderPath } from "./addresses";

const folders = [
  { publicId: "Inbox1", path: "INBOX" },
  { publicId: "Proj01", path: "Projekte" },
  { publicId: "Year25", path: "Projekte / 2025" },
  { publicId: "Arch25", path: "Projekte / 2025 / Archiv" },
  { publicId: "Archiv", path: "Sonstiges" },
  { publicId: "RootAr", path: "Archiv" },
  { publicId: "Slash1", path: "Projekte / 2025" },
];

describe("mail folder addresses", () => {
  test("normalizes the separator and surrounding spaces", () => {
    expect(normalizeMailFolderPath(" Projekte/2025 /  Archiv/ ")).toBe("Projekte / 2025 / Archiv");
    expect(normalizeMailFolderPath("/")).toBe("");
  });

  test("matches a path with any spacing and INBOX in any case", () => {
    expect(matchMailFolders(folders, "Projekte/2025/Archiv").map((folder) => folder.publicId)).toEqual(["Arch25"]);
    expect(matchMailFolders(folders, "inbox").map((folder) => folder.publicId)).toEqual(["Inbox1"]);
  });

  test("returns every candidate instead of guessing", () => {
    // A folder whose leaf name contains `/` has the same path as a nested one.
    expect(matchMailFolders(folders, "Projekte / 2025").map((folder) => folder.publicId)).toEqual(["Year25", "Slash1"]);
    // A six-character name can also be another folder's ID.
    expect(matchMailFolders(folders, "Archiv").map((folder) => folder.publicId)).toEqual(["Archiv", "RootAr"]);
    // Paths that differ only in case are ambiguous too.
    expect(matchMailFolders([...folders, { publicId: "Lower1", path: "archiv" }], "archiv").map((folder) => folder.publicId)).toEqual([
      "RootAr",
      "Lower1",
    ]);
  });

  test("a single name also finds a nested special folder by its last segment or role", () => {
    const gmail = [
      { publicId: "Inbox2", path: "INBOX", role: "inbox" },
      { publicId: "Sent01", path: "[Gmail] / Sent Mail", role: "sent" },
      { publicId: "AllMai", path: "[Gmail] / All Mail", role: "all" },
      { publicId: "Label1", path: "Clients / Sent Mail", role: "other" },
    ];
    expect(matchMailFolders(gmail, "[Gmail]/Sent Mail").map((folder) => folder.publicId)).toEqual(["Sent01"]);
    expect(matchMailFolders(gmail, "sent").map((folder) => folder.publicId)).toEqual(["Sent01"]);
    expect(matchMailFolders(gmail, "all mail").map((folder) => folder.publicId)).toEqual(["AllMai"]);
    // Two folders end in the same name: every candidate, no guess.
    expect(matchMailFolders(gmail, "Sent Mail").map((folder) => folder.publicId)).toEqual(["Sent01", "Label1"]);
    // A path with a separator never falls back to the last segment.
    expect(matchMailFolders(gmail, "Other / Sent Mail")).toEqual([]);
  });

  test("an ID always resolves and an empty path matches nothing", () => {
    expect(matchMailFolders(folders, "Year25").map((folder) => folder.publicId)).toEqual(["Year25"]);
    expect(matchMailFolders(folders, " / ")).toEqual([]);
  });
});
