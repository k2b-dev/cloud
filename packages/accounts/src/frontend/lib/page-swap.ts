import { swapPage } from "@k2b/ssr/nav";
import { onCleanup } from "solid-js";

/**
 * Page changes for one island. A page change disposes the island; an action that finishes later must not move the
 * person away from the page they went to, so its calls then do nothing. Call it while the island renders.
 */
export const usePageSwap = () => {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  return {
    /** Shows this page again after a change, where it was: the content column swaps, the document stays. */
    showChanges: (): Promise<void> =>
      disposed
        ? Promise.resolve()
        : swapPage(`${window.location.pathname}${window.location.search}`, { replace: true, scroll: "preserve" }),
    /** Opens another Accounts page, such as a filtered list or the list after a deletion, in the content column. */
    openPage: (href: string): Promise<void> => (disposed ? Promise.resolve() : swapPage(href)),
  };
};
