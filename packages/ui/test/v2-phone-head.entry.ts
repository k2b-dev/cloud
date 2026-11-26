import { focusPageSearch } from "../src/v2/host";

declare global {
  interface Window {
    __focusPageSearch: () => boolean;
  }
}

// What a host's search button calls on the phone.
window.__focusPageSearch = () => focusPageSearch();
