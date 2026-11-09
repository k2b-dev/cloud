import {
  type AiConversation,
  type AiOpenQuestions,
  type AiProject,
  type AiResourceContext,
  aiConversations,
  aiProjects,
  listAiOpenQuestions,
} from "@k2b/cloud/ai";
import { cloudResourceRefAppId } from "@k2b/cloud/contracts";
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

export type AssistantSidebarSnapshot = {
  conversations: AiConversation[];
  counts: import("@k2b/cloud/ai").AiConversationCounts;
  projects: AiProject[];
  doneCount: number;
  questions: AiOpenQuestions;
  /** The person's chats at places, which `conversations` leaves out: their total and newest page. Null: not listed. */
  placeChats?: { total: number; items: AiConversation[] } | null;
};

export const loadAssistantSidebarSnapshot = async (
  identity: AiResourceContext,
  context: { locale: string; timeZone: string },
  placeApp?: AssistantPlaceAppLookup,
): Promise<AssistantSidebarSnapshot> => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const [questions, projects, activeConversations, donePage, counts, placePage] = await Promise.all([
    listAiOpenQuestions({ ownerUserId: userId, ...context }),
    aiProjects.list(identity),
    aiConversations.listSidebarConversations({ ownerUserId: userId }),
    aiConversations.listConversationsPage({ ownerUserId: userId, done: true, page: 1, perPage: 15 }),
    aiConversations.getConversationCounts({ ownerUserId: userId }),
    // A failed list leaves "At places" with its failure line; the rest of the sidebar still shows.
    aiConversations.listConversationsPage({ ownerUserId: userId, place: "any", page: 1, perPage: PLACE_CHATS_PAGE }).catch(() => null),
  ]);
  const conversations = [...activeConversations, ...donePage.items];
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
          placePage.items.map(async (conversation) => ({
            ...conversation,
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
    projects: projects.map((project) => ({ ...project, id: project.shortId })),
    conversations: conversations.map((conversation) => ({
      ...conversation,
      id: conversation.shortId,
      projectId: conversation.projectId ? (projectShortIds.get(conversation.projectId) ?? null) : null,
    })),
  };
};
