import { aiConversations, assistantAiSettingsState, getLiveDictationStatus, loadAiStreamState } from "@k2b/cloud/ai";
import { aiLive } from "@k2b/cloud/ai/live";
import { type AuthContext, expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { getLocalizedRuntimeContext, PwaLayout } from "@k2b/cloud/ssr";
import type { Context } from "hono";
import { app, ssr } from "../config";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import AssistantPwa, { type AssistantPwaProps } from "./AssistantPwa.island";
import { pwaMessages } from "./messages";
import type { PwaAddress } from "./paths";

/** The part's name and icon as the Cloud app shows them, in the reader's language. */
const presentation = <E extends AuthContext>(c: Context<E>) => {
  const meta = getLocalizedRuntimeContext(c).apps.find((candidate) => candidate.id === app.meta.id);
  return { name: meta?.name ?? app.meta.name, icon: meta?.icon ?? app.meta.icon };
};

const render = async <E extends AuthContext>(c: Context<E>, address: PwaAddress) => {
  c.header("Cache-Control", "private, no-store");
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const t = pwaMessages.resolve([locale]).t;
  const user = expectUserBackedActor(c);
  const identity = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
  const part = presentation(c);
  const [initialLiveCursor, settings, liveDictation, sidebar, total] = await Promise.all([
    aiLive.cursor(),
    assistantAiSettingsState({ type: "user", userId: user.id }),
    getLiveDictationStatus(c.get("accessSubject")),
    // A list that fails to load leaves the rest of the part usable; the island offers to try again.
    loadAssistantSidebarSnapshot(identity, { locale, timeZone }).catch(() => null),
    aiConversations
      .listConversationsPage({ ownerUserId: user.id, page: 1, perPage: 1 })
      .then((page) => page.total)
      .catch(() => null),
  ]);
  // A chat that does not exist and one of another person read the same: the address names no chat.
  const record =
    address.level === "chat" ? await aiConversations.getConversationByShortId({ shortId: address.id, ownerUserId: user.id }) : null;
  if (record) await aiConversations.markConversationViewed({ conversationId: record.id, ownerUserId: user.id });
  const conversation = record ? { ...record, unreadCompletion: false } : null;
  const [detail, timeline] = conversation
    ? await Promise.all([loadAiStreamState(conversation), aiConversations.listConversationTimeline({ conversationId: conversation.id })])
    : [null, []];
  if (address.level === "chat" && !conversation) c.status(404);
  const props: AssistantPwaProps = {
    userId: user.id,
    name: part.name,
    icon: part.icon,
    status: { ...settings, liveDictationAvailable: liveDictation.available },
    // App sessions never carry administration, so the way to set up AI stays on the web.
    canConfigure: user.roles.includes("admin"),
    timeZone,
    renderedAt: new Date().toISOString(),
    initialLiveCursor,
    initialAddress: address,
    initialSidebar: sidebar
      ? {
          conversations: sidebar.conversations.map((entry) =>
            entry.id === conversation?.shortId ? { ...entry, unreadCompletion: false } : entry,
          ),
          questions: sidebar.questions,
        }
      : null,
    initialTotal: total,
    initialDetail: detail
      ? {
          conversation: detail.conversation,
          messages: detail.messages,
          hasMoreMessages: detail.hasMoreMessages ?? false,
          activeTurn: detail.activeTurn,
          timeline,
        }
      : null,
  };
  const title = address.level === "chat" ? (conversation?.title ?? t.chatUnavailable) : address.level === "new" ? t.newChat : part.name;
  return () => (
    <PwaLayout c={c} title={title} bare screen={address.level !== "start"}>
      <AssistantPwa {...props} />
    </PwaLayout>
  );
};

/** `/pwa/assistant`: the person's recent chats, what waits for them, and a field to ask something new. */
export const startPage = ssr<AuthContext>((c) => render(c, { level: "start" }));

/** `/pwa/assistant/new`: a new chat; on a phone a screen of its own, beside the list from 64rem. */
export const newChatPage = ssr<AuthContext>((c) => render(c, { level: "new" }));

/** `/pwa/assistant/c/<chat>`: one of the person's chats, read with the same owner rule as the web. */
export const chatPage = ssr<AuthContext>((c) => render(c, { level: "chat", id: c.req.param("chat") ?? "" }));
