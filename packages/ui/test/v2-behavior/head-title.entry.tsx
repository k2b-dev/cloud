import { longName, SpaceHead } from "../v2-head-title.fixture";
import { mount } from "./mount";

declare global {
  interface Window {
    /** The name of the Space in the head; a long one by default. */
    __spaceName?: string;
  }
}

// A Space's head as its island renders it over the server's markup, so its search folds on Escape as on a real page.
mount(() => <SpaceHead name={window.__spaceName ?? longName} />);
