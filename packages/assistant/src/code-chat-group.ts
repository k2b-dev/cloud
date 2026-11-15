import { i18n } from "@k2b/stdlib";
import { z } from "zod";
import type { AssistantChatContextGroup } from "./chat-context";
import type { CodeQueryInvoke } from "./code-summary";

/**
 * The box's group "Automations": the Code this chat submitted, read through Core's public `core.code.chat.list` like
 * any application could. The box itself knows only the generic group; the state words of concept 3d live here.
 */
const CodeChatListSchema = z.object({
  items: z.array(
    z.object({
      codeId: z.string(),
      title: z.string(),
      state: z.enum(["on", "paused", "ready", "waiting", "changes", "revising", "rejected"]),
      attention: z.boolean(),
      anchor: z.string(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type CodeChatList = z.infer<typeof CodeChatListSchema>;
type CodeChatState = CodeChatList["items"][number]["state"];

export const codeChatGroupMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      label: "Automations",
      openPage: ({ title }: { title: string }) => `Open the Code page of “${title}”`,
      on: "Switched on",
      paused: "Paused",
      ready: "Ready, still off",
      waiting: "Waiting for admin",
      changes: "Changes requested",
      revising: "Gustav is revising",
      rejected: "Rejected",
    },
    de: {
      label: "Automationen",
      openPage: ({ title }: { title: string }) => `Code-Seite von „${title}“ öffnen`,
      on: "Eingeschaltet",
      paused: "Pausiert",
      ready: "Bereit, noch aus",
      waiting: "Wartet auf Admin",
      changes: "Änderungen angefordert",
      revising: "Gustav überarbeitet",
      rejected: "Abgelehnt",
    },
  },
});

/** Colour of the state word: plum while Gustav or the person can move it on, the warning colour while it waits. */
const TONE: Record<CodeChatState, AssistantChatContextGroup["rows"][number]["tone"]> = {
  on: "ok",
  paused: "warn",
  ready: "ai",
  waiting: "warn",
  changes: "warn",
  revising: "ai",
  rejected: undefined,
};

/** The group from Core's answer; null when the chat submitted no readable Code. */
export const codeChatGroup = (list: CodeChatList, locale: string): AssistantChatContextGroup | null => {
  if (list.count === 0) return null;
  const t = codeChatGroupMessages.resolve([locale]).t;
  return {
    key: "automations",
    label: t.label,
    count: list.count,
    // All of the person's Code, where every automation of this chat is listed too.
    allHref: "/app/assistant?code=1",
    rows: list.items.map((item) => ({
      key: item.codeId,
      icon: "ti ti-code",
      title: item.title,
      word: t[item.state],
      tone: TONE[item.state],
      attention: item.attention,
      anchor: item.anchor,
      action: { href: `/app/assistant/code/${item.codeId}`, label: t.openPage({ title: item.title }), icon: "ti ti-arrow-up-right" },
    })),
  };
};

/**
 * Reads the chat's Code with the person's own credentials. A Core that cannot answer leaves the group out; the box keeps
 * everything else, and the next live update reads again.
 */
export const loadCodeChatGroup = async (
  invoke: CodeQueryInvoke,
  conversationId: string,
  locale: string,
): Promise<AssistantChatContextGroup | null> => {
  const result = await invoke(
    { appId: "core", capabilityId: "code.chat.list", kind: "query", input: { conversationId } },
    CodeChatListSchema,
  ).catch(() => null);
  return result?.ok ? codeChatGroup(result.data.data, locale) : null;
};
