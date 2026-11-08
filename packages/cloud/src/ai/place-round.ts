import type { RequestActor } from "../server/middleware/auth";
import { panelContextConsent } from "../services/panel-context-consent";
import { resolveAiCapabilityActor } from "./capability-execution";
import { runPlaceProvider } from "./place-provider";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";

/** The durable chat binding is the selector; page navigation never retargets an existing chat. */
export const loadPlaceAssistantRound = async (input: { conversationId: string; persistedActor?: RequestActor; skillsEnabled: boolean }) => {
  const conversation = await aiConversations.getConversation({ conversationId: input.conversationId });
  if (!conversation?.place) return null;
  const authority = await resolveAiCapabilityActor({ ...input, store: aiConversations });
  if (!(await panelContextConsent.get(authority.actor.user.id, "assistant"))?.allowed) return null;
  const ref = conversation.place.ref;
  const place = await runPlaceProvider(authority, ref);
  if ("unavailable" in place) return null;
  const skills = input.skillsEnabled
    ? (await aiSkills.list({ actor: authority.actor, accessSubject: authority.accessSubject }, { authority }))
        .filter((skill) => skill.enabled && !skill.manualOnly && place.skills.includes(skill.name))
        .map(({ name, description }) => ({ name, description }))
    : [];
  return { ref, place, skills };
};
