import { expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts/shared";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

const entry = (principal: AccessEntry["principal"], displayName: string): AccessEntry => ({
  id: "access",
  principal,
  permission: "read",
  createdAt: "2026-10-06T00:00:00.000Z",
  displayName,
});

domTest("Grids administration keeps localized audience labels over the server's English names", async () => {
  const dom = createDomTestHarness();
  try {
    const { entryLabel } = await import("./AdminGridsActions.island");
    const label = (value: AccessEntry) => entryLabel(value, "Angemeldete Benutzer", "Öffentlich");
    expect(label(entry({ type: "authenticated" }, "All users (incl. guests)"))).toBe("Angemeldete Benutzer");
    expect(label(entry({ type: "public" }, "Public"))).toBe("Öffentlich");
    expect(label(entry({ type: "user", userId: "user-qdt" }, "Quentin Dorn"))).toBe("Quentin Dorn");
  } finally {
    dom.cleanup();
  }
});
