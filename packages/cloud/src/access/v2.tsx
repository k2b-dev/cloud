import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { AccessDialogProps } from "./AccessDialog";
import { AccessDialogV2 } from "./AccessDialogV2";

export type { AccessDialogProps, FoundServiceAccount } from "./AccessDialog";
export type { ResourceApiKey, ResourceApiKeyPermissionOption, ResourceApiKeysProps } from "./ResourceApiKeys";
export { ResourceApiKeysV2 as ResourceApiKeys } from "./ResourceApiKeysV2";

/**
 * Opens the access dialog for a page built with `@k2b/ui/v2` (its layout has `ui: "v2"`); resolves `true` when changes
 * were saved. The same props, draft, rules and saving as `openAccessDialog` of `@k2b/cloud/access/ui`; the dialog is
 * a v2 `Dialog` in a v2 scope of its own, so it works from any island. A separate entry, so v1 pages load no v2.
 */
export const openAccessDialog = (props: AccessDialogProps): Promise<boolean> =>
  new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "k2-ui";
    host.style.display = "contents";
    document.body.append(host);
    let settled = false;
    let stop = () => {};
    const close = (saved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(saved);
      // The dialog leaves first, then its scope.
      queueMicrotask(() => {
        stop();
        host.remove();
      });
    };
    props.signal?.addEventListener("abort", () => close(false), { once: true });
    stop = render(
      () => (
        <LocaleProvider locale={document.documentElement.lang || "en"}>
          <AccessDialogV2 {...props} close={close} />
        </LocaleProvider>
      ),
      host,
    );
  });
