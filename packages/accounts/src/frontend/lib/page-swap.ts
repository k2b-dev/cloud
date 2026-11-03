import { swapPage } from "@k2b/ssr/nav";

/** Shows this page again after a change, where it was: the content column swaps, the document stays. */
export const showChanges = (): Promise<void> =>
  swapPage(`${window.location.pathname}${window.location.search}`, { replace: true, scroll: "preserve" });

/** Opens another Accounts page, such as a filtered list or the list after a deletion, in the content column. */
export const openPage = (href: string): Promise<void> => swapPage(href);
