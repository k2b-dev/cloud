import { focusPageSearch } from "../../src/v2/host";
import type {} from "../v2-phone-head.entry";
import { PathAndSearch } from "../v2-phone-head.fixture";
import { mount } from "./mount";

declare global {
  interface Window {
    /** The page's search takes Escape itself, so the field does not fold. */
    __takeEscape?: boolean;
  }
}

// The head of a path and a search as its island renders it, so Escape folds the field as on a real page; the host's
// search button calls focusPageSearch.
window.__focusPageSearch = () => focusPageSearch();
mount(() => <PathAndSearch takeEscape={window.__takeEscape} />);
