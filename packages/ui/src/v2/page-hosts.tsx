import { ConfirmDialog } from "./overlays";
import { Toasts } from "./toast";

/**
 * The toaster and the confirm dialog of a page whose `Workspace` the server renders without a script, such as a
 * platform's frame around islands. Mount it once, in an island of that frame: every `useToast` and `Dialog.confirm`
 * of the page's islands answers here, so an island needs no `Workspace` of its own for them. A page whose `Workspace`
 * lives in the browser has its hosts already; it needs none of this.
 */
export const PageHosts = () => {
  let element: HTMLSpanElement | undefined;
  return (
    <span ref={element} class="k2-page-hosts" data-k2-part="PageHosts" data-k2-hosts="">
      <ConfirmDialog host={() => element} />
      <Toasts />
    </span>
  );
};
