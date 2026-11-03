import { describe, expect, test } from "bun:test";
import { mailFolderNameMessages, mailFolderNames, type StandardFolderNameKey, standardFolderNameKey } from "./folder-names";

describe("standardFolderNameKey", () => {
  test.each<[StandardFolderNameKey, string]>([
    ["inbox", "INBOX"],
    ["drafts", "Drafts"],
    ["drafts", "Entwürfe"],
    ["sent", "Sent"],
    ["sent", "Sent Items"],
    ["sent", "Sent Mail"],
    ["sent", "[Gmail]/Sent Mail"],
    ["sent", "Sent Messages"],
    ["sent", "Gesendete Elemente"],
    ["sent", "Gesendet"],
    ["trash", "Trash"],
    ["trash", "Deleted Items"],
    ["trash", "Deleted Messages"],
    ["trash", "Gelöschte Elemente"],
    ["trash", "Papierkorb"],
    ["junk", "Junk"],
    ["junk", "Junk Email"],
    ["junk", "Junk E-Mail"],
    ["junk", "Junk Mail"],
    ["junk", "Spam"],
    ["junk", "Junk-E-Mail"],
    ["archive", "Archive"],
    ["archive", "Archiv"],
    ["all", "All Mail"],
    ["all", "[Google Mail]/Alle Nachrichten"],
  ])("a %s folder named %p shows its localized name", (role, name) => {
    expect(standardFolderNameKey(role, name)).toBe(role);
  });

  test("case, spacing and Unicode normalization do not matter", () => {
    expect(standardFolderNameKey("sent", "  sent   ITEMS ")).toBe("sent");
    expect(standardFolderNameKey("drafts", "Entwürfe")).toBe("drafts");
  });

  test("a standard folder with its own name keeps it", () => {
    expect(standardFolderNameKey("sent", "Rechnungen gesendet")).toBeNull();
    expect(standardFolderNameKey("archive", "Archiv 2024")).toBeNull();
  });

  test("a default name only counts for its own role", () => {
    expect(standardFolderNameKey("other", "Sent Items")).toBeNull();
    expect(standardFolderNameKey("archive", "Sent Items")).toBeNull();
    expect(standardFolderNameKey("trash", "Spam")).toBeNull();
    expect(standardFolderNameKey("folder", "Inbox")).toBeNull();
  });
});

describe("mailFolderNames", () => {
  test("standard folders read in the request locale", () => {
    const de = mailFolderNames("de-CH");
    expect(de({ role: "inbox", name: "INBOX" })).toBe("Eingang");
    expect(de({ role: "drafts", name: "Drafts" })).toBe("Entwürfe");
    expect(de({ role: "sent", name: "Sent Items" })).toBe("Gesendet");
    expect(de({ role: "trash", name: "Deleted Items" })).toBe("Papierkorb");
    expect(de({ role: "junk", name: "Junk Mail" })).toBe("Spam");
    expect(de({ role: "archive", name: "Archive" })).toBe("Archiv");
    const en = mailFolderNames("en");
    expect(en({ role: "inbox", name: "INBOX" })).toBe("Inbox");
    expect(en({ role: "sent", name: "Gesendete Elemente" })).toBe("Sent");
    expect(en({ role: "trash", name: "Deleted Items" })).toBe("Trash");
    expect(en({ role: "junk", name: "Junk Email" })).toBe("Junk");
  });

  test("other folders keep the server's name", () => {
    expect(mailFolderNames("de")({ role: "sent", name: "Rechnungen gesendet" })).toBe("Rechnungen gesendet");
    expect(mailFolderNames("de")({ role: "other", name: "Projects" })).toBe("Projects");
  });

  test("every locale names every standard folder", () => {
    expect(mailFolderNameMessages.check()).toEqual([]);
  });
});
