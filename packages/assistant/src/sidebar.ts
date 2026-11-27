import {
  type AiConversation,
  type AiOpenQuestions,
  type AiProject,
  type AiResourceContext,
  aiConversations,
  aiProjects,
  listAiOpenQuestions,
} from "@k2b/cloud/ai";
import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { getLocale } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { catalogPerApp } from "./code-place";

/** Names the app of a place chat's place for its row; null leaves the row with the place's title alone. */
export type AssistantPlaceAppLookup = (appId: string) => Promise<{ id: string; name: string; icon: string | null } | null>;
/** The app lookup from the person's capability catalog, read once per app and request (`catalogPerApp`). */
export const placeAppsFromCatalog =
  (catalog: ReturnType<typeof catalogPerApp>): AssistantPlaceAppLookup =>
  async (appId) => {
    const app = await catalog(appId);
    return app.ok && app.data ? { id: app.data.appId, name: app.data.appName, icon: app.data.appIcon || null } : null;
  };
/** The newest chats at places the sidebar lists under "At places"; the total comes from the counts. */
const PLACE_CHATS_PAGE = 20;
/**
 * The open chats the sidebar carries on the first view, pinned first, then the newest; the list of every chat holds the
 * rest. Like the v2 navigation (#4387): a first screen and more, not every chat the person keeps open.
 */
export const ASSISTANT_SIDEBAR_CHATS = 40;

/**
 * One chat as the sidebar shows it: its title, time, state and pin, its project and place, the progress of a run, and
 * the description its settings open with (a row's edit saves it back). The chat itself (its draft, tools, keywords) is
 * read when it opens; the sidebar never carries it per row.
 */
export type AssistantSidebarChat = Pick<
  AiConversation,
  | "id"
  | "shortId"
  | "title"
  | "description"
  | "pinnedAt"
  | "done"
  | "isDone"
  | "lastUsedAt"
  | "runStatus"
  | "unreadCompletion"
  | "projectId"
> &
  Partial<Pick<AiConversation, "place" | "activity" | "runError" | "archivedAt">>;

/** The row of a chat: only what the sidebar shows, so a hundred rows never carry a hundred drafts. */
export const sidebarChat = <T extends AssistantSidebarChat>(chat: T): AssistantSidebarChat => ({
  id: chat.id,
  shortId: chat.shortId,
  title: chat.title,
  description: chat.description,
  pinnedAt: chat.pinnedAt,
  done: chat.done,
  isDone: chat.isDone,
  lastUsedAt: chat.lastUsedAt,
  runStatus: chat.runStatus,
  unreadCompletion: chat.unreadCompletion,
  projectId: chat.projectId,
  ...(chat.place ? { place: chat.place } : {}),
  // A run's progress only while it runs; an idle chat's empty progress is not sent.
  ...(chat.activity && chat.activity.total > 0 ? { activity: chat.activity } : {}),
  ...(chat.runError ? { runError: chat.runError } : {}),
  ...(chat.archivedAt ? { archivedAt: chat.archivedAt } : {}),
});

export type AssistantSidebarSnapshot = {
  conversations: AssistantSidebarChat[];
  counts: import("@k2b/cloud/ai").AiConversationCounts;
  projects: AiProject[];
  doneCount: number;
  /** More open chats exist than the sidebar lists (`ASSISTANT_SIDEBAR_CHATS`); the list of every chat holds them. */
  moreConversations?: boolean;
  questions: AiOpenQuestions;
  /** The person's chats at places, which `conversations` leaves out: their total and newest page. Null: not listed. */
  placeChats?: { total: number; items: AssistantSidebarChat[] } | null;
};

/** The person's own credentials, forwarded so Core lists what waits for them (Assistant runs outside Core). */
export const openQuestionsCaller = (c: Context): CapabilityCaller => ({
  cookie: c.req.header("cookie"),
  authorization: c.req.header("authorization"),
  locale: getLocale(c),
  signal: c.req.raw.signal,
  requestId: c.req.header("x-request-id"),
});

/**
 * The open chats the sidebar shows: at most `ASSISTANT_SIDEBAR_CHATS`, in the store's order (pinned, then the
 * newest), and whether more exist. The store reads one more than that to tell.
 */
export const sidebarPage = <T>(open: readonly T[]): { conversations: T[]; more: boolean } => ({
  conversations: open.slice(0, ASSISTANT_SIDEBAR_CHATS),
  more: open.length > ASSISTANT_SIDEBAR_CHATS,
});

export const loadAssistantSidebarSnapshot = async (
  identity: AiResourceContext,
  context: { locale: string; timeZone: string; caller: CapabilityCaller },
  placeApp?: AssistantPlaceAppLookup,
): Promise<AssistantSidebarSnapshot> => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const [questions, projects, activeConversations, donePage, counts, placePage] = await Promise.all([
    listAiOpenQuestions({ ownerUserId: userId, ...context }),
    aiProjects.list(identity),
    // One more than the sidebar shows tells whether the list goes on, in the same statement.
    aiConversations.listSidebarConversations({ ownerUserId: userId, limit: ASSISTANT_SIDEBAR_CHATS + 1 }),
    aiConversations.listConversationsPage({ ownerUserId: userId, done: true, page: 1, perPage: 15 }),
    aiConversations.getConversationCounts({ ownerUserId: userId }),
    // A failed list leaves "At places" with its failure line; the rest of the sidebar still shows. Its total is in the
    // counts, so the list itself counts nothing.
    aiConversations.listConversations({ ownerUserId: userId, place: "any", limit: PLACE_CHATS_PAGE }).catch(() => null),
  ]);
  const open = sidebarPage(activeConversations);
  const moreConversations = open.more;
  const conversations = [...open.conversations, ...donePage.items];
  const apps = new Map<string, ReturnType<AssistantPlaceAppLookup>>();
  const appOf = (appId: string) => {
    let app = apps.get(appId);
    if (!app) {
      app = placeApp ? placeApp(appId).catch(() => null) : Promise.resolve(null);
      apps.set(appId, app);
    }
    return app;
  };
  const placeChats = placePage
    ? {
        total: counts.places.total,
        items: await Promise.all(
          placePage.map(async (conversation) => ({
            ...sidebarChat(conversation),
            id: conversation.shortId,
            projectId: null,
            place: conversation.place ? { ...conversation.place, app: await appOf(cloudResourceRefAppId(conversation.place.ref)) } : null,
          })),
        ),
      }
    : null;
  const projectShortIds = await aiProjects.resolveShortIds(
    conversations.flatMap((conversation) => (conversation.projectId ? [conversation.projectId] : [])),
    identity,
  );
  return {
    questions,
    counts,
    placeChats,
    doneCount: donePage.total,
    moreConversations,
    projects: projects.map((project) => ({ ...project, id: project.shortId })),
    conversations: conversations.map((conversation) => ({
      ...sidebarChat(conversation),
      id: conversation.shortId,
      projectId: conversation.projectId ? (projectShortIds.get(conversation.projectId) ?? null) : null,
    })),
  };
};
