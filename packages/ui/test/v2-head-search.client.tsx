import { hydrate } from "solid-js/web";
import { LocaleProvider } from "../src/intl/locale";
import { Demo } from "./v2-head-search.demo";

// Hydrates the server's markup in #root, as an island does, in the same tree as the server (v2-head-search.server.tsx):
// the development build of Solid throws on a mismatch.
const root = document.getElementById("root");
if (!root) throw new Error("head search: #root is missing");
hydrate(
  () => (
    <LocaleProvider locale="de">
      <Demo />
    </LocaleProvider>
  ),
  root,
);
window.__mounted = true;
