import type { AiConversation, AiConversationPage, AiConversationStatusFilter } from "@k2b/cloud/ai";
import { query as solidQuery } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { assistantApi } from "../api/client";
import { type AssistantLiveInvalidation, matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import type { ConversationOpenResult } from "./assistant-navigation";
import { assistantMessages } from "./messages";
import { useAssistantText } from "./ui-copy";

// "All chats" on v1 and v2: one search, one filter, one page of the person's history. The dialogs only draw it.

export type ChatView = "done" | "all" | "running" | "needs_attention" | "failed" | "unread" | "archived";

const PER_PAGE = 20;

export const emptyViewText = (view: ChatView, search: string, text: (value: string) => string): string => {
  if (search) return text("No chats match your search.");
  if (view === "done") return text("No done chats.");
  if (view === "archived") return text("No archived chats.");
  if (view === "running") return text("No chats are running.");
  if (view === "needs_attention") return text("No chats need attention.");
  if (view === "failed") return text("No failed chats.");
  if (view === "unread") return text("No new responses.");
  return text("No chats yet.");
};

export const createAllChats = (props: {
  close: () => void;
  initialView?: ChatView;
  openConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>;
}) => {
  const text = useAssistantText();
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  // One quiet filter beside the search instead of seven segments that wrap on narrow screens.
  const chatViews = (): { value: ChatView; label: string }[] => [
    { value: "all", label: text("All chats") },
    { value: "unread", label: text("New responses") },
    { value: "running", label: t().running },
    { value: "needs_attention", label: t().needsAttention },
    { value: "failed", label: t().failed },
    { value: "done", label: text("Done") },
    { value: "archived", label: text("Archived") },
  ];
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal<ChatView>(props.initialView ?? "all");
  const [page, setPage] = createSignal(1);
  const [requestQuery, setRequestQuery] = createSignal("");
  let latestOpenRequestId = 0;
  const source = createMemo(() => JSON.stringify({ query: requestQuery(), view: view(), page: page() }));
  const result = solidQuery.create<string, AiConversationPage, AssistantLiveInvalidation>({
    source,
    load: async (serialized, { abortSignal }) => {
      const input = JSON.parse(serialized) as { query: string; view: ChatView; page: number };
      const status =
        input.view !== "all" && input.view !== "archived" && input.view !== "done" ? (input.view as AiConversationStatusFilter) : undefined;
      return assistantApi.listConversationsPage({
        q: input.query || undefined,
        page: input.page,
        perPage: PER_PAGE,
        archived: input.view === "archived",
        done: input.view === "done" ? true : undefined,
        status,
        signal: abortSignal,
      });
    },
  });
  const live = useAssistantLive();
  const unregister = live.register({
    matches: matchesAssistantInvalidation(["conversation-list", "project-list"]),
    invalidate: (invalidation) => result.invalidate(invalidation),
  });
  onCleanup(unregister);

  createEffect(() => {
    const value = query().trim();
    const timer = window.setTimeout(() => setRequestQuery(value), 180);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const value = result.data();
    if (!value) return;
    const lastPage = Math.max(1, Math.ceil(value.total / value.perPage));
    if (value.page > lastPage) setPage(lastPage);
  });

  const search = (value: string) => {
    setPage(1);
    setQuery(value);
  };
  const selectView = (next: ChatView) => {
    setPage(1);
    setView(next);
  };
  const totalPages = () => Math.max(1, Math.ceil((result.data()?.total ?? 0) / (result.data()?.perPage ?? PER_PAGE)));
  const openConversation = async (conversation: AiConversation): Promise<ConversationOpenResult> => {
    const requestId = ++latestOpenRequestId;
    const opened = await props.openConversation(conversation);
    if (requestId !== latestOpenRequestId) return "stale";
    if (opened !== "stale") props.close();
    return opened;
  };
  onCleanup(() => {
    latestOpenRequestId += 1;
  });

  return { chatViews, query, search, view, selectView, page, setPage, result, totalPages, openConversation };
};
