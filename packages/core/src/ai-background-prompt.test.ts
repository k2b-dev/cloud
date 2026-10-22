import { expect, test } from "bun:test";
import { createAiTurnCodeAndClientTools } from "@k2b/cloud/ai/runtime";
import { backgroundTaskInstructions } from "./ai-background-prompt";

test("scheduled instructions match the turn's Code Mode tools and interactive limits", () => {
  // Scheduled turns use default tools, have no clientToolIds, and receive a mandate at delivery.
  const tools = createAiTurnCodeAndClientTools({
    mandate: { id: "00000000-0000-4000-8000-000000000001", revision: 1 },
  });
  const names = new Set(tools.map((tool) => tool.def.name));
  const prompt = backgroundTaskInstructions({
    taskId: "Task001",
    occurrenceId: "Occ001",
    scheduledFor: "2026-10-17T09:00:00Z",
    grants: [],
  });

  // If scheduled tools change, update the Code Mode sentence in the background prompt too.
  const claimsCodeMode = /\bCode Mode\b/.test(prompt) && !/Code Mode is unavailable/i.test(prompt);
  expect(claimsCodeMode).toBe(names.has("code_run"));
  expect(names.has("code_run")).toBe(true);

  const claimsInteractiveLimits = /cannot open apps beside the chat/i.test(prompt) && /collect new secrets/i.test(prompt);
  expect(claimsInteractiveLimits).toBe(!names.has("code_open") && !names.has("code_secret"));
});
