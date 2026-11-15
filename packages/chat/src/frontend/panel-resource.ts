import { readPanelContext } from "@k2b/cloud/ssr";
import { type ResourceChat, resourceChatExists, resourceChatPath } from "./resource-chat";

export type { ResourceChat } from "./resource-chat";

type Request = { req: { path: string; raw: { url: string } } };

/**
 * The panel starts in the discussion about the host page's resource. The shared scope is an untrusted selector:
 * `locate` reads it as the signed-in reader, creates nothing, and answers null where the reader may not read it, so
 * the panel stays at the chat list. The panel's start, and the start page once its discussion exists, move to the
 * discussion, keeping the shared context; the start page without one returns to the list.
 */
export async function panelResourceChat(
  c: Request,
  locate: (ref: ResourceChat["ref"]) => Promise<Omit<ResourceChat, "ref"> | null>,
): Promise<{ resourceChat: ResourceChat | null; redirect: string | null; scope: ResourceChat["ref"] | null }> {
  const scope = readPanelContext(c)?.scope ?? null;
  const found = scope ? await locate(scope).catch(() => null) : null;
  const resourceChat = scope && found ? { ...found, ref: scope } : null;
  const search = new URL(c.req.raw.url).search;
  const start = /^\/app\/chat\/panel\/?$/.test(c.req.path);
  const startPage = /^\/app\/chat\/panel\/resource\/?$/.test(c.req.path);
  let redirect: string | null = null;
  if (resourceChat && (start || (startPage && resourceChatExists(resourceChat)))) redirect = `${resourceChatPath(resourceChat)}${search}`;
  else if (startPage && !resourceChat) redirect = "/app/chat/panel";
  return { resourceChat, redirect, scope };
}
