import { createSignal } from "solid-js";

export type Route =
  | { name: "home" }
  | { name: "admin" }
  | { name: "note"; id: string }
  | { name: "shared"; linkId: string }
  | { name: "legal"; page: "datenschutz" | "nutzungsbedingungen" | "impressum" }
  | { name: "unknown" };

const LINK_ID = /^[0-9A-Za-z]{16,32}$/;

export function parseRoute(pathname: string): Route {
  if (pathname === "/admin") return { name: "admin" };
  if (pathname === "/" || pathname === "") return { name: "home" };
  const note = pathname.match(/^\/n\/([0-9A-Za-z_-]{1,64})$/);
  if (note?.[1]) return { name: "note", id: note[1] };
  const shared = pathname.match(/^\/p\/([^/]+)$/);
  if (shared?.[1]) return LINK_ID.test(shared[1]) ? { name: "shared", linkId: shared[1] } : { name: "unknown" };
  const legal = pathname.match(/^\/(datenschutz|nutzungsbedingungen|impressum)$/);
  if (legal?.[1] === "datenschutz" || legal?.[1] === "nutzungsbedingungen" || legal?.[1] === "impressum")
    return { name: "legal", page: legal[1] };
  return { name: "unknown" };
}

const [location, setLocation] = createSignal({ pathname: window.location.pathname, search: window.location.search });

export const route = () => parseRoute(location().pathname);
export const searchParams = () => new URLSearchParams(location().search);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  const url = new URL(to, window.location.href);
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  if (options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  setLocation({ pathname: url.pathname, search: url.search });
  if (!options.replace) window.scrollTo(0, 0);
}

window.addEventListener("popstate", () => setLocation({ pathname: window.location.pathname, search: window.location.search }));

/** Same-origin links navigate inside the SPA; modified clicks keep the browser's behaviour. */
export function linkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href);
  if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
}
