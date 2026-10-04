import { describe, expect, test } from "bun:test";
import { isAggregatedListing } from "../folder-display-rules";
import { aggregatedViewScope, type FolderDisplayEntry, folderDisplayStates } from "./folder-display";

const folder = (id: string, overrides: Partial<FolderDisplayEntry> = {}): FolderDisplayEntry => ({
  id,
  parentId: null,
  name: id,
  display: "everywhere",
  role: "other",
  providerRole: "other",
  providerCollection: false,
  ...overrides,
});

describe("folder display", () => {
  test("passes the stricter display down and names the folder that sets it", () => {
    const states = folderDisplayStates([
      folder("shared", { display: "folder_only" }),
      folder("support", { parentId: "shared" }),
      folder("archive", { parentId: "support", display: "hidden" }),
      folder("old", { parentId: "archive", display: "folder_only" }),
      folder("inbox"),
    ]);

    expect(states.get("shared")).toEqual({ effectiveDisplay: "folder_only", displayInheritedFromFolderId: null, displayNeutral: false });
    expect(states.get("support")).toMatchObject({ effectiveDisplay: "folder_only", displayInheritedFromFolderId: "shared" });
    expect(states.get("archive")).toMatchObject({ effectiveDisplay: "hidden", displayInheritedFromFolderId: null });
    expect(states.get("old")).toMatchObject({ effectiveDisplay: "hidden", displayInheritedFromFolderId: "archive" });
    expect(states.get("inbox")).toMatchObject({ effectiveDisplay: "everywhere", displayInheritedFromFolderId: null });
  });

  test("leaves Sent, Drafts, Trash, Junk and provider collections out of the decision", () => {
    const scope = aggregatedViewScope([
      folder("inbox", { role: "inbox", providerRole: "inbox" }),
      folder("shared", { display: "folder_only" }),
      folder("hidden", { display: "hidden" }),
      folder("sent", { role: "sent", providerRole: "sent" }),
      folder("drafts", { role: "drafts", providerRole: "drafts" }),
      folder("trash", { role: "trash", providerRole: "trash", display: "hidden" }),
      folder("junk", { role: "junk", providerRole: "junk" }),
      folder("all-mail", { role: "all", providerRole: "all", display: "hidden" }),
      folder("all-as-archive", { role: "archive", providerRole: "all" }),
      folder("important", { providerCollection: true }),
      folder("archive", { role: "archive", providerRole: "archive" }),
    ]);

    expect(scope).toEqual({ isolatedFolderIds: ["shared", "hidden"], countingFolderIds: ["inbox", "archive"] });
    expect(folderDisplayStates([folder("starred", { providerCollection: true })]).get("starred")?.displayNeutral).toBe(true);
  });

  test("needs no folder lists while every folder shows its mail everywhere", () => {
    expect(aggregatedViewScope([folder("inbox"), folder("trash", { role: "trash", providerRole: "trash", display: "hidden" })])).toEqual({
      isolatedFolderIds: [],
      countingFolderIds: [],
    });
  });

  test("applies to All mail and the work views, not to an open folder, Assigned to me or Send problems", () => {
    expect(isAggregatedListing(null, null)).toBe(true);
    for (const view of ["needs_action", "unassigned", "waiting", "done", "snoozed", "recently_active"] as const) {
      expect(isAggregatedListing(null, view)).toBe(true);
    }
    expect(isAggregatedListing(null, "mine")).toBe(false);
    expect(isAggregatedListing(null, "send_problems")).toBe(false);
    expect(isAggregatedListing("folder", null)).toBe(false);
  });
});
