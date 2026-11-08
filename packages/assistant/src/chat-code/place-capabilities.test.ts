import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { RequestAuthority } from "@k2b/cloud/server";
import {
  createAssistantPlaceFixture,
  PLACE_FIXTURE_APP_ID,
  PLACE_FIXTURE_PEOPLE,
  PLACE_FIXTURE_TYPE,
} from "../../../../scripts/fixtures/assistant-place";
import { createRuntimeCapabilities } from "./capability-runtime";
import * as chatAccess from "./chat-access";
import { codeRunSdk } from "./runtime/code-run-sdk";
import { testIdentity } from "./test-identity";

afterEach(() => mock.restore());

const fixture = () => {
  const { capabilities } = createAssistantPlaceFixture();
  const manifest = compileCapabilityManifest(PLACE_FIXTURE_APP_ID, capabilities);
  const app = { appId: PLACE_FIXTURE_APP_ID, appName: "Contact fixture", appDescription: "Invented", appIcon: "ti ti-message", manifest };
  const identity = testIdentity(PLACE_FIXTURE_PEOPLE.lea);
  const authority: RequestAuthority = {
    actor: identity.actor,
    accessSubject: identity.accessSubject,
    credentialKind: "session",
    scopes: [],
  };
  return { app, identity: { ...identity, authority }, authority };
};

const chat = (atPlace: boolean): AiConversation => ({
  id: "00000000-0000-4000-8000-000000000010",
  shortId: "abc123",
  title: "Marta",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-11-08T00:00:00Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: PLACE_FIXTURE_PEOPLE.lea,
  createdAt: "2026-11-08T00:00:00Z",
  updatedAt: "2026-11-08T00:00:00Z",
  ...(atPlace ? { place: { ref: { type: PLACE_FIXTURE_TYPE, id: "marta" }, title: "Marta" } } : {}),
});

test.each([false, true])("one-off scripts cannot call place Actions with another target (place chat: %s)", async (atPlace) => {
  const h = fixture();
  spyOn(chatAccess, "requireToolChat").mockResolvedValue(chat(atPlace));
  spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: h.app });
  const review = spyOn(capabilityClient, "reviewCapabilityAction");
  const invoke = spyOn(capabilityClient, "invokeCapability");
  const transport = mock(async () => {
    throw new Error("Must not dispatch");
  });
  await expect(
    createRuntimeCapabilities().prepare(
      {
        id: "00000000-0000-4000-8000-000000000011",
        name: `${PLACE_FIXTURE_APP_ID}.reply.set`,
        input: { text: "Other conversation" },
        target: { type: PLACE_FIXTURE_TYPE, id: "jonas" },
        conversationId: chat(atPlace).id,
      },
      h.identity,
      { transport, origin: "assistant", locale: "en" },
    ),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(review).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

test("the one-off SDK omits place Actions while retaining resource queries", async () => {
  const h = fixture();
  spyOn(capabilityClient, "listCapabilityCatalog").mockResolvedValue({
    ok: true,
    data: { protocolVersion: 2, apps: [h.app], page: { hasMore: false } },
  });
  const sdk = await codeRunSdk(h.authority, "en");
  expect(sdk.declarations).not.toContain("reply");
  expect(sdk.declarations).not.toContain("note");
  expect(sdk.declarations).toContain("read");
});
