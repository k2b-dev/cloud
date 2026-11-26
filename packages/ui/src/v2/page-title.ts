import { createContext } from "solid-js";

// The page's name (internal): the Workspace knows it (its `title`, else the current entry of its sidebar's Nav) and the
// Bar in its head shows it as the page's one heading. A module of its own, as Nav and the Workspace live apart.

/** The current entry of a Nav in the Workspace's sidebar reports its words here, the page's name without a `title`. */
export const NavCurrentContext = createContext<(label: string | undefined) => void>();

/**
 * The page's name for the Bar in the Workspace's head. Every Bar made there claims it (`claim`), and the first claim
 * that still stands holds it: a Bar made inside the head's parts does not show the page's name a second time, and when
 * a Bar goes, the next one shows it, in whatever order the two come and go. A part that names the page itself (a
 * `RecordHead`, whose name is the page's heading) says so (`nameItself`) as long as it stands: then the page has that
 * one heading and no other (`namedItself`). Both count each part, so a part that comes before another has gone (two
 * `Show`s that never stand at once) changes nothing when the other goes.
 */
export type PageTitle = {
  title: () => string | undefined;
  /** Claims the page's name while the calling part stands; the result tells whether this claim holds it now. */
  claim: () => () => boolean;
  /** Whether any part in the head claims the page's name. */
  claimed: () => boolean;
  nameItself: () => void;
  namedItself: () => boolean;
};
export const PageTitleContext = createContext<PageTitle>();
