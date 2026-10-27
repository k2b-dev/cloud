import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { buildProjectedUser } from "../services/session/user";
import { aiModelAccess } from "./model-access";
import { aiAssignmentFixture, aiModelFixture, aiSettingsFixture } from "./model-fixture";
import { aiUserPrefs } from "./prefs";
import { aiQuotas } from "./quotas";
import { prepareAiChatTurn } from "./runtime";
import * as settings from "./settings";
import { aiConversations } from "./store";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user" });
const at = "2026-10-16T00:00:00.000Z";
afterEach(() => mock.restore());
const setup = () => {
  spyOn(settings, "readAiSettingsState").mockResolvedValue(
    aiSettingsFixture({
      profiles: [aiModelFixture({ id: "new:deep", modelId: "new", variantLabel: "Thorough" })],
      assignments: [aiAssignmentFixture("thorough", "new:deep")],
    }),
  );
  spyOn(aiConversations, "getLatestTurn").mockResolvedValue({
    id: "turn",
    shortId: "Turn01",
    conversationId: "chat",
    status: "completed",
    attempt: 1,
    modelId: "removed",
    createdAt: at,
    completedAt: at,
    error: null,
  });
  spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Previous",
    model: { id: "removed" },
    modelLabel: "Previous model",
  });
  spyOn(aiUserPrefs, "get").mockResolvedValue({
    userId: user.id,
    memoryEnabled: true,
    memoryLearningEnabled: true,
    selection: { class: "thorough" },
    updatedAt: at,
  });
  spyOn(aiModelAccess, "assertAllowed").mockResolvedValue();
  spyOn(aiQuotas, "assertAllowed").mockResolvedValue(false);
};
test.each([undefined, { id: "removed" }])(
  "a deleted chat selection uses the person's class and records a timeline marker: %p",
  async (model) => {
    setup();
    const prepared = await prepareAiChatTurn({
      conversationId: "chat",
      input: "Next",
      model,
      userMessage: { role: "user", content: ["Next"] },
      assistantChat: true,
      actor: { kind: "user", user },
      canInspectAttachedImages: false,
      fileSnapshot: { attached: [], available: [], total: 0 },
    });
    expect(prepared.runConfig.model).toEqual({ class: "thorough" });
    expect(prepared.runConfig.modelResolved).toEqual({
      requestedClass: "thorough",
      class: "thorough",
      id: "new:deep",
    });
    expect(prepared.runConfig.modelReplacement).toEqual({
      kind: "model_replaced",
      previousLabel: "Previous model",
      nextLabel: "Chat · Thorough",
    });
  },
);
test("a deliberately requested missing variant fails instead of substituting", async () => {
  setup();
  await expect(
    prepareAiChatTurn({
      conversationId: "chat",
      input: "Next",
      userMessage: { role: "user", content: ["Next"] },
      model: { id: "another-missing" },
      assistantChat: true,
      actor: { kind: "user", user },
      canInspectAttachedImages: false,
      fileSnapshot: { attached: [], available: [], total: 0 },
    }),
  ).rejects.toMatchObject({ aiError: { code: "model_policy_mismatch" } });
});
