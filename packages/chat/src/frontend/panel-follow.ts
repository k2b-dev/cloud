import { getContext, onContextChange } from "@k2b/cloud/browser/panel";
import { type ResourceChat, resourceChatExists } from "./resource-chat";
import type { Route } from "./route";
import { locateResource } from "./system-chats";

type OpenResult = "applied" | "superseded" | "failed" | "blocked";

/** What following the host page needs from the panel's workspace; it loads with the panel, outside the first bundle. */
export type PanelFollowHost = {
  route: () => Route;
  resourceChat: () => ResourceChat | null;
  setResourceChat: (chat: ResourceChat | null) => void;
  atResource: () => boolean;
  /** Counts every open the reader or the workspace starts. */
  opens: () => number;
  open: (next: Route) => Promise<OpenResult>;
  /** The workspace's address for a route, and for the resource's discussion. */
  routeHref: (route: Route) => string;
  resourceHref: (chat: ResourceChat) => string;
  navigateReplace: (href: string) => void;
  chatRoute: (chatId: string | null, view?: Route["view"], extra?: Partial<Route>) => Route;
  /** The place the server read from the shared context, the start the browser's context is compared to. */
  served: ResourceChat["ref"] | null;
  disposed: () => boolean;
};

/**
 * The host page changed its place: the panel follows to that resource's discussion only while it shows the previous
 * one. Every change invalidates the earlier ones. An open the reader starts meanwhile wins over following. A follow
 * whose open is still loading is superseded by the next follow's open, or, when the host returns or shares no place,
 * by reopening where the follow started. The shown resource changes only once its discussion is in place, so the
 * next change compares against what the reader sees. Returns the disposer.
 */
export function followPanelContext(host: PanelFollowHost): () => void {
  let scopeToken = 0;
  let inflight: { start: Route } | null = null;
  let followedRoute: Route | undefined;
  const returnFromFollow = () => {
    const start = inflight?.start;
    inflight = null;
    if (start)
      void host.open(start).then((result) => {
        if (result === "applied" && !host.disposed()) host.navigateReplace(host.routeHref(start));
      });
  };
  const follow = (context: ReturnType<typeof getContext>) => {
    const scope = context?.scope;
    const shown = host.resourceChat();
    const token = ++scopeToken;
    if (scope && shown && scope.type === shown.ref.type && scope.id === shown.ref.id) return void returnFromFollow();
    if (!scope) {
      host.setResourceChat(null);
      return void returnFromFollow();
    }
    const start = inflight?.start ?? host.route();
    const shownRoute = host.route();
    const following = host.atResource() || inflight !== null;
    const opens = host.opens();
    locateResource(scope)
      .then(async (found) => {
        if (host.disposed() || token !== scopeToken) return;
        const { conversation, ...location } = found;
        const next: ResourceChat = { ...location, id: conversation, ref: scope };
        // A chat the reader opened meanwhile, even one still loading, wins; a route an earlier follow put in place
        // does not count as the reader's choice.
        const moved = host.route() !== shownRoute && host.route() !== followedRoute;
        if (!following || host.opens() !== opens || moved) return void host.setResourceChat(next);
        const target = resourceChatExists(next)
          ? host.chatRoute(next.id, next.thread ?? "all")
          : host.chatRoute(null, "all", { resource: true });
        inflight = { start };
        const result = await host.open(target);
        if (host.disposed()) return;
        // An applied open keeps its address in step, also when a newer place already waits for its own.
        if (result === "applied") {
          host.navigateReplace(host.resourceHref(next));
          followedRoute = host.route();
        }
        if (token !== scopeToken) return;
        inflight = null;
        host.setResourceChat(next);
      })
      .catch(() => {
        if (token === scopeToken) host.setResourceChat(null);
      });
  };
  const dispose = onContextChange(follow);
  // A change the panel runtime accepted before this code loaded has no event of its own.
  const loaded = getContext()?.scope ?? null;
  if (loaded?.type !== host.served?.type || loaded?.id !== host.served?.id) follow(getContext());
  return dispose;
}
