import { expect, test } from "bun:test";
import { z } from "zod";
import { compileActionSentences } from "../_internal/capabilities";
import { CodeActionInput, CodeRunInput } from "./browser-code-contracts";
import { CloudAiFetchFileInputSchema } from "./fetch-file-tool";
import { CloudAiWriteFileInputSchema } from "./file-tools";
import { CloudAiWebExtractInputSchema } from "./firecrawl-tools";
import { CloudAiMemoryInputSchema } from "./memory-tool";
import { CLOUD_AI_TOOL_PRESENTATION } from "./tool-sentences";

const inputs: Record<keyof typeof CLOUD_AI_TOOL_PRESENTATION.sentences, z.ZodType> = {
  code_run: CodeRunInput,
  code_action: CodeActionInput,
  web_extract: CloudAiWebExtractInputSchema,
  fetch_file: CloudAiFetchFileInputSchema,
  write_file: CloudAiWriteFileInputSchema,
  memory: CloudAiMemoryInputSchema,
};

test("Cloud's own tool sentences pass the checks every app's sentences pass, in every shipped locale", () => {
  for (const [name, base] of Object.entries(CLOUD_AI_TOOL_PRESENTATION.sentences)) {
    const schemas = {
      inputSchema: z.toJSONSchema(inputs[name as keyof typeof inputs], { io: "input" }) as Record<string, unknown>,
      dataSchema: {},
    };
    expect(compileActionSentences(base, schemas, name)).toEqual(base);
    const german = CLOUD_AI_TOOL_PRESENTATION.translations.de.actions[name as keyof typeof inputs].sentences;
    expect(compileActionSentences(german, schemas, `${name} de`)).toEqual(german);
    // The same outcomes in each locale, so a receipt never switches language.
    expect(Object.keys(german).sort()).toEqual(Object.keys(base).sort());
  }
});
