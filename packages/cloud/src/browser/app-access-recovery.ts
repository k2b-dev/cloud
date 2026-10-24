import { type ToastHandle, toast } from "@k2b/ui";
import { appAccessMessages } from "../access/app-access-messages";
import { APP_ACCESS_REVOKED_EVENT } from "./live-websocket";
import { reloadOnce } from "./reload";

/** Keep an already-open page coherent when its next request or live connection loses app access. */
export const installAppAccessRecovery = (app: { id: string; routes: readonly string[] }): (() => void) => {
  let active = true;
  let notice: ToastHandle | undefined;
  const recover = () => {
    if (!active) return;
    const url = new URL(window.location.href);
    url.searchParams.set("_cloud_access", "revoked");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (!reloadOnce(`app-access:${app.id}`) && !notice) {
      const t = appAccessMessages.resolve([document.documentElement.lang]).t;
      notice = toast(t.accessChanged, { duration: 0, action: { label: t.reload, onClick: () => window.location.reload() } });
    }
  };
  const original = window.fetch;
  const wrapped: typeof window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>) => {
    const response = await original.apply(window, args);
    if (response.status === 403 && response.headers.get("X-Cloud-App-Access-Denied") === app.id) {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin === window.location.origin) recover();
    }
    return response;
  }, original);
  window.fetch = wrapped;
  const revoked = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    const url = new URL(event.detail, window.location.href);
    if (url.host !== window.location.host || !["ws:", "wss:"].includes(url.protocol)) return;
    if (app.routes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix.replace(/\/$/, "")}/`))) recover();
  };
  window.addEventListener(APP_ACCESS_REVOKED_EVENT, revoked);
  return () => {
    active = false;
    notice?.dismiss();
    if (window.fetch === wrapped) window.fetch = original;
    window.removeEventListener(APP_ACCESS_REVOKED_EVENT, revoked);
  };
};
