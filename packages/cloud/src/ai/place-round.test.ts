import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { panelContextConsent } from "../services/panel-context-consent";
import { buildProjectedUser } from "../services/session/user";
import * as authority from "./capability-execution";
import * as provider from "./place-provider";
import { loadPlaceAssistantRound } from "./place-round";
import { type AiSkillSummary, aiSkills } from "./skills";
import { aiConversations } from "./store";
import type { AiConversation } from "./types";

afterEach(() => mock.restore());
const ref = { type: "place-fixture.conversation", id: "marta" };
const user = buildProjectedUser({ id: "00000000-0000-4000-8000-000000000001", provider: "local", profile: "user", effective_admin: false });
const actor = { kind: "user" as const, user };
const freshAuthority = { actor, accessSubject: { type: "user" as const, userId: user.id }, credentialKind: "session" as const, scopes: [] };
const place = { title: "Marta", context: "Latest context", tools: ["reply.set"], skills: ["contact-writing"] };
const at = "2026-11-08T00:00:00.000Z";
const conversation: AiConversation = {
  id: "10000000-0000-4000-8000-000000000001",
  shortId: "aBc234",
  title: "Private chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: user.id,
  createdAt: at,
  updatedAt: at,
  place: { ref, title: "Marta snapshot" },
};
const skill = (name: string): AiSkillSummary => ({
  source: null,
  id: name,
  shortId: "aBc234",
  name,
  description: `Use ${name}`,
  permission: "read",
  enabled: true,
  manualOnly: false,
  revision: 1,
  referenceCount: 0,
  createdAt: at,
  updatedAt: at,
});
const setup = () => {
  const get = spyOn(aiConversations, "getConversation").mockResolvedValue(conversation);
  const resolve = spyOn(authority, "resolveAiCapabilityActor").mockResolvedValue(freshAuthority);
  const consent = spyOn(panelContextConsent, "get").mockResolvedValue({ allowed: true, revision: 1 });
  const run = spyOn(provider, "runPlaceProvider").mockResolvedValue(place);
  const skills = spyOn(aiSkills, "list").mockResolvedValue([skill("contact-writing"), skill("other")]);
  return { get, resolve, consent, run, skills };
};

test("an ordinary chat adds no place dependency", async () => {
  const { get, resolve, consent, run } = setup();
  get.mockResolvedValue(null);
  expect(await loadPlaceAssistantRound({ conversationId: "normal", persistedActor: actor, skillsEnabled: true })).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  expect(consent).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test("every round uses the refreshed actor and durable target, with only the current readable place Skill catalog", async () => {
  const { run, skills } = setup();
  const stale = { ...actor, user: { ...user, displayName: "Old snapshot" } };
  const signal = new AbortController().signal;
  const input = { conversationId: conversation.id, persistedActor: stale, skillsEnabled: true, locale: "de", signal };
  expect(await loadPlaceAssistantRound(input)).toEqual({
    ref,
    place,
    skills: [{ name: "contact-writing", description: "Use contact-writing" }],
  });
  expect(run).toHaveBeenLastCalledWith(actor, ref, { locale: "de", signal });
  expect(skills).toHaveBeenCalledWith({ actor, accessSubject: freshAuthority.accessSubject }, { authority: freshAuthority });
  run.mockResolvedValueOnce({ unavailable: true });
  expect(await loadPlaceAssistantRound(input)).toBeNull();
  expect(run).toHaveBeenCalledTimes(2);
  expect(skills).toHaveBeenCalledTimes(1);
});

test("withdrawing consent prevents the provider read on the next round", async () => {
  const { consent, run, skills } = setup();
  consent.mockResolvedValueOnce({ allowed: false, revision: 2 });
  expect(await loadPlaceAssistantRound({ conversationId: conversation.id, persistedActor: actor, skillsEnabled: true })).toBeNull();
  expect(run).not.toHaveBeenCalled();
  expect(skills).not.toHaveBeenCalled();
});
