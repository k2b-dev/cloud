import { createContext } from "solid-js";

// The page's name (internal): the Workspace knows it (its `title`, else the current entry of its sidebar's Nav) and the
// Bar in its head shows it as the page's one heading. A module of its own, as Nav and the Workspace live apart.

/** The current entry of a Nav in the Workspace's sidebar reports its words here, the page's name without a `title`. */
export const NavCurrentContext = createContext<(label: string | undefined) => void>();

/**
 * The page's name for the Bar in the Workspace's head. The first Bar made there takes it (`take`), so a Bar made inside
 * the head's parts does not show the page's name a second time; it gives it back when it goes.
 */
export type PageTitle = { title: () => string | undefined; take: () => boolean; giveBack: () => void };
export const PageTitleContext = createContext<PageTitle>();
