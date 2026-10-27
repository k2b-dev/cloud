import { expect, spyOn, test } from "bun:test";
import * as assistant from "./assistant-models";
import { personalAiModelPolicy } from "./personal-agent";
import * as settings from "./settings";
import * as structured from "./structured";
import { resolveApplicationAiTaskModel } from "./task-model";
import type { AiResolvedModel } from "./types";

const resolved: AiResolvedModel = {
  profile: {
    id: "personal",
    label: "Personal",
    provider: "openai",
    model: "test",
    enabled: true,
    capabilities: [],
    dataBoundary: "hosted",
  },
  provider: {
    name: "test",
    family: "openai-compatible",
    model: "test",
    capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
    complete: async () => {
      throw new Error("Unused provider");
    },
    async *stream() {
      throw new Error("Unused provider");
    },
  },
};

test("personal tasks authorize the pinned model with Assistant grants and the personal data policy", async () => {
  const select = spyOn(assistant, "selectAssistantAiModelId").mockResolvedValue("personal");
  const resolve = spyOn(settings, "resolveAiModel").mockResolvedValue(resolved);
  const background = spyOn(structured, "resolveAiWorkflowModel");
  try {
    const subject = { type: "user", userId: "person" } as const;
    expect(await resolveApplicationAiTaskModel(subject, "personal")).toBe(resolved);
    expect(select).toHaveBeenCalledWith(subject, "personal");
    expect(resolve).toHaveBeenCalledWith(personalAiModelPolicy, "personal");
    expect(background).not.toHaveBeenCalled();
    select.mockRejectedValue(new Error("Model grant revoked"));
    await expect(resolveApplicationAiTaskModel(subject, "personal")).rejects.toThrow("Model grant revoked");
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally {
    select.mockRestore();
    resolve.mockRestore();
    background.mockRestore();
  }
});

test("background tasks retain the shared workflow/background/default selection", async () => {
  const select = spyOn(assistant, "selectAssistantAiModelId");
  const background = spyOn(structured, "resolveAiWorkflowModel").mockResolvedValue(resolved);
  try {
    expect(await resolveApplicationAiTaskModel(undefined, "background")).toBe(resolved);
    expect(background).toHaveBeenCalledWith("background");
    expect(select).not.toHaveBeenCalled();
  } finally {
    select.mockRestore();
    background.mockRestore();
  }
});
