import type { AiModelPolicy } from "./types";

export const personalAiModelPolicy: AiModelPolicy = {
  kind: "selectable",
  requiredCapabilities: ["streaming", "tools"],
};
