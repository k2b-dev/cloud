import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { attachWorkspaces, confirm, Dialog, useToast } from "../../src/v2";
import type {} from "./mount";

declare global {
  interface Window {
    /** Every collapse the person made, in order. */
    __collapsed: boolean[];
    __toast: (message: string) => void;
    __confirm: () => Promise<boolean>;
    /** Stops the attached workspaces, as a page swap does. */
    __detach: () => void;
    /** Opens a modal v2 dialog of the page, such as one an island shows. */
    __openDialog: () => void;
  }
}

// The frame entry of a page whose Workspace the server rendered: nothing renders again, it only attaches.
window.__collapsed = [];
window.__detach = attachWorkspaces({ onSidebarCollapsedChange: (collapsed) => window.__collapsed.push(collapsed) });
createRoot(() => {
  const toast = useToast();
  window.__toast = (message) => void toast(message);
});
window.__confirm = () => confirm({ title: "Auftrag verwerfen?", confirm: "Verwerfen" });
window.__openDialog = () => {
  const box = document.createElement("div");
  box.className = "k2-ui";
  document.body.append(box);
  render(
    () => (
      <Dialog title="Auftrag" open onOpenChange={() => {}} foot={<span />}>
        <span>Inhalt</span>
      </Dialog>
    ),
    box,
  );
};
window.__mounted = true;
