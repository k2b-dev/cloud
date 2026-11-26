import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { useLocale } from "@k2b/ui";
import { type MenuEntry, type NavGroup, type NavItem, type OnNavigate, type Status, useToast } from "@k2b/ui/v2";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { assistantApi } from "../../api/client";
import { assistantCommandMessages } from "../../commands";
import { openAssistantPrefsModal } from "../AssistantPrefsModals";
import type { AssistantArchiveBlocker } from "../archive-blocker";
import { assistantConversationHref, assistantProjectHref } from "../assistant-navigation";
import { conversationPlace } from "../assistant-place";
import { assistantProjectSearchOptions, assistantProjectsSearchOptions, assistantSearchOptions } from "../assistant-search";
import { type ConversationAgeGroup, groupConversationsByAge, isConversationBusy } from "../conversation-view";
import { assistantMessages } from "../messages";
import { placeMessages } from "../place-messages";
import { useAssistantText } from "../ui-copy";
import { assistantV2Messages } from "./assistant-v2-messages";

/** A Tabler class as v1 stores it ("ti ti-folder") as the v2 name ("folder"). */
export const iconName = (icon: string | null | undefined, fallback: string): string => icon?.trim().replace(/^ti\s+ti-/, "") || fallback;

export type AssistantNavOptions = {
  basePath: string;
  conversations: Accessor<AiConversation[]>;
  doneCount: Accessor<number>;
  timeZone: string;
  renderedAt: string;
  activeConversationId: Accessor<string | null>;
  activeView: Accessor<"chat" | "approvals" | "code">;
  activeProjectId: Accessor<string | null>;
  projects: Accessor<AiProject[]>;
  waitingCount: Accessor<number>;
  hasPersonalCode: Accessor<boolean>;
  placeChats: Accessor<{ total: number; items: AiConversation[] } | null>;
  /** Opens a chat in place; false when it could not, and the address then loads as a page. */
  openConversation: (conversationId: string) => Promise<boolean>;
  openProject: (projectId: string) => Promise<boolean>;
  openApprovals: () => void;
  openCode: () => void;
  createProject: () => void | Promise<void>;
  editConversation: (conversation: AiConversation) => void | Promise<void>;
  showDetails: (conversation: AiConversation) => void | Promise<void>;
  archiveConversation: (conversation: AiConversation) => void | Promise<void>;
  archiveBlocker: (conversation: AiConversation) => AssistantArchiveBlocker;
  openAllChats: () => void;
  openPreferences: () => void | Promise<void>;
  onConversationUpdated: (conversation: AiConversation) => void;
};

/**
 * The Assistant's sidebar on v2, as data for `Nav` and the phone menu (`V2WorkspaceNavigation`): what waits for the
 * person and their apps first, then the Projects, the chats by the day they were last used (pinned ones first), the
 * chats at places and the done chats folded away, and "Personalize" at the foot. Each chat opens in place through its
 * link; its "…" holds editing, pinning, done and archiving. The same deeds as v1's sidebar, in v2's places.
 */
export function createAssistantNav(options: AssistantNavOptions) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const v2 = () => assistantV2Messages.resolve([locale()]).t;
  const placeT = () => placeMessages.resolve([locale()]).t;
  const text = useAssistantText();
  const toast = useToast();

  // The day sections follow the clock: the server's render time first, so hydration builds the same sections.
  const [now, setNow] = createSignal(options.renderedAt);
  onMount(() => {
    setNow(new Date().toISOString());
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 60_000);
    onCleanup(() => window.clearInterval(timer));
  });

  // The skill editor opened by a link (`?skill=<id>`), as v1's sidebar did; the address forgets it once open.
  onMount(() => {
    const url = new URL(window.location.href);
    const skillId = url.searchParams.get("skill");
    if (!skillId) return;
    url.searchParams.delete("skill");
    window.history.replaceState(window.history.state, "", url);
    void openAssistantPrefsModal("skills", { skillId });
  });

  const activeProject = () => options.projects().find((project) => project.id === options.activeProjectId());
  const searchOptions = () => {
    const project = activeProject();
    return project ? assistantProjectSearchOptions(project) : assistantSearchOptions(locale());
  };
  const search = (query = "") => openGlobalSearch({ ...searchOptions(), query });
  // The search of every chat (or of the open Project) on mod+shift+k, as v1's sidebar registered it.
  createEffect(() => {
    const commands = assistantCommandMessages.resolve([locale()]).t;
    const project = activeProject();
    onCleanup(
      registerContextAwareCommand({
        id: "assistant.search",
        title: project ? commands.searchProject : t().searchChats,
        description: project ? commands.searchProjectDescription({ name: project.name }) : commands.searchChatsDescription,
        icon: "ti ti-search",
        shortcut: options.activeConversationId() ? undefined : "mod+shift+k",
        action: { search: searchOptions() },
      }),
    );
  });

  const currentChatId = () => (options.activeView() === "chat" && !options.activeProjectId() ? options.activeConversationId() : null);
  const chatHref = (conversation: AiConversation) => assistantConversationHref(options.basePath, conversation.id);
  const openChat =
    (conversation: AiConversation): OnNavigate =>
    async (nav) => {
      if (conversation.id === currentChatId()) return;
      try {
        if (await options.openConversation(conversation.id)) nav.push(undefined, { scroll: "manual" });
        else nav.fallback();
      } catch {
        nav.fallback();
      }
    };

  const setDone = async (conversation: AiConversation, done: boolean) => {
    try {
      options.onConversationUpdated(await assistantApi.setConversationDone(conversation.id, done));
      toast(done ? v2().markedDone : v2().reopened, {
        status: "ok",
        undo: () => setDone(conversation, !done),
      });
    } catch {
      toast(text("Could not update chat. Stop the response first or try again."), { status: "bad" });
    }
  };
  const setPinned = async (conversation: AiConversation, pinned: boolean) => {
    try {
      options.onConversationUpdated(await assistantApi.setConversationPinned(conversation.id, pinned));
    } catch {
      toast(text("Could not update pin."), { status: "bad" });
    }
  };

  const chatMenu = (conversation: AiConversation): MenuEntry[] => {
    const busy = isConversationBusy(conversation);
    const blocker = options.archiveBlocker(conversation);
    return [
      { label: v2().editChat, icon: "pencil", onClick: () => options.editConversation(conversation) },
      { label: text("Chat details"), icon: "info-circle", onClick: () => options.showDetails(conversation) },
      {
        label: conversation.pinnedAt ? v2().unpinChat : v2().pinChat,
        icon: conversation.pinnedAt ? "pinned-off" : "pin",
        onClick: () => setPinned(conversation, !conversation.pinnedAt),
      },
      // A pinned chat stays open; a chat whose run goes on cannot be marked done until it ends or is stopped.
      ...(conversation.pinnedAt
        ? []
        : [
            conversation.isDone
              ? { label: text("Reopen chat"), icon: "arrow-back-up", onClick: () => setDone(conversation, false) }
              : {
                  label: busy ? text("Stop the response before marking it done") : text("Mark chat done"),
                  icon: "check",
                  disabled: busy,
                  onClick: () => setDone(conversation, true),
                },
          ]),
      "separator",
      {
        label: v2().archiveChat,
        icon: "archive",
        danger: true,
        disabled: blocker !== null,
        meta: blocker === "waiting" ? t().decideBeforeArchive : blocker === "running" ? t().stopBeforeArchive : undefined,
        onClick: () => options.archiveConversation(conversation),
      },
    ];
  };

  // A chat's state is colour, sign and word: a new answer, a question that waits, a run that failed. A run that
  // goes on shows its sign in place of the chat's own.
  const dotOf = (conversation: AiConversation): Status | undefined =>
    conversation.runStatus === "needs_attention"
      ? "warn"
      : conversation.runStatus === "failed"
        ? "bad"
        : conversation.unreadCompletion && conversation.id !== currentChatId()
          ? "ok"
          : undefined;
  const iconOf = (conversation: AiConversation) => {
    if (["running", "queued", "waiting_for_browser"].includes(conversation.runStatus)) return "loader-2";
    const place = conversationPlace(conversation);
    if (place) return iconName(place.app?.icon, "map-pin");
    if (conversation.pinnedAt) return "pin";
    const project = conversation.projectId ? options.projects().find((entry) => entry.id === conversation.projectId) : undefined;
    return project ? iconName(project.icon, "folder") : "message";
  };
  const chatEntry = (conversation: AiConversation): NavItem => ({
    label: conversation.title,
    icon: iconOf(conversation),
    href: chatHref(conversation),
    onNavigate: openChat(conversation),
    current: conversation.id === currentChatId(),
    dot: dotOf(conversation),
    menu: chatMenu(conversation),
  });

  const groupLabel = (group: ConversationAgeGroup) =>
    ({
      pinned: t().pinned,
      today: t().today,
      yesterday: t().yesterday,
      week: t().previousWeek,
      month: t().previousMonth,
      older: t().older,
    })[group];

  const openChats = () => options.conversations().filter((conversation) => !conversation.isDone);
  const doneChats = () => options.conversations().filter((conversation) => conversation.isDone);
  // The views open in place and write their own address.
  const inPlace =
    (open: () => void): OnNavigate =>
    () =>
      open();

  const groups = createMemo((): NavGroup[] => {
    const view = options.activeView();
    const base = options.basePath;
    const top: NavItem[] = [
      {
        label: t().waitingForYou,
        icon: "hand-stop",
        href: `${base}?approvals=1`,
        onNavigate: inPlace(options.openApprovals),
        current: view === "approvals",
        count: options.waitingCount() > 0 ? options.waitingCount().toLocaleString(locale()) : undefined,
        dot: options.waitingCount() > 0 ? "warn" : undefined,
      },
      ...(options.hasPersonalCode() || view === "code"
        ? [
            {
              label: t().myCode,
              icon: "stack-2",
              href: `${base}?code=1`,
              onNavigate: inPlace(options.openCode),
              current: view === "code",
            } satisfies NavItem,
          ]
        : []),
      { label: t().allChats, icon: "messages", onClick: options.openAllChats },
    ];
    const projects: NavGroup = {
      label: t().projects,
      action: {
        label: v2().projectGroupActions,
        items: [
          { label: t().newProject, icon: "plus", onClick: () => options.createProject() },
          { label: t().searchProjects, icon: "search", onClick: () => openGlobalSearch(assistantProjectsSearchOptions(locale())) },
        ],
      },
      items: options.projects().map((project) => ({
        label: project.name,
        icon: iconName(project.icon, "folder"),
        href: assistantProjectHref(base, project.id),
        onNavigate: async (nav) => {
          if (options.activeProjectId() === project.id && view === "chat") return;
          try {
            if (await options.openProject(project.id)) nav.push(undefined, { scroll: "manual" });
            else nav.fallback();
          } catch {
            nav.fallback();
          }
        },
        current: view === "chat" && options.activeProjectId() === project.id,
      })),
    };
    const chats = groupConversationsByAge(openChats(), now(), options.timeZone).map(
      (entry): NavGroup => ({ label: groupLabel(entry.group), items: entry.conversations.map(chatEntry) }),
    );
    // What the main list leaves out, folded at its end: the chats at places and the done chats.
    const placeChats = options.placeChats();
    const folded: NavItem[] = [
      ...(placeChats && placeChats.total > 0
        ? [{ label: placeT().atPlaces, count: placeChats.total.toLocaleString(locale()), items: placeChats.items.map(chatEntry) }]
        : []),
      ...(options.doneCount() > 0 || doneChats().length > 0
        ? [
            {
              label: text("Done"),
              count: Math.max(options.doneCount(), doneChats().length).toLocaleString(locale()),
              items: [...doneChats().map(chatEntry), { label: t().allChats, icon: "messages", onClick: options.openAllChats }],
            },
          ]
        : []),
    ];
    return [
      { items: top },
      projects,
      ...(chats.length > 0 ? chats : [{ label: v2().chats, items: [] }]),
      ...(folded.length > 0 ? [{ items: folded }] : []),
    ];
  });
  const foot = createMemo((): NavItem[] => [{ label: t().personalize, icon: "user-cog", onClick: () => void options.openPreferences() }]);

  return { groups, foot, search, chatMenu, label: () => t().assistant };
}
