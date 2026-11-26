import { longName, SpaceHead } from "../v2-head-title.fixture";
import { mount } from "./mount";

declare global {
  interface Window {
    /** The name of the Space in the head; a long one by default. */
    __spaceName?: string;
    /** The head carries a deed, a link and a menu with words beside its people. */
    __headDeeds?: boolean;
    /** The head has no "…" of its own. */
    __noMore?: boolean;
  }
}

// A Space's head as its island renders it over the server's markup, so its search folds on Escape and its "…" lists
// what gave way, as on a real page.
mount(() => <SpaceHead name={window.__spaceName ?? longName} deeds={window.__headDeeds} more={!window.__noMore} />);
