import { readPanelContext } from "@k2b/cloud/ssr";

export type ResourceChat = { id: string; thread: string | null; ref: { type: string; id: string }; title: string };
type Request = { req: { path: string; raw: { url: string } } };

/**
 * The panel starts in the discussion about the host page's resource: a container's chat, or an item's thread in its
 * container's chat. The shared scope is an untrusted selector:
 * `open` reads it as the signed-in reader and answers null where no discussion exists that they may read, so the
 * panel stays at the chat list. Only the panel's start address moves to the discussion, keeping the shared context.
 */
export async function panelResourceChat(
  c: Request,
  open: (ref: ResourceChat["ref"]) => Promise<Omit<ResourceChat, "ref"> | null>,
): Promise<{ resourceChat: ResourceChat | null; redirect: string | null; scope: ResourceChat["ref"] | null }> {
  const scope = readPanelContext(c)?.scope;
  const opened = scope ? await open(scope).catch(() => null) : null;
  const resourceChat = scope && opened ? { ...opened, ref: scope } : null;
  const redirect =
    resourceChat && /^\/app\/chat\/panel\/?$/.test(c.req.path)
      ? `/app/chat/panel/c/${encodeURIComponent(resourceChat.id)}${resourceChat.thread ? `/t/${encodeURIComponent(resourceChat.thread)}` : ""}${new URL(c.req.raw.url).search}`
      : null;
  return { resourceChat, redirect, scope: scope ?? null };
}
