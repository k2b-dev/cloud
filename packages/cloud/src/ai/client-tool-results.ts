import type { z } from "zod";
import {
  createCloudAiCodeTools,
  createCloudAiLocalBashTool,
  createCloudAiLocalTools,
  createCloudAiSurveyTool,
  createCloudAiTextEditorTool,
} from "./default-tools";

// Two 512 KiB Bash streams, fully JSON-escaped at six bytes per character, plus a 64 KiB envelope.
export const AI_CLIENT_TOOL_ACTION_MAX_BYTES = 2 * 512 * 1024 * 6 + 64 * 1024;

export const aiClientToolOutputSchemas = new Map<string, z.ZodType>(
  [
    createCloudAiLocalBashTool(),
    ...createCloudAiLocalTools(),
    createCloudAiSurveyTool(),
    createCloudAiTextEditorTool(),
    ...createCloudAiCodeTools(),
  ]
    .filter((tool) => tool.location === "client" || tool.location === "client_interaction")
    .map((tool) => [tool.def.name, tool.def.outputSchema]),
);
