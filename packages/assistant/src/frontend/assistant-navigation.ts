const URL_BASE = "http://assistant.local";

const relativeHref = (url: URL): string => `${url.pathname}${url.search}${url.hash}`;
export type ConversationOpenResult = "opened" | "unchanged" | "stale";

export const shouldCommitConversationNavigation = (result: ConversationOpenResult, currentHref: string, targetHref: string): boolean =>
  result === "opened" ||
  (result === "unchanged" && relativeHref(new URL(currentHref, URL_BASE)) !== relativeHref(new URL(targetHref, URL_BASE)));

/** A Project page must reopen its underlying active chat so the visible view can change back to that chat. */
export const shouldOpenProjectConversation = (
  activeProjectId: string | null | undefined,
  activeConversationId: string | null,
  targetConversationId: string,
): boolean => Boolean(activeProjectId) || activeConversationId !== targetConversationId;

export const assistantConversationHref = (currentHref: string, conversationId: string | null): string => {
  const url = new URL(currentHref, URL_BASE);
  const previousConversationId = url.searchParams.get("conversation");
  if (conversationId) url.searchParams.set("conversation", conversationId);
  else url.searchParams.delete("conversation");
  url.searchParams.delete("project");
  url.searchParams.delete("q");
  if (previousConversationId !== conversationId) {
    url.searchParams.delete("artifact");
    url.searchParams.delete("message");
  }
  return relativeHref(url);
};

export const assistantProjectHref = (currentHref: string, projectId: string): string => {
  const url = new URL(currentHref, URL_BASE);
  url.searchParams.delete("conversation");
  url.searchParams.delete("message");
  url.searchParams.delete("artifact");
  url.searchParams.set("project", projectId);
  url.searchParams.delete("q");
  return relativeHref(url);
};

export const assistantConversationIdFromHref = (href: string): string | null => new URL(href, URL_BASE).searchParams.get("conversation");

export const assistantProjectIdFromHref = (href: string): string | null => new URL(href, URL_BASE).searchParams.get("project");

export const assistantArtifactHref = (currentHref: string, path: string | null): string => {
  const url = new URL(currentHref, URL_BASE);
  if (path) url.searchParams.set("artifact", path);
  else url.searchParams.delete("artifact");
  return relativeHref(url);
};

export const assistantArtifactPathFromHref = (href: string): string | null => new URL(href, URL_BASE).searchParams.get("artifact");

/** Message sequence links remain valid across reloads and history navigation. */
export const assistantMessageSeqFromHref = (href: string): number | null => {
  const value = new URL(href, URL_BASE).searchParams.get("message");
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) ? seq : null;
};
