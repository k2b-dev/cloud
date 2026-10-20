import { expect, spyOn, test } from "bun:test";
import { spacesService } from "./index";
import { loadSpacesSidebar } from "./overview";

test("sidebar snapshot uses the permission-aware listing, reuses an existing count, and serializes pin preferences without a database", async () => {
  const list = spyOn(spacesService.space, "list").mockResolvedValue({ items: [], page: 1, perPage: 0, total: 0, hasNext: false });
  try {
    const sidebar = await loadSpacesSidebar({
      userId: "user-fixture",
      cookieHeader: `settings-app-spaces=${encodeURIComponent(JSON.stringify({ pinnedSpaceIds: ["Space2", "Space1"], spaces: {} }))}`,
      myWorkCount: Promise.resolve(0),
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ subject: { type: "user", userId: "user-fixture" } });
    expect(sidebar).toEqual({ spaces: [], pinnedSpaceIds: ["Space2", "Space1"], myWorkCount: 0 });
    expect(JSON.parse(JSON.stringify(sidebar))).toEqual(sidebar);
  } finally {
    list.mockRestore();
  }
});
