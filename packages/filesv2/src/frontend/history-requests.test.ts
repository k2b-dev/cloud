import { describe, expect, test } from "bun:test";
import { current, entry, gone, page, snapshot } from "../../test/history-fixtures";
import type { BaseSummary } from "../contracts";
import { isCurrent } from "./history-actions";
import { itemHistoryRequest, movedEntry, placeDescriber, sharePeriod } from "./history-requests";

const base: BaseSummary = {
  id: "cloud:groups:0b4c9a52-5f7e-4c47-9d2e-6c1f1f0a7b11",
  area: "cloud",
  kind: "groups",
  name: "Team Vertrieb",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
};

describe("shared history requests", () => {
  test("an item asks by stable ID on its own base and by path otherwise", () => {
    const fileId = "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
    expect(itemHistoryRequest(base, { path: "Kunden/Proof.pdf", resourceId: `n:${base.id}:${fileId}` })).toEqual({
      baseId: base.id,
      itemId: fileId,
    });
    expect(itemHistoryRequest(base, { path: "Kunden/Proof.pdf" })).toEqual({ baseId: base.id, path: "Kunden/Proof.pdf", scope: "item" });
    // A stable ref of another base never filters this base by a foreign ID.
    expect(
      itemHistoryRequest(base, { path: "Kunden/Proof.pdf", resourceId: `n:cloud:groups:11111111-2222-4333-8444-555555555555:${fileId}` }),
    ).toEqual({ baseId: base.id, path: "Kunden/Proof.pdf", scope: "item" });
  });

  test("an old address selects exact moves and directory ancestors only by the approved relative path", () => {
    const before = (path: string, directory: boolean | null = true) => ({
      ...gone(`opaque/base/${path}`, { directory }),
      relativePath: path,
    });
    const own = entry({ action: "item.move", before: before("Kunden/Angebote 2025"), after: current("x") });
    const ancestor = entry({ action: "item.move", before: before("Kunden"), after: current("x") });
    const unclear = entry({ action: "item.move", state: "unclear", before: before("Kunden/Angebote 2025"), after: current("x") });
    expect(movedEntry(page([unclear, own, ancestor]), "Kunden/Angebote 2025")).toBe(own);
    expect(movedEntry(page([ancestor]), "Kunden/Angebote 2025")).toBe(ancestor);
    expect(movedEntry(page([unclear]), "Kunden/Angebote 2025")).toBeNull();
    expect(movedEntry(page([ancestor]), "Kundenschau/Angebote 2025")).toBeNull();
    const renamed = entry({ action: "item.rename", before: before("Kunden/Angebote"), after: snapshot("x") });
    expect(movedEntry(page([renamed]), "Kunden/Angebote")).toBe(renamed);
    // An approved empty relative path is the base itself, so every nonempty child is underneath it.
    const root = entry({ action: "item.move", before: before(""), after: current("x") });
    expect(movedEntry(page([root]), "Kunden/Angebote")).toBe(root);
    for (const side of [
      gone("opaque/Kunden"),
      { ...before("Kunden"), relativePath: null },
      before("Kunden", false),
      before("Kunden", null),
      { visibility: "hidden" as const },
      { ...before("elsewhere/Kunden"), path: "opaque/Kunden" },
    ]) {
      const unrelated = entry({ action: "item.move", before: side, after: current("x") });
      expect(movedEntry(page([unrelated]), "Kunden/Angebote")).toBeNull();
    }
    // Even an exact-looking raw suffix cannot supply the missing base-relative scope.
    expect(
      movedEntry(page([entry({ action: "item.move", before: gone("opaque/Kunden/Angebote"), after: current("x") })]), "Kunden/Angebote"),
    ).toBeNull();
  });

  test("link facts count the last 30 UTC dates", () => {
    expect(sharePeriod("2026-10-20T12:30:00.000Z")).toEqual({ from: "2026-09-21", to: "2026-10-20" });
  });

  test("approved current and disappearance sides use the storage label and relative folders; snapshots stay raw", () => {
    const describe = placeDescriber([base], { personal: "Persönlich" }, "de");
    expect(describe({ kind: "endpoint", endpoint: { baseId: base.id, path: "Archiv/2025/Angebote 2025", itemId: null } })).toEqual([
      "Team Vertrieb",
      "Archiv",
      "2025",
    ]);
    const full = (path: string) => {
      const side = current(path);
      if (side.visibility !== "full") throw new Error("Expected full fixture");
      return side;
    };
    const recorded = snapshot("users/raw-id/Kunden/A");
    if (recorded.visibility !== "full") throw new Error("Expected snapshot fixture");
    for (const side of [
      {
        visibility: "disappearance" as const,
        name: "A",
        path: "users/raw-id/Kunden/A",
        directory: true,
        publicBaseId: base.id,
        relativePath: "Kunden/A",
      },
      { ...full("users/raw-id/Kunden/A"), publicBaseId: base.id, relativePath: "Kunden/A" },
    ])
      expect(describe({ kind: "side", side })).toEqual(["Team Vertrieb", "Kunden"]);
    expect(describe({ kind: "side", side: { ...full("users/raw-id/A"), publicBaseId: base.id, relativePath: "A" } })).toEqual([
      "Team Vertrieb",
    ]);
    const namedSnapshot = { ...recorded, publicBaseId: base.id, relativePath: "Kunden/A" };
    expect(describe({ kind: "side", side: namedSnapshot })).toEqual(["Team Vertrieb", "Kunden"]);
    expect(isCurrent(namedSnapshot)).toBe(false);
    expect(describe({ kind: "side", side: { ...recorded, relativePath: null } })).toBeUndefined();
    expect(describe({ kind: "side", side: { ...full("users/raw-id/A"), publicBaseId: "unknown", relativePath: "A" } })).toBeUndefined();
    expect(
      describe({
        kind: "side",
        side: { visibility: "disappearance", name: "A", path: "vertrieb/Kunden/A", directory: true, publicBaseId: base.id },
      }),
    ).toBeUndefined();
  });
});
