import { createRoot } from "solid-js";
import { attachWorkspaces, confirm, useToast } from "../../src/v2";
import type {} from "./mount";

declare global {
  interface Window {
    /** Every collapse the person made, in order. */
    __collapsed: boolean[];
    __toast: (message: string) => void;
    __confirm: () => Promise<boolean>;
  }
}

// The frame entry of a page whose Workspace the server rendered: nothing renders again, it only attaches.
window.__collapsed = [];
attachWorkspaces({ onSidebarCollapsedChange: (collapsed) => window.__collapsed.push(collapsed) });
createRoot(() => {
  const toast = useToast();
  window.__toast = (message) => void toast(message);
});
window.__confirm = () => confirm({ title: "Auftrag verwerfen?", confirm: "Verwerfen" });
window.__mounted = true;
