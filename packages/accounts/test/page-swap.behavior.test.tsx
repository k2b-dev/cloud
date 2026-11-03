import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as navigation from "@k2b/ssr/nav";
import { createRoot } from "solid-js";
import { createDomTestHarness } from "../../ui/test/dom";
import { usePageSwap } from "../src/frontend/lib/page-swap";

describe("Accounts page swaps", () => {
  let cleanup = () => {};
  beforeEach(() => {
    cleanup = createDomTestHarness().cleanup;
  });
  afterEach(() => cleanup());

  test("show the current page again in place, and open other pages in the column", async () => {
    const swapped = spyOn(navigation, "swapPage").mockResolvedValue();
    window.history.replaceState(null, "", "/app/accounts/groups?scope=all#ignored");
    try {
      await createRoot(async (dispose) => {
        const { showChanges, openPage } = usePageSwap();
        await showChanges();
        await openPage("/app/accounts/users");
        dispose();
      });
      expect(swapped.mock.calls).toEqual([
        ["/app/accounts/groups?scope=all", { replace: true, scroll: "preserve" }],
        ["/app/accounts/users"],
      ]);
    } finally {
      swapped.mockRestore();
    }
  });

  test("an action that finishes after its island left the page navigates nowhere", async () => {
    const swapped = spyOn(navigation, "swapPage").mockResolvedValue();
    try {
      const { showChanges, openPage } = createRoot((dispose) => {
        const pageSwap = usePageSwap();
        dispose();
        return pageSwap;
      });
      await showChanges();
      await openPage("/app/accounts/groups");
      expect(swapped).not.toHaveBeenCalled();
    } finally {
      swapped.mockRestore();
    }
  });
});
