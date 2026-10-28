import { defineEnv } from "@k2b/cloud/config";
import { z } from "zod";

export const appEnv = defineEnv({
  MAIL_WORKFLOW_AI_BODY_MAX_CHARS: {
    schema: z.coerce.number().int().positive().max(100_000),
    default: 20_000,
    doc: "Maximum Mail body characters loaded for an AI workflow step; the pilot budget rejects larger bodies visibly without truncation and preserves the original for manual inspection.",
  },
});
