import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createAssistantPlaceFixture, PLACE_FIXTURE_PEOPLE, PLACE_FIXTURE_TYPE } from "../../../../scripts/fixtures/assistant-place";
import { compileCapabilities } from "../_internal/capabilities";
import type { getCapability } from "../_internal/registry";
import type { AssistantPlaceResult } from "../contracts/assistant-place";
import type { CloudResourceRef } from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import type { AuthContext } from "../server/middleware/auth";
import { buildProjectedUser } from "../services/session/user";
import { AiCreateConversationInputSchema } from "./http";
import { createPlaceAssistantLoader } from "./place-assistant";
import type { AiConversation } from "./types";

const ref = { type: PLACE_FIXTURE_TYPE, id: "marta" };
const at = "2026-11-08T00:00:00.000Z";
const chat = (owner: string): AiConversation => ({
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
  createdByUserId: owner,
  createdAt: at,
  updatedAt: at,
  place: { ref, title: "Marta snapshot" },
});

const fixture = () => {
  const invented = createAssistantPlaceFixture();
  const compiled = compileCapabilities("place-fixture", invented.capabilities);
  const app = {
    appId: "place-fixture",
    appName: "Contacts fixture",
    appDescription: "Invented contacts",
    appIcon: "ti ti-address-book",
    endpoint: "http://place-fixture.invalid",
    manifest: compiled.manifest,
  };
  const deps = {
    consent: mock(async (_person: string, _provider: string) => ({ allowed: true, revision: 1 })),
    capability: mock<typeof getCapability>(async (_app: string) => app),
    provider: mock(
      async (_authority: RequestAuthority, _ref: CloudResourceRef): Promise<AssistantPlaceResult> => ({
        title: "Marta Example",
        context: "Private app context",
        tools: ["reply.set"],
        skills: [],
        starters: [{ label: "Shorten reply", prompt: "Make the reply shorter." }],
      }),
    ),
    conversation: mock(async ({ ownerUserId }: { ownerUserId: string; ref: CloudResourceRef }) =>
      ownerUserId === PLACE_FIXTURE_PEOPLE.lea ? chat(ownerUserId) : null,
    ),
    skills: mock(async () => []),
    projectIds: mock(async () => new Map<string, string>()),
  };
  const load = createPlaceAssistantLoader(deps);
  const server = (person = PLACE_FIXTURE_PEOPLE.lea, scope: CloudResourceRef | null = ref) =>
    new Hono<AuthContext>()
      .use("*", async (c, next) => {
        const user = buildProjectedUser({ id: person, provider: "local", profile: "user", effective_admin: false });
        c.set("actor", { kind: "user", user });
        c.set("user", user);
        c.set("accessSubject", { type: "user", userId: person });
        c.set("credentialKind", "session");
        await next();
      })
      .get("/", async (c) => c.json(await load(c, scope)));
  return { deps, server };
};

test("consent gates registry, provider, and personal chat reads for both SSR and navigation loader", async () => {
  const { deps, server } = fixture();
  deps.consent.mockResolvedValueOnce({ allowed: false, revision: 2 });
  expect(await (await server().request("/")).json()).toEqual({ state: "consent_required" });
  expect(deps.capability).not.toHaveBeenCalled();
  expect(deps.provider).not.toHaveBeenCalled();
  expect(deps.conversation).not.toHaveBeenCalled();
  expect(await (await server(PLACE_FIXTURE_PEOPLE.lea, null).request("/")).json()).toEqual({ state: "none" });
  expect(deps.consent).toHaveBeenCalledTimes(1);
});

test("place snapshot returns only the current person's chat, normal action policy, and starters", async () => {
  const { deps, server } = fixture();
  const lea = await (await server().request("/")).json();
  expect(lea).toMatchObject({
    state: "available",
    conversationId: "aBc234",
    tools: [{ id: "reply.set", policy: { silent: "you" } }],
    starters: [{ label: "Shorten reply", prompt: "Make the reply shorter." }],
  });
  expect(lea.conversation.id).toBe("aBc234");
  expect(lea).not.toHaveProperty("context");
  const ben = await (await server(PLACE_FIXTURE_PEOPLE.ben).request("/")).json();
  expect(ben.conversationId).toBeNull();
  expect(ben.conversation).toBeNull();
  expect(deps.conversation).toHaveBeenLastCalledWith({ ownerUserId: PLACE_FIXTURE_PEOPLE.ben, ref });
});

test("an unavailable place retains the person's chat and title snapshot without place additions", async () => {
  const { deps, server } = fixture();
  deps.provider.mockResolvedValue({ unavailable: true });
  expect(await (await server().request("/")).json()).toEqual({
    state: "unavailable",
    ref,
    title: "Marta snapshot",
    conversationId: "aBc234",
  });
  expect(await (await server(PLACE_FIXTURE_PEOPLE.ben).request("/")).json()).toEqual({
    state: "unavailable",
    ref,
    title: null,
    conversationId: null,
  });
  expect(deps.skills).not.toHaveBeenCalled();
});

test("removing the app or assistant declaration preserves an existing chat without calling the provider", async () => {
  const { deps, server } = fixture();
  deps.capability.mockResolvedValue(null);
  expect(await (await server().request("/")).json()).toEqual({
    state: "unavailable",
    ref,
    title: "Marta snapshot",
    conversationId: "aBc234",
  });
  expect(await (await server(PLACE_FIXTURE_PEOPLE.ben).request("/")).json()).toEqual({ state: "none" });
  expect(deps.provider).not.toHaveBeenCalled();
});

test("place creation requires the first message and keeps the normal creation contract", () => {
  expect(AiCreateConversationInputSchema.safeParse({ place: ref }).success).toBe(false);
  expect(AiCreateConversationInputSchema.safeParse({ place: ref, draft: { content: [{ type: "text", text: " " }] } }).success).toBe(false);
  expect(AiCreateConversationInputSchema.safeParse({ place: ref, draft: { content: [{ type: "text", text: "Help here" }] } }).success).toBe(
    true,
  );
  expect(AiCreateConversationInputSchema.safeParse({ title: "Normal empty chat" }).success).toBe(true);
});
