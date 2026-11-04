import type { AiConversationService, AiStoredMessage, aiProjects } from "@k2b/cloud/ai";
import { CodeResourceId } from "@k2b/cloud/ai/browser";
import {
  type CapabilityExecutionContext,
  CloudResourceReaderViewSchema,
  type CloudResourceView,
  type UniversalSearchInput,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import type { artifacts } from "./artifacts/service";
import { assistantCommandMessages } from "./commands";

type SearchStore = Pick<AiConversationService, "listConversations" | "getConversationByShortId" | "searchConversationMessages">;
const textOf = (message: AiStoredMessage): string =>
  message.message.role === "tool_result"
    ? ""
    : message.message.content
        .flatMap((part) => (typeof part === "string" ? [part] : part.type === "text" ? [part.text] : []))
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();

/** Both projections reuse the existing owner-scoped Assistant search service. */
export const searchAssistant = async (
  input: UniversalSearchInput,
  context: Pick<CapabilityExecutionContext, "actor" | "accessSubject" | "locale">,
  store: SearchStore,
  projects: Pick<typeof aiProjects, "getByShortId">,
) => {
  const t = assistantCommandMessages.resolve([context.locale]).t;
  if (context.accessSubject.type !== "user") return fail(err.forbidden(t.userRequired));
  const ownerUserId = context.accessSubject.userId;
  let projectId: string | undefined;
  if (input.scope?.type === "assistant.project") {
    const project = await projects.getByShortId(input.scope.id, context);
    if (!project) return fail(err.notFound(t.project));
    projectId = project.id;
  } else if (input.scope) {
    if (input.scope.type !== "assistant.chat") return fail(err.badInput(t.invalidSearchScope));
    const chat = await store.getConversationByShortId({ shortId: input.scope.id, ownerUserId });
    if (!chat || chat.createdByUserId !== ownerUserId) return fail(err.notFound(t.chat));
    const page = await store.searchConversationMessages({ conversationId: chat.id, query: input.query, limit: input.limit });
    const data: CloudResourceView[] = page.messages.slice(0, input.limit).map((message) => ({
      ref: { type: "assistant.message", id: message.shortId },
      title: (textOf(message) || t.message).slice(0, 500),
      preview: textOf(message).slice(0, 2000),
      icon: message.message.role === "user" ? "ti ti-user" : "ti ti-sparkles",
      priority: 8,
      metadata: [{ label: t.chat, value: chat.title }],
      links: [{ rel: "open", href: `/app/assistant?conversation=${encodeURIComponent(chat.shortId)}&message=${message.seq}` }],
    }));
    return ok({ data });
  }
  const chats = await store.listConversations({
    ownerUserId,
    search: input.query,
    limit: input.limit,
    ...(projectId ? { projectId } : {}),
  });
  const data: CloudResourceView[] = chats.map((chat) => ({
    ref: { type: "assistant.chat", id: chat.shortId },
    title: chat.title.slice(0, 500),
    preview: (chat.description || "").slice(0, 2000),
    icon: "ti ti-messages",
    priority: 7,
    links: [{ rel: "open", href: `/app/assistant?conversation=${encodeURIComponent(chat.shortId)}` }],
  }));
  return ok({ data });
};

/** Reuse the authorized project catalog; filter before applying the result limit. */
export const searchAssistantProjects = async (
  input: UniversalSearchInput,
  context: Pick<CapabilityExecutionContext, "actor" | "accessSubject" | "locale">,
  projects: Pick<typeof aiProjects, "list">,
) => {
  if (input.scope) return fail(err.badInput(assistantCommandMessages.resolve([context.locale]).t.invalidSearchScope));
  const terms = input.query.toLocaleLowerCase(context.locale).trim().split(/\s+/u).filter(Boolean);
  const visible = await projects.list(context);
  const data: CloudResourceView[] = visible
    .filter((project) => {
      const text = `${project.name} ${project.description}`.toLocaleLowerCase(context.locale);
      return terms.every((term) => text.includes(term));
    })
    .slice(0, input.limit)
    .map((project) => ({
      ref: { type: "assistant.project", id: project.shortId },
      title: project.name.slice(0, 500),
      preview: project.description.slice(0, 2000),
      icon: project.icon || "ti ti-folders",
      priority: 7,
      links: [{ rel: "open", href: `/app/assistant?project=${encodeURIComponent(project.shortId)}` }],
    }));
  return ok({ data });
};

/** Studio search uses the same permission-aware published/draft projection as its catalog. */
export const searchAssistantApps = async (
  input: UniversalSearchInput,
  context: Pick<CapabilityExecutionContext, "actor" | "actor" | "accessSubject" | "locale">,
  store: Pick<typeof artifacts, "list">,
) => {
  const t = assistantCommandMessages.resolve([context.locale]).t;
  if (input.scope) return fail(err.badInput(t.invalidSearchScope));
  if (context.accessSubject.type !== "user") return fail(err.forbidden(t.userRequired));
  const page = await store.list(context, 1, input.query, input.limit);
  const data: CloudResourceView[] = page.items.map((app) => ({
    ref: { type: "assistant.app", id: app.id },
    title: app.title.slice(0, 500),
    preview: (app.description || "").slice(0, 2000),
    icon: app.icon || "ti ti-app-window",
    priority: 7,
    links: [{ rel: "open", href: `/app/assistant/apps/${encodeURIComponent(app.id)}` }],
  }));
  return ok({ data });
};

export const AppReadInputSchema = z.object({ id: CodeResourceId.describe("Studio app ID from an assistant.app ref.") }).strict();
export const AppReadDataSchema = z.object({ view: CloudResourceReaderViewSchema }).strict();

/**
 * The Studio app reader: title and the person's own level, from the same projection as search. Apps the person cannot
 * open, and callers other than a person, find nothing. A target search for service accounts asks it for Manage.
 */
export const readAssistantApp = async (
  input: z.infer<typeof AppReadInputSchema>,
  context: Pick<CapabilityExecutionContext, "actor" | "accessSubject" | "locale">,
  store: Pick<typeof artifacts, "describe">,
) => {
  const t = assistantCommandMessages.resolve([context.locale]).t;
  const [app] = context.accessSubject.type === "user" ? await store.describe([input.id], context) : [];
  if (!app) return fail(err.notFound(t.studioApp));
  return ok({
    data: { view: { title: app.title.slice(0, 500), permission: app.permission === "admin" ? ("admin" as const) : ("read" as const) } },
    refs: [{ type: "assistant.app", id: app.id }],
    links: [{ rel: "open" as const, href: `/app/assistant/apps/${encodeURIComponent(app.id)}` }],
  });
};
