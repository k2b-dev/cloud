import { render } from "solid-js/web";
import { PageHosts } from "../src/v2";

// The frame's island: the page's hosts for a Workspace the server renders without a script.

declare global {
  interface Window {
    __hostsMounted?: boolean;
  }
}

const target = document.getElementById("hosts");
if (!target) throw new Error("Missing hosts target");
render(() => <PageHosts />, target);
window.__hostsMounted = true;
