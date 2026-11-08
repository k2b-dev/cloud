import type { Context } from "hono";
import { resolveCapabilityOperationTitle } from "../_internal/capabilities";
import { getCapability } from "../_internal/registry";
import { type CloudResourceRef, capabilityActionPolicy, cloudResourceRefAppId } from "../contracts/capabilities";
import { getLocale } from "../server/locale";
import { type AuthContext, auth } from "../server/middleware/auth";
import { appAccessAuthority } from "../services/app-access";
import { panelContextConsent } from "../services/panel-context-consent";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { runPlaceProvider } from "./place-provider";
import { aiProjects } from "./projects";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import type { AiConversation } from "./types";

export type PlaceAssistantState =
  | { state: "none" | "consent_required" }
  | {
      state: "unavailable";
      ref: CloudResourceRef;
      title: string | null;
      conversationId: string | null;
      retry?: true;
    }
  | {
      state: "available";
      ref: CloudResourceRef;
      title: string;
      app: { id: string; name: string; icon: string | null };
      typeTitle: string;
      tools: { id: string; title: string; icon: string | null; policy: ReturnType<typeof capabilityActionPolicy> | null }[];
      skills: { id: string; title: string }[];
      starters: { label: string; prompt: string }[];
      conversationId: string | null;
      conversation: AiConversation | null;
    };

const dependencies = {
  consent: panelContextConsent.get,
  capability: getCapability,
  provider: runPlaceProvider,
  conversation: aiConversations.findPlaceConversation,
  skills: aiSkills.list,
  projectIds: aiProjects.resolveShortIds,
};

export const createPlaceAssistantLoader =
  (deps: typeof dependencies) =>
  async <T extends AuthContext>(c: Context<T>, scope: CloudResourceRef | null | undefined): Promise<PlaceAssistantState> => {
    const actor = c.get("actor");
    if (!scope || actor?.kind !== "user") return { state: "none" };
    // Consent gates even registry and chat reads. The selector never grants resource access.
    if (!(await deps.consent(actor.user.id, "assistant"))?.allowed) return { state: "consent_required" };
    const app = await deps.capability(cloudResourceRefAppId(scope));
    const type = app?.manifest.types.find((entry) => `${app.appId}.${entry.localId}` === scope.type);
    if (!app || !type?.assistant) {
      const conversation = await deps.conversation({ ownerUserId: actor.user.id, ref: scope });
      if (!app) {
        return {
          state: "unavailable",
          ref: scope,
          title: conversation?.place?.title ?? null,
          conversationId: conversation?.shortId ?? null,
          retry: true,
        };
      }
      return conversation
        ? { state: "unavailable", ref: scope, title: conversation.place?.title ?? null, conversationId: conversation.shortId }
        : { state: "none" };
    }
    const place = await deps.provider(auth.getAuthority(c), scope, { locale: getLocale(c), signal: c.req.raw.signal });
    const conversation = await deps.conversation({ ownerUserId: actor.user.id, ref: scope });
    if ("unavailable" in place) {
      return {
        state: "unavailable",
        ref: scope,
        title: conversation?.place?.title ?? null,
        conversationId: conversation?.shortId ?? null,
        ...(place.retry ? { retry: true } : {}),
      };
    }
    const locale = getLocale(c);
    const subject = { actor, accessSubject: c.get("accessSubject") };
    const skills = (
      await Promise.all(
        place.skills.map((name) =>
          deps.skills(subject, { name, enabledOnly: true, modelInvocableOnly: true, authority: appAccessAuthority(c) }),
        ),
      )
    ).flat();
    const projectIds = conversation?.projectId ? await deps.projectIds([conversation.projectId], subject) : null;
    return {
      state: "available",
      ref: scope,
      title: place.title,
      app: {
        id: app.appId,
        name: resolveAppIdentityPresentation(
          { name: app.appName, description: app.appDescription, presentation: app.appPresentation },
          locale,
        ).name,
        icon: app.appIcon ?? null,
      },
      typeTitle: type.title,
      tools: place.tools.flatMap((id) => {
        const action = app.manifest.actions.find((entry) => entry.localId === id);
        return action
          ? [
              {
                id,
                title: resolveCapabilityOperationTitle(action, "actions", app.presentation, locale),
                icon: null,
                policy: capabilityActionPolicy(app.manifest, id) ?? null,
              },
            ]
          : [];
      }),
      skills: place.skills.flatMap((name) =>
        skills.some((skill) => skill.name === name && skill.enabled) ? [{ id: name, title: name }] : [],
      ),
      starters: place.starters ?? [],
      conversationId: conversation?.shortId ?? null,
      conversation: conversation
        ? {
            ...conversation,
            id: conversation.shortId,
            projectId: conversation.projectId ? (projectIds?.get(conversation.projectId) ?? null) : null,
          }
        : null,
    };
  };

/** Same consent, provider, and personal-chat snapshot for SSR and navigation. Opening never creates a chat. */
export const loadPlaceAssistant = createPlaceAssistantLoader(dependencies);
