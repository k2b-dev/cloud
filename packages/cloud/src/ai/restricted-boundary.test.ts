import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { aiReplacementProblem } from "../shared/ai-models";
import { selectAssistantAiModel } from "./assistant-models";
import * as credentials from "./credentials";
import { resolveLiveDictationModel } from "./live-dictation-model";
import { aiAssignmentFixture, aiModelFixture, aiSettingsFixture } from "./model-fixture";
import { personalAiModelPolicy } from "./personal-agent";
import * as settings from "./settings";
import { listAiModels, resolveAiVisionModel, selectAiModelProfile } from "./settings";
import { resolveAiBackgroundModel, resolveAiWorkflowModel } from "./structured";
import { resolveApplicationAiTaskModel } from "./task-model";
import { resolveAiAudioModel } from "./transcription";
import type { AiModelPolicy } from "./types";

/** One shared catalog: a restricted model that also sits in every slot, as if an assignment had slipped through. */
const restricted = aiModelFixture({ id: "free", modelId: "free", dataBoundary: "restricted", capabilities: ["tools", "vision"] });
const state = aiSettingsFixture({
  profiles: [
    aiModelFixture(),
    restricted,
    aiModelFixture({ id: "free-audio", modelId: "free-audio", dataBoundary: "restricted", capabilities: ["transcription"] }),
    aiModelFixture({ id: "free-live", modelId: "free-live", dataBoundary: "restricted", capabilities: ["live-transcription"] }),
  ],
  assignments: [
    aiAssignmentFixture("balanced", "free"),
    aiAssignmentFixture("vision", "free"),
    aiAssignmentFixture("audio", "free-audio"),
    aiAssignmentFixture("liveAudio", "free-live"),
  ],
});
const boundaryError = { aiError: { code: "model_policy_mismatch", fields: { model: "free", boundary: "restricted" } } };

let read: ReturnType<typeof spyOn<typeof settings, "readAiSettingsState">>;
let credentialIds: ReturnType<typeof spyOn<typeof credentials, "listAiCredentialProviderIds">>;
beforeEach(() => {
  read = spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
  credentialIds = spyOn(credentials, "listAiCredentialProviderIds").mockResolvedValue([]);
});
afterEach(() => {
  read.mockRestore();
  credentialIds.mockRestore();
});

test("application server code reaches a restricted model only by naming its ID", async () => {
  expect((await resolveAiBackgroundModel({ id: "free" })).profile.id).toBe("free");
  expect((await resolveApplicationAiTaskModel(undefined, { id: "free" })).profile.id).toBe("free");
  // A class never resolves to a restricted model, even on the application path.
  await expect(resolveAiBackgroundModel({ class: "balanced" })).rejects.toMatchObject(boundaryError);
  await expect(resolveApplicationAiTaskModel(undefined, { class: "balanced" })).rejects.toMatchObject(boundaryError);
});

test("every person-facing path rejects a restricted model", async () => {
  const person = { type: "user", userId: "00000000-0000-4000-8000-000000000001" } as const;
  // Assistant chat, routines, the chat API and the OpenAI-compatible API share the personal policy.
  expect(() => selectAiModelProfile(state, personalAiModelPolicy, { id: "free" })).toThrow("no data-protection commitment");
  expect((await listAiModels(personalAiModelPolicy, state)).map((profile) => profile.id)).toEqual(["chat"]);
  expect((await listAiModels(undefined, state)).map((profile) => profile.id)).toEqual(["chat"]);
  await expect(selectAssistantAiModel(person, { id: "free" })).rejects.toMatchObject(boundaryError);
  // Application tasks for a person keep the personal policy.
  await expect(resolveApplicationAiTaskModel(person, { id: "free" })).rejects.toMatchObject(boundaryError);
  // Workflows and code.
  await expect(resolveAiWorkflowModel({ id: "free" })).rejects.toMatchObject(boundaryError);
  // Image and audio tools, and live dictation.
  await expect(resolveAiVisionModel()).rejects.toMatchObject(boundaryError);
  await expect(resolveAiAudioModel()).rejects.toMatchObject({ code: "transcription_configuration_failed" });
  await expect(resolveLiveDictationModel(person)).rejects.toMatchObject({ code: "not_configured" });
});

test("only a policy that names the restricted boundary lists such models", async () => {
  const apps: AiModelPolicy = { kind: "selectable", allowedDataBoundaries: ["private", "hosted", "restricted"] };
  expect((await listAiModels(apps, state)).map((profile) => profile.id)).toEqual(["chat", "free"]);
  expect((await listAiModels({ kind: "selectable", allowedDataBoundaries: ["private", "hosted"] }, state)).length).toBe(1);
});

test("a deleted model names its ID in a clear policy error", async () => {
  await expect(resolveAiBackgroundModel({ id: "deleted" })).rejects.toMatchObject({
    message: 'The AI model "deleted" does not exist. It may have been deleted.',
    aiError: { code: "model_policy_mismatch", fields: { model: "deleted" } },
  });
});

test("replacements keep the boundary rank and never move to a restricted model", () => {
  const model = { kind: "chat" as const, capabilities: [], enabled: true };
  const provider = (dataBoundary: "private" | "hosted" | "restricted") => ({ dataBoundary, enabled: true });
  expect(aiReplacementProblem(provider("private"), provider("hosted"), model, model)).toBe("private_boundary");
  expect(aiReplacementProblem(provider("private"), provider("restricted"), model, model)).toBe("restricted_boundary");
  expect(aiReplacementProblem(provider("hosted"), provider("restricted"), model, model)).toBe("restricted_boundary");
  expect(aiReplacementProblem(provider("restricted"), provider("restricted"), model, model)).toBe("restricted_boundary");
  expect(aiReplacementProblem(provider("hosted"), provider("private"), model, model)).toBeNull();
  expect(aiReplacementProblem(provider("restricted"), provider("hosted"), model, model)).toBeNull();
});
